/**
 * The streamed `session.list` wire: registry rows before the snapshot pass,
 * bounded page frames, the completion frame only after the complete listing,
 * and closure while the listing read is still in flight.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine, {
  type SessionEventSearchPage, type SessionEventSearchRequest,
  type SessionSearchExecContext, type SessionSearchHit, type SessionSearchPage, type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ApiSessionList } from '../src/list.ts'
import { collectSessionListPages, createSessionTestRemote, testSessionPersistence } from './test-remote.ts'
import { SESSION_LIST_PAGE_SIZE, type SessionListPage } from '../src/types.ts'

const sid = (id: string): SessionId => id as SessionId

function header(id: string, createdAt: number): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt, isSeeded: false, cwd: '/proj' }
}

function headers(count: number, baseTime = 0): SessionHeader[] {
  return Array.from({ length: count }, (_, index) => header(`cold-${String(index)}`, baseTime + index))
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): void {
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

/** A Workspace registry accounting for `sessionIds` (+ archived) through one fixed Workspace. */
function provideRegistry(
  ctx: Context,
  sessionIds: readonly SessionId[],
  archived: readonly SessionId[] = [],
): void {
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [{ workspaceId: 'w1', sessionIds, path: '/w1' }],
    get archivedSessionIds() {
      return archived
    },
    get pinnedSessionIds() {
      return []
    },
  } as never)
}

class ListingStreamQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.reject(new Error('search is not exercised by the list stream'))
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('search is not exercised by the list stream'))
  }
}

function remoteFor(ctx: Context) {
  return createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
}

describe('session.list stream', () => {
  it('delivers registry rows before the snapshot listing read settles', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const gate = Promise.withResolvers<readonly SessionHeader[]>()
    const listing = vi.fn((): Promise<readonly SessionHeader[]> => gate.promise)
    provideRegistry(ctx, [sid('registry-1')])
    providePersistence(ctx, {
      list: listing,
      stat: async (id: SessionId) => ({
        header: header(id, 500),
        revision: 'test:stat' as never,
      }),
    })
    const remote = remoteFor(ctx)
    const stream = remote.list(new AbortController().signal)
    expect(typeof stream[Symbol.asyncIterator]).toBe('function')

    // The generator wrapper types the iterator's completion return as `void`,
    // so reading `value` from a not-done step stays narrowed.
    const iterator = (async function* () { yield* stream })()[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done === true) throw new Error('the stream closed before its provisional frame')
    expect(first.value).toMatchObject({ items: [expect.objectContaining({ sessionId: sid('registry-1') })], done: false })
    // The complete listing covers the registry row too: it must not repeat.
    gate.resolve([header('registry-1', 500), header('cold-1', 100)])
    const rest: SessionListPage[] = []
    for await (const page of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<SessionListPage>) rest.push(page)
    expect(rest.at(-1)?.done).toBe(true)
    const rows = [first.value, ...rest].flatMap(page => [...page.items])
    expect(rows.filter(row => row.sessionId === sid('registry-1'))).toHaveLength(1)
    expect(rows.map(row => row.sessionId)).toContain(sid('cold-1'))
  })

  it('pages a provisional catalog larger than the page size before the snapshot read', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const registryIds = Array.from(
      { length: SESSION_LIST_PAGE_SIZE + 5 },
      (_, index) => sid(`registry-${String(index)}`),
    )
    const gate = Promise.withResolvers<readonly SessionHeader[]>()
    provideRegistry(ctx, registryIds, [sid('registry-archived')])
    providePersistence(ctx, {
      list: () => gate.promise,
      stat: async (id: SessionId) => ({
        header: header(id, 500),
        revision: 'test:stat' as never,
      }),
    })
    const remote = remoteFor(ctx)
    const iterator = remote.list(new AbortController().signal)[Symbol.asyncIterator]()

    const first = await iterator.next()
    if (first.done === true) throw new Error('the stream closed inside its provisional pages')
    expect(first.value).toMatchObject({ done: false })
    expect(first.value.items).toHaveLength(SESSION_LIST_PAGE_SIZE)
    const second = await iterator.next()
    if (second.done === true) throw new Error('the stream closed before the provisional tail page')
    expect(second.value).toMatchObject({ done: false })
    const provisional = [...first.value.items, ...second.value.items].map(item => item.sessionId)
    expect(provisional).toHaveLength(SESSION_LIST_PAGE_SIZE + 6)
    expect(new Set(provisional).size).toBe(SESSION_LIST_PAGE_SIZE + 6)
    expect(provisional).toContain(sid('registry-archived'))

    gate.resolve([
      ...registryIds.map(id => header(String(id), 500)),
      header('registry-archived', 500),
      header('cold-late', 400),
    ])
    const rest: SessionListPage[] = []
    for await (const page of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<SessionListPage>) rest.push(page)
    expect(rest.at(-1)?.done).toBe(true)
    const snapshotIds = rest.flatMap(page => page.items.map(item => item.sessionId))
    expect(snapshotIds).not.toContain(sid('registry-0'))
    expect(snapshotIds).toContain(sid('cold-late'))
  })

  it('re-reads a snapshot-listed Session that went live after the provisional capture', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const gate = Promise.withResolvers<readonly SessionHeader[]>()
    providePersistence(ctx, { list: () => gate.promise })
    ctx.provide('agents', { get: () => undefined, list: () => [] } as never)
    const remote = remoteFor(ctx)
    const iterator = remote.list(new AbortController().signal)[Symbol.asyncIterator]()

    // Nothing is live or registered yet, so the generator is suspended inside
    // the snapshot read; the Session opens and moves after that capture point.
    const pending = iterator.next()
    const live = ctx.sessions.create(sid('went-live'), { meta: header('went-live', 100) })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'moved' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    gate.resolve([header('went-live', 100), header('cold-1', 50)])

    const pages: SessionListPage[] = []
    const first = await pending
    pages.push(first.value as SessionListPage)
    for await (const page of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<SessionListPage>) pages.push(page)
    expect(pages.at(-1)?.done).toBe(true)
    const rows = pages.flatMap(page => [...page.items])
    expect(rows.map(row => row.sessionId)).toEqual([sid('went-live'), sid('cold-1')])
    // The row carries the live Session's current activity, not the snapshot
    // record's captured header time.
    expect(rows[0]?.updatedAt).toBeGreaterThan(100)
    expect(rows[1]?.updatedAt).toBe(50)
  })

  it('ends with the completion frame after pages bounded by the page size', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    providePersistence(ctx, { list: () => Promise.resolve(headers(SESSION_LIST_PAGE_SIZE * 2 + 10)) })
    const remote = remoteFor(ctx)

    const pages = await collectSessionListPages(remote.list(new AbortController().signal))

    expect(pages.map(page => page.items.length)).toEqual([SESSION_LIST_PAGE_SIZE, SESSION_LIST_PAGE_SIZE, 10])
    expect(pages.slice(0, -1).every(page => !page.done)).toBe(true)
    expect(pages.at(-1)?.done).toBe(true)
    const ids = pages.flatMap(page => page.items.map(item => item.sessionId))
    expect(ids[0]).toBe('cold-509')
    expect(ids.at(-1)).toBe('cold-0')
    expect(pages.at(-1)?.items.map(item => item.sessionId)).toEqual(
      ['cold-9', 'cold-8', 'cold-7', 'cold-6', 'cold-5', 'cold-4', 'cold-3', 'cold-2', 'cold-1', 'cold-0'],
    )
  })

  it('closes a suspended stream while the listing read is still in flight', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const gate = Promise.withResolvers<readonly SessionHeader[]>()
    provideRegistry(ctx, [sid('registry-1')])
    providePersistence(ctx, {
      list: () => gate.promise,
      stat: async (id: SessionId) => ({
        header: header(id, 500),
        revision: 'test:stat' as never,
      }),
    })
    const remote = remoteFor(ctx)

    const iterator = remote.list(new AbortController().signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toMatchObject({ done: false })

    const returned = await iterator.return?.()
    expect(returned?.done).toBe(true)
    gate.resolve([])
  })

  it('refuses an already-aborted signal before reading anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const listing = vi.fn((): Promise<readonly SessionHeader[]> => Promise.resolve([]))
    providePersistence(ctx, { list: listing })
    const remote = remoteFor(ctx)
    const controller = new AbortController()
    controller.abort()

    // A rejected read proves the abort fired before the generator awaited any
    // persistence listing; the shared snapshot's own boot read is unrelated.
    await expect(collectSessionListPages(remote.list(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('completes a snapshot-only listing where no Workspace registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    providePersistence(ctx, { list: () => Promise.resolve(headers(3)) })
    new ListingStreamQuery(ctx)
    const list = new ApiSessionList(ctx)

    const pages: SessionListPage[] = []
    for await (const page of list.stream(new AbortController().signal)) pages.push(page)

    expect(pages.at(-1)?.done).toBe(true)
    expect(pages.flatMap(page => [...page.items]).map(item => item.sessionId))
      .toEqual(['cold-2', 'cold-1', 'cold-0'])
  })

  it('gives a registry member whose artifact is gone no row and still completes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    provideRegistry(ctx, [sid('gone-1')])
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      stat: async () => undefined,
    })
    const remote = remoteFor(ctx)

    const pages = await collectSessionListPages(remote.list(new AbortController().signal))

    expect(pages).toEqual([{ items: [], done: true }])
  })
})
