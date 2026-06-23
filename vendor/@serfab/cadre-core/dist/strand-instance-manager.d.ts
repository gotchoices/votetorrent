import type { PrivateKey } from '@libp2p/interface';
import type { StrandInstance, StrandRow, StorageConfig, NetworkConfig, LatencyHint, NodeProfile, SAppConfig, StrandMode } from './types.js';
/**
 * Configuration for starting a strand instance
 */
export interface StartStrandConfig {
    strandRow: StrandRow;
    /** sApp configuration provided by the hosting application */
    sAppConfig: SAppConfig;
    storage?: StorageConfig;
    network?: NetworkConfig;
    profile: NodeProfile;
    defaultLatencyHint: LatencyHint;
    privateKey?: PrivateKey;
    /** Cohort-derived discovery seed (multiaddr strings). Defaults to [] when omitted. */
    bootstrapNodes?: string[];
    /**
     * Lifecycle mode for this strand; selects the default transactor used by the
     * StrandDatabase. When omitted, the StrandDatabase falls back to `'networked'`;
     * callers (CadreNode) infer it from cohort membership before reaching here.
     */
    mode?: StrandMode;
    /**
     * Require a valid author signature on the sApp schema before bring-up.
     * Defaults to true (fail closed) when omitted; set false only for dev/test
     * with unsigned demo schemas. Mirrors {@link CadreNodeConfig.requireSignedSchemas}.
     */
    requireSignedSchemas?: boolean;
}
/**
 * Volatile inputs re-resolved when resuming a quiesced strand. These may have
 * changed since the strand first launched — the cohort discovery seed grows as
 * peers are learned, and cohort membership can push a strand `bootstrap → networked`.
 */
export interface ResumeStrandOverrides {
    /** Freshly-resolved cohort discovery seed (multiaddr strings). */
    bootstrapNodes?: string[];
    /** Freshly-resolved lifecycle mode. */
    mode?: StrandMode;
}
/**
 * Get the isolated storage path for a specific strand.
 *
 * @deprecated This helper is Node-only and throws in React Native (it assumes a
 * filesystem layout). Use a storage provider factory function instead, which
 * receives the strandId and can create strand-specific storage paths using
 * platform-appropriate methods.
 *
 * @example
 * // Instead of using getStrandStoragePath, use a storage provider factory:
 * const storage = {
 *   provider: (strandId: string) => new FileRawStorage(`./data/strands/${strandId}`)
 * };
 */
export declare function getStrandStoragePath(basePath: string, strandId: string): string;
/**
 * Manages individual strand instances - creates and destroys isolated libp2p nodes
 * for each strand the cadre participates in.
 */
export declare class StrandInstanceManager {
    private instances;
    /**
     * Retained launch config per strand, captured in `startStrand` and cleared in
     * `stopStrand`. `resumeStrand` reuses it to rebuild a quiesced strand's runtime
     * without the caller re-threading storage/network/profile/key/sApp config.
     */
    private launchConfigs;
    private stopping;
    constructor();
    /**
     * Get all current strand instances
     */
    getInstances(): Map<string, StrandInstance>;
    /**
     * Get a specific strand instance
     */
    getInstance(strandId: string): StrandInstance | undefined;
    /**
     * Check if a strand is currently running
     */
    hasStrand(strandId: string): boolean;
    /**
     * Start a new strand instance
     */
    startStrand(config: StartStrandConfig): Promise<StrandInstance>;
    /**
     * Build (or rebuild) the libp2p node + StrandDatabase for an instance and
     * attach them, transitioning it to `active`. Shared by `startStrand` (fresh
     * launch) and `resumeStrand` (rehydrating a quiesced instance). Reads all
     * volatile inputs (bootstrapNodes, mode, storage, network, profile,
     * privateKey, sApp config) from `config`, so the caller controls the
     * cohort-derived values.
     */
    private buildStrandRuntime;
    /**
     * Release an instance's strand-network runtime: close the StrandDatabase, then
     * stop the libp2p node (construction order in reverse), clearing both fields
     * and zeroing connectedPeers. Tolerant of partially-built state — either handle
     * may be absent — so it doubles as rollback for a failed `buildStrandRuntime`.
     * Shared by `quiesceStrand`, `stopStrand`, and that rollback path.
     */
    private releaseRuntime;
    /**
     * Quiesce a strand: release its strand-network resources (stop the libp2p node,
     * close the StrandDatabase) while RETAINING the instance record — identity,
     * sAppInfo, keys, latency hint, metadata — and its launch config so it can be
     * resumed later. Mechanically this is `stopStrand` minus the instance/config
     * deletion. The caller sets the post-quiesce status (e.g. `hibernating`).
     * No-ops when the strand is missing or already quiesced.
     */
    quiesceStrand(strandId: string): Promise<void>;
    /**
     * Resume a previously-quiesced strand: rebuild its libp2p node + StrandDatabase
     * from the retained launch config and re-attach them, transitioning it back to
     * `active`. `overrides` re-applies volatile inputs that may have changed since
     * launch (cohort `bootstrapNodes`, lifecycle `mode`) and updates the retained
     * config so a later resume reuses the latest values. Returns the live instance
     * unchanged if it is already running.
     */
    resumeStrand(strandId: string, overrides?: ResumeStrandOverrides): Promise<StrandInstance>;
    /**
     * Stop a strand instance
     */
    stopStrand(strandId: string): Promise<void>;
    /**
     * Stop all strand instances
     */
    stopAll(): Promise<void>;
}
