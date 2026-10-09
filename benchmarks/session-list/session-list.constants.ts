/** Fixed synthetic workload and reference budgets for the streamed Session listing. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Cold Sessions in the corpus, matching a heavily used multi-Workspace deployment. */
export const SESSION_COUNT = 200
/** Corpus Sessions accounted by the one synthetic Workspace (registry rows). */
export const ACCOUNTED_SESSION_COUNT = 20
/** Process identifier prefix; every id is deterministic, so reports compare directly. */
export const SYNTHETIC_SESSION_PREFIX = 'synth-session-'
/** Fresh worker processes per scenario; the median enforces each timing budget. */
export const ATTEMPTS = 5
/** A stuck worker is reaped well before the outer test deadline. */
export const WORKER_TIMEOUT_MS = 60_000

/** Deterministic corpus ids in creation order. */
export function syntheticSessionIds(count: number = SESSION_COUNT): SessionId[] {
  return Array.from({ length: count }, (_, index) => `${SYNTHETIC_SESSION_PREFIX}${String(index)}` as SessionId)
}

/** The ids the synthetic Workspace accounts for; the rest surface only through the snapshot pass. */
export function accountedSessionIds(): SessionId[] {
  return syntheticSessionIds(ACCOUNTED_SESSION_COUNT)
}

/** Expected durations on the reference machine before CI scaling and variance headroom. */
export const EXPECTED_MS = {
  /** Warm streamed listing completion frame after the shared snapshot exists. */
  warmDone: 80,
  /** Warm first provisional frame, the sidebar's first-row paint boundary. */
  warmFirstFrame: 75,
} as const
