import debug from "debug";
import {
  createBootstrapManager,
  DEFAULT_PROTOCOL_ID
} from "@serfab/strand-proto";
const log = debug("sereus:cadre:formation-manager");
class StrandFormationManager {
  constructor(options) {
    this.registeredNodes = /* @__PURE__ */ new Set();
    this.disclosureValidator = options.disclosureValidator;
    this.formationUsageRecorder = options.formationUsageRecorder;
    this.strandProvisioner = options.strandProvisioner;
    this.partyId = options.partyId;
    this.cadrePeerAddrs = options.cadrePeerAddrs ?? [];
    const hooks = this.createSessionHooks();
    const config = {
      sessionTimeoutMs: options.config?.sessionTimeoutMs ?? 3e4,
      stepTimeoutMs: options.config?.stepTimeoutMs ?? 5e3,
      maxConcurrentSessions: options.config?.maxConcurrentSessions ?? 100,
      enableDebugLogging: options.config?.enableDebugLogging ?? false,
      protocolId: options.config?.protocolId ?? DEFAULT_PROTOCOL_ID
    };
    this.sessionManager = createBootstrapManager(hooks, config);
    log("StrandFormationManager created for party: %s", this.partyId);
  }
  /**
   * Register this manager as a protocol handler on a libp2p node.
   * Call this on the control network node to handle incoming formation requests.
   */
  registerResponder(node, protocolId) {
    if (this.registeredNodes.has(node)) {
      log("Node already registered");
      return;
    }
    this.sessionManager.register(node, protocolId);
    this.registeredNodes.add(node);
    log("Registered as responder on node");
  }
  /**
   * Unregister the protocol handler from a libp2p node.
   */
  unregisterResponder(node, protocolId) {
    if (!this.registeredNodes.has(node)) {
      return;
    }
    this.sessionManager.unregister(node, protocolId);
    this.registeredNodes.delete(node);
    log("Unregistered from node");
  }
  /**
   * Form a strand with a responder via an open invitation.
   *
   * This is the initiator-side operation. It:
   * 1. Converts the OpenInvitation to a BootstrapLink
   * 2. Calls SessionManager.initiateBootstrap()
   * 3. Returns the result as a FormStrandResult
   */
  async formStrand(invitation, disclosure, node) {
    log("Forming strand with invitation token: %s", invitation.token);
    const link = {
      responderPeerAddrs: invitation.bootstrap,
      token: invitation.token,
      tokenExpiryUtc: invitation.expiration.toISOString(),
      mode: "responderCreates"
      // Responder provisions the strand
    };
    const result = await this.sessionManager.initiateBootstrap(link, node);
    log("Strand formed: %s", result.strand.strandId);
    return {
      memberKey: this.partyId,
      // The initiator's member key
      invitePrivateKey: "",
      // Would come from key generation
      strandId: result.strand.strandId
    };
  }
  /**
   * Get the number of active sessions
   */
  getActiveSessionCounts() {
    return this.sessionManager.getActiveSessionCounts();
  }
  /**
   * Create SessionHooks that delegate to our interfaces
   */
  createSessionHooks() {
    return {
      validateToken: async (token, sessionId) => {
        log("validateToken: %s (session: %s)", token, sessionId);
        if (!this.formationUsageRecorder) {
          return { mode: "responderCreates", valid: true };
        }
        const tokenCheck = await this.formationUsageRecorder.isTokenValid(token);
        if (!tokenCheck.valid) {
          log("Token invalid: %s", token);
          return { mode: "responderCreates", valid: false };
        }
        const isUsed = await this.formationUsageRecorder.isTokenUsed(token);
        if (isUsed) {
          log("Token already used: %s", token);
          return { mode: "responderCreates", valid: false };
        }
        return { mode: "responderCreates", valid: true };
      },
      validateIdentity: async (identity, sessionId) => {
        log("validateIdentity (session: %s)", sessionId);
        if (!this.disclosureValidator) {
          return true;
        }
        const disclosure = identity;
        const token = identity?.token ?? "";
        return this.disclosureValidator.validateDisclosure(token, disclosure);
      },
      provisionStrand: async (creator, creatorPartyId, otherPartyId, sessionId) => {
        log(
          "provisionStrand: creator=%s, other=%s (session: %s)",
          creatorPartyId,
          otherPartyId,
          sessionId
        );
        if (!this.strandProvisioner) {
          const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          return {
            strand: { strandId, createdBy: creator },
            dbConnectionInfo: { endpoint: "local", credentialsRef: "" }
          };
        }
        const initiatorKey = creator === "initiator" ? creatorPartyId : otherPartyId;
        const responderKey = creator === "responder" ? creatorPartyId : otherPartyId;
        const result = await this.strandProvisioner.provisionStrand(
          "",
          // sAppId - would come from invitation
          initiatorKey,
          responderKey
        );
        return {
          strand: { strandId: result.strandId, createdBy: creator },
          dbConnectionInfo: { endpoint: "local", credentialsRef: "" }
        };
      },
      validateResponse: async (response, sessionId) => {
        log("validateResponse (session: %s)", sessionId);
        return true;
      },
      validateDatabaseResult: async (result, sessionId) => {
        log("validateDatabaseResult (session: %s)", sessionId);
        return true;
      }
    };
  }
}
function createStrandFormationManager(options) {
  return new StrandFormationManager(options);
}
export {
  StrandFormationManager,
  createStrandFormationManager
};
