/** Required performance budgets for the streamed Session listing and its shared-snapshot dependency. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  runBuiltBenchmarkWorker,
  type BuiltBenchmarkWorkerRun,
} from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import type {
  SessionListBenchmarkScenario,
  SessionListDrainReport,
  SessionListWorkerReport,
} from './session-list.worker.ts'
import { writeSyntheticColdCorpus } from './session-list-corpus.ts'
import {
  ATTEMPTS,
  EXPECTED_MS,
  SESSION_COUNT,
  WORKER_TIMEOUT_MS,
} from './session-list.constants.ts'

const WARM_DONE_BUDGET_MS = ciTimeBudget(EXPECTED_MS.warmDone)
const WARM_FIRST_FRAME_BUDGET_MS = ciTimeBudget(EXPECTED_MS.warmFirstFrame)

const WORKER = join(import.meta.dirname, '..', '.dsh-build', 'session-list', 'session-list.worker.js')

type WorkerRun = BuiltBenchmarkWorkerRun<SessionListWorkerReport>

let corpusRoot: string

beforeAll(async () => {
  corpusRoot = await mkdtemp(join(tmpdir(), 'dsh-session-list-bench-'))
  await writeSyntheticColdCorpus(corpusRoot)
}, WORKER_TIMEOUT_MS)

afterAll(async () => {
  await rm(corpusRoot, { recursive: true, maxRetries: 3 })
})

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function requireReport(run: WorkerRun, scenario: SessionListBenchmarkScenario): SessionListWorkerReport {
  if (run.report === undefined) {
    throw new Error(`session-list ${scenario} worker failed (exit ${String(run.exitCode)}, `
      + `timedOut ${String(run.timedOut)}): ${run.stderr.slice(0, 2_000)}`)
  }
  return run.report
}

async function runScenario(scenario: SessionListBenchmarkScenario): Promise<SessionListWorkerReport> {
  const run = await runBuiltBenchmarkWorker<SessionListWorkerReport>({
    worker: WORKER,
    args: [corpusRoot, scenario],
    timeoutMs: WORKER_TIMEOUT_MS,
  })
  return requireReport(run, scenario)
}

function reportDrain(label: string, drain: SessionListDrainReport): string {
  return `${label}: first frame ${drain.firstFrameMs.toFixed(1)} ms, done `
    + `${drain.doneMs.toFixed(1)} ms, ${String(drain.pages)} pages, ${String(drain.rows)} rows`
}

describe('session list stream', () => {
  it('completes a warm streamed listing within the reviewed budget', async () => {
    const runs: SessionListWorkerReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) runs.push(await runScenario('stream'))
    const warm = runs.map(run => {
      if (run.warm === undefined) throw new Error('stream worker omitted the warm drain')
      return run.warm
    })
    for (const [index, drain] of warm.entries()) {
      console.log(`warm attempt ${String(index + 1)} ${reportDrain('streamed listing', drain)}`)
      expect(drain.rows).toBe(SESSION_COUNT)
      expect(drain.pages).toBeGreaterThanOrEqual(2)
    }
    expect(median(warm.map(drain => drain.doneMs))).toBeLessThanOrEqual(WARM_DONE_BUDGET_MS)
    expect(median(warm.map(drain => drain.firstFrameMs))).toBeLessThanOrEqual(WARM_FIRST_FRAME_BUDGET_MS)
  })

  it('reports the cold streamed listing shape', async () => {
    const runs: SessionListWorkerReport[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) runs.push(await runScenario('stream'))
    const cold = runs.map(run => {
      if (run.cold === undefined) throw new Error('stream worker omitted the cold drain')
      return run.cold
    })
    for (const [index, drain] of cold.entries()) {
      console.log(`cold attempt ${String(index + 1)} ${reportDrain('cold streamed listing', drain)}`)
      expect(drain.rows).toBe(SESSION_COUNT)
      expect(drain.pages).toBeGreaterThanOrEqual(2)
    }
    // The cold first frame still precedes the cold completion; it is reported,
    // not budgeted, because the corpus scan cost is workload-bound.
    expect(median(cold.map(drain => drain.firstFrameMs))).toBeLessThan(
      median(cold.map(drain => drain.doneMs)))
  })

  it('rejects per-request enumeration against the shared-snapshot warm cost (negative control)', async () => {
    const run = await runScenario('per-request')
    if (run.perRequest === undefined || run.warmFlat === undefined) {
      throw new Error('per-request worker omitted its drains')
    }
    for (const [index, drain] of run.perRequest.entries()) {
      console.log(`negative control ${String(index + 1)} ${reportDrain('fresh-host enumeration', drain)}`)
      expect(drain.rows).toBe(SESSION_COUNT)
    }
    for (const [index, drain] of run.warmFlat.entries()) {
      console.log(`negative control baseline ${String(index + 1)} ${reportDrain('shared-snapshot listing', drain)}`)
    }
    // A fresh Host re-enumerates the corpus for its only listing; the shared
    // snapshot keeps repeated warm listings flat. If snapshot sharing were
    // removed, the warm listings would pay the per-request cost and this
    // dimensionless ratio gate would fail on the same machine.
    const ratio = median(run.perRequest.map(drain => drain.doneMs))
      / median(run.warmFlat.map(drain => drain.doneMs))
    console.log(`negative control ratio: ${ratio.toFixed(1)}x`)
    expect(ratio).toBeGreaterThanOrEqual(4)
  }, WORKER_TIMEOUT_MS * 4)
})
