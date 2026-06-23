import type { IRawStorage } from './i-raw-storage.js';
export interface StorageCapacity {
    total: number;
    used: number;
    available: number;
}
export interface StorageMonitorConfig {
    totalBytes?: number;
    usedBytes?: number;
    availableBytes?: number;
}
/**
 * Monitors storage capacity for ring selection.
 * Provides estimates based on storage backend or supplied overrides.
 */
export declare class StorageMonitor {
    private readonly storage;
    private readonly config;
    constructor(storage: IRawStorage, config?: StorageMonitorConfig);
    getCapacity(): Promise<StorageCapacity>;
    private estimateUsedSpace;
}
//# sourceMappingURL=storage-monitor.d.ts.map