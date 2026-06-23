import type { StrandInstance, HibernationConfig } from './types.js';
/**
 * Callbacks for hibernation state changes
 */
export interface HibernationCallbacks {
    onIdle: (strandId: string) => Promise<void>;
    onHibernate: (strandId: string) => Promise<void>;
    onWake: (strandId: string) => Promise<void>;
    /**
     * Perform a real cohort check-in for a hibernating strand. The implementation
     * (`CadreNode.handleStrandCheckIn`) resumes the strand, gives it a bounded
     * window to connect to reachable cohort peers and surface pending activity,
     * then re-hibernates if still idle. The manager AWAITS this before scheduling
     * the next (longer-delayed) check-in, so a slow check-in never overlaps the
     * next tick. After it resolves the manager inspects `instance.status`: a
     * strand left non-`hibernating` is treated as woken (backoff resets on the
     * next hibernation); a strand left `hibernating` escalates the backoff.
     */
    onCheckIn: (strandId: string) => Promise<void>;
}
/**
 * Manages strand hibernation state transitions based on activity.
 *
 * State machine:
 *   active → idle (after idleTimeout with no activity)
 *   idle → hibernating (after hibernateTimeout with no activity)
 *   idle → active (on activity)
 *   hibernating → active (on wake signal or check-in with pending activity)
 */
export declare class HibernationManager {
    private readonly config;
    private readonly callbacks;
    private readonly timers;
    /**
     * Pending check-in timers, one per hibernating strand. Unlike the old fixed
     * `setInterval`, these are single-shot `setTimeout`s rescheduled by
     * {@link runCheckIn} with an escalating delay — so a long-running `onCheckIn`
     * can never overlap the next tick, and the period adapts to the backoff.
     */
    private readonly checkInTimers;
    /**
     * In-flight wake promises keyed by strandId. Coalesces overlapping wake
     * triggers (two near-simultaneous activities, or activity racing a force wake)
     * so `onWake` — and the libp2p-node rebuild it drives — runs at most once per
     * concurrent wake.
     */
    private readonly wakePromises;
    private running;
    constructor(config: HibernationConfig, callbacks: HibernationCallbacks);
    /**
     * Get effective timeouts for a latency hint
     */
    private getTimeouts;
    /**
     * Start managing hibernation for all strands
     */
    start(): void;
    /**
     * Stop managing hibernation
     */
    stop(): void;
    /**
     * Whether a strand with this instance's latency hint ever hibernates — `false`
     * for realtime (Infinity idle timeout, see {@link HIBERNATION_TIMEOUTS}), also
     * honouring any per-hint `customTimeouts` override. Imperative callers
     * (`CadreNode.hibernateStrand` / `hibernateAll`) use this as the single source
     * of truth for "skip realtime", consistent with {@link trackStrand} declining
     * to track Infinity-timeout strands.
     */
    hibernates(instance: StrandInstance): boolean;
    /**
     * Imperatively hibernate a tracked strand now, bypassing the idle/hibernate
     * timers — the mobile background-entry path. Cancels the strand's pending
     * idle/hibernate AND check-in timers so none can later re-fire `onHibernate`
     * on the already-quiesced strand or resurrect one the caller means to keep
     * down, then invokes `onHibernate` (quiesce + mark hibernating).
     *
     * Unlike the timer path ({@link handleHibernateTimeout}) it deliberately does
     * NOT re-arm the check-in chain: a force-hibernate keeps the strand down until
     * the caller drives the next wake on demand (push-delivered on mobile), so a
     * stray check-in timer must not bring it back up.
     *
     * @returns `true` if the strand was hibernated, `false` (no-op) for a realtime
     *   strand that never hibernates.
     */
    forceHibernate(instance: StrandInstance): Promise<boolean>;
    /**
     * Register a strand for hibernation management
     */
    trackStrand(instance: StrandInstance): void;
    /**
     * Untrack a strand from hibernation management
     */
    untrackStrand(strandId: string): void;
    /**
     * Record activity on a strand - resets idle timer
     */
    recordActivity(instance: StrandInstance): void;
    /**
     * Force wake a hibernating strand
     */
    wakeStrand(strandId: string): Promise<void>;
    /**
     * Begin a wake for a strand, or coalesce with one already in flight. Ensures
     * `onWake` runs at most once per concurrent wake — the returned promise is
     * shared by all overlapping callers and cleared once it settles. Force-wake
     * callers await it; activity-driven callers fire-and-forget.
     */
    private beginWake;
    private scheduleIdleTransition;
    private handleIdleTimeout;
    private scheduleHibernateTransition;
    private handleHibernateTimeout;
    /**
     * Arm the next check-in for a hibernating strand. Each call is a single-shot
     * `setTimeout` (not a fixed `setInterval`) so the period escalates per
     * {@link runCheckIn} and a slow `onCheckIn` never overlaps the next tick.
     *
     * `delay` is omitted by the chain start ({@link handleHibernateTimeout}),
     * defaulting to the base `checkInInterval` — which is why backoff naturally
     * resets to base each fresh hibernation cycle, with no per-strand counter to
     * clear on wake. Subsequent ticks pass the escalated, capped delay.
     */
    private scheduleCheckIn;
    /**
     * Run a single check-in tick: invoke `onCheckIn` (a real resume → bounded
     * sync window → re-hibernate-if-idle cycle in `CadreNode`) and AWAIT it before
     * deciding the next step.
     *
     * - If the strand woke during the check-in (`onCheckIn` left it non-
     *   `hibernating`), stop the chain — the activity path has re-armed the
     *   idle/hibernate timers, and the next hibernation restarts the chain at the
     *   base delay (backoff reset).
     * - Otherwise escalate the delay by `checkInBackoffFactor`, capped at
     *   `checkInMaxInterval`, and reschedule.
     */
    private runCheckIn;
    private clearTimer;
    private clearTimers;
    /**
     * Get the current status of hibernation tracking
     */
    getStatus(): {
        enabled: boolean;
        trackedStrands: number;
    };
}
