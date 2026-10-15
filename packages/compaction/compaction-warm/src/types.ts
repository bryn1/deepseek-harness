/**
 * Configuration vocabulary for the warm-prefix compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-warm/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { BasicCompactionConfig, SummarizationInput } from '@deepseek-ai/dsh-compaction-basic'

/** Warm backend configuration: every basic field plus the warm-replay policy keys. */
export interface WarmCompactionConfig extends BasicCompactionConfig {
  /** Attempt full-surface warm replays; `false` reproduces basic exactly for comparison runs. Defaults to `true`. */
  warm?: boolean
  /** Case-insensitive comma list of provider routes allowed the full-prompt replay; empty allows every provider. Defaults to `''`. */
  warmProviders?: string
  /** Require the last routed assistant response to report `cacheReadTokens > 0` before attempting warm. Defaults to `false`. */
  warmRequireReportedCache?: boolean
}

/** Validated immutable warm policy fields after load-time resolution. */
export type ResolvedWarmFields = {
  readonly warm: boolean
  readonly warmProviders: readonly string[]
  readonly warmRequireReportedCache: boolean
}

/** One built full-surface replay: the model-visible input and its durable anchor. */
export type FullSurfaceReplay = {
  readonly input: SummarizationInput
  /** Seq of the last surface node the input includes; recorded as the summary event's `replayBoundarySeq`. */
  readonly boundarySeq: SessionSeq
}
