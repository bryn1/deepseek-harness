/**
 * Warm-prefix compaction backend: basic's transaction with a full-surface
 * first summarization attempt on cache-reporting routes.
 *
 * @module @deepseek-ai/dsh-compaction-warm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { baseConfigSchema, BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: makes the token meter's Context merge visible on `ctx.tokenMeter`.
import type {} from '@deepseek-ai/dsh-token-meter'
import { resolveWarmConfig } from './config.ts'
import { buildFullSurfaceInput } from './warm-replay.ts'
import type { FullSurfaceReplay, ResolvedWarmFields, WarmCompactionConfig } from './types.ts'

export type { WarmCompactionConfig, ResolvedWarmFields } from './types.ts'

/**
 * Conservative token reserve for the frozen compaction instruction the base
 * appends after the replayed prefix. That instruction is pinned stable
 * model-visible text, so a fixed upper-bound reserve prices the warm request
 * without forking its source; an attempt that still overflows fails inside
 * the call and degrades to the head replay.
 */
const INSTRUCTION_TOKEN_RESERVE = 512

/** Reasons the warm attempt is refused before any model call is issued. */
type WarmRefusalReason =
  | 'disabled'
  | 'provider_not_allowed'
  | 'no_routed_request'
  | 'reported_cache_zero'
  | 'capacity'
  | 'unbalanced_live_tail'

/** Resolve the provider/model the warm attempt targets, as the base resolver will. */
function warmTarget(
  config: { readonly summarizationProvider: string; readonly summarizationModel: string },
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  if (config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const header = session.requestHeader()?.config
  if (header === undefined || header.provider.length === 0 || header.model.length === 0) {
    return undefined
  }
  return { provider: header.provider, model: header.model }
}

/** Whether the most recent reported usage on the durable surface shows prefix-cache reads. */
function reportedCacheRead(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-deprecated, typescript/no-non-null-assertion -- every log index below the current seq exists.
    const event = session.eventAt(SessionSeq(seq))!
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    return (usage.cacheReadTokens ?? 0) > 0
  }
  return false
}

/**
 * Basic's maintained backend with a warm first attempt: the one-shot
 * summarization call replays the entire current conversation surface instead
 * of only the shadowed region, so the provider's prefix cache is reused for
 * the whole live conversation rather than just its compacted head.
 *
 * The replay choice is durable: a successful warm attempt records
 * `replayScope: 'full-surface'` and its `replayBoundarySeq` on the
 * `compaction/summary` event; every other outcome (refusal, failed warm
 * call, cancellation-free degrade) leaves basic's shadowed-head default in
 * place. Pressure, retention, the bracket transaction, stability checks,
 * shrink validation, and waterfall recovery stay on the base. Load this
 * backend in place of `dsh-compaction-basic`, never beside it.
 */
export class WarmCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions']

  static override Config: z<WarmCompactionConfig> = z.intersect([
    baseConfigSchema,
    z.object({
      warm: z.boolean(),
      warmProviders: z.string(),
      warmRequireReportedCache: z.boolean(),
    }),
  ])

  private readonly warmFields: ResolvedWarmFields

  /**
   * Create the warm backend.
   * @param ctx - plugin context providing the LLM, token meter, and session services.
   * @param config - warm configuration; base fields pass through to basic's own validation.
   */
  constructor(ctx: Context, config: WarmCompactionConfig = {}) {
    const { base, warm } = resolveWarmConfig(config)
    super(ctx, base)
    this.warmFields = warm
  }

  /**
   * Attempt one full-surface warm replay, then fall back to basic's shadowed
   * head replay. Refusals issue no warm call; a failed warm call is retried
   * once through the head input on the same lane. Cancellation rethrows the
   * exact abort reason without a retry.
   * @param input - basic's replayed shadowed-region prefix from the caller.
   * @param agent - agent whose session supplies the live surface and routing.
   * @param signal - cancellation forwarded to both attempts.
   * @returns the summary result of whichever attempt succeeded, carrying the
   * replay fields only when the warm attempt itself succeeded.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const replay = await this.warmReplay(agent, signal)
    if (replay !== undefined) {
      try {
        const result = await super.summarize(replay.input, agent, signal)
        this.ctx.logger.info('compaction-warm: path=warm reason=accepted')
        return { ...result, replayScope: 'full-surface', replayBoundarySeq: replay.boundarySeq }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        // Every failure reaching here is an Error from the LLM layer (the
        // base's summarizer throws typed `LlmError` for transport, cap, and
        // content failures); the refusal path above never reaches a call.
        this.ctx.logger.info(`compaction-warm: path=degraded reason=summary_failed:${(error as Error).name}`)
      }
    }
    return super.summarize(input, agent, signal)
  }

  /**
   * Build the warm attempt's input, or return `undefined` after logging the
   * refusal reason. Gates check configuration, route, reported cache,
   * capacity, and the live tail in that order; none of them issues a call.
   * @param agent - agent whose session and resolved config the gates read.
   * @param signal - cancellation forwarded to capacity resolution.
   * @returns the replay input and boundary when the attempt should proceed.
   */
  private async warmReplay(
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<FullSurfaceReplay | undefined> {
    const { ctx } = this
    if (!this.warmFields.warm) {
      this.refuse('disabled')
      return undefined
    }
    const target = warmTarget(this.config, agent.session)
    if (target === undefined) {
      this.refuse('no_routed_request')
      return undefined
    }
    if (this.warmFields.warmProviders.length > 0
      && !this.warmFields.warmProviders.includes(target.provider.toLowerCase())) {
      this.refuse('provider_not_allowed')
      return undefined
    }
    if (this.warmFields.warmRequireReportedCache && !reportedCacheRead(agent.session)) {
      this.refuse('reported_cache_zero')
      return undefined
    }
    let contextWindow: number | undefined
    try {
      contextWindow = (await ctx.llm.resolveModelInfo(target.provider, target.model, signal))
        .context?.contextWindow
    } catch {
      // The adapter's failure text would only repeat this refusal; the head replay decides.
      this.refuse('no_routed_request')
      return undefined
    }
    if (contextWindow === undefined) {
      this.refuse('capacity')
      return undefined
    }
    const priced = ctx.tokenMeter.measure(agent.session).totalTokens
      + this.config.maxTokens + INSTRUCTION_TOKEN_RESERVE
    if (priced >= contextWindow) {
      this.refuse('capacity')
      return undefined
    }
    const replay = buildFullSurfaceInput(agent.session)
    if (replay === null) {
      this.refuse('unbalanced_live_tail')
      return undefined
    }
    return replay
  }

  /** Record one pre-call warm refusal at the same visibility as basic's result log. */
  private refuse(reason: WarmRefusalReason): void {
    this.ctx.logger.info(`compaction-warm: path=refused reason=${reason}`)
  }
}

export default WarmCompactionEngine
