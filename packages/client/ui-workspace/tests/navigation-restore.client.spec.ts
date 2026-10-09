/**
 * Startup restoration across the widened Session-list phase axis.
 * `streaming` carries provisional rows from the first page of the streamed
 * catalog; only the `done` frame's `ready` phase states a complete catalog,
 * so every restoration decision — saved-Session, blank reuse, or default
 * Workspace — must stay closed until then.
 */

import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ISessions, SessionListState, SessionReference, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { UiWorkspaceService } from '../src/client/navigation.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import type { RowToast } from '../src/client/contract/slots.ts'

const sid = (id: string): SessionId => SessionId(id)
const wid = (id: string) => id as WorkspaceId

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Seed the persisted main selection the service restores through its store. */
function persistSelection(selection: { readonly sessionId?: SessionId; readonly subagentAddress?: SubagentAddress }): void {
  const backing = new Map([['dsh.sessions.current', JSON.stringify(selection)]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  })
}

function workspace(id: string, sessionIds: readonly SessionId[] = []): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function summary(id: string, updatedAt = 0): SessionSummary {
  return { id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, retainedBy: {} }
}

function sessionState(
  summaries: readonly SessionSummary[],
  phase: SessionListState['phase'],
): SessionListState {
  return {
    ids: summaries.map(item => item.id),
    byId: Object.fromEntries(summaries.map(item => [item.id, item])),
    phase,
    projectionsBySession: {},
  }
}

function workspaceState(items: readonly WorkspaceView[], phase: WorkspaceSnapshot['phase']): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    phase,
    state: phase === 'ready' ? 'idle' : 'loading',
    error: null,
  }
}

class MutableSource<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeSessions implements ISessions {
  readonly list: MutableSource<SessionListState>
  readonly create = vi.fn<ISessions['create']>(async options =>
    options?.sessionId ?? sid(`created-${String(options?.workspaceId ?? 'none')}`))
  readonly retain = vi.fn<ISessions['retain']>((target) => {
    const sessionId = typeof target === 'string' ? target : target.childSessionId
    const binding = { sessionId } as SessionReference['binding']
    const release = vi.fn<() => void>()
    return { sessionId, binding, ready: Promise.resolve(binding), release, [Symbol.dispose]: release }
  })
  readonly subagentAddress = vi.fn<ISessions['subagentAddress']>(() => undefined)
  declare readonly using: ISessions['using']
  declare readonly fork: ISessions['fork']
  declare readonly retainInfo: ISessions['retainInfo']
  declare readonly searchResultLimit: ISessions['searchResultLimit']
  declare readonly refresh: ISessions['refresh']
  declare readonly refreshProjections: ISessions['refreshProjections']
  declare readonly search: ISessions['search']
  declare readonly scope: ISessions['scope']
  declare readonly scopeOf: ISessions['scopeOf']
  declare readonly sessionOf: ISessions['sessionOf']
  declare readonly binding: ISessions['binding']

  constructor(initial: SessionListState) {
    this.list = new MutableSource(initial)
  }
}

class FakeWorkspaces implements IWorkspaces {
  readonly list: MutableSource<WorkspaceSnapshot>
  readonly initializeDefault = vi.fn<IWorkspaces['initializeDefault']>(async () => undefined)
  declare readonly create: IWorkspaces['create']
  declare readonly rename: IWorkspaces['rename']
  declare readonly delete: IWorkspaces['delete']
  declare readonly archiveSession: IWorkspaces['archiveSession']
  declare readonly unarchiveSession: IWorkspaces['unarchiveSession']
  declare readonly pinSession: IWorkspaces['pinSession']
  declare readonly unpinSession: IWorkspaces['unpinSession']
  declare readonly insertBefore: IWorkspaces['insertBefore']
  declare readonly insertSessionBefore: IWorkspaces['insertSessionBefore']

  constructor(initial: WorkspaceSnapshot) {
    this.list = new MutableSource(initial)
  }
}

function bench(options: {
  readonly workspaces?: WorkspaceSnapshot
  readonly sessions?: SessionListState
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const layout = new LayoutController({
    selectPanel: vi.fn(), retainMainPanels: vi.fn(),
    setSidebar: vi.fn(), toggleSidebar: vi.fn(), setViewportWidth: vi.fn(),
    setRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
  }, () => true)
  ctx.provide('layout', layout)
  ctx.effect(() => () => { layout.dispose() })
  const workspaces = new FakeWorkspaces(options.workspaces ?? workspaceState([], 'pending'))
  const sessions = new FakeSessions(options.sessions ?? sessionState([], 'pending'))
  const view = createWorkspaceViewStore().create()
  const notify = vi.fn<(toast: RowToast) => void>()
  const uiWorkspace = new UiWorkspaceService(
    ctx,
    {} as ClientRemote['directoryPicker'],
    workspaces,
    sessions,
    view.actions,
    notify,
  )
  return { uiWorkspace, sessions, workspaces }
}

describe('startup restoration across the widened phase axis', () => {
  it('restores nothing while the Session catalog only streams provisional pages', async () => {
    persistSelection({ sessionId: sid('saved') })
    const b = bench({
      workspaces: workspaceState([workspace('w1', [sid('saved')])], 'ready'),
      // The first page arrived and named the saved row; the catalog is not complete.
      sessions: sessionState([summary('saved')], 'streaming'),
    })
    await setImmediate()
    expect(b.sessions.retain).not.toHaveBeenCalled()
    expect(b.sessions.create).not.toHaveBeenCalled()

    b.sessions.list.set(sessionState([summary('saved')], 'ready'))
    await vi.waitFor(() => { expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('saved'), { source: 'mainView' }) })
  })

  it('default-initializes only after the completion frame, never on an empty provisional page', async () => {
    persistSelection({ sessionId: sid('saved') })
    const b = bench({
      workspaces: workspaceState([workspace('w1')], 'ready'),
      sessions: sessionState([], 'streaming'),
    })
    await setImmediate()
    expect(b.sessions.create).not.toHaveBeenCalled()
    expect(b.sessions.retain).not.toHaveBeenCalled()
    expect(b.workspaces.initializeDefault).not.toHaveBeenCalled()

    // The done frame proves the Workspace lost its Sessions: only now the
    // restore path may reuse-or-create through Workspace w1.
    b.sessions.list.set(sessionState([], 'ready'))
    // The retain follows the create resolution, so both settle together.
    await vi.waitFor(() => {
      expect(b.sessions.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: wid('w1') })
      expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('created-w1'), { source: 'mainView' })
    })
  })

  it('restores the saved Session rather than the newest row once ready', async () => {
    persistSelection({ sessionId: sid('saved') })
    const b = bench({
      workspaces: workspaceState([workspace('w1', [sid('saved'), sid('fresh')])], 'ready'),
      sessions: sessionState([summary('fresh', 100), summary('saved')], 'ready'),
    })
    await vi.waitFor(() => { expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('saved'), { source: 'mainView' }) })
  })

  it('keeps pending Sessions closed even after the Workspace baseline turns ready', async () => {
    persistSelection({ sessionId: sid('saved') })
    const b = bench({
      workspaces: workspaceState([workspace('w1', [sid('saved')])], 'ready'),
      sessions: sessionState([summary('saved')], 'pending'),
    })
    await setImmediate()
    expect(b.sessions.retain).not.toHaveBeenCalled()

    b.sessions.list.set(sessionState([summary('saved')], 'ready'))
    await vi.waitFor(() => { expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(sid('saved'), { source: 'mainView' }) })
  })

  it('restores a persisted subagent address only from the completion frame onward', async () => {
    const address: SubagentAddress = {
      parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'continuable',
    }
    persistSelection({ sessionId: sid('child'), subagentAddress: address })
    const b = bench({
      workspaces: workspaceState([workspace('w1', [sid('child')])], 'ready'),
      sessions: sessionState([], 'streaming'),
    })
    await setImmediate()
    expect(b.sessions.retain).not.toHaveBeenCalled()

    b.sessions.list.set(sessionState([], 'ready'))
    await vi.waitFor(() => { expect(b.sessions.retain).toHaveBeenCalledExactlyOnceWith(address, { source: 'mainView' }) })
  })
})
