import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import WarmCompactionEngine from '@deepseek-ai/dsh-compaction-warm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  MODEL, ScriptedAdapter, conversationSession, replayedText, summaryEvent, surfaceRange,
} from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-token-meter', TokenMeter],
  ['@deepseek-ai/dsh-compaction-basic', BasicCompactionEngine],
  ['@deepseek-ai/dsh-compaction-warm', WarmCompactionEngine],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-agent-preset-registry', AgentPresets],
  ['@deepseek-ai/dsh-agent-preset', AgentPreset],
])

/** Boot one test-only `cordis.yml` through the real Loader and Include. */
async function loadYaml(
  lines: readonly string[],
  patches: readonly PatchOptions[] = [],
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-compaction-warm-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.builtins.group = Group
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    // The Node internal cascade loader type is not constructible in tests; every
    // Loader composition spec in the repo installs this same interception.
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href, patches },
  })
  await context.loader.await()
  return context
}

const coreLines = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-token-meter'",
]

/** The web-app plane: registry plus one preset whose compaction group mounts `rowName`. */
function presetLines(presetId: string, rowName: string): string[] {
  return [
    ...coreLines,
    "- name: '@deepseek-ai/dsh-system-prompt'",
    '  config:',
    "    personaPrefix: ''",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: standard',
    `- id: preset-${presetId}`,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    `    id: ${presetId}`,
    '    plugins:',
    '      - id: compaction',
    '        name: cordis:group',
    '        group: true',
    '        isolate:',
    '          compaction: true',
    '        config:',
    `          - id: compaction-${presetId}`,
    `            name: '${rowName}'`,
  ]
}

async function agentIn(loaded: Context, sessionId: string, presetId?: string) {
  const handle = await loaded.agents.create({
    sessionId: SessionId(sessionId),
    setup: async (agentCtx: Context) => { await loaded.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

const SIGNAL = new AbortController().signal

describe('real Loader composition', () => {
  it('mounts the warm engine in place of basic and drives it durably', async () => {
    const loaded = await loadYaml([
      ...coreLines,
      "- name: '@deepseek-ai/dsh-compaction-warm'",
      '  config:',
      '    auto: false',
      '    warmProviders: mock',
    ])
    const engine = loaded.get('compaction')
    expect(engine).toBeInstanceOf(WarmCompactionEngine)
    if (engine === undefined) throw new Error('the compaction service did not mount')
    // The class exposes its resolved config; the service interface does not.
    expect((engine as WarmCompactionEngine).config).toMatchObject({ auto: false })
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new ScriptedAdapter()
    loaded.llm.registerAdapter([MODEL], adapter)
    const session = conversationSession()
    const range = surfaceRange(session)
    const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent
    await engine.compactRegion(range.firstSeq, range.endSeq, agent, SIGNAL)
    expect(adapter.purposes[0]).toBe('compaction')
    expect(replayedText(adapter.requests[0]!)).toContain('You are now acting as a compaction engine')
    const event = summaryEvent(session)
    expect(event.data.replayScope).toBe('full-surface')
    expect(event.data.replayBoundarySeq).toBe(range.boundarySeq)
  })

  it('degrades through the loaded engine when the mock provider fails the warm call', async () => {
    const loaded = await loadYaml([
      ...coreLines,
      "- name: '@deepseek-ai/dsh-compaction-warm'",
      '  config:',
      '    auto: false',
    ])
    const infos: string[] = []
    loaded.logger.info = (line: string) => { infos.push(line) }
    const adapter = new ScriptedAdapter()
    adapter.mode = 'fail-once'
    loaded.llm.registerAdapter([MODEL], adapter)
    const session = conversationSession()
    const range = surfaceRange(session)
    const agent = { session, options: { provider: MODEL, model: MODEL } } as Agent
    await loaded.compaction.compactRegion(range.firstSeq, range.endSeq, agent, SIGNAL)
    expect(infos.some(line => line.includes('path=degraded reason=summary_failed:LlmError'))).toBe(true)
    expect(adapter.calls).toBe(2)
    expect('replayScope' in summaryEvent(session).data).toBe(false)
  })

  it('resolves the preset scope to the mounted engine and keeps basic for other rows', async () => {
    const loaded = await loadYaml(presetLines('standard', '@deepseek-ai/dsh-compaction-warm'))
    const warmAgent = await agentIn(loaded, 'preset-warm-agent', 'standard')
    expect(loaded.agentPresets.serviceFor({ ctx: warmAgent.ctx }, 'compaction'))
      .toBeInstanceOf(WarmCompactionEngine)
    expect(loaded.agentPresets.serviceFor({ ctx: loaded }, 'compaction')).toBeUndefined()
  })

  it('switches the preset row through a deployment patches layer', async () => {
    const loaded = await loadYaml(
      presetLines('standard', '@deepseek-ai/dsh-compaction-basic'),
      [{
        id: 'preset-standard',
        config: {
          id: 'standard',
          plugins: [{
            id: 'compaction',
            name: 'cordis:group',
            group: true,
            isolate: { compaction: true },
            config: [{ id: 'compaction-standard', name: '@deepseek-ai/dsh-compaction-warm' }],
          }],
        },
      }],
    )
    const patchedAgent = await agentIn(loaded, 'patched-agent', 'standard')
    expect(loaded.agentPresets.serviceFor({ ctx: patchedAgent.ctx }, 'compaction'))
      .toBeInstanceOf(WarmCompactionEngine)
  })

  it('releases the engine when its Loader fiber is disposed', async () => {
    const loaded = await loadYaml([
      ...coreLines,
      "- name: '@deepseek-ai/dsh-compaction-warm'",
      '  config:',
      '    auto: false',
    ])
    expect(loaded.get('compaction')).toBeInstanceOf(WarmCompactionEngine)
    const row = [...loaded.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-compaction-warm')
    const fiber = row?.fiber
    expect(fiber).toBeDefined()
    await fiber?.dispose()
    expect(loaded.get('compaction')).toBeUndefined()
  })
})
