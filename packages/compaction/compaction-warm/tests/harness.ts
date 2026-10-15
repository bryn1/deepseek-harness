/**
 * Shared unit-test harness: a durable session, the real LLM runtime with one
 * scripted adapter, and the warm engine under test control.
 */

import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmResolvedModelInfo, RequestMessage, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { WarmCompactionEngine } from '@deepseek-ai/dsh-compaction-warm'
import type { WarmCompactionConfig } from '@deepseek-ai/dsh-compaction-warm'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const MODEL = 'mock'
export const TAIL_MARKER = 'unique-tail-77 late question'
export const PREFIX_TEXT = 'shared warm prefix history '.repeat(40).trim()
export const INSTRUCTION_HEAD = 'You are now acting as a compaction engine for this AI coding assistant.'

/** The warm call's injected failure; its name surfaces in the degrade log. */
class SummaryFailure extends Error {
  override readonly name = 'SummaryFailure'
}

const CANCEL = new Error('harness cancelled')

export type CallMode = 'ok' | 'fail-once' | 'abort-once'

/** One text answer per request, with knobs for failure, cancellation, and capacity. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: RequestMessage[][] = []
  readonly purposes: (string | undefined)[] = []
  calls = 0
  mode: CallMode = 'ok'
  contextWindow: number | undefined = 100_000
  failResolveOnce = false
  readonly controller = new AbortController()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.failResolveOnce) {
      this.failResolveOnce = false
      return Promise.reject(new Error('harness cannot resolve route'))
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.contextWindow === undefined ? {} : { context: { contextWindow: this.contextWindow } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.requests.push([...options.messages])
    this.purposes.push(options.purpose)
    if (this.mode === 'abort-once' && this.calls === 1) {
      this.controller.abort()
      throw CANCEL
    }
    if (this.mode === 'fail-once' && this.calls === 1) throw new SummaryFailure()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export interface WarmHarness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly engine: WarmCompactionEngine
  readonly infos: string[]
  readonly session: Session
  readonly agent: Agent
  /** Surface seqs: first compactable node, the selected-range end, and the live boundary. */
  readonly firstSeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly boundarySeq: SessionSeq
}

/**
 * Build the engine plus a closed three-turn conversation: two turns inside the
 * selected range and one later tail turn carrying {@link TAIL_MARKER}.
 * @param config - warm configuration for the engine under test.
 * @param options - usage recorded on every turn (for the cache gate) and
 * whether the durable header exists (the route the warm gates require).
 */
export function warmHarness(
  config: WarmCompactionConfig = {},
  options: { turnUsage?: TokenUsage; withHeader?: boolean } = {},
): WarmHarness {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const infos: string[] = []
  ctx.logger.info = (line: string) => { infos.push(line) }
  const session = conversationSession(options)
  const engine = new WarmCompactionEngine(ctx, { auto: false, ...config })
  const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent
  return { ctx, adapter, engine, infos, session, agent, ...surfaceRange(session) }
}

/** The harness conversation's first compactable seq, selected-range end, and live boundary. */
export function surfaceRange(session: Session): {
  firstSeq: SessionSeq
  endSeq: SessionSeq
  boundarySeq: SessionSeq
} {
  const nodes = session.surface.nodes
  // The fixture always carries at least three surface nodes.
  return {
    firstSeq: headAt(nodes[0]!, session) ? nodes[1]! : nodes[0]!,
    endSeq: nodes[nodes.length - 2]!,
    boundarySeq: nodes[nodes.length - 1]!,
  }
}

function headAt(seq: SessionSeq, session: Session): boolean {
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-deprecated
  return session.eventAt(seq)!.type === 'system/message'
}

export function conversationSession(
  options: { turnUsage?: TokenUsage; withHeader?: boolean } = {},
): Session {
  const session = Session.create(SessionId(`warm-harness-${Math.random().toString(36).slice(2)}`))
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage('You are a helpful coding assistant.'),
      }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${PREFIX_TEXT} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1 && options.withHeader !== false) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      ...options.turnUsage === undefined ? {} : { usage: options.turnUsage },
      message: createAssistantMessage({
        content: [{ type: 'text', text: `assistant answer ${turn}` }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // The live turn: open, so `compactRegion` treats it as automatic-path work.
  session.append('turn/start', { turn: 3 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: TAIL_MARKER }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 3, step: 1 })
  return session
}

/** Join every text fragment of replayed messages for substring assertions. */
export function replayedText(messages: readonly RequestMessage[]): string {
  return messages.flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

/** The single durable summary event of a harness session. */
export function summaryEvent(session: Session): SessionEvent<'compaction/summary'> {
  for (let seq = 0; seq < session.seq; seq += 1) {
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-deprecated
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'compaction/summary') return event
  }
  throw new Error('no compaction/summary event was appended')
}

export { createAssistantMessage, createUserMessage }
