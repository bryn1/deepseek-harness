/** One synthetic cold-Session corpus written once per run through the persistence write handles. */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SESSION_COUNT, syntheticSessionIds } from './session-list.constants.ts'

const TIME_ZERO = 1_700_000_000_000

/** One completed turn: enough log for a real cold artifact without touching measured work. */
function oneTurnEventLog(index: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: TIME_ZERO + index * 1_000, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: TIME_ZERO + index * 1_000 + 1, surfaceOp: 'append', data: freezeMessage({
      id: MessageId(`synth-user-${String(index)}`),
      role: 'user',
      content: [{ type: 'text', text: `synthetic prompt ${String(index)}` }],
      source: { kind: 'user' },
    }) },
    { type: 'turn/end', seq: SessionSeq(2), time: TIME_ZERO + index * 1_000 + 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Persist `SESSION_COUNT` detached cold Sessions under `root`.
 * @param root - the private `mkdtemp` directory owned by the calling benchmark.
 */
export async function writeSyntheticColdCorpus(root: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  const persistence = ctx.sessionPersistence
  for (const [index, sessionId] of syntheticSessionIds().entries()) {
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: TIME_ZERO + index * 1_000,
      isSeeded: false,
      // Eight project roots, like a multi-repo desktop: the persisted catalog's
      // per-artifact lookup stays bounded while the enumeration scales with rows.
      cwd: `/synthetic/proj-${String(index % 8)}`,
    }
    const handle = await persistence.create(header)
    try {
      await handle.append(oneTurnEventLog(index))
    } finally {
      await handle.close()
    }
  }
  await persistence.flush()
  await ctx.fiber.dispose()
  let persisted = 0
  for (const projectEntry of await readdir(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue
    persisted += (await readdir(join(root, projectEntry.name), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).length
  }
  if (persisted !== SESSION_COUNT) {
    throw new Error(`synthetic corpus wrote ${String(persisted)} Sessions, expected ${String(SESSION_COUNT)}`)
  }
}
