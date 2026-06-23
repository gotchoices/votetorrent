import type { EngineHealthState, DisputeConfig } from './types.js';
/**
 * Tracks local engine health based on dispute outcomes.
 * When the node repeatedly loses disputes (its validations are wrong),
 * it flags itself as unhealthy and stops participating in promise voting.
 */
export declare class EngineHealthMonitor {
    private state;
    private readonly threshold;
    private readonly windowMs;
    constructor(config?: Partial<DisputeConfig>);
    /** Record a dispute loss (our validation was wrong) */
    recordDisputeLoss(): void;
    /** Check if the engine is currently unhealthy */
    isUnhealthy(): boolean;
    /** Get the current health state */
    getState(): Readonly<EngineHealthState>;
    /** Reset health state (for testing or admin recovery) */
    reset(): void;
    private pruneOldLosses;
}
//# sourceMappingURL=engine-health-monitor.d.ts.map