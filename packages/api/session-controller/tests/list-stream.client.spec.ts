/**
 * The streamed `session.list` pull inside SessionManager: the completion frame
 * as the only authority for the arrival phase, superseded-generation stream
 * cancellation, page-boundary mutation replay, and provisional-row survival.
 */

import { describe, expect, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type ClientTestFixtures, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-session-title/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import type { SessionListPage } from '../src/types.ts'
import {
  listStream, listStreamDeferred, listStreamPages, listStreamStaged,
} from './list-stream.client.ts'
import { sessionWorld } from './remote/session.client.ts'

const S1 = 'fk-ls1' as SessionId
const S2 = 'fk-ls2' as SessionId
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })

function summary(sessionId: SessionId, over: Partial<{ updatedAt: number; running: boolean; blank: boolean }> = {}) {
  return { agentAvailable: true, sessionId, updatedAt: 100, running: false, blank: false, ...over }
}

function makeManager(mock: RemoteMock, remote: ClientTestFixtures['remote']): SessionManager {
  mock.load(sessionWorld)
  // Cases using this helper never open a Session, so they do not need the broader Client Remote's $stream member.
  return new SessionManager(remote as unknown as SessionRemotes)
}

function rowIds(manager: SessionManager): SessionId[] {
  return manager.getListSnapshot().items.map(item => item.sessionId)
}

describe('SessionManager list stream', () => {
  it('advances the arrival phase through streaming and never leaves ready', async ({ mock, remote }) => {
    const pages = Promise.withResolvers<readonly SessionListPage[]>()
    remote.session.list.mockReturnValueOnce(listStreamDeferred(pages.promise))
    const manager = makeManager(mock, remote)
    const refreshing = manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'loading', phase: 'pending' })
    pages.resolve([{ items: [summary(S1)], done: false }, { items: [summary(S2)], done: true }])
    await refreshing
    expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
    expect(rowIds(manager)).toEqual([S1, S2])
    remote.session.list.mockReturnValueOnce(listStream([]))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
    expect(manager.getListSnapshot().items).toEqual([])
  })

  it('holds an ended-but-unfinished stream out of ready and reports the missing completion frame', async ({ mock, remote }) => {
    remote.session.list.mockReturnValueOnce(listStreamPages([{ items: [summary(S1)], done: false }]))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({
      state: 'error',
      phase: 'streaming',
      error: { code: 'gateway/internal', message: 'session list stream ended without its completion frame' },
    })
    // Provisional rows stay readable while the catalog is known-incomplete.
    expect(rowIds(manager)).toEqual([S1])
  })

  it('keeps a row named only by a provisional frame in the completed catalog', async ({ mock, remote }) => {
    remote.session.list.mockReturnValueOnce(listStreamPages([
      { items: [summary(S1)], done: false },
      { items: [], done: true },
    ]))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    expect(manager.getListSnapshot().phase).toBe('ready')
    expect(rowIds(manager)).toEqual([S1])
  })

  it('carries established rows across provisional frames and drops them only on the complete catalog', async ({ mock, remote }) => {
    remote.session.list.mockReturnValueOnce(listStream([summary(S1)]))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    expect(rowIds(manager)).toEqual([S1])

    const gate = Promise.withResolvers<undefined>()
    remote.session.list.mockReturnValueOnce(listStreamStaged(
      [{ items: [summary(S2)], done: false }],
      gate.promise,
      [{ items: [summary(S2)], done: true }],
    ))
    const refreshing = manager.refreshList()
    // The provisional page adds S2 without dropping the established S1, and
    // the already-complete catalog keeps its 'ready' arrival phase.
    await vi.waitFor(() => {
      expect(rowIds(manager)).toEqual([S1, S2])
      expect(manager.getListSnapshot()).toMatchObject({ state: 'loading', phase: 'ready' })
    })
    gate.resolve(undefined)
    await refreshing
    expect(manager.getListSnapshot().phase).toBe('ready')
    expect(rowIds(manager)).toEqual([S2])
  })

  it('replays a mutation recorded across the page boundary over the completed rows', async ({ mock, remote }) => {
    const gate = Promise.withResolvers<undefined>()
    remote.session.list.mockReturnValueOnce(listStreamStaged(
      [{ items: [summary(S1, { running: false })], done: false }],
      gate.promise,
      [{ items: [summary(S1, { running: false }), summary(S2, { blank: true })], done: true }],
    ))
    const manager = makeManager(mock, remote)
    const refreshing = manager.refreshList()
    await vi.waitFor(() => {
      expect(manager.getListSnapshot().items.find(item => item.sessionId === S1)).toMatchObject({ running: false })
    })
    manager.handleSessionStatus(S1, true)
    gate.resolve(undefined)
    await refreshing
    const row = manager.getListSnapshot().items.find(item => item.sessionId === S1)
    expect(row).toMatchObject({ running: true })
    expect(rowIds(manager)).toEqual([S1, S2])
  })

  it('cancels the superseded stream signal when a new Host generation pulls', async ({ mock, remote }) => {
    const superseded = Promise.withResolvers<readonly SessionListPage[]>()
    const signals: (AbortSignal | undefined)[] = []
    let pull = 0
    remote.session.list.mockImplementation((signal?: AbortSignal) => {
      signals.push(signal)
      return pull++ === 0
        ? listStreamDeferred(superseded.promise)
        : listStreamPages([{ items: [summary(S2)], done: true }])
    })
    const manager = makeManager(mock, remote)
    const supersededPull = manager.refreshList()
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1)
    })
    manager.handleConnected()
    expect(signals[0]?.aborted).toBe(true)
    superseded.reject(new RemoteError('gateway/internal', 'carrier closed with the generation', {}))
    await supersededPull
    await vi.waitFor(() => {
      expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
    })
    expect(rowIds(manager)).toEqual([S2])
  })

  it('keeps an errored pull from overriding a completed catalog', async ({ mock, remote }) => {
    remote.session.list.mockReturnValueOnce(listStream([summary(S1)]))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    remote.session.list.mockReturnValueOnce(listStreamPages([]))
    await manager.refreshList()
    const snapshot = manager.getListSnapshot()
    expect(snapshot).toMatchObject({ state: 'error', phase: 'ready' })
    expect(rowIds(manager)).toEqual([S1])
  })
})
