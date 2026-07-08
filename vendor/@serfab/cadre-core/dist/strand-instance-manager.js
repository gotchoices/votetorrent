import debug from "debug";
import { createLibp2pNode } from "@optimystic/db-p2p";
import { StrandDatabase } from "./strand-database.js";
import { assertSchemaSignature } from "./schema-verification.js";
const log = debug("sereus:cadre:strand-manager");
const timing = debug("sereus:cadre:timing");
function getStrandStoragePath(basePath, strandId) {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error(
      "getStrandStoragePath is not available in React Native. Use a storage provider factory function instead."
    );
  }
  const path = require("path");
  const safeId = strandId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(basePath, "strands", safeId);
}
function resolveStrandStorage(provider, strandId) {
  if (!provider) {
    return void 0;
  }
  return typeof provider === "function" ? provider(strandId) : provider;
}
class StrandInstanceManager {
  constructor() {
    this.instances = /* @__PURE__ */ new Map();
    this.stopping = false;
    log("StrandInstanceManager created");
  }
  /**
   * Get all current strand instances
   */
  getInstances() {
    return new Map(this.instances);
  }
  /**
   * Get a specific strand instance
   */
  getInstance(strandId) {
    return this.instances.get(strandId);
  }
  /**
   * Check if a strand is currently running
   */
  hasStrand(strandId) {
    return this.instances.has(strandId);
  }
  /**
   * Start a new strand instance
   */
  async startStrand(config) {
    const { strandRow, sAppConfig } = config;
    const strandId = strandRow.Id;
    if (this.stopping) {
      throw new Error("StrandInstanceManager is stopping");
    }
    if (this.instances.has(strandId)) {
      log("Strand %s already running", strandId);
      return this.instances.get(strandId);
    }
    log("Starting strand instance: %s (sApp: %s v%s)", strandId, sAppConfig.id, sAppConfig.version);
    const tTotal = performance.now();
    assertSchemaSignature(sAppConfig);
    log("Strand %s sApp schema signature verified (author: %s)", strandId, sAppConfig.id);
    const sAppInfo = {
      id: sAppConfig.id,
      version: sAppConfig.version,
      schema: sAppConfig.schema,
      signature: sAppConfig.signature
    };
    const latencyHint = sAppConfig.latencyHint ?? config.defaultLatencyHint;
    const instance = {
      strandId,
      status: "starting",
      sAppInfo,
      memberPrivateKey: strandRow.MemberPrivateKey ?? void 0,
      connectedPeers: 0,
      lastActivity: /* @__PURE__ */ new Date(),
      latencyHint
    };
    this.instances.set(strandId, instance);
    try {
      const strandStorage = resolveStrandStorage(config.storage?.provider, strandId);
      if (strandStorage) {
        log("Strand %s using provided storage provider", strandId);
      }
      const _protocolPrefix = `/sereus/strand/${strandId}`;
      const enableRelay = config.network?.enableRelay ?? config.profile === "storage";
      let t0 = performance.now();
      const node = await createLibp2pNode({
        port: 0,
        // Random port
        bootstrapNodes: config.network?.strandBootstrapNodes ?? [],
        // cohort bootstrap forward (REPL-01)
        networkName: `strand-${strandId}`,
        storage: strandStorage,
        fretProfile: config.profile === "storage" ? "core" : "edge",
        relay: enableRelay,
        clusterSize: 4,
        clusterPolicy: {
          allowDownsize: true,
          sizeTolerance: 0.5
        },
        arachnode: {
          enableRingZulu: config.profile === "storage"
        },
        ...config.privateKey && { privateKey: config.privateKey },
        ...config.network?.transports && { transports: config.network.transports },
        ...config.network?.listenAddrs && { listenAddrs: config.network.listenAddrs },
        ...config.network?.connectionGater && { connectionGater: config.network.connectionGater },
        // T-38-12-01: the strand node is where replication/relay traffic flows,
        // so when the storage profile turns its relay server on (relay:
        // enableRelay above) its circuitRelayServer() MUST be bounded too —
        // forward the same relayServerInit from the network config.
        ...config.network?.relayServerInit && { relayServerInit: config.network.relayServerInit }
      });
      timing("[startStrand:%s] createLibp2pNode: %dms", strandId, Math.round(performance.now() - t0));
      instance.libp2pNode = node;
      t0 = performance.now();
      const strandDb = new StrandDatabase({
        strandId,
        sAppConfig,
        libp2pNode: node,
        coordinatedRepo: node.coordinatedRepo,
        mode: config.mode ?? "networked",
        rawStorage: strandStorage
      });
      await strandDb.initialize();
      timing("[startStrand:%s] strandDatabase.initialize: %dms", strandId, Math.round(performance.now() - t0));
      instance.database = strandDb;
      instance.status = "active";
      instance.lastActivity = /* @__PURE__ */ new Date();
      timing("[startStrand:%s] total: %dms", strandId, Math.round(performance.now() - tTotal));
      log("Strand %s started successfully with sApp %s", strandId, sAppConfig.id);
      return instance;
    } catch (error) {
      instance.status = "error";
      instance.error = error instanceof Error ? error.message : String(error);
      log("Failed to start strand %s: %s", strandId, instance.error);
      throw error;
    }
  }
  /**
   * Stop a strand instance
   */
  async stopStrand(strandId) {
    const instance = this.instances.get(strandId);
    if (!instance) {
      log("Strand %s not found", strandId);
      return;
    }
    log("Stopping strand instance: %s", strandId);
    instance.status = "stopping";
    try {
      if (instance.database) {
        await instance.database.close();
        instance.database = void 0;
      }
      if (instance.libp2pNode) {
        await instance.libp2pNode.stop();
        instance.libp2pNode = void 0;
      }
      instance.status = "stopped";
      this.instances.delete(strandId);
      log("Strand %s stopped successfully", strandId);
    } catch (error) {
      instance.status = "error";
      instance.error = error instanceof Error ? error.message : String(error);
      log("Error stopping strand %s: %s", strandId, instance.error);
      throw error;
    }
  }
  /**
   * Stop all strand instances
   */
  async stopAll() {
    this.stopping = true;
    log("Stopping all strand instances (%d)", this.instances.size);
    const stopPromises = Array.from(this.instances.keys()).map(
      (id) => this.stopStrand(id).catch((err) => {
        log("Error stopping strand %s during shutdown: %s", id, err);
      })
    );
    await Promise.all(stopPromises);
    this.stopping = false;
    log("All strand instances stopped");
  }
}
export {
  StrandInstanceManager,
  getStrandStoragePath
};
