/**
 * Node-side drain of the streamed `session/list` over the Web Remote mux.
 * Wire probes (smoke checks, scaffold helpers) open the stream exactly like
 * the browser carrier does and read pages until the completion frame, so a
 * green drain proves the product stream end to end, not a mocked face.
 */

import WebSocket from 'ws'
import type { Page } from 'playwright'
import type { SessionListPage } from '@deepseek-ai/dsh-api-session-controller/types'

/** The single stream id this drain opens on each carrier. */
const streamId = 'session-list-drain'

/** One mux frame on a stream; `endpoint` rides the uplink `open` frame. */
type MuxFrame = {
  type: string
  streamId: string
  endpoint?: string
  value?: unknown
  error?: unknown
}

/** Await the socket opening, rejecting when the carrier fails first. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      socket.removeEventListener('open', resolved)
      socket.removeEventListener('error', failed)
      socket.removeEventListener('close', closed)
    }
    const resolved = (): void => { done(); resolve() }
    const failed = (): void => { done(); reject(new Error('session/list carrier failed before opening')) }
    const closed = (): void => { done(); reject(new Error('session/list carrier closed before opening')) }
    socket.addEventListener('open', resolved)
    socket.addEventListener('error', failed)
    socket.addEventListener('close', closed)
  })
}

/**
 * Open `session/list` on a running Host's mux and drain its page frames.
 * @param origin - HTTP origin of the running Host (rewritten to ws://).
 * @param cookieHeader - authenticated session cookie for the upgrade.
 * @param timeoutMs - ceiling for the whole drain.
 * @returns the page frames in arrival order, ending with the `done` page.
 * @throws Error when the stream errors, closes early, or never completes.
 */
export function drainSessionListViaMux(
  origin: string,
  cookieHeader: string,
  timeoutMs = 15_000,
): Promise<SessionListPage[]> {
  const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie: cookieHeader },
  })
  const pages: SessionListPage[] = []
  return new Promise<SessionListPage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`session/list stream did not complete within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    const finish = (error: Error | undefined): void => {
      clearTimeout(timer)
      socket.close()
      if (error !== undefined) reject(error)
      else resolve(pages)
    }
    const message = (event: WebSocket.MessageEvent): void => {
      try {
        const text = typeof event.data === 'string'
          ? event.data
          : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
        if (text === undefined) throw new Error('session/list published a non-text frame')
        const frame: MuxFrame = JSON.parse(text) as MuxFrame
        if (frame.streamId !== streamId) return
        if (frame.type === 'error') {
          finish(new Error(`session/list failed: ${JSON.stringify(frame.error)}`))
          return
        }
        if (frame.type === 'end') {
          finish(new Error('session/list ended without its completion frame'))
          return
        }
        if (frame.type === 'item') {
          const page = frame.value as SessionListPage
          pages.push(page)
          if (page.done) finish(undefined)
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const failed = (): void => { finish(new Error('session/list carrier failed mid-stream')) }
    const closed = (): void => { finish(new Error('session/list carrier closed mid-stream')) }
    void opened(socket).then(() => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/list', payload: { args: {} } }))
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
    }, (error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

/**
 * Hold or rewrite downlink frames of the page's `session/list` streams.
 * The interceptor forwards every other frame untouched and in order; frames
 * of the list stream are buffered while `handle` is pending, so a held page
 * pauses only the catalog — exactly the seam a restore-gating test needs.
 * @param page - browser page to route.
 * @param handle - observes each streamed page; returns a replacement page, a
 * promise of one (holding the frame until it settles), or undefined to pass
 * the frame through unchanged.
 */
export function interceptMuxSessionList(
  page: Page,
  handle: (listPage: SessionListPage) => SessionListPage | undefined | Promise<SessionListPage | undefined>,
): void {
  void page.routeWebSocket('**/api/remote.mux', (route) => {
    const server = route.connectToServer()
    const listStreams = new Set<string>()
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as MuxFrame
      if (frame.type === 'open' && frame.endpoint === 'session/list') {
        listStreams.add(frame.streamId)
        route.send(message)
        return
      }
      if (frame.type !== 'item' || !listStreams.has(frame.streamId)) {
        route.send(message)
        return
      }
      const listed = frame.value as SessionListPage
      const patched = handle(listed)
      if (!(patched instanceof Promise)) {
        route.send(patched === undefined ? message : JSON.stringify({ ...frame, value: patched }))
        return
      }
      void patched.then((settled) => {
        route.send(settled === undefined ? message : JSON.stringify({ ...frame, value: settled }))
      })
    })
  })
}
