import debug from "debug";
const log = debug("sereus:cadre:arachnode");
class ArachnodeStub {
  constructor(profile, config) {
    this.running = false;
    this.profile = profile;
    this.config = config;
    log("ArachnodeStub created for profile=%s, config=%o", profile, config);
  }
  /**
   * Start participating in rings
   */
  async start() {
    if (this.running) return;
    this.running = true;
    if (this.config.enableRingZulu) {
      log("Joining Ring Zulu (transaction ring)");
    }
    if (this.profile === "storage" && this.config.storageRing) {
      const { ring, partition = 0 } = this.config.storageRing;
      log("Joining storage ring %d, partition %d", ring, partition);
      this.ringConfig = {
        ring,
        partition,
        keyspaceStart: this.calculateKeyspaceStart(ring, partition),
        keyspaceEnd: this.calculateKeyspaceEnd(ring, partition)
      };
    }
    log("ArachnodeStub started");
  }
  /**
   * Stop participating in rings
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.ringConfig) {
      log(
        "Leaving storage ring %d, partition %d",
        this.ringConfig.ring,
        this.ringConfig.partition
      );
      this.ringConfig = void 0;
    }
    if (this.config.enableRingZulu) {
      log("Leaving Ring Zulu");
    }
    log("ArachnodeStub stopped");
  }
  /**
   * Get current ring configuration
   */
  getRingConfig() {
    return this.ringConfig;
  }
  /**
   * Check if participating in Ring Zulu
   */
  isInRingZulu() {
    return this.running && this.config.enableRingZulu;
  }
  /**
   * Check if participating in a storage ring
   */
  isInStorageRing() {
    return this.running && this.ringConfig !== void 0;
  }
  // Stub keyspace calculations
  calculateKeyspaceStart(ring, partition) {
    const numPartitions = Math.pow(2, ring);
    const partitionSize = 256 / numPartitions;
    const start = new Uint8Array(32);
    start[0] = Math.floor(partition * partitionSize);
    return start;
  }
  calculateKeyspaceEnd(ring, partition) {
    const numPartitions = Math.pow(2, ring);
    const partitionSize = 256 / numPartitions;
    const end = new Uint8Array(32);
    end[0] = Math.floor((partition + 1) * partitionSize) - 1;
    end.fill(255, 1);
    return end;
  }
}
function createArachnodeStub(profile, config) {
  const fullConfig = {
    enableRingZulu: config?.enableRingZulu ?? true,
    storageRing: profile === "storage" ? config?.storageRing ?? { ring: 0 } : void 0
  };
  return new ArachnodeStub(profile, fullConfig);
}
export {
  ArachnodeStub,
  createArachnodeStub
};
