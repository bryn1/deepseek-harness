/**
 * The service-wide `flush()` barrier against handles whose close is in
 * flight: the barrier must join an in-flight `close()` through its release
 * step, aggregate a closing handle's failure, and settle a close whose drain
 * gains a publisher mid-pass. The window is real close-tail time: an
 * unmaterialized handle that kept its write lease (materialization refused
 * after the lease was taken) keeps `close()` in flight — the filesystem-bound
 * lease release — across the barrier's pre-fix resolution point.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlSessionHandle } from '../src/storage.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const temporaryRoots: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-flush-barrier-'))
  temporaryRoots.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of temporaryRoots.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function mounted(): Promise<{ ctx: Context; service: JsonlSessionPersistence; root: string }> {
  const root = await freshRoot()
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, service: ctx.sessionPersistence as JsonlSessionPersistence, root }
}

/**
 * A created-never-materialized write handle that still holds its lease:
 * `flush()` acquires the lease, then a refused materialization leaves the
 * session unmaterialized with the lease retained (the documented
 * retained-across-retry state). The retained lease's release inside `close()`
 * is filesystem-bound, so close stays in flight while the barrier sweeps.
 */
async function blankLeaseHoldingHandle(
  service: JsonlSessionPersistence,
  header: SessionHeader,
  options: { refuseRelease?: boolean } = {},
): Promise<SessionHandle> {
  const acquire = service.acquireWriteLease.bind(service)
  vi.spyOn(service, 'acquireWriteLease').mockImplementation(async (leaseHeader) => {
    const lease = await acquire(leaseHeader)
    if (options.refuseRelease !== true) return lease
    const release = lease.release.bind(lease)
    lease.release = async () => {
      await release()
      throw new Error('test lease release refusal')
    }
    return lease
  })
  const writer = await service.create(header)
  const refusal = new Error('test materialization refusal')
  vi.spyOn(service, 'persistHeader').mockRejectedValueOnce(refusal)
  await expect(writer.flush()).rejects.toBe(refusal)
  // The wrapped lease object carries its own release failure; restoring the
  // service methods cannot unwrap the retained lease the close will call.
  vi.restoreAllMocks()
  return writer
}

describe('service flush barrier against in-flight closes', () => {
  it('resolves only after a closing handle settles through its release step', async () => {
    const { ctx, service, root } = await mounted()
    const header = meta('closing-handle', root)
    const writer = await blankLeaseHoldingHandle(service, header)

    const order: string[] = []
    const closing = writer.close().then(
      () => { order.push('close') },
      () => { order.push('close-failed') },
    )
    const barrier = service.flush().then(
      () => { order.push('barrier') },
      () => { order.push('barrier-failed') },
    )
    await Promise.all([closing, barrier])

    // The pre-fix barrier counted a closing handle as already flushed and
    // resolved before its release; the fixed barrier joins the in-flight close.
    expect(order).toEqual(['close', 'barrier'])
    expect(service.hasPendingSession(header.id)).toBe(false)
    // The tracker released the writers claim: the id can be created again.
    const again = await service.create(header)
    await again.close()
    await ctx.fiber.dispose()
  })

  it('aggregates a closing handle failure instead of resolving clean', async () => {
    const { ctx, service, root } = await mounted()
    const header = meta('failing-close', root)
    const writer = await blankLeaseHoldingHandle(service, header, { refuseRelease: true })

    const closing = writer.close()
    const barrierFailure = await service.flush().then(
      () => undefined,
      (error: unknown) => error,
    )
    // The pre-fix barrier dropped the closing handle's failure (catch-continue)
    // and resolved clean; the fixed barrier joins the close and aggregates.
    expect(barrierFailure).toBeInstanceOf(AggregateError)
    const aggregated = (barrierFailure as AggregateError).errors
      .map(error => String(error))
      .join('\n')
    expect(aggregated).toContain('test lease release refusal')
    await expect(closing).rejects.toThrow('test lease release refusal')
    expect(service.hasPendingSession(header.id)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('settles a publisher that routes an event while close drains', async () => {
    const { ctx, service, root } = await mounted()
    const header = meta('late-publisher', root)
    const created = await service.create(header)
    const writer = created as JsonlSessionHandle
    const [turnStart, userMessage, stepStart] = oneTurnLog()
    await writer.append([turnStart!])

    // Publishing inside the first drain persist lands a routed event after the
    // drain loop passed its first emptiness check, forcing the multi-pass
    // drain close performs before it releases.
    const persistBatch = service.persistBatch.bind(service)
    let routed = false
    vi.spyOn(service, 'persistBatch').mockImplementation(async (...args) => {
      await persistBatch(...args)
      if (!routed) {
        routed = true
        writer.enqueueLive(stepStart!, () => {})
      }
    })
    writer.enqueueLive(userMessage!, () => {})

    const order: string[] = []
    const closing = writer.close().then(
      () => { order.push('close') },
      () => { order.push('close-failed') },
    )
    const barrier = service.flush().then(
      () => { order.push('barrier') },
      () => { order.push('barrier-failed') },
    )
    await Promise.all([closing, barrier])
    expect(order).toEqual(['close', 'barrier'])
    expect(routed).toBe(true)

    const reader = await service.open(header.id, 'read')
    const stored = await reader.read()
    await reader.close()
    expect(stored.events.map(event => event.seq)).toEqual([SessionSeq(0), SessionSeq(1), SessionSeq(2)])
    await ctx.fiber.dispose()
  })
})
