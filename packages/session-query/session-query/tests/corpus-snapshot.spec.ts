/**
 * PR-1 busy-safe listing snapshot: dispose reconciliation (R1 arms) and TTL
 * revalidation (R5) against the real JSONL backend; single-flight build (R2),
 * generation discard (R3), and cold-start paths against a controllable
 * in-memory backend. Temporary roots are mkdtemp directories, never `~/.dsh`.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionPersistence, {
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionDir } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { SessionQueryError, type SessionQueryErrorCode } from '@deepseek-ai/dsh-session-query'
import { TestSessionQueryEngine } from './test-service.ts'

const temporaryRoots: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-corpus-snapshot-'))
  temporaryRoots.push(dir)
  return dir
}

/** Let real macrotask work (filesystem continuations, timers) run. */
function settle(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of temporaryRoots.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function headerOf(id: string, createdAt = 1, cwd?: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...(cwd === undefined ? {} : { cwd }) }
}

function eventText(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

async function jsonlContext(listRefreshMs?: number): Promise<{ ctx: Context; root: string }> {
  const root = await freshRoot()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TestSessionQueryEngine, listRefreshMs === undefined ? {} : { listRefreshMs })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, root }
}

/** Enter and announce one live session the test can detach at will. */
function attachLiveSession(ctx: Context, id: string, cwd: string): { session: Session; detach: () => void } {
  const session = ctx.sessions.prepare(SessionId(id), { meta: { cwd } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { session, detach }
}

async function listIds(ctx: Context): Promise<SessionIdType[]> {
  return (await ctx.sessionQuery.listSessions()).map(record => record.header.id)
}

/** Poll `listSessions` until `predicate` holds or the budget lapses. */
async function waitUntilListed(
  ctx: Context,
  predicate: (ids: readonly SessionIdType[]) => boolean,
  budgetMs = 4_000,
): Promise<SessionIdType[]> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const ids = await listIds(ctx)
    if (predicate(ids)) return ids
    if (Date.now() > deadline) return ids
    await settle(10)
  }
}

describe('persisted snapshot dispose reconciliation (R1)', () => {
  /**
   * Arm (iii): a created-never-materialized session that still holds its write
   * lease (retained when materialization refuses after the lease was taken).
   * `close()` awaits the lease release, whose filesystem-bound completion is
   * the window that keeps close in flight while the coalesced reconcile task
   * resolves its barrier. A session that never took a lease (the bare arm)
   * settles its close tail in pure microtasks and holds no window.
   */
  async function blankSessionWithLease(ctx: Context, root: string, id: string) {
    const service = ctx.sessionPersistence as JsonlSessionPersistence
    const { session, detach } = attachLiveSession(ctx, id, root)
    const writer = await service.create(session.header)
    const refusal = new Error('test materialization refusal')
    vi.spyOn(service, 'persistHeader').mockRejectedValueOnce(refusal)
    await expect(writer.flush()).rejects.toBe(refusal)
    vi.restoreAllMocks()
    return { writer, detach }
  }

  it('arm (iii) with the release-step window: a disposed blank session leaves no phantom row', async () => {
    const { ctx, root } = await jsonlContext()
    const id = SessionId('blank-with-lease')
    const { writer, detach } = await blankSessionWithLease(ctx, root, 'blank-with-lease')

    // While attached, the live overlay publishes the session; the snapshot's
    // persisted side never carries a never-materialized row.
    const during = await ctx.sessionQuery.listSessions()
    expect(during.find(record => record.header.id === id))
      .toMatchObject({ live: true, persisted: false })

    // Detach runs the disposal dispatch: the JSONL listener starts `close()`
    // (in flight across the lease-release window) and the corpus listener
    // schedules the coalesced reconcile task, whose barrier must join that
    // close. Settle point: the close promise and the reconcile continuation.
    detach()
    await writer.close()
    await settle(15)

    expect((await listIds(ctx)).some(candidate => candidate === id)).toBe(false)
    const service = ctx.sessionPersistence as JsonlSessionPersistence
    expect(service.hasPendingSession(id)).toBe(false)
    await expect(ctx.sessionPersistence.stat(id)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('arm (iii) bare sequence without the window settles green', async () => {
    const { ctx, root } = await jsonlContext()
    const id = SessionId('blank-bare')
    const { session, detach } = attachLiveSession(ctx, 'blank-bare', root)
    const writer = await ctx.sessionPersistence.create(session.header)
    detach()
    await writer.close()
    await settle(15)
    expect((await listIds(ctx)).some(candidate => candidate === id)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('arm (i) slow-success drain: the materialized row lands after settle', async () => {
    const { ctx, root } = await jsonlContext()
    const service = ctx.sessionPersistence as JsonlSessionPersistence
    const id = SessionId('slow-drain')
    const persistBatch = service.persistBatch.bind(service)
    vi.spyOn(service, 'persistBatch').mockImplementation(async (...args) => {
      await settle(10)
      await persistBatch(...args)
    })
    const { session, detach } = attachLiveSession(ctx, 'slow-drain', root)
    const writer = await service.create(session.header)
    session.append('user/message', eventText('slow'), { surfaceOp: 'append' })
    detach()
    await writer.close()
    await settle(15)

    const records = await ctx.sessionQuery.listSessions()
    expect(records.find(record => record.header.id === id))
      .toMatchObject({ live: false, persisted: true })
    const reader = await service.open(id, 'read')
    await expect(reader.read()).resolves.toMatchObject({ events: [{ seq: SessionSeq(0) }] })
    await reader.close()
    await ctx.fiber.dispose()
  })

  it('arm (ii) forced-failure drain: the barrier fails, reconciles stale-marks, and the listing converges healthy', async () => {
    // The drain refusal makes the barrier reject, so the reconcile task takes
    // its documented mark-stale path instead of a stat-precise removal; the
    // TTL re-enumeration converges after the failed close releases the id.
    const { ctx, root } = await jsonlContext(50)
    const service = ctx.sessionPersistence as JsonlSessionPersistence
    const id = SessionId('failed-drain')
    const { session, detach } = attachLiveSession(ctx, 'failed-drain', root)
    const writer = await service.create(session.header)
    session.append('user/message', eventText('doomed'), { surfaceOp: 'append' })
    vi.spyOn(service, 'persistBatch').mockRejectedValue(new Error('test drain refusal'))
    detach()
    await writer.close().catch(() => undefined)

    // Healthy means answered, not empty: every request resolves through the
    // stale/rebuild path, and the never-materialized row ends up removed.
    const ids = await waitUntilListed(ctx, candidates => !candidates.some(candidate => candidate === id))
    expect(ids.some(candidate => candidate === id)).toBe(false)
    expect(service.hasPendingSession(id)).toBe(false)
    await ctx.fiber.dispose()
  })
})

/**
 * A keyless in-memory backend whose listing can be gated, failed, and
 * re-seeded between service replacements; `list()` captures its entry view at
 * call time so a gated build returns pre-trigger content. Static state is
 * reset by each `beforeEach` of the suites that mount it.
 */
class SnapshotTestPersistence extends SessionPersistence {
  static seed: readonly SessionHeader[] = []
  static gate: Promise<void> | undefined
  static fail = false

  listCalls = 0
  flushCalls = 0

  create(): never {
    throw new Error('unused by these cases')
  }

  open(): never {
    throw new Error('unused by these cases')
  }

  async flush(): Promise<void> {
    this.flushCalls += 1
  }

  async stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const header = SnapshotTestPersistence.seed.find(candidate => candidate.id === id)
    if (header === undefined) return undefined
    return { header: structuredClone(header), revision: SessionPersistenceRevision(`test:${id}`) }
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    this.listCalls += 1
    const captured = [...SnapshotTestPersistence.seed]
    if (SnapshotTestPersistence.gate !== undefined) await SnapshotTestPersistence.gate
    if (SnapshotTestPersistence.fail) {
      throw new SessionQueryError('test listing refusal', 'SESSION_QUERY_PERSISTENCE_FAILED')
    }
    return captured.map(header => ({
      header: structuredClone(header),
      revision: SessionPersistenceRevision(`test:${header.id}`),
    }))
  }
}

function resetMemoryBackend(): void {
  SnapshotTestPersistence.seed = []
  SnapshotTestPersistence.gate = undefined
  SnapshotTestPersistence.fail = false
}

async function memoryContext(
  config: ConstructorParameters<typeof TestSessionQueryEngine>[1] = {},
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TestSessionQueryEngine, config)
  return ctx
}

describe('persisted snapshot build discipline (R2, R3, cold start)', () => {
  beforeEach(resetMemoryBackend)

  it('R2: concurrent first requests share one enumeration and see identical rows', async () => {
    const gate = Promise.withResolvers<undefined>()
    const ctx = await memoryContext()
    SnapshotTestPersistence.seed = [headerOf('r2-a', 2), headerOf('r2-b', 1)]
    SnapshotTestPersistence.gate = gate.promise
    await ctx.plugin(SnapshotTestPersistence)
    const service = ctx.sessionPersistence as SnapshotTestPersistence
    const first = ctx.sessionQuery.listSessions()
    const second = ctx.sessionQuery.listSessions()
    gate.resolve(undefined)
    const [a, b] = await Promise.all([first, second])
    expect(a.map(record => record.header.id)).toEqual([SessionId('r2-a'), SessionId('r2-b')])
    expect(b).toEqual(a)
    expect(service.listCalls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('R3: a trigger during a build discards the stale build and re-arms', async () => {
    const gate = Promise.withResolvers<undefined>()
    const ctx = await memoryContext()
    SnapshotTestPersistence.seed = [headerOf('r3-x', 5)]
    SnapshotTestPersistence.gate = gate.promise
    await ctx.plugin(SnapshotTestPersistence)
    const service = ctx.sessionPersistence as SnapshotTestPersistence
    const pending = ctx.sessionQuery.listSessions()
    await settle(5)
    // The trigger fires while the gated enumeration is in flight: the build's
    // captured header predates it, so the result must not publish.
    SnapshotTestPersistence.seed = []
    const { detach } = attachLiveSession(ctx, 'r3-trigger', '/r3')
    detach()
    gate.resolve(undefined)
    const records = await pending
    expect(records.map(record => record.header.id)).toEqual([])
    expect(service.listCalls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('first build failure reaches every waiter, the next request re-arms, and no waiter hangs', async () => {
    const ctx = await memoryContext()
    SnapshotTestPersistence.fail = true
    await ctx.plugin(SnapshotTestPersistence)
    const service = ctx.sessionPersistence as SnapshotTestPersistence
    const failures = await Promise.all([
      ctx.sessionQuery.listSessions().catch((error: unknown) => error),
      ctx.sessionQuery.listSessions().catch((error: unknown) => error),
    ])
    expect(failures).toEqual([
      expectCode('SESSION_QUERY_PERSISTENCE_FAILED'),
      expectCode('SESSION_QUERY_PERSISTENCE_FAILED'),
    ])
    SnapshotTestPersistence.fail = false
    SnapshotTestPersistence.seed = [headerOf('after-rearm', 3)]
    await expect(ctx.sessionQuery.listSessions()).resolves.toMatchObject([
      { header: { id: SessionId('after-rearm') }, live: false, persisted: true },
    ])
    expect(service.listCalls).toBe(3)
    await ctx.fiber.dispose()
  })

  it('cold start: the first request shares the eager build; warm requests never re-enumerate', async () => {
    const ctx = await memoryContext({ listRefreshMs: 600_000 })
    SnapshotTestPersistence.seed = [headerOf('warm-a', 2)]
    await ctx.plugin(SnapshotTestPersistence)
    const service = ctx.sessionPersistence as SnapshotTestPersistence
    await expect(ctx.sessionQuery.listSessions()).resolves.toMatchObject([
      { header: { id: SessionId('warm-a') }, live: false },
    ])
    await ctx.sessionQuery.listSessions()
    await ctx.sessionQuery.filterSessions([])
    expect(service.listCalls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('an empty corpus with only live sessions still lists the live half', async () => {
    const ctx = await memoryContext()
    await ctx.plugin(SnapshotTestPersistence)
    attachLiveSession(ctx, 'live-only', '/live')
    await expect(ctx.sessionQuery.listSessions()).resolves.toMatchObject([
      { header: { id: SessionId('live-only') }, live: true, persisted: false },
    ])
    await ctx.fiber.dispose()
  })

  it('a persistence replacement empties and re-prewarms the snapshot', async () => {
    const gate = Promise.withResolvers<undefined>()
    const ctx = await memoryContext({ listRefreshMs: 40 })
    SnapshotTestPersistence.seed = [headerOf('first-service', 1)]
    SnapshotTestPersistence.gate = gate.promise
    const firstFiber = await ctx.plugin(SnapshotTestPersistence)
    const first = ctx.sessionPersistence as SnapshotTestPersistence
    const pending = ctx.sessionQuery.listSessions()

    // Replace the backend while its enumeration is still in flight: the
    // stale build never publishes, the waiting request answers with the
    // persisted half absent, and the re-armed build and the TTL refresh run
    // detached — harmlessly, until the replacement attaches and kicks a
    // fresh enumeration of its own rows.
    await firstFiber.dispose()
    gate.resolve(undefined)
    await expect(pending).resolves.toEqual([])
    expect(first.listCalls).toBe(1)
    await settle(80)

    SnapshotTestPersistence.seed = [headerOf('second-service', 2)]
    SnapshotTestPersistence.gate = undefined
    await ctx.plugin(SnapshotTestPersistence)
    const second = ctx.sessionPersistence as SnapshotTestPersistence
    await expect(ctx.sessionQuery.listSessions()).resolves.toMatchObject([
      { header: { id: SessionId('second-service') }, persisted: true },
    ])
    expect(second.listCalls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('an aborted request waiting on the shared build keeps its exact reason', async () => {
    const gate = Promise.withResolvers<undefined>()
    const ctx = await memoryContext()
    SnapshotTestPersistence.seed = [headerOf('gated', 1)]
    SnapshotTestPersistence.gate = gate.promise
    await ctx.plugin(SnapshotTestPersistence)
    const controller = new AbortController()
    const reason = new Error('listing cancelled while the shared build runs')
    const pending = ctx.sessionQuery.listSessions(controller.signal)
    await settle(5)
    controller.abort(reason)
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await settle(5)
    expect(settled).toBe(false)
    gate.resolve(undefined)
    await expect(pending).rejects.toBe(reason)
    await ctx.fiber.dispose()
  })

  it('rejects a non-positive or fractional listRefreshMs at load', async () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      expect(() => new TestSessionQueryEngine(ctx, { listRefreshMs: value }))
        .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
      await ctx.fiber.dispose()
    }
  })
})

describe('persisted snapshot TTL revalidation (R5, real JSONL)', () => {
  it('out-of-band additions and removals become visible within the TTL budget', async () => {
    const { ctx, root } = await jsonlContext(40)
    await expect(listIds(ctx)).resolves.toEqual([])

    // A foreign writer on the same root simulates another process: the first
    // service learns of the artifact only through a TTL-triggered rebuild.
    const foreignId = SessionId('foreign')
    const other = new Context()
    await other.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const foreignService = other.sessionPersistence as JsonlSessionPersistence
    const foreign = await foreignService.create(headerOf('foreign', 110))
    await foreign.append([{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 10,
      data: createUserMessage({ content: [{ type: 'text', text: 'foreign' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    }])
    await foreign.close()
    await other.fiber.dispose()

    const added = await waitUntilListed(ctx, ids => ids.includes(foreignId))
    expect(added).toContain(foreignId)

    await rm(sessionDir(root, undefined, foreignId), { recursive: true, force: true })
    const removed = await waitUntilListed(ctx, ids => !ids.includes(foreignId))
    expect(removed).not.toContain(foreignId)
    await ctx.fiber.dispose()
  }, 20_000)
})
