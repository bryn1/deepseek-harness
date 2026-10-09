/**
 * Node-side drain of the streamed `session/list` over the Web Remote mux.
 * Wire probes (smoke checks, scaffold helpers) open the stream exactly like
 * the browser carrier does and read pages until the completion frame, so a
 * green drain proves the product stream end to end, not a mocked face.
 */

import WebSocket from 'ws'
import type { WebSocketRoute } from 'playwright'
import type { SessionListPage } from '@deepseek-ai/dsh-api-session-controller/types'

/** The single stream id this drain opens on each carrier. */
const streamId = 'session-list-drain'

/** Remote endpoint path carried on the uplink `open` frame of the catalog stream. */
const sessionListEndpoint = 'session/list'

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
 * A Playwright WebSocket route handler that observes or rewrites the downlink
 * pages of the browser's `session/list` streams.
 *
 * `page.unrouteAll()` does not retire `routeWebSocket` registrations, so the
 * handler outlives its test and re-attaches to every later carrier. `release`
 * makes it a pure pass-through, keeping any rewrite scoped to its own test.
 */
export interface MuxListInterceptor {
  (route: WebSocketRoute): void
  /** Stop observing/rewriting: later frames pass through untouched. */
  release(): void
}

/**
 * Build a route handler that forwards every frame untouched and in order, and
 * runs `collect` for each downlink page of a `session/list` stream. Every
 * frame of a list stream — pages and the stream's own `end`/`error` — is
 * sequenced through one arrival-ordered tail while a returned promise is
 * pending, so a held page pauses the catalog without the carrier's terminal
 * frame overtaking it; exactly the seam a restore-gating test needs.
 * `handle` returning a replacement page rewrites that frame.
 * @param handle - observes each streamed page; returns a replacement page, a
 * promise of one (holding the frame until it settles), or undefined to pass
 * the frame through unchanged.
 * @returns the WebSocket route handler to register on the page.
 */
export function createMuxListInterceptor(
  handle: (listPage: SessionListPage) => SessionListPage | undefined | Promise<SessionListPage | undefined>,
): MuxListInterceptor {
  let released = false
  const interceptor: MuxListInterceptor = Object.assign((route: WebSocketRoute): void => {
    const server = route.connectToServer()
    const listStreams = new Set<string>()
    let tail: Promise<unknown> = Promise.resolve()
    // Uplink frames carry the `open`; a set handler owns this direction, so it
    // forwards every message to the Host after recording list opens.
    route.onMessage((message) => {
      const frame = JSON.parse(String(message)) as MuxFrame
      if (frame.type === 'open' && frame.endpoint === sessionListEndpoint) listStreams.add(frame.streamId)
      server.send(message)
    })
    // Downlink frames carry the pages; this handler owns that direction.
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as MuxFrame
      if (!listStreams.has(frame.streamId)) {
        route.send(message)
        return
      }
      if (released) {
        route.send(message)
        return
      }
      tail = tail.then(async () => {
        if (frame.type !== 'item') {
          route.send(message)
          return
        }
        const settled = await handle(frame.value as SessionListPage)
        route.send(settled === undefined ? message : JSON.stringify({ ...frame, value: settled }))
      })
    })
  }, {
    release(): void {
      released = true
    },
  })
  return interceptor
}

/**
 * Build a pass-through route handler that resolves `complete` with every
 * collected `session/list` page once the completion frame passes through.
 * This is the RPC-level signal that the sidebar baseline landed.
 * @param complete - receives the page frames in arrival order.
 * @returns the WebSocket route handler to register on the page.
 */
export function createMuxListCollector(
  complete: (pages: SessionListPage[]) => void,
): MuxListInterceptor {
  const pages: SessionListPage[] = []
  return createMuxListInterceptor((listPage) => {
    pages.push(listPage)
    if (listPage.done) complete([...pages])
    return undefined
  })
}
