import { DEFAULT_DISPUTE_CONFIG } from './types.js';
import { createLogger } from '../logger.js';
const log = createLogger('engine-health');
/**
 * Tracks local engine health based on dispute outcomes.
 * When the node repeatedly loses disputes (its validations are wrong),
 * it flags itself as unhealthy and stops participating in promise voting.
 */
export class EngineHealthMonitor {
    state = {
        disputesLost: 0,
        recentLosses: [],
        unhealthy: false,
    };
    threshold;
    windowMs;
    constructor(config) {
        this.threshold = config?.engineHealthDisputeThreshold ?? DEFAULT_DISPUTE_CONFIG.engineHealthDisputeThreshold;
        this.windowMs = config?.engineHealthWindowMs ?? DEFAULT_DISPUTE_CONFIG.engineHealthWindowMs;
    }
    /** Record a dispute loss (our validation was wrong) */
    recordDisputeLoss() {
        const now = Date.now();
        this.state.recentLosses.push(now);
        this.pruneOldLosses(now);
        this.state.disputesLost = this.state.recentLosses.length;
        log('dispute-loss-recorded', {
            recentLosses: this.state.recentLosses.length,
            threshold: this.threshold,
            wasUnhealthy: this.state.unhealthy,
        });
        if (this.state.recentLosses.length >= this.threshold && !this.state.unhealthy) {
            this.state.unhealthy = true;
            this.state.unhealthySince = now;
            log('engine-marked-unhealthy', {
                disputesLost: this.state.recentLosses.length,
                threshold: this.threshold,
                windowMs: this.windowMs,
            });
        }
    }
    /** Check if the engine is currently unhealthy */
    isUnhealthy() {
        this.pruneOldLosses(Date.now());
        // Auto-recover if losses drop below threshold
        if (this.state.unhealthy && this.state.recentLosses.length < this.threshold) {
            this.state.unhealthy = false;
            this.state.unhealthySince = undefined;
            log('engine-auto-recovered', {
                recentLosses: this.state.recentLosses.length,
                threshold: this.threshold,
            });
        }
        return this.state.unhealthy;
    }
    /** Get the current health state */
    getState() {
        this.pruneOldLosses(Date.now());
        return { ...this.state };
    }
    /** Reset health state (for testing or admin recovery) */
    reset() {
        this.state = {
            disputesLost: 0,
            recentLosses: [],
            unhealthy: false,
        };
    }
    pruneOldLosses(now) {
        const cutoff = now - this.windowMs;
        this.state.recentLosses = this.state.recentLosses.filter(t => t > cutoff);
        this.state.disputesLost = this.state.recentLosses.length;
    }
}
//# sourceMappingURL=engine-health-monitor.js.map