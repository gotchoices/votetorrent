import type { StrandFilter, StrandRow } from './types.js';
/**
 * Extended strand row that includes the sAppId for filtering purposes.
 * The sAppId is provided by the hosting application, not from the control network.
 */
export interface StrandRowWithApp extends StrandRow {
    /** sApp ID if known (for filtering) */
    sAppId?: string;
}
/**
 * Callback for strand changes
 */
export interface StrandWatcherCallbacks {
    onStrandAdded: (strand: StrandRow) => Promise<void>;
    onStrandRemoved: (strandId: string) => Promise<void>;
}
/**
 * Interface for querying strands from control network
 */
export interface StrandQueryable {
    queryStrands(): Promise<StrandRow[]>;
}
/**
 * Interface for looking up sAppId for a strand (for filtering)
 */
export interface SAppIdLookup {
    /** Get the sAppId for a strand, if known */
    getSAppId(strandId: string): string | undefined;
}
/**
 * Watches the control network's Strand table for changes and triggers
 * strand instance start/stop via callbacks.
 *
 * Uses polling until Optimystic supports reactive subscriptions.
 */
export declare class StrandWatcher {
    private readonly filter;
    private readonly pollInterval;
    private readonly callbacks;
    private readonly queryable;
    private readonly sAppIdLookup?;
    private knownStrands;
    /** Ids admitted under a `defer` decision; re-evaluated each poll until they resolve. */
    private provisional;
    private pollTimer;
    private initialPollTimer;
    private running;
    constructor(queryable: StrandQueryable, callbacks: StrandWatcherCallbacks, filter?: StrandFilter, pollInterval?: number, sAppIdLookup?: SAppIdLookup);
    /**
     * Evaluate a strand against the current filter, distinguishing a not-yet-known
     * sAppId (`defer`) from a known non-match (`reject`). A `defer` admission is
     * provisional and re-checked on subsequent polls.
     */
    private evaluateFilter;
    /**
     * Poll for strand changes
     */
    private poll;
    /**
     * Start watching for strand changes
     */
    start(): Promise<void>;
    /**
     * Stop watching for strand changes
     */
    stop(): Promise<void>;
    /**
     * Get currently known strands
     */
    getKnownStrands(): Map<string, StrandRow>;
    /**
     * Force an immediate poll (useful for testing)
     */
    forcePoll(): Promise<void>;
}
