import { describe, expect, it } from 'vitest'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { INSTRUCTION_HEAD, MODEL, TAIL_MARKER, replayedText, summaryEvent, warmHarness } from './harness.ts'

const SIGNAL = new AbortController().signal

describe('WarmCompactionEngine.summarize', () => {
  it('sends one warm full-surface call and records the replay fields on the durable event', async () => {
    const h = warmHarness()
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.adapter.calls).toBe(1)
    const warmRequest = replayedText(h.adapter.requests[0]!)
    expect(warmRequest).toContain(TAIL_MARKER)
    expect(warmRequest).toContain(INSTRUCTION_HEAD)
    expect(h.adapter.purposes[0]).toBe('compaction')
    expect(h.infos).toContain('compaction-warm: path=warm reason=accepted')
    const event = summaryEvent(h.session)
    expect(event.data.replayScope).toBe('full-surface')
    expect(event.data.replayBoundarySeq).toBe(h.boundarySeq)
    expect(event.data.provider).toBe(MODEL)
    expect('usage' in event.data).toBe(false)
  })

  it('reproduces basic exactly when warm is disabled', async () => {
    const h = warmHarness({ warm: false })
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=disabled')
    expect(h.adapter.calls).toBe(1)
    expect(replayedText(h.adapter.requests[0]!)).not.toContain(TAIL_MARKER)
    const event = summaryEvent(h.session)
    expect('replayScope' in event.data).toBe(false)
    expect('replayBoundarySeq' in event.data).toBe(false)
  })

  it('refuses providers outside the allowlist and honors the case-insensitive match', async () => {
    const refused = warmHarness({ warmProviders: 'other-provider' })
    await refused.engine.compactRegion(refused.firstSeq, refused.endSeq, refused.agent, SIGNAL)
    expect(refused.infos).toContain('compaction-warm: path=refused reason=provider_not_allowed')
    expect(refused.adapter.calls).toBe(1)
    expect(replayedText(refused.adapter.requests[0]!)).not.toContain(TAIL_MARKER)

    const allowed = warmHarness({ warmProviders: ` , ${MODEL.toUpperCase()} , ` })
    await allowed.engine.compactRegion(allowed.firstSeq, allowed.endSeq, allowed.agent, SIGNAL)
    expect(allowed.infos).toContain('compaction-warm: path=warm reason=accepted')
    const event = summaryEvent(allowed.session)
    expect(event.data.replayScope).toBe('full-surface')
    expect(event.data.replayBoundarySeq).toBe(allowed.boundarySeq)
  })

  it('refuses without a durable routed request', async () => {
    const h = warmHarness({}, { withHeader: false })
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=no_routed_request')
    expect(h.adapter.calls).toBe(1)
    expect(replayedText(h.adapter.requests[0]!)).not.toContain(TAIL_MARKER)
    expect('replayScope' in summaryEvent(h.session).data).toBe(false)
  })

  it('refuses a route the adapter cannot resolve', async () => {
    const h = warmHarness()
    h.adapter.failResolveOnce = true
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=no_routed_request')
    expect(h.adapter.calls).toBe(1)
    expect(replayedText(h.adapter.requests[0]!)).not.toContain(TAIL_MARKER)
  })

  it('refuses attempts priced at or above the routed context window', async () => {
    const h = warmHarness({ maxTokens: 99_000 })
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=capacity')
    expect(h.adapter.calls).toBe(1)
    expect(replayedText(h.adapter.requests[0]!)).not.toContain(TAIL_MARKER)
  })

  it('refuses when the adapter declares no capacity', async () => {
    const h = warmHarness()
    h.adapter.contextWindow = undefined
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=capacity')
    expect(h.adapter.calls).toBe(1)
  })

  it('requires a positive reported cache read only when configured', async () => {
    const zero = warmHarness(
      { warmRequireReportedCache: true },
      { turnUsage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 } },
    )
    await zero.engine.compactRegion(zero.firstSeq, zero.endSeq, zero.agent, SIGNAL)
    expect(zero.infos).toContain('compaction-warm: path=refused reason=reported_cache_zero')
    expect(replayedText(zero.adapter.requests[0]!)).not.toContain(TAIL_MARKER)

    const unknown = warmHarness({ warmRequireReportedCache: true })
    await unknown.engine.compactRegion(unknown.firstSeq, unknown.endSeq, unknown.agent, SIGNAL)
    expect(unknown.infos).toContain('compaction-warm: path=refused reason=reported_cache_zero')

    const positive = warmHarness(
      { warmRequireReportedCache: true },
      { turnUsage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 900 } },
    )
    await positive.engine.compactRegion(positive.firstSeq, positive.endSeq, positive.agent, SIGNAL)
    expect(positive.infos).toContain('compaction-warm: path=warm reason=accepted')
    expect(replayedText(positive.adapter.requests[0]!)).toContain(TAIL_MARKER)
  })

  it('refuses an open tool step at the live tail without issuing the warm call', async () => {
    const h = warmHarness()
    h.session.append('assistant/message', {
      stream: [],
      turn: 3,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-open-9'), name: 'probe', arguments: '{}' }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=unbalanced_live_tail')
    expect(h.adapter.calls).toBe(1)
    expect(replayedText(h.adapter.requests[0]!)).not.toContain(TAIL_MARKER)
    expect('replayScope' in summaryEvent(h.session).data).toBe(false)
  })

  it('degrades to the head replay once when the warm call fails, with no replay fields', async () => {
    const h = warmHarness()
    h.adapter.mode = 'fail-once'
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=degraded reason=summary_failed:LlmError')
    expect(h.adapter.calls).toBe(2)
    expect(replayedText(h.adapter.requests[0]!)).toContain(TAIL_MARKER)
    expect(replayedText(h.adapter.requests[1]!)).not.toContain(TAIL_MARKER)
    const event = summaryEvent(h.session)
    expect('replayScope' in event.data).toBe(false)
    expect('replayBoundarySeq' in event.data).toBe(false)
  })

  it('rethrows cancellation without a degrade retry', async () => {
    const h = warmHarness()
    h.adapter.mode = 'abort-once'
    await expect(h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, h.adapter.controller.signal))
      .rejects.toThrow('harness cancelled')
    expect(h.adapter.calls).toBe(1)
    expect(h.infos.some(line => line.includes('path=degraded'))).toBe(false)
  })

  it('prices usage onto the durable event when the provider reports it', async () => {
    const h = warmHarness({}, { turnUsage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 400 } })
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    const event = summaryEvent(h.session)
    expect(event.data.replayScope).toBe('full-surface')
  })

  it('routes the warm call through the configured summarization pair without a durable header', async () => {
    const h = warmHarness(
      { summarizationProvider: MODEL, summarizationModel: MODEL },
      { withHeader: false },
    )
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=warm reason=accepted')
    expect(replayedText(h.adapter.requests[0]!)).toContain(TAIL_MARKER)
    expect(summaryEvent(h.session).data.replayScope).toBe('full-surface')
  })

  it('degrades without a caller signal when the warm call fails', async () => {
    const h = warmHarness()
    h.adapter.mode = 'fail-once'
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent)
    expect(h.infos).toContain('compaction-warm: path=degraded reason=summary_failed:LlmError')
    expect(h.adapter.calls).toBe(2)
  })

  it('refuses the cache gate when the reported usage carries no cache counters', async () => {
    const h = warmHarness(
      { warmRequireReportedCache: true },
      { turnUsage: { inputTokens: 900, outputTokens: 20 } },
    )
    await h.engine.compactRegion(h.firstSeq, h.endSeq, h.agent, SIGNAL)
    expect(h.infos).toContain('compaction-warm: path=refused reason=reported_cache_zero')
  })
})
