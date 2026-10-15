/**
 * Full-surface replay input for the warm summarization attempt.
 *
 * @module @deepseek-ai/dsh-compaction-warm/warm-replay
 */

import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { FullSurfaceReplay } from './types.ts'

/**
 * Rebuild the cacheable prefix of the last routed request over the entire
 * current surface: the system head, the header's tool schemas, then every
 * non-system surface message in surface order. The sent set is anchored at the
 * last surface node's seq so the durable summary event can pin exactly what
 * the model saw.
 * @param session - session supplying the surface, request header, and per-node projection.
 * @returns the replay input with its boundary seq, or `null` when the live
 * tail ends inside an unanswered tool call. That shape exists only inside the
 * balance-validated selected span, so the caller refuses the warm attempt
 * rather than trimming the sent set away from the recorded boundary.
 */
export function buildFullSurfaceInput(session: Session): FullSurfaceReplay | null {
  const nodes = session.surface.nodes
  // Region selection guarantees a non-empty surface before any summarize call.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the final surface node exists.
  const boundarySeq = nodes[nodes.length - 1]!
  if (!toolPairingBalancedAfter(session, boundarySeq)) return null
  const header = session.requestHeader()
  // Surface nodes are current log seqs, so the event exists.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const headEvent = session.eventAt(nodes[0]!)!
  const isSystemHead = headEvent.type === 'system/message'
  // A `system/message` head projects to the leading system message (or to no
  // message when empty); any other node 0 is an ordinary surface message.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const system = isSystemHead ? session.deriveEventMessage(headEvent) : null
  const bodyMessages = nodes.slice(isSystemHead ? 1 : 0)
    // Surface nodes are current log seqs, so each event exists.
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    .map(seq => session.deriveEventMessage(session.eventAt(seq)!))
    .filter((message): message is Message => message !== null)
  return {
    input: {
      ...header?.tools === undefined ? {} : { tools: header.tools },
      messages: system === null ? bodyMessages : [system, ...bodyMessages],
    },
    boundarySeq,
  }
}
