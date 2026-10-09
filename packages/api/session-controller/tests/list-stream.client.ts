/** Stream builders standing in for the generated `session.list` Client method. */

import { streamHandle } from '@deepseek-ai/dsh-remote-mock'
import type { SessionListPage, SessionSummary } from '../src/types.ts'

/**
 * A finished `session.list` stream whose single completion page carries `items`.
 * @param items - the complete catalog rows.
 * @returns the handle the generated method would return.
 */
export function listStream(items: readonly SessionSummary[]) {
  return listStreamPages([{ items, done: true }])
}

/**
 * A `session.list` stream yielding `pages` in order and then ending.
 * @param pages - the page frames to yield.
 * @returns the handle the generated method would return.
 */
export function listStreamPages(pages: readonly SessionListPage[]) {
  return streamHandle<SessionListPage>((async function* () {
    for (const page of pages) yield page
  })())
}

/**
 * A `session.list` stream whose pages arrive when `pages` settles.
 * @param pages - the promise gating the first frame.
 * @returns the handle the generated method would return.
 */
export function listStreamDeferred(pages: Promise<readonly SessionListPage[]>) {
  return streamHandle<SessionListPage>((async function* () {
    for (const page of await pages) yield page
  })())
}

/**
 * A `session.list` stream that fails its first read with `error`.
 * @param error - the failure the iteration raises.
 * @returns the handle the generated method would return.
 */
export function listStreamFailing(error: Error) {
  return streamHandle<SessionListPage>((async function* () {
    throw error
  })())
}

/**
 * A `session.list` stream that yields `lead`, waits for `gate`, then yields `tail`.
 * @param lead - the provisional frames released immediately.
 * @param gate - the promise gating the remaining frames.
 * @param tail - the frames released once `gate` settles.
 * @returns the handle the generated method would return.
 */
export function listStreamStaged(
  lead: readonly SessionListPage[],
  gate: Promise<unknown>,
  tail: readonly SessionListPage[],
) {
  return streamHandle<SessionListPage>((async function* () {
    for (const page of lead) yield page
    await gate
    for (const page of tail) yield page
  })())
}
