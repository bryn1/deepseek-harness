import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildFullSurfaceInput } from '@deepseek-ai/dsh-compaction-warm/src/warm-replay.ts'
import { MODEL, PREFIX_TEXT, TAIL_MARKER, replayedText } from './harness.ts'

/** One surface node per message; the header carries tools only when `withTools`. */
function surfaceFixture(options: { system?: string; openToolTail?: boolean; withTools?: boolean } = {}): Session {
  const session = Session.create(SessionId('warm-replay-fixture'))
  session.append('turn/start', { turn: 1 })
  if (options.system !== undefined) {
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage(options.system),
    }, { surfaceOp: 'append' })
  }
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: PREFIX_TEXT }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'first answer' }],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('request/header', {
    header: {
      config: { provider: MODEL, model: MODEL },
      ...options.withTools === true
        ? { tools: [{ name: 'probe', description: 'probe tool', parameters: {} }] }
        : {},
    },
    reason: 'initial',
  })
  if (options.openToolTail === true) {
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('call-open-1'), name: 'probe', arguments: '{}' }],
        source: { provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
  }
  return session
}

describe('buildFullSurfaceInput', () => {
  it('replays the system head first, then every surface message, anchored at the last node', () => {
    const session = surfaceFixture({ system: 'You are a helpful coding assistant.', withTools: true })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: TAIL_MARKER }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const built = buildFullSurfaceInput(session)
    expect(built).not.toBeNull()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- checked above.
    const { input, boundarySeq } = built!
    expect(input.messages[0]?.role).toBe('system')
    const text = replayedText(input.messages)
    expect(text).toContain('You are a helpful coding assistant.')
    expect(text).toContain(PREFIX_TEXT)
    expect(text).toContain(TAIL_MARKER)
    expect(input.tools).toHaveLength(1)
    expect(boundarySeq).toBe(session.surface.nodes.at(-1))
    const roles = input.messages.map(message => message.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('omits tools for a toolless header and skips a head that projects to no message', () => {
    const session = surfaceFixture({ system: '' })
    const built = buildFullSurfaceInput(session)
    expect(built).not.toBeNull()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- checked above.
    const { input } = built!
    expect(input.messages.every(message => message.role !== 'system')).toBe(true)
    expect(input.tools).toBeUndefined()
    expect(input.messages).toHaveLength(2)
  })

  it('refuses a surface whose live tail ends in an unanswered tool call', () => {
    expect(buildFullSurfaceInput(surfaceFixture({
      system: 'system prompt',
      openToolTail: true,
    }))).toBeNull()
  })

  it('starts at node zero when the surface has no system head', () => {
    const built = buildFullSurfaceInput(surfaceFixture())
    expect(built).not.toBeNull()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- checked above.
    const { input } = built!
    expect(input.messages.map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('builds without tools when no request header exists yet', () => {
    const session = Session.create(SessionId('warm-replay-headerless'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: PREFIX_TEXT }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const built = buildFullSurfaceInput(session)
    expect(built).not.toBeNull()
    // oxlint-disable-next-line typescript/no-non-null-assertion -- checked above.
    expect(built!.input.tools).toBeUndefined()
    expect(built!.input.messages).toHaveLength(1)
  })
})
