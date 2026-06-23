import { multiaddr as toMultiaddr } from "@multiformats/multiaddr";
import { pipe } from "it-pipe";
import { encode as lpEncode, decode as lpDecode } from "it-length-prefixed";
const DEFAULT_PROTOCOL_ID = "/sereus/bootstrap/1.0.0";
async function writeJson(stream, obj) {
  const jsonData = JSON.stringify(obj);
  const encoded = new TextEncoder().encode(jsonData);
  const lpEncoded = pipe([encoded], lpEncode);
  for await (const chunk of lpEncoded) {
    stream.send(chunk.subarray());
  }
}
async function readJson(stream, debug) {
  try {
    const decoder = new TextDecoder();
    if (debug) console.debug("[readJson] starting to read from stream");
    if (debug) console.debug("[readJson] stream type:", typeof stream, "keys:", Object.keys(stream));
    if (debug) console.debug("[readJson] calling lpDecode via pipe");
    const decoded = pipe(stream, lpDecode);
    if (debug) console.debug("[readJson] created decoded iterator, type:", typeof decoded);
    if (debug) console.debug("[readJson] starting iteration");
    for await (const data of decoded) {
      if (debug) console.debug("[readJson] received data:", data.byteLength, "bytes");
      const message = decoder.decode(data.subarray());
      if (debug) console.debug("[readJson] decoded message:", message.substring(0, 100));
      return JSON.parse(message);
    }
    throw new Error("Received empty data from stream");
  } catch (err) {
    if (debug) console.debug("[readJson] ERROR:", err);
    throw err;
  }
}
class SessionManager {
  constructor(hooks, config = {
    sessionTimeoutMs: 3e4,
    stepTimeoutMs: 5e3,
    maxConcurrentSessions: 100,
    protocolId: DEFAULT_PROTOCOL_ID
  }) {
    this.hooks = hooks;
    this.config = config;
    this.listenerSessions = /* @__PURE__ */ new Map();
    this.dialerSessions = /* @__PURE__ */ new Map();
    this.sessionCounter = 0;
  }
  generateSessionId() {
    return `session-${Date.now()}-${++this.sessionCounter}`;
  }
  // Helper to register/unregister libp2p protocol handlers
  register(node, protocolId) {
    const pid = protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID;
    node.handle(pid, async (stream) => {
      await this.handleNewStream(stream);
    });
  }
  unregister(node, protocolId) {
    const pid = protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID;
    try {
      node.unhandle(pid);
    } catch {
    }
  }
  async handleNewStream(stream) {
    if (this.listenerSessions.size >= this.config.maxConcurrentSessions) {
      await writeJson(stream, { approved: false, reason: "Too many concurrent sessions" });
      await stream.close();
      return;
    }
    const sessionId = this.generateSessionId();
    const session = new ListenerSession(sessionId, stream, this.hooks, this.config);
    this.listenerSessions.set(sessionId, session);
    session.execute().catch(() => {
    }).finally(() => this.listenerSessions.delete(sessionId));
  }
  async initiateBootstrap(link, node) {
    const sessionId = this.generateSessionId();
    const session = new DialerSession(sessionId, link, node, this.hooks, this.config);
    this.dialerSessions.set(sessionId, session);
    try {
      return await session.execute();
    } finally {
      this.dialerSessions.delete(sessionId);
    }
  }
  getActiveSessionCounts() {
    return { listeners: this.listenerSessions.size, dialers: this.dialerSessions.size };
  }
}
function tokenInfoToMode(tokenInfo) {
  if (tokenInfo.mode) return tokenInfo.mode;
  return "responderCreates";
}
function linkToMode(link) {
  if (link.mode) return link.mode;
  return "responderCreates";
}
class ListenerSession {
  constructor(sessionId, stream, hooks, config) {
    this.sessionId = sessionId;
    this.stream = stream;
    this.hooks = hooks;
    this.config = config;
    this.state = "L_PROCESS_CONTACT";
    this.startTime = Date.now();
    this.tokenInfo = null;
    this.contactMessage = null;
    this.provisionResult = null;
  }
  async execute() {
    try {
      await this.withTimeout(this.config.sessionTimeoutMs, async () => {
        await this.processContact();
        await this.sendResponse();
        if (tokenInfoToMode(this.tokenInfo) === "initiatorCreates") await this.awaitDatabase();
        this.transitionTo("L_DONE");
      });
    } catch (e) {
      this.transitionTo("L_FAILED", e);
      throw e;
    } finally {
      this.closeStream();
    }
  }
  async processContact() {
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] processContact: waiting for contact`);
    const msg = await this.withStepTimeout(() => readJson(this.stream, this.config.enableDebugLogging));
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] received contact`, msg);
    this.contactMessage = msg;
    const tokenInfo = await this.withStepTimeout(() => this.hooks.validateToken(msg.token, this.sessionId));
    this.tokenInfo = tokenInfo;
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] token validated`, tokenInfo);
    if (!this.tokenInfo?.valid) {
      await this.sendRejection("Invalid token");
      throw new Error("Invalid token");
    }
    const okId = await this.withStepTimeout(() => this.hooks.validateIdentity(msg.identityBundle, this.sessionId));
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] identity validated=${okId}`);
    if (!okId) {
      await this.sendRejection("Invalid identity");
      throw new Error("Invalid identity");
    }
    const mode = tokenInfoToMode(this.tokenInfo);
    if (mode === "responderCreates") {
      if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] provisioning (responderCreates mode)`);
      this.provisionResult = await this.withStepTimeout(() => this.hooks.provisionStrand("responder", this.sessionId, msg.partyId, this.sessionId));
      if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] provisioned`, this.provisionResult);
    }
  }
  async sendResponse() {
    this.transitionTo("L_SEND_RESPONSE");
    if (!this.tokenInfo || !this.contactMessage) throw new Error("Invalid state");
    const response = {
      approved: true,
      partyId: this.sessionId,
      cadrePeerAddrs: ["cadre-a-1.local", "cadre-a-2.local"],
      provisionResult: this.provisionResult || void 0
    };
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] sending response`, response);
    await this.withStepTimeout(() => writeJson(this.stream, response));
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] response sent`);
  }
  async awaitDatabase() {
    this.transitionTo("L_AWAIT_DATABASE");
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] awaiting database message`);
    const db = await this.withStepTimeout(() => readJson(this.stream));
    const valid = await this.withStepTimeout(() => this.hooks.validateDatabaseResult(db, this.sessionId));
    if (!valid) throw new Error("Invalid database result");
    if (this.config.enableDebugLogging) console.debug(`[L:${this.sessionId}] database message accepted`);
  }
  transitionTo(s, _e) {
    this.state = s;
  }
  async withTimeout(ms, op) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Session timeout after ${ms}ms`)), ms);
      op().then(resolve).catch(reject).finally(() => clearTimeout(t));
    });
  }
  withStepTimeout(op) {
    return this.withTimeout(this.config.stepTimeoutMs, op);
  }
  async sendRejection(reason) {
    await writeJson(this.stream, { approved: false, reason });
    await this.stream.close();
  }
  closeStream() {
    try {
      this.stream.close?.();
    } catch {
    }
  }
}
class DialerSession {
  constructor(sessionId, link, node, hooks, config) {
    this.sessionId = sessionId;
    this.link = link;
    this.node = node;
    this.hooks = hooks;
    this.config = config;
    this.state = "D_SEND_CONTACT";
    this.startTime = Date.now();
    this.stream = null;
    this.responseMessage = null;
  }
  async execute() {
    try {
      return await this.withTimeout(this.config.sessionTimeoutMs, async () => {
        this.stream = await this.connectAndSend();
        this.responseMessage = await this.awaitResponse();
        const mode = linkToMode(this.link);
        if (mode === "initiatorCreates") {
          return await this.provisionAndSendDatabase();
        } else {
          if (!this.responseMessage.provisionResult) throw new Error("Missing provision result for responderCreates mode");
          return this.responseMessage.provisionResult;
        }
      });
    } catch (e) {
      this.state = "D_FAILED";
      throw e;
    } finally {
      this.closeStream();
    }
  }
  async connectAndSend() {
    const responderAddr = toMultiaddr(this.link.responderPeerAddrs[0]);
    const pid = this.link.protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID;
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] dialing`, responderAddr.toString(), "pid", pid);
    const stream = await this.withStepTimeout(async () => await this.node.dialProtocol(responderAddr, pid));
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] dialed; sending contact`);
    const contact = {
      token: this.link.token,
      partyId: this.sessionId,
      identityBundle: { partyId: this.sessionId },
      cadrePeerAddrs: ["cadre-b-1.local", "cadre-b-2.local"]
    };
    await this.withStepTimeout(() => writeJson(stream, contact));
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] contact sent`);
    return stream;
  }
  async awaitResponse() {
    if (!this.stream) throw new Error("No stream");
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] awaiting response`);
    const response = await this.withStepTimeout(() => readJson(this.stream, this.config.enableDebugLogging));
    if (this.config.enableDebugLogging) console.debug(`[D:${this.sessionId}] response received`, response);
    if (!response.approved) throw new Error(`Bootstrap rejected: ${response.reason || "No reason provided"}`);
    const ok = await this.withStepTimeout(() => this.hooks.validateResponse(response, this.sessionId));
    if (!ok) throw new Error("Invalid response from peer");
    return response;
  }
  async provisionAndSendDatabase() {
    if (!this.responseMessage) throw new Error("No response message available");
    let provision;
    try {
      provision = await this.withStepTimeout(() => this.hooks.provisionStrand("initiator", this.sessionId, this.responseMessage.partyId, this.sessionId));
    } catch (e) {
      this.state = "D_FAILED";
      throw new Error(`Provisioning failed: ${e?.message || String(e)}`);
    }
    const dbMsg = { strand: provision.strand, dbConnectionInfo: provision.dbConnectionInfo };
    const pid = this.link.protocolId || this.config.protocolId || DEFAULT_PROTOCOL_ID;
    const maddr = toMultiaddr(this.link.responderPeerAddrs[0]);
    const newStream = await this.withStepTimeout(async () => await this.node.dialProtocol(maddr, pid));
    await this.withStepTimeout(() => writeJson(newStream, dbMsg));
    await newStream.close();
    this.closeStream();
    return provision;
  }
  async withTimeout(ms, op) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Session timeout after ${ms}ms`)), ms);
      op().then(resolve).catch(reject).finally(() => clearTimeout(t));
    });
  }
  withStepTimeout(op) {
    return this.withTimeout(this.config.stepTimeoutMs, op);
  }
  closeStream() {
    try {
      this.stream?.close?.();
    } catch {
    }
  }
}
function createBootstrapManager(hooks, config) {
  const full = {
    sessionTimeoutMs: 3e4,
    stepTimeoutMs: 5e3,
    maxConcurrentSessions: 100,
    enableDebugLogging: false,
    protocolId: DEFAULT_PROTOCOL_ID,
    ...config
  };
  return new SessionManager(hooks, full);
}
export {
  DEFAULT_PROTOCOL_ID,
  DialerSession,
  ListenerSession,
  SessionManager,
  createBootstrapManager
};
