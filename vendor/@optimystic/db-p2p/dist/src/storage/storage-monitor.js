/**
 * Monitors storage capacity for ring selection.
 * Provides estimates based on storage backend or supplied overrides.
 */
export class StorageMonitor {
    storage;
    config;
    constructor(storage, config = {}) {
        this.storage = storage;
        this.config = config;
    }
    async getCapacity() {
        const defaultTotal = 10 * 1024 * 1024 * 1024; // 10GB default
        const total = this.config.totalBytes ?? defaultTotal;
        const usedOverride = this.config.usedBytes;
        const availableOverride = this.config.availableBytes;
        // Only short-circuit the backend when used/available is explicitly supplied;
        // a bare `totalBytes` is just the disk-size hint and should still let the
        // backend report actual used bytes.
        const rawUsed = usedOverride
            ?? (availableOverride !== undefined ? total - availableOverride : await this.estimateUsedSpace());
        const used = Math.min(total, Math.max(0, rawUsed));
        const available = availableOverride !== undefined
            ? Math.max(0, Math.min(total, availableOverride))
            : Math.max(0, total - used);
        return {
            total,
            used,
            available
        };
    }
    async estimateUsedSpace() {
        return (await this.storage.getApproximateBytesUsed?.()) ?? 0;
    }
}
//# sourceMappingURL=storage-monitor.js.map