import debug from "debug";
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from "uint8arrays";
import { digest, sign, verify, getPublicKey } from "@optimystic/quereus-plugin-crypto";
import { multiaddr } from "@multiformats/multiaddr";
import { peerIdFromString } from "@libp2p/peer-id";
const log = debug("sereus:cadre:seed-bootstrap");
const SEED_PROTOCOL = "/sereus/seed/1.0.0";
const MAX_SEED_SIZE = 1024 * 1024;
class SeedBootstrapService {
  constructor(config) {
    this.libp2pNode = null;
    this.controlDatabase = null;
    this.eventCallbacks = {};
    this.config = config;
    if (config.authorityPrivateKey && !config.authorityPublicKey) {
      this.authorityPublicKey = getPublicKey(
        config.authorityPrivateKey,
        "ed25519",
        "base64url",
        "base64url"
      );
    } else {
      this.authorityPublicKey = config.authorityPublicKey ?? null;
    }
    log("SeedBootstrapService created for party: %s", config.partyId);
  }
  /**
   * Set event callbacks for seed-related events.
   * Used by CadreNode to emit events.
   */
  setEventCallbacks(callbacks) {
    this.eventCallbacks = callbacks;
  }
  /**
   * Initialize the service with libp2p node and control database
   */
  initialize(libp2pNode, controlDatabase) {
    this.libp2pNode = libp2pNode;
    this.controlDatabase = controlDatabase;
    this.registerProtocolHandler();
    log("SeedBootstrapService initialized");
  }
  /**
   * Authorize a new peer to join the cadre.
   * Signs the peer ID with the authority key and inserts into CadrePeer table.
   */
  async authorizePeer(options) {
    const { peerId, multiaddrs } = options;
    if (!this.config.authorityPrivateKey) {
      throw new Error("Authority private key required to authorize peers");
    }
    if (!this.controlDatabase) {
      throw new Error("Control database not initialized");
    }
    log("Authorizing peer: %s", peerId);
    const peerIdDigest = digest(peerId, "sha256", "utf8", "base64url");
    const signature = sign(
      peerIdDigest,
      this.config.authorityPrivateKey,
      "ed25519",
      "base64url",
      "base64url",
      "base64url"
    );
    const db = this.controlDatabase.getDatabase();
    const multiaddrStr = multiaddrs?.length ? multiaddrs.join(",") : "";
    await db.exec(`
      insert into CadreControl.CadrePeer (PeerId, Multiaddr)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?)
    `, [this.authorityPublicKey, signature, peerId, multiaddrStr]);
    log("Peer %s authorized successfully", peerId);
  }
  /**
   * Remove a peer from the cadre by authority signature.
   *
   * The constraint over CadrePeer's `check on insert, delete` validates a
   * signature over `digest(old.PeerId, 'sha256', 'utf8')` by an authority
   * key. We use the same digest pattern as authorizePeer.
   */
  async removePeer(peerId) {
    if (!this.config.authorityPrivateKey) {
      throw new Error("Authority private key required to remove peers");
    }
    if (!this.controlDatabase) {
      throw new Error("Control database not initialized");
    }
    log("Removing peer: %s", peerId);
    const peerIdDigest = digest(peerId, "sha256", "utf8", "base64url");
    const signature = sign(
      peerIdDigest,
      this.config.authorityPrivateKey,
      "ed25519",
      "base64url",
      "base64url",
      "base64url"
    );
    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      delete from CadreControl.CadrePeer
        with context AuthorityKey = ?, Signature = ?
        where PeerId = ?
    `, [this.authorityPublicKey, signature, peerId]);
    log("Peer %s removed successfully", peerId);
  }
  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an authority.
   */
  async createSeed() {
    if (!this.config.authorityPrivateKey || !this.authorityPublicKey) {
      throw new Error("Authority key required to create seeds");
    }
    if (!this.controlDatabase || !this.libp2pNode) {
      throw new Error("Service not initialized");
    }
    log("Creating seed for party: %s", this.config.partyId);
    const peers = await this.queryPeers();
    const seedData = {
      partyId: this.config.partyId,
      peers
    };
    const seedJson = JSON.stringify(seedData);
    const seedDigest = digest(seedJson, "sha256", "utf8", "base64url");
    const signature = sign(
      seedDigest,
      this.config.authorityPrivateKey,
      "ed25519",
      "base64url",
      "base64url",
      "base64url"
    );
    const seed = {
      ...seedData,
      signature,
      signerKey: this.authorityPublicKey
    };
    log("Created seed with %d peers", peers.length);
    return seed;
  }
  /**
   * Apply a seed to populate the peer cache and enable connections.
   * Validates the seed signature before applying.
   */
  async applySeed(seed) {
    if (!this.libp2pNode) {
      return { success: false, peersAdded: 0, error: "Service not initialized" };
    }
    log("Applying seed for party: %s", seed.partyId);
    if (!this.validateSeedSignature(seed)) {
      return { success: false, peersAdded: 0, error: "Invalid seed signature" };
    }
    const signerIsAuthority = seed.peers.some(
      (p) => p.isAuthority && p.publicKey === seed.signerKey
    );
    if (!signerIsAuthority) {
      return { success: false, peersAdded: 0, error: "Signer key does not match any authority peer" };
    }
    let peersAdded = 0;
    for (const peer of seed.peers) {
      try {
        if (peer.multiaddrs.length > 0) {
          const peerId = peerIdFromString(peer.peerId);
          const addrs = peer.multiaddrs.map((ma) => multiaddr(ma));
          await this.libp2pNode.peerStore.merge(peerId, {
            multiaddrs: addrs
          });
          peersAdded++;
          log("Added peer to store: %s with %d addrs", peer.peerId, addrs.length);
        }
      } catch (error) {
        log("Failed to add peer %s: %o", peer.peerId, error);
      }
    }
    for (const peer of seed.peers.filter((p) => p.isAuthority)) {
      try {
        if (peer.multiaddrs.length > 0) {
          const addr = multiaddr(peer.multiaddrs[0]);
          log("Dialing authority peer: %s", peer.peerId);
          await this.libp2pNode.dial(addr);
        }
      } catch (error) {
        log("Failed to dial peer %s: %o", peer.peerId, error);
      }
    }
    log("Applied seed: %d peers added", peersAdded);
    return { success: true, peersAdded };
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
   * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
   */
  async deliverSeed(targetMultiaddr, seed) {
    if (!this.libp2pNode) {
      throw new Error("Service not initialized");
    }
    const addr = multiaddr(targetMultiaddr);
    log("Delivering seed to: %s", targetMultiaddr);
    const rawStream = await this.libp2pNode.dialProtocol(addr, SEED_PROTOCOL);
    const stream = rawStream;
    try {
      const message = {
        partyId: seed.partyId,
        peers: seed.peers,
        transactions: seed.transactions,
        signature: seed.signature,
        signerKey: seed.signerKey
      };
      const messageBytes = new TextEncoder().encode(JSON.stringify(message));
      const lengthBytes = new Uint8Array(4);
      new DataView(lengthBytes.buffer).setUint32(0, messageBytes.length, false);
      stream.send(lengthBytes);
      stream.send(messageBytes);
      await stream.close();
      const chunks = [];
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        chunks.push(bytes);
      }
      const responseData = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        responseData.set(chunk, offset);
        offset += chunk.length;
      }
      const responseLength = new DataView(responseData.buffer, responseData.byteOffset).getUint32(0, false);
      const responseJson = new TextDecoder().decode(responseData.slice(4, 4 + responseLength));
      const ack = JSON.parse(responseJson);
      log("Seed delivery response: accepted=%s", ack.accepted);
      return ack;
    } catch (err) {
      stream.abort(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }
  /**
   * Get this node's circuit relay address for inclusion in seeds.
   * Returns null if no relay address is available.
   */
  async getRelayAddress() {
    if (!this.libp2pNode) {
      return null;
    }
    const addrs = this.libp2pNode.getMultiaddrs();
    const relayAddr = addrs.find((addr) => addr.toString().includes("/p2p-circuit/"));
    return relayAddr?.toString() ?? null;
  }
  /**
   * Validate a seed's signature.
   */
  validateSeedSignature(seed) {
    try {
      const seedData = {
        partyId: seed.partyId,
        peers: seed.peers,
        ...seed.transactions ? { transactions: seed.transactions } : {}
      };
      const seedJson = JSON.stringify(seedData);
      const seedDigest = digest(seedJson, "sha256", "utf8", "base64url");
      return verify(
        seedDigest,
        seed.signature,
        seed.signerKey,
        "ed25519",
        "base64url",
        "base64url",
        "base64url"
      );
    } catch (error) {
      log("Seed signature validation failed: %o", error);
      return false;
    }
  }
  /**
   * Query peers from the control database.
   */
  async queryPeers() {
    if (!this.controlDatabase) {
      return [];
    }
    const db = this.controlDatabase.getDatabase();
    const peers = [];
    const authorityKeys = /* @__PURE__ */ new Set();
    for await (const row of db.eval("select Key from CadreControl.AuthorityKey")) {
      authorityKeys.add(row.Key);
    }
    for await (const row of db.eval("select PeerId, Multiaddr from CadreControl.CadrePeer")) {
      const peerId = row.PeerId;
      const multiaddr2 = row.Multiaddr;
      const isAuthority = peerId === this.libp2pNode?.peerId.toString();
      peers.push({
        peerId,
        multiaddrs: multiaddr2 ? multiaddr2.split(",") : [],
        isAuthority,
        ...isAuthority && this.authorityPublicKey ? { publicKey: this.authorityPublicKey } : {}
      });
    }
    return peers;
  }
  /**
   * Register the seed protocol handler.
   */
  registerProtocolHandler() {
    if (!this.libp2pNode) return;
    this.libp2pNode.handle(SEED_PROTOCOL, async (rawStream, rawConnection) => {
      const stream = rawStream;
      const remotePeerId = rawConnection.remotePeer.toString();
      log("Incoming seed delivery from: %s", remotePeerId);
      try {
        const chunks = [];
        let totalLength = 0;
        for await (const chunk of stream) {
          const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
          chunks.push(bytes);
          totalLength += bytes.length;
          if (totalLength > MAX_SEED_SIZE) {
            throw new Error("Seed message too large");
          }
        }
        const data = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        const messageLength = new DataView(data.buffer, data.byteOffset).getUint32(0, false);
        const messageJson = new TextDecoder().decode(data.slice(4, 4 + messageLength));
        const message = JSON.parse(messageJson);
        this.eventCallbacks.onSeedReceived?.(message.partyId, remotePeerId);
        const seed = {
          partyId: message.partyId,
          peers: message.peers,
          transactions: message.transactions,
          signature: message.signature,
          signerKey: message.signerKey
        };
        const result = await this.applySeed(seed);
        if (result.success) {
          this.eventCallbacks.onSeedApplied?.(seed.partyId, result.peersAdded);
        } else {
          this.eventCallbacks.onSeedError?.(seed.partyId, result.error ?? "Unknown error");
        }
        const ack = {
          accepted: result.success,
          reason: result.error
        };
        const ackBytes = new TextEncoder().encode(JSON.stringify(ack));
        const lengthBytes = new Uint8Array(4);
        new DataView(lengthBytes.buffer).setUint32(0, ackBytes.length, false);
        stream.send(lengthBytes);
        stream.send(ackBytes);
      } catch (error) {
        log("Error handling seed delivery: %o", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        this.eventCallbacks.onSeedError?.(this.config.partyId, errorMessage);
        const ack = {
          accepted: false,
          reason: errorMessage
        };
        const ackBytes = new TextEncoder().encode(JSON.stringify(ack));
        const lengthBytes = new Uint8Array(4);
        new DataView(lengthBytes.buffer).setUint32(0, ackBytes.length, false);
        try {
          stream.send(lengthBytes);
          stream.send(ackBytes);
        } catch {
        }
      } finally {
        await stream.close();
      }
    });
    log("Registered seed protocol handler: %s", SEED_PROTOCOL);
  }
  /**
   * Shutdown the service.
   */
  async shutdown() {
    if (this.libp2pNode) {
      await this.libp2pNode.unhandle(SEED_PROTOCOL);
    }
    this.libp2pNode = null;
    this.controlDatabase = null;
    log("SeedBootstrapService shutdown");
  }
  // ============================================================================
  // Helper Functions for Common Scenarios
  // ============================================================================
  /**
   * Add a drone to the cadre (phone/server adds provider-hosted node).
   *
   * Use this when you've spawned a drone via provider API and received its
   * peer ID and multiaddrs. This method:
   * 1. Authorizes the drone peer
   * 2. Creates a seed including all current peers
   * 3. Returns the seed for sending to provider API
   *
   * @param options - Drone peer info from provider API
   * @returns Seed and encoded seed for drone initialization
   */
  async addDrone(options) {
    const { dronePeerId, droneMultiaddrs } = options;
    log("Adding drone: %s", dronePeerId);
    await this.authorizePeer({ peerId: dronePeerId, multiaddrs: droneMultiaddrs });
    const seed = await this.createSeed();
    const encodedSeed = this.encodeSeed(seed);
    log("Drone %s added, seed created with %d peers", dronePeerId, seed.peers.length);
    return { seed, encodedSeed };
  }
  /**
   * Create an invite for a phone to join the cadre.
   *
   * Use this when a server (public IP) wants to invite a phone (NAT'd).
   * The invite is shared out-of-band (QR code, link, etc.) and contains
   * the server's address so the phone can dial in.
   *
   * @param token - Optional invite token for validation
   * @param expiresIn - Optional expiration time in milliseconds
   * @returns Invite and encoded invite for sharing
   */
  async createInvite(token, expiresIn) {
    if (!this.libp2pNode) {
      throw new Error("Service not initialized");
    }
    log("Creating invite for phone");
    let authorityAddrs;
    if (this.config.inviteAddressResolver) {
      try {
        authorityAddrs = await this.config.inviteAddressResolver();
      } catch (err) {
        log("inviteAddressResolver threw, falling back to libp2pNode.getMultiaddrs(): %o", err);
        authorityAddrs = this.libp2pNode.getMultiaddrs().map((a) => a.toString());
      }
    } else {
      authorityAddrs = this.libp2pNode.getMultiaddrs().map((a) => a.toString());
    }
    const now = Date.now();
    const invite = {
      partyId: this.config.partyId,
      authorityAddrs,
      token,
      createdAt: now,
      expiresAt: expiresIn ? now + expiresIn : void 0
    };
    const encodedInvite = this.encodeInvite(invite);
    log("Invite created with %d authority addresses", authorityAddrs.length);
    return { invite, encodedInvite };
  }
  /**
   * Accept a phone connection using an invite.
   *
   * Use this when a phone dials in with an invite token. This method:
   * 1. Validates the token if provided
   * 2. Authorizes the phone peer
   *
   * After this, the phone can sync the control database normally.
   *
   * @param options - Phone peer info and invite token
   * @param issuedInvite - The original invite for validation
   */
  async acceptPhone(options, issuedInvite) {
    const { phonePeerId, token } = options;
    log("Accepting phone: %s", phonePeerId);
    if (issuedInvite) {
      if (issuedInvite.token && issuedInvite.token !== token) {
        throw new Error("Invalid invite token");
      }
      if (issuedInvite.expiresAt && Date.now() > issuedInvite.expiresAt) {
        throw new Error("Invite has expired");
      }
    }
    await this.authorizePeer({ peerId: phonePeerId });
    log("Phone %s accepted and authorized", phonePeerId);
  }
  /**
   * Add a phone to the cadre with relay support.
   *
   * Use this when both nodes are NAT'd (phone-to-phone). This method:
   * 1. Authorizes the new phone peer
   * 2. Creates a seed with relay addresses for dialing
   *
   * @param phonePeerId - Peer ID of the new phone
   * @returns Seed with relay addresses for out-of-band delivery
   */
  async addPhoneWithRelay(phonePeerId) {
    log("Adding phone with relay: %s", phonePeerId);
    await this.authorizePeer({ peerId: phonePeerId });
    const relayAddr = await this.getRelayAddress();
    const seed = await this.createSeed();
    if (relayAddr && this.libp2pNode) {
      const ourPeerId = this.libp2pNode.peerId.toString();
      const ourPeer = seed.peers.find((p) => p.peerId === ourPeerId);
      if (ourPeer && !ourPeer.multiaddrs.includes(relayAddr)) {
        ourPeer.multiaddrs.push(relayAddr);
      }
    }
    const encodedSeed = this.encodeSeed(seed);
    log("Phone %s added with relay, seed created", phonePeerId);
    return { seed, encodedSeed };
  }
  /**
   * Encode an invite for out-of-band delivery.
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
   * Dial an authority from an invite.
   * Use this on a phone after receiving an invite to connect to the authority.
   *
   * @param invite - The invite received out-of-band
   * @returns Connection to the authority
   */
  async dialInvite(invite) {
    if (!this.libp2pNode) {
      throw new Error("Service not initialized");
    }
    if (invite.expiresAt && Date.now() > invite.expiresAt) {
      throw new Error("Invite has expired");
    }
    log("Dialing invite authority with %d addresses", invite.authorityAddrs.length);
    let lastError = null;
    for (const addrStr of invite.authorityAddrs) {
      try {
        const addr = multiaddr(addrStr);
        await this.libp2pNode.dial(addr);
        log("Connected to authority at: %s", addrStr);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log("Failed to dial %s: %o", addrStr, error);
      }
    }
    throw lastError ?? new Error("No authority addresses available");
  }
}
export {
  SEED_PROTOCOL,
  SeedBootstrapService
};
