import debug from "debug";
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from "uint8arrays";
import { createLibp2pNode } from "@optimystic/db-p2p";
import { StrandWatcher } from "./strand-watcher.js";
import { StrandInstanceManager } from "./strand-instance-manager.js";
import { EnrollmentService } from "./enrollment.js";
import { HibernationManager } from "./hibernation-manager.js";
import { ControlDatabase } from "./control-database.js";
import { SeedBootstrapService } from "./seed-bootstrap.js";
import {
  StrandSolicitationService
} from "./strand-solicitation.js";
const log = debug("sereus:cadre:node");
const timing = debug("sereus:cadre:timing");
class CadreNode {
  constructor(config) {
    this.controlNode = null;
    this.controlDatabase = null;
    this.strandWatcher = null;
    this.seedBootstrapService = null;
    this.strandSolicitationService = null;
    this.running = false;
    this.eventHandlers = /* @__PURE__ */ new Map();
    /** Map of strandId -> sAppConfig for sAppId filtering and management */
    this.sAppConfigs = /* @__PURE__ */ new Map();
    this.config = config;
    this.strandManager = new StrandInstanceManager();
    this.enrollmentService = new EnrollmentService();
    const hibernationCallbacks = {
      onIdle: async (strandId) => this.handleStrandIdle(strandId),
      onHibernate: async (strandId) => this.handleStrandHibernate(strandId),
      onWake: async (strandId) => this.handleStrandWake(strandId)
    };
    this.hibernationManager = new HibernationManager(
      config.hibernation ?? { enabled: false },
      hibernationCallbacks
    );
    log("CadreNode created for party: %s", config.controlNetwork.partyId);
  }
  /**
   * SAppIdLookup implementation - get sAppId for a strand
   */
  getSAppId(strandId) {
    return this.sAppConfigs.get(strandId)?.id;
  }
  /**
   * Get the peer ID of this node (available after start)
   */
  get peerId() {
    return this.controlNode?.peerId;
  }
  /**
   * Get the multiaddrs of this node (available after start)
   */
  getMultiaddrs() {
    if (!this.controlNode) return [];
    return this.controlNode.getMultiaddrs().map((ma) => ma.toString());
  }
  /**
   * Check if the node is running
   */
  get isRunning() {
    return this.running;
  }
  /**
   * Get all strand instances
   */
  getStrands() {
    return this.strandManager.getInstances();
  }
  /**
   * Get a specific strand instance
   */
  getStrand(strandId) {
    return this.strandManager.getInstance(strandId);
  }
  /**
   * Get the enrollment service for adding new peers
   */
  getEnrollmentService() {
    return this.enrollmentService;
  }
  /**
   * Start the cadre node
   */
  async start() {
    if (this.running) {
      log("CadreNode already running");
      return;
    }
    log("Starting CadreNode for party: %s", this.config.controlNetwork.partyId);
    try {
      const tTotal = performance.now();
      let t0 = performance.now();
      this.controlNode = await this.createControlNode();
      timing("[start] createControlNode: %dms", Math.round(performance.now() - t0));
      log("Control node started with ID: %s", this.controlNode.peerId.toString());
      const coordinatedRepo = this.controlNode.coordinatedRepo;
      if (!coordinatedRepo) {
        throw new Error("coordinatedRepo not available on control node");
      }
      t0 = performance.now();
      this.controlDatabase = new ControlDatabase({
        partyId: this.config.controlNetwork.partyId,
        libp2pNode: this.controlNode,
        coordinatedRepo,
        schemaPath: this.config.controlNetwork.schemaPath
      });
      await this.controlDatabase.initialize();
      timing("[start] controlDatabase.initialize: %dms", Math.round(performance.now() - t0));
      log("Control database initialized");
      const queryable = this.createStrandQueryable();
      this.strandWatcher = new StrandWatcher(
        queryable,
        {
          onStrandAdded: async (strand) => this.handleStrandAdded(strand),
          onStrandRemoved: async (strandId) => this.handleStrandRemoved(strandId)
        },
        this.config.strandFilter ?? { mode: "all" },
        this.config.strandWatchInterval ?? 5e3,
        this
        // CadreNode implements SAppIdLookup
      );
      t0 = performance.now();
      await this.strandWatcher.start();
      timing("[start] strandWatcher.start: %dms", Math.round(performance.now() - t0));
      this.hibernationManager.start();
      this.running = true;
      this.emit("control:connected", void 0);
      timing("[start] total: %dms", Math.round(performance.now() - tTotal));
      log("CadreNode started successfully");
      this.scheduleSelfRegistration();
    } catch (error) {
      log("Failed to start CadreNode: %o", error);
      await this.cleanup();
      throw error;
    }
  }
  /**
   * Stop the cadre node
   */
  async stop() {
    if (!this.running) {
      log("CadreNode not running");
      return;
    }
    log("Stopping CadreNode");
    await this.cleanup();
    this.running = false;
    this.emit("control:disconnected", void 0);
    log("CadreNode stopped");
  }
  /**
   * Subscribe to events
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, /* @__PURE__ */ new Set());
    }
    this.eventHandlers.get(event).add(handler);
  }
  /**
   * Unsubscribe from events
   */
  off(event, handler) {
    this.eventHandlers.get(event)?.delete(handler);
  }
  emit(event, data) {
    this.eventHandlers.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (e) {
        log("Event handler error: %o", e);
      }
    });
  }
  async createControlNode() {
    const { controlNetwork, network, storage, profile, privateKey } = this.config;
    const enableRelay = network?.enableRelay ?? profile === "storage";
    const controlStorageProvider = storage?.provider ? typeof storage.provider === "function" ? storage.provider("control") : storage.provider : void 0;
    const nodeOptions = {
      port: 0,
      bootstrapNodes: controlNetwork.bootstrapNodes,
      networkName: `control-${controlNetwork.partyId}`,
      storage: controlStorageProvider,
      fretProfile: profile === "storage" ? "core" : "edge",
      relay: enableRelay,
      clusterSize: 3,
      clusterPolicy: { allowDownsize: true, sizeTolerance: 0.5 },
      arachnode: { enableRingZulu: this.config.profile === "storage" },
      ...privateKey && { privateKey },
      ...network?.transports && { transports: network.transports },
      ...network?.listenAddrs && { listenAddrs: network.listenAddrs },
      ...network?.connectionGater && { connectionGater: network.connectionGater }
    };
    return await createLibp2pNode(nodeOptions);
  }
  createStrandQueryable() {
    return {
      queryStrands: async () => {
        if (!this.controlDatabase) {
          log("Control database not initialized, returning empty strands");
          return [];
        }
        log("Querying strands from control database");
        return await this.controlDatabase.queryStrands();
      }
    };
  }
  /**
   * Schedule self-registration in the CadrePeer table.
   * This runs as a background task after the node is started.
   */
  scheduleSelfRegistration() {
    setTimeout(async () => {
      try {
        await this.registerSelf();
      } catch (error) {
        log("Self-registration failed: %o", error);
      }
    }, 1e3);
  }
  /**
   * Register this peer in the CadrePeer table.
   * This allows other cadre members to discover this node.
   */
  async registerSelf() {
    if (!this.controlNode || !this.controlDatabase) {
      log("Cannot register self - node or database not initialized");
      return;
    }
    const peerId = this.controlNode.peerId.toString();
    const multiaddrs = this.controlNode.getMultiaddrs();
    if (multiaddrs.length === 0) {
      log("No multiaddrs available for self-registration");
      return;
    }
    const multiaddr = multiaddrs[0].toString();
    log("Registering self: peerId=%s, multiaddr=%s", peerId, multiaddr);
    log("Self-registration requires authorization - skipping for now");
  }
  async handleStrandAdded(strand) {
    log("Handling strand added from control network: %s", strand.Id);
    const sAppConfig = this.sAppConfigs.get(strand.Id);
    if (!sAppConfig) {
      log("No sAppConfig registered for strand %s - skipping auto-start", strand.Id);
      return;
    }
    try {
      const instance = await this.strandManager.startStrand({
        strandRow: strand,
        sAppConfig,
        storage: this.config.storage,
        network: this.config.network,
        profile: this.config.profile,
        defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? "interactive",
        privateKey: this.config.privateKey
      });
      this.hibernationManager.trackStrand(instance);
      this.emit("strand:started", { strandId: strand.Id });
    } catch (error) {
      log("Error starting strand %s: %o", strand.Id, error);
      this.emit("strand:error", {
        strandId: strand.Id,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }
  async handleStrandRemoved(strandId) {
    log("Handling strand removed: %s", strandId);
    try {
      this.hibernationManager.untrackStrand(strandId);
      this.sAppConfigs.delete(strandId);
      await this.strandManager.stopStrand(strandId);
      this.emit("strand:stopped", { strandId });
    } catch (error) {
      log("Error stopping strand %s: %o", strandId, error);
      this.emit("strand:error", {
        strandId,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }
  async cleanup() {
    this.hibernationManager.stop();
    if (this.seedBootstrapService) {
      await this.seedBootstrapService.shutdown();
      this.seedBootstrapService = null;
    }
    if (this.strandSolicitationService && this.controlNode) {
      this.strandSolicitationService.unregisterResponder(this.controlNode);
      this.strandSolicitationService = null;
    }
    if (this.strandWatcher) {
      await this.strandWatcher.stop();
      this.strandWatcher = null;
    }
    await this.strandManager.stopAll();
    this.sAppConfigs.clear();
    if (this.controlDatabase) {
      await this.controlDatabase.close();
      this.controlDatabase = null;
    }
    if (this.controlNode) {
      await this.controlNode.stop();
      this.controlNode = null;
    }
  }
  // Hibernation callbacks
  async handleStrandIdle(strandId) {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = "idle";
      log("Strand %s transitioned to idle", strandId);
      this.emit("strand:idle", { strandId });
    }
  }
  async handleStrandHibernate(strandId) {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = "hibernating";
      log("Strand %s transitioned to hibernating", strandId);
      this.emit("strand:hibernating", { strandId });
    }
  }
  async handleStrandWake(strandId) {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      instance.status = "active";
      instance.lastActivity = /* @__PURE__ */ new Date();
      log("Strand %s woke up", strandId);
      this.emit("strand:waking", { strandId });
    }
  }
  /**
   * Add a strand with its sApp configuration.
   * The hosting application must provide the sApp schema when creating a strand.
   */
  async addStrand(config) {
    if (!this.running) {
      throw new Error("CadreNode not running");
    }
    const { strandRow, sAppConfig, mode } = config;
    this.sAppConfigs.set(strandRow.Id, sAppConfig);
    log("Registered sAppConfig for strand %s (sApp: %s, mode: %s)", strandRow.Id, sAppConfig.id, mode ?? "networked");
    const instance = await this.strandManager.startStrand({
      strandRow,
      sAppConfig,
      storage: this.config.storage,
      network: this.config.network,
      profile: this.config.profile,
      defaultLatencyHint: this.config.hibernation?.defaultLatencyHint ?? "interactive",
      privateKey: this.config.privateKey,
      mode
    });
    this.hibernationManager.trackStrand(instance);
    this.emit("strand:started", { strandId: strandRow.Id });
    return instance;
  }
  /**
   * Remove a strand
   */
  async removeStrand(strandId) {
    if (!this.running) {
      throw new Error("CadreNode not running");
    }
    this.hibernationManager.untrackStrand(strandId);
    this.sAppConfigs.delete(strandId);
    await this.strandManager.stopStrand(strandId);
    this.emit("strand:stopped", { strandId });
  }
  /**
   * Record activity on a strand (resets hibernation timer)
   */
  recordStrandActivity(strandId) {
    const instance = this.strandManager.getInstance(strandId);
    if (instance) {
      this.hibernationManager.recordActivity(instance);
    }
  }
  /**
   * Force wake a hibernating strand
   */
  async wakeStrand(strandId) {
    await this.hibernationManager.wakeStrand(strandId);
  }
  /**
   * Get the control network node (for advanced use)
   */
  getControlNode() {
    return this.controlNode;
  }
  /**
   * Get the control database (for advanced queries)
   */
  getControlDatabase() {
    return this.controlDatabase;
  }
  /**
   * Force a poll of the strand watcher (for testing)
   */
  async forceStrandPoll() {
    await this.strandWatcher?.forcePoll();
  }
  /**
   * Get the sApp configuration for a strand
   */
  getSAppConfig(strandId) {
    return this.sAppConfigs.get(strandId);
  }
  // ============================================================================
  // Seed Bootstrap API
  // ============================================================================
  /**
   * Initialize the seed bootstrap service with an authority key.
   * Must be called before using seed-related methods that require signing.
   *
   * @param authorityPrivateKey - The authority's private key (base64url encoded)
   */
  initializeSeedBootstrap(authorityPrivateKey) {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error("CadreNode must be started before initializing seed bootstrap");
    }
    this.seedBootstrapService = new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      authorityPrivateKey,
      ...this.config.network?.inviteAddressResolver ? { inviteAddressResolver: this.config.network.inviteAddressResolver } : {}
    });
    this.seedBootstrapService.setEventCallbacks({
      onSeedReceived: (partyId, peerId) => this.emit("seed:received", { partyId, peerId }),
      onSeedApplied: (partyId, peersAdded) => this.emit("seed:applied", { partyId, peersAdded }),
      onSeedError: (partyId, error) => this.emit("seed:error", { partyId, error })
    });
    this.seedBootstrapService.initialize(this.controlNode, this.controlDatabase);
    log("Seed bootstrap service initialized");
  }
  /**
   * Enable the seed listener for receiving seeds via the /sereus/seed/1.0.0 protocol.
   * This is for drone nodes that need to receive seeds without being an authority.
   * Does not require an authority key.
   */
  enableSeedListener() {
    if (!this.controlNode || !this.controlDatabase) {
      throw new Error("CadreNode must be started before enabling seed listener");
    }
    if (this.seedBootstrapService) {
      log("Seed bootstrap service already initialized");
      return;
    }
    this.seedBootstrapService = new SeedBootstrapService({
      partyId: this.config.controlNetwork.partyId,
      // No authority key - this node only receives seeds
      ...this.config.network?.inviteAddressResolver ? { inviteAddressResolver: this.config.network.inviteAddressResolver } : {}
    });
    this.seedBootstrapService.setEventCallbacks({
      onSeedReceived: (partyId, peerId) => this.emit("seed:received", { partyId, peerId }),
      onSeedApplied: (partyId, peersAdded) => this.emit("seed:applied", { partyId, peersAdded }),
      onSeedError: (partyId, error) => this.emit("seed:error", { partyId, error })
    });
    this.seedBootstrapService.initialize(this.controlNode, this.controlDatabase);
    log("Seed listener enabled");
  }
  /**
   * Get the seed bootstrap service (for advanced use)
   */
  getSeedBootstrapService() {
    return this.seedBootstrapService;
  }
  /**
   * Authorize a new peer to join the cadre.
   * Signs the peer ID with the authority key and inserts into CadrePeer table.
   *
   * @param peerId - The peer ID to authorize
   * @param multiaddrs - Optional multiaddrs for the peer
   */
  async authorizePeer(peerId, multiaddrs) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    await this.seedBootstrapService.authorizePeer({ peerId, multiaddrs });
  }
  /**
   * Remove a previously-authorized peer from the cadre.
   * Signs the peer ID with the authority key and deletes the CadrePeer row.
   *
   * @param peerId - The peer ID to remove
   */
  async removePeer(peerId) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    await this.seedBootstrapService.removePeer(peerId);
  }
  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an authority.
   */
  async createSeed() {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    return await this.seedBootstrapService.createSeed();
  }
  /**
   * Apply a seed to populate the peer cache and enable connections.
   * Validates the seed signature before applying.
   */
  async applySeed(seed) {
    if (!this.seedBootstrapService) {
      const tempService = new SeedBootstrapService({
        partyId: seed.partyId
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase);
      }
      return await tempService.applySeed(seed);
    }
    return await this.seedBootstrapService.applySeed(seed);
  }
  /**
   * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
   */
  async deliverSeed(targetMultiaddr, seed) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    return await this.seedBootstrapService.deliverSeed(targetMultiaddr, seed);
  }
  /**
   * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
   */
  encodeSeed(seed) {
    const json = JSON.stringify(seed);
    return uint8ArrayToString(new TextEncoder().encode(json), "base64url");
  }
  /**
   * Decode a seed from base64url encoding.
   */
  decodeSeed(encoded) {
    const bytes = uint8ArrayFromString(encoded, "base64url");
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }
  /**
   * Get this node's circuit relay address for inclusion in seeds.
   * Returns null if no relay address is available.
   */
  async getRelayAddress() {
    if (!this.controlNode) {
      return null;
    }
    const addrs = this.controlNode.getMultiaddrs();
    const relayAddr = addrs.find((addr) => addr.toString().includes("/p2p-circuit/"));
    return relayAddr?.toString() ?? null;
  }
  // ============================================================================
  // Seed Bootstrap Helper Methods
  // ============================================================================
  /**
   * Add a drone to the cadre (for phone/server adding provider-hosted node).
   * Creates authorization and seed for drone initialization.
   */
  async addDrone(options) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    return await this.seedBootstrapService.addDrone(options);
  }
  /**
   * Create an invite for a phone to join the cadre.
   * Use when a server wants to invite a NAT'd phone.
   */
  async createInvite(token, expiresIn) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    return await this.seedBootstrapService.createInvite(token, expiresIn);
  }
  /**
   * Accept a phone connection using an invite.
   * Call this when a phone dials in with an invite token.
   */
  async acceptPhone(options, issuedInvite) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    await this.seedBootstrapService.acceptPhone(options, issuedInvite);
  }
  /**
   * Add a phone to the cadre with relay support.
   * Use when both nodes are NAT'd (phone-to-phone).
   */
  async addPhoneWithRelay(phonePeerId) {
    if (!this.seedBootstrapService) {
      throw new Error("Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.");
    }
    return await this.seedBootstrapService.addPhoneWithRelay(phonePeerId);
  }
  /**
   * Encode an invite for out-of-band delivery (QR, link, etc.).
   */
  encodeInvite(invite) {
    const json = JSON.stringify(invite);
    return uint8ArrayToString(new TextEncoder().encode(json), "base64url");
  }
  /**
   * Decode an invite from base64url encoding.
   */
  decodeInvite(encoded) {
    const bytes = uint8ArrayFromString(encoded, "base64url");
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }
  /**
   * Dial an authority from an invite (for phone joining via invite).
   */
  async dialInvite(invite) {
    if (!this.seedBootstrapService) {
      const tempService = new SeedBootstrapService({
        partyId: invite.partyId
      });
      if (this.controlNode && this.controlDatabase) {
        tempService.initialize(this.controlNode, this.controlDatabase);
      }
      await tempService.dialInvite(invite);
      return;
    }
    await this.seedBootstrapService.dialInvite(invite);
  }
  // ============================================================================
  // Strand Solicitation API (strand-proto integration)
  // ============================================================================
  /**
   * Initialize the strand solicitation service.
   * This enables forming strands with other parties via open invitations.
   *
   * @param options - Configuration for the solicitation service
   */
  initializeStrandSolicitation(options) {
    if (!this.controlNode) {
      throw new Error("CadreNode must be started before initializing strand solicitation");
    }
    this.strandSolicitationService = new StrandSolicitationService({
      ...options,
      partyId: this.config.controlNetwork.partyId,
      cadrePeerAddrs: this.getMultiaddrs()
    });
    this.strandSolicitationService.registerResponder(this.controlNode);
    log("Strand solicitation service initialized");
  }
  /**
   * Get the strand solicitation service (for advanced use)
   */
  getStrandSolicitationService() {
    return this.strandSolicitationService;
  }
  /**
   * Create an open invitation for others to form strands with this party.
   *
   * @param sAppId - The sApp to use for formed strands
   * @param expirationMs - How long the invitation is valid (ms from now)
   * @returns The open invitation to share out-of-band
   */
  async createOpenInvitation(sAppId, expirationMs = 24 * 60 * 60 * 1e3) {
    if (!this.strandSolicitationService) {
      this.initializeStrandSolicitation();
    }
    const bootstrap = this.getMultiaddrs();
    if (bootstrap.length === 0) {
      throw new Error("No multiaddrs available for invitation");
    }
    return await this.strandSolicitationService.createOpenInvitation(
      sAppId,
      expirationMs,
      bootstrap
    );
  }
  /**
   * Form a strand with a responder via an open invitation.
   *
   * @param invitation - The open invitation received out-of-band
   * @param disclosure - Identity/context information to share with the responder
   * @returns The member key and strand info if successful
   */
  async formStrand(invitation, disclosure = {}) {
    if (!this.controlNode) {
      throw new Error("CadreNode must be started before forming strands");
    }
    if (!this.strandSolicitationService) {
      this.initializeStrandSolicitation();
    }
    return await this.strandSolicitationService.formStrand(
      invitation,
      disclosure,
      this.controlNode
    );
  }
  /**
   * Encode an open invitation for out-of-band delivery (QR, link, etc.).
   */
  encodeInvitation(invitation) {
    const json = JSON.stringify({
      ...invitation,
      expiration: invitation.expiration.toISOString()
    });
    return uint8ArrayToString(new TextEncoder().encode(json), "base64url");
  }
  /**
   * Decode an open invitation from base64url encoding.
   */
  decodeInvitation(encoded) {
    const bytes = uint8ArrayFromString(encoded, "base64url");
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return {
      ...parsed,
      expiration: new Date(parsed.expiration)
    };
  }
}
export {
  CadreNode
};
