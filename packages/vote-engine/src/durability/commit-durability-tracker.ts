/**
 * commit-durability-tracker.ts -- which of this phone's writes no other member holds yet
 * (todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort).
 *
 * A write that reaches no cohort member still succeeds: it is committed on this phone only, and
 * until another member holds it, losing the phone loses it. Optimystic#19 (fixed in 1.0.0) made
 * that visible as a commit's durability class, and cadre-core reports it per commit as the
 * CadreNode events `strand:commit-durability` (`heldElsewhere`, `followed`) and
 * `strand:commit-held`. This tracker turns those events into two things an app can show:
 *
 *   - `unsharedCount`: how many commits on this phone no other member holds yet (app-wide);
 *   - `actionState(key)`: for one user action run through `track(key, fn)`, whether every commit
 *     it made is held elsewhere (`'shared'`), some is not yet (`'waiting'`), or no commit was seen
 *     (`'unknown'`: the action wrote nothing to a strand, or no node was attached).
 *
 * ATTRIBUTION. cadre-core delivers each commit's report synchronously, inside the commit, before
 * the statement that made it returns, and Quereus runs one writer at a time. So a report that
 * arrives while `fn` is running belongs to a commit made during `fn`. Other writers can commit in
 * that window too (cadre-core's own membership writes, a background sync). Those are attributed
 * to the action as well, which can only make an action read `'waiting'` when its own commits were
 * already shared -- never `'shared'` when one of them was not. That is the safe direction.
 *
 * MEMORY ONLY. Like cadre-core's own record, this forgets everything on restart. A commit reported
 * with `followed: false` will never get a `strand:commit-held` event; it stays counted until the
 * app restarts. That is honest: nothing will say it reached anyone.
 *
 * No platform imports: used by both React Native apps.
 */

/** The `strand:commit-durability` payload fields this tracker reads (cadre-core StrandCommitDurability). */
export interface CommitDurabilityReport {
  readonly strandId: string
  readonly transactionId: string
  readonly heldElsewhere: boolean
  readonly followed: boolean
}

/** The `strand:commit-held` payload (cadre-core StrandCommitHeld). */
export interface CommitHeldReport {
  readonly strandId: string
  readonly transactionId: string
}

/**
 * The part of a CadreNode the tracker listens to (a Node EventEmitter fits too). Method syntax on
 * purpose: TypeScript checks method parameters bivariantly, so CadreNode's typed `on<K>` overloads
 * and EventEmitter's untyped ones both satisfy it. `off` may be named `removeListener`.
 */
export interface CommitEventSource {
  on (event: 'strand:commit-durability' | 'strand:commit-held', listener: (event: any) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  off? (event: 'strand:commit-durability' | 'strand:commit-held', listener: (event: any) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  removeListener? (event: 'strand:commit-durability' | 'strand:commit-held', listener: (event: any) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ActionShareState = 'shared' | 'waiting' | 'unknown'

const DEFAULT_MAX_TRACKED = 512

function commitKey (strandId: string, transactionId: string): string {
  return `${strandId}\u0000${transactionId}`
}

export class CommitDurabilityTracker {
  /** Commits no other member holds yet, by strand+tx, in arrival order. */
  private readonly unshared = new Map<string, { followed: boolean }>()
  /** Every commit attributed to each action key. */
  private readonly actions = new Map<string, Set<string>>()
  /** Windows of `track` calls still running. */
  private readonly open = new Set<Set<string>>()
  private readonly listeners = new Set<() => void>()
  private readonly maxTracked: number
  private source: CommitEventSource | null = null

  private readonly onDurability = (e: CommitDurabilityReport): void => {
    if (e == null || typeof e.strandId !== 'string' || typeof e.transactionId !== 'string') return
    const key = commitKey(e.strandId, e.transactionId)
    for (const window of this.open) window.add(key)
    if (e.heldElsewhere === true) {
      if (!this.unshared.delete(key) && this.open.size === 0) return
    } else {
      this.unshared.delete(key)
      this.unshared.set(key, { followed: e.followed === true })
      while (this.unshared.size > this.maxTracked) {
        const oldest = this.unshared.keys().next().value
        if (oldest === undefined) break
        this.unshared.delete(oldest)
      }
    }
    this.emit()
  }

  private readonly onHeld = (e: CommitHeldReport): void => {
    if (e == null || typeof e.strandId !== 'string' || typeof e.transactionId !== 'string') return
    if (this.unshared.delete(commitKey(e.strandId, e.transactionId))) this.emit()
  }

  constructor (options: { maxTracked?: number } = {}) {
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED
  }

  /** Start listening to `source`'s commit events. Re-attaching moves the tracker to the new source. */
  attach (source: CommitEventSource): void {
    if (this.source === source) return
    this.detach()
    this.source = source
    source.on('strand:commit-durability', this.onDurability)
    source.on('strand:commit-held', this.onHeld)
  }

  /** Stop listening. What was recorded so far is kept. */
  detach (): void {
    const source = this.source
    if (source === null) return
    this.source = null
    const off = (source.off ?? source.removeListener)?.bind(source)
    off?.('strand:commit-durability', this.onDurability)
    off?.('strand:commit-held', this.onHeld)
  }

  get attached (): boolean {
    return this.source !== null
  }

  /** Commits on this phone that no other member holds yet. */
  get unsharedCount (): number {
    return this.unshared.size
  }

  /** Of those, how many nothing will report reaching anyone (`followed: false`). */
  get unfollowedCount (): number {
    let n = 0
    for (const v of this.unshared.values()) if (!v.followed) n++
    return n
  }

  /**
   * Run `fn` and attribute every commit reported while it runs to `actionKey` (added to what an
   * earlier `track` with the same key recorded). Returns `fn`'s result; rethrows its error.
   */
  async track<T> (actionKey: string, fn: () => Promise<T>): Promise<T> {
    const window = new Set<string>()
    this.open.add(window)
    try {
      return await fn()
    } finally {
      this.open.delete(window)
      if (window.size > 0) {
        const existing = this.actions.get(actionKey) ?? new Set<string>()
        for (const k of window) existing.add(k)
        this.actions.delete(actionKey)
        this.actions.set(actionKey, existing)
        while (this.actions.size > this.maxTracked) {
          const oldest = this.actions.keys().next().value
          if (oldest === undefined) break
          this.actions.delete(oldest)
        }
        this.emit()
      }
    }
  }

  /** `'waiting'` while any commit attributed to `actionKey` is held only here. */
  actionState (actionKey: string): ActionShareState {
    const commits = this.actions.get(actionKey)
    if (commits === undefined || commits.size === 0) return 'unknown'
    for (const k of commits) if (this.unshared.has(k)) return 'waiting'
    return 'shared'
  }

  /** How many tracked actions whose key starts with `prefix` are `'waiting'` (e.g. `'decision:'`). */
  waitingActionCount (prefix: string): number {
    let n = 0
    for (const key of this.actions.keys()) {
      if (key.startsWith(prefix) && this.actionState(key) === 'waiting') n++
    }
    return n
  }

  /** Called after any change to `unsharedCount` or an action's state. Returns an unsubscribe. */
  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit (): void {
    for (const l of [...this.listeners]) {
      try { l() } catch { /* a listener never breaks a commit report */ }
    }
  }
}
