/** Event-invalidated in-memory view of the persisted Session set. */

import type { LoggerService } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'

/** Enumeration the snapshot runs per build; failures reach every waiter. */
export type PersistedListing = (
  persistence: SessionPersistence,
  signal?: AbortSignal,
) => Promise<readonly SessionHeader[]>

/**
 * The persisted half of the logical corpus, held as one `Map<SessionId, SessionHeader>`.
 *
 * - Concurrent cold readers share one enumeration (single-flight build).
 * - A trigger during a build bumps the generation; the stale build is discarded
 *   on completion and the next build is re-armed eagerly.
 * - A disposal reconciles after the service durability barrier settles: a
 *   defined `stat` upserts the header row, an undefined one removes it; flush
 *   or `stat` failure marks the whole snapshot stale and arms a rebuild.
 * - `listRefreshMs` expiry re-enumerates in the background; requests during a
 *   revalidation are answered from the previous snapshot.
 * - Build failure reaches every waiter; the slot clears and the next request
 *   or TTL tick re-arms, so a waiter can never hang on a failed build.
 *
 * Stored headers are immutable at create, so a snapshot row is absent or
 * present, never wrongly valued.
 */
export class PersistedSessionSnapshot {
  private headers = new Map<SessionId, SessionHeader>()
  private built = false
  private stale = false
  private generation = 0
  private build: Promise<void> | undefined
  private discarded = false
  private persistence: SessionPersistence | undefined
  private dirty = new Set<SessionId>()
  private reconcileScheduled = false
  private reconcile: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly listRefreshMs: number,
    private readonly listing: PersistedListing,
    private readonly logger: LoggerService,
  ) {}

  /** Point the snapshot at one persistence service and kick the eager build. */
  attach(persistence: SessionPersistence): void {
    this.persistence = persistence
    this.reset()
    this.background()
  }

  /**
   * Drop this service's view; live-only semantics until the next attach.
   * Called only for the currently attached service; the binding owner in
   * `SessionCorpus` holds that identity check.
   */
  detach(): void {
    this.persistence = undefined
    this.reset()
  }

  /** Stop the background refresh timer; the view drops with the owning fiber. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * The current view, building once on cold start.
   *
   * A caller aborted while the shared build runs rejects with its own reason
   * after that build settles; one waiter's cancellation never cancels the
   * shared enumeration. A persistence service that detaches while the caller
   * waits answers with the persisted half absent rather than waiting on a
   * build that can no longer run.
   * @param signal - optional cancellation for the calling request.
   * @returns the retained header map; callers clone what they publish.
   */
  async view(signal?: AbortSignal): Promise<ReadonlyMap<SessionId, SessionHeader>> {
    signal?.throwIfAborted()
    for (;;) {
      if (this.built && !this.stale) break
      if (this.persistence === undefined) return this.headers
      await this.enqueueBuild(signal)
      signal?.throwIfAborted()
    }
    return this.headers
  }

  /**
   * Reconcile one disposed session. The synchronous trigger only records the
   * id; the coalesced task awaits the durability barrier after the current
   * dispatch (including the backend's own close start) has run, so the
   * barrier always joins an in-flight `close()`.
   * @param id - the disposed session to reconcile at next settle.
   */
  markDisposed(id: SessionId): void {
    this.generation += 1
    this.dirty.add(id)
    if (this.reconcileScheduled) return
    this.reconcileScheduled = true
    queueMicrotask(() => {
      this.reconcileScheduled = false
      this.reconcile ??= this.runReconcile().finally(() => {
        this.reconcile = undefined
      })
    })
  }

  private reset(): void {
    this.headers = new Map()
    this.built = false
    this.stale = false
    this.generation += 1
  }

  private background(): void {
    void this.enqueueBuild().catch((error: unknown) => {
      this.logger.warn(`sessionQuery: persisted listing build failed: ${String(error)}`)
    })
  }

  private enqueueBuild(signal?: AbortSignal): Promise<void> {
    if (this.build !== undefined) return this.build
    const build = this.runBuild(signal)
    this.build = build
    build.finally(() => {
      // `enqueueBuild` is the slot's only writer and clears it here before
      // the discard re-arm below may enqueue the next one.
      this.build = undefined
      if (this.discarded) {
        this.discarded = false
        this.background()
      }
    }).catch(() => {})
    return build
  }

  private async runBuild(signal?: AbortSignal): Promise<void> {
    const persistence = this.persistence
    if (persistence === undefined) return
    const generation = this.generation
    try {
      const headers = await this.listing(persistence, signal)
      if (generation !== this.generation || this.disposesUnresolved()) {
        // A trigger landed mid-enumeration (or a disposal is still awaiting its
        // barrier), so this result cannot describe the corpus. Discard it; the
        // slot-clear re-arms the next build once the disposes settle.
        this.discarded = true
        return
      }
      this.headers = new Map(headers.map(header => [header.id, header]))
      this.built = true
      this.stale = false
    } finally {
      this.scheduleRefresh()
    }
  }

  /** True while any disposal has not yet been reconciled past the barrier. */
  private disposesUnresolved(): boolean {
    return this.dirty.size > 0 || this.reconcileScheduled || this.reconcile !== undefined
  }

  private scheduleRefresh(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.persistence === undefined || this.build !== undefined) return
      this.background()
    }, this.listRefreshMs)
    this.timer.unref()
  }

  private async runReconcile(): Promise<void> {
    while (this.dirty.size > 0) {
      const persistence = this.persistence
      if (persistence === undefined) {
        this.dirty.clear()
        return
      }
      const ids = [...this.dirty]
      this.dirty.clear()
      try {
        await persistence.flush()
        for (const id of ids) {
          // Post-fix the barrier settles every handle it observed before it
          // resolves, so `stat` here reports the disposal's durable outcome:
          // a defined header upserts the row, an undefined one removes it.
          const snapshot = await persistence.stat(id)
          if (snapshot === undefined) this.headers.delete(id)
          else this.headers.set(id, snapshot.header)
        }
      } catch (error: unknown) {
        // Membership is unknown: mark the whole snapshot unverified and arm
        // the enumeration that clears the flag.
        this.stale = true
        this.logger.warn(`sessionQuery: persisted dispose reconcile failed; snapshot marked stale: ${String(error)}`)
        this.background()
        this.dirty.clear()
      }
    }
  }
}
