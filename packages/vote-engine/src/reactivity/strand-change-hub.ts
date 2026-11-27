// reactivity/strand-change-hub.ts — one place screens subscribe to strand table changes.
//
// Role:
//   - Holds the open network strand's change source (cadre-core's `StrandDatabase.watchTables`, built on
//     Quereus `Database.watch` + the Optimystic plugin's `notifyExternalChange` bridge, so it hears this
//     device's commits, commits replicated into its storage and, for tables tagged
//     `"optimystic.network_watch" = true` on a node with `strandReactivity`, commits made anywhere).
//   - Screens subscribe by qualified table name ('App.Election'). A subscription made before a strand is
//     attached, or across a network switch, is (re)bound when the next source attaches; nothing is lost.
//
// Rules:
//   - vote-engine never imports cadre-core: the source is the structural `StrandChangeSource` below.
//   - A listener never runs inside a commit: the source's own single-flight, coalesced schedule calls it.
//   - Every subscription keeps a backstop run (default 60 s), because a table change without a storage
//     event (cadre-core's table-change-watch.ts module doc) is not heard. Screens keep their focus reload.
//   - A table the source refuses (an unknown name throws synchronously) disables only that subscription,
//     reported through `onError`; it never throws into the screen.

/** The cadre-core `TableChangeWatch` surface used here. */
export interface StrandTableWatch {
  trigger (delayMs?: number): void
  dispose (): void
}

/** The cadre-core `StrandDatabase.watchTables` surface used here. */
export interface StrandChangeSource {
  watchTables (
    tables: readonly string[],
    onChange: () => Promise<void>,
    options: { label: string, coalesceMs?: number, backstopMs?: number }
  ): StrandTableWatch
}

export interface StrandChangeSubscribeOptions {
  /** Short label for the source's log lines. */
  label: string
  /** Coalescing window (ms); default the source's (cadre-core: 50 ms). */
  coalesceMs?: number
  /** Run anyway this long after the last run settled; default {@link STRAND_CHANGE_BACKSTOP_MS}. 0 disables. */
  backstopMs?: number
}

/** Default backstop: a changed table is noticed within a minute even if no change event arrived. */
export const STRAND_CHANGE_BACKSTOP_MS = 60_000

interface Subscription {
  tables: readonly string[]
  listener: () => void | Promise<void>
  options: StrandChangeSubscribeOptions
  watch?: StrandTableWatch
}

export class StrandChangeHub {
  private source: StrandChangeSource | undefined
  private strandId: string | undefined
  private readonly subs = new Set<Subscription>()

  constructor (private readonly onError: (label: string, err: unknown) => void = () => undefined) {}

  /** The strand id of the attached source, if any. */
  get attachedStrandId (): string | undefined { return this.strandId }

  /**
   * Bind to `strandId`'s change source, re-binding every live subscription. Re-attaching the SAME source
   * for the same strand is a no-op; a different source (a network switch, or a hibernated strand rebuilt
   * on wake) replaces the old bindings and runs each listener once, since changes may have been missed.
   */
  attach (strandId: string, source: StrandChangeSource): void {
    if (this.source === source && this.strandId === strandId) return
    this.unbindAll()
    this.source = source
    this.strandId = strandId
    for (const sub of this.subs) {
      this.bind(sub)
      sub.watch?.trigger(0)
    }
  }

  /** Drop the source (the network closed). Subscriptions stay and re-bind on the next attach. */
  detach (strandId?: string): void {
    if (strandId !== undefined && strandId !== this.strandId) return
    this.unbindAll()
    this.source = undefined
    this.strandId = undefined
  }

  /** Subscribe `listener` to changes of `tables`. Returns the unsubscribe; calling it twice is harmless. */
  subscribe (tables: readonly string[], listener: () => void | Promise<void>, options: StrandChangeSubscribeOptions): () => void {
    const sub: Subscription = { tables: [...tables], listener, options }
    this.subs.add(sub)
    if (this.source !== undefined) this.bind(sub)
    return () => {
      if (!this.subs.delete(sub)) return
      sub.watch?.dispose()
      sub.watch = undefined
    }
  }

  /** Number of live subscriptions (for tests and debug). */
  get size (): number { return this.subs.size }

  private bind (sub: Subscription): void {
    const source = this.source
    if (source === undefined) return
    const backstopMs = sub.options.backstopMs ?? STRAND_CHANGE_BACKSTOP_MS
    try {
      sub.watch = source.watchTables(sub.tables, async () => {
        try {
          await sub.listener()
        } catch (err) {
          this.onError(sub.options.label, err)
        }
      }, {
        label: sub.options.label,
        ...(sub.options.coalesceMs !== undefined ? { coalesceMs: sub.options.coalesceMs } : {}),
        ...(backstopMs > 0 ? { backstopMs } : {})
      })
    } catch (err) {
      sub.watch = undefined
      this.onError(sub.options.label, err)
    }
  }

  private unbindAll (): void {
    for (const sub of this.subs) {
      sub.watch?.dispose()
      sub.watch = undefined
    }
  }
}
