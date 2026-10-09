/** Isolated worker for the streamed Session listing benchmark. */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine, {
  type SessionEventSearchPage, type SessionEventSearchRequest,
  type SessionSearchExecContext, type SessionSearchHit, type SessionSearchPage, type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
// This Host-only adapter has no public Node export and is compiled into the benchmark worker.
import { ApiSessionList } from '../../packages/api/session-controller/src/list.ts'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { accountedSessionIds } from './session-list.constants.ts'

/** Worker scenario selected by the parent benchmark. */
export type SessionListBenchmarkScenario = 'stream' | 'per-request'

/** One timed streamed listing. */
export interface SessionListDrainReport {
  readonly firstFrameMs: number
  readonly doneMs: number
  readonly pages: number
  readonly rows: number
}

/** JSON report emitted by one worker run. */
export interface SessionListWorkerReport {
  readonly scenario: SessionListBenchmarkScenario
  readonly cold?: SessionListDrainReport
  readonly warm?: SessionListDrainReport
  readonly perRequest?: readonly SessionListDrainReport[]
  readonly warmFlat?: readonly SessionListDrainReport[]
}

interface ListingHost {
  readonly ctx: Context
  readonly list: ApiSessionList
}

/** The listing benchmark never searches; the search half stays rejected. */
class ListingBenchmarkQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.reject(new Error('search is outside the Session listing benchmark'))
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('search is outside the Session listing benchmark'))
  }
}

async function mountListingHost(root: string, withRegistry: boolean): Promise<ListingHost> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  if (withRegistry) {
    // The one Workspace accounts for the first rows, exactly like the GUI's sidebar world.
    ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [{ workspaceId: 'synth-workspace', sessionIds: accountedSessionIds(), path: '/synthetic' }],
    get archivedSessionIds() {
      return []
    },
      get pinnedSessionIds() {
        return []
      },
    } as never)
  }
  new ListingBenchmarkQuery(ctx)
  const list = new ApiSessionList(ctx)
  return { ctx, list }
}

async function drainOnce(list: ApiSessionList): Promise<SessionListDrainReport> {
  const started = performance.now()
  const iterator = list.stream(new AbortController().signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  const firstFrameMs = performance.now() - started
  if (first.done === true) throw new Error('listing stream ended before its first frame')
  let pages = 1
  let rows = first.value.items.length
  let completed = first.value.done
  while (!completed) {
    const next = await iterator.next()
    if (next.done === true) throw new Error('listing stream ended without its completion frame')
    pages += 1
    rows += next.value.items.length
    completed = next.value.done
  }
  return { firstFrameMs, doneMs: performance.now() - started, pages, rows }
}

assertBuiltBenchmarkRuntime(import.meta.url, {
  '@deepseek-ai/dsh-session-persistence-jsonl': import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'),
  '@deepseek-ai/dsh-session-query': import.meta.resolve('@deepseek-ai/dsh-session-query'),
})

const [root, scenarioValue] = process.argv.slice(2)
const scenarios: readonly SessionListBenchmarkScenario[] = ['stream', 'per-request']
if (root === undefined || !scenarios.includes(scenarioValue as SessionListBenchmarkScenario)) {
  throw new Error('usage: session-list.worker.js <root> <stream|per-request>')
}
const scenario = scenarioValue as SessionListBenchmarkScenario

let report: SessionListWorkerReport
if (scenario === 'stream') {
  const host = await mountListingHost(root, true)
  try {
    report = { scenario, cold: await drainOnce(host.list), warm: await drainOnce(host.list) }
  } finally {
    await host.ctx.fiber.dispose()
  }
} else {
  // Negative control without the registry overlay, so both sides measure the
  // persisted enumeration alone: a fresh Host re-enumerates for its only
  // listing, while the shared snapshot keeps repeated warm listings flat.
  const perRequest: SessionListDrainReport[] = []
  let warmFlat: readonly SessionListDrainReport[] = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const host = await mountListingHost(root, false)
    try {
      perRequest.push(await drainOnce(host.list))
      if (attempt === 2) warmFlat = [await drainOnce(host.list), await drainOnce(host.list)]
    } finally {
      await host.ctx.fiber.dispose()
    }
  }
  report = { scenario, perRequest, warmFlat }
}
process.stdout.write(`${JSON.stringify(report)}\n`)
