import debug from "debug";
import { toString as uint8ArrayToString } from "uint8arrays";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import {
  StrandFormationManager
} from "./strand-formation-manager.js";
const log = debug("sereus:cadre:solicitation");
class StrandSolicitationService {
  constructor(options) {
    this.disclosureValidator = options?.disclosureValidator;
    this.formationUsageRecorder = options?.formationUsageRecorder;
    this.strandProvisioner = options?.strandProvisioner;
    this.formationSigner = options?.formationSigner;
    this.partyId = options?.partyId ?? `party-${Date.now()}`;
    this.cadrePeerAddrs = options?.cadrePeerAddrs ?? [];
    this.formationConfig = options?.formationConfig;
    log("StrandSolicitationService created for party: %s", this.partyId);
  }
  /**
   * Get or create the StrandFormationManager.
   * Lazily initialized to allow configuration after construction.
   */
  getFormationManager() {
    if (!this.formationManager) {
      this.formationManager = new StrandFormationManager({
        disclosureValidator: this.disclosureValidator,
        formationUsageRecorder: this.formationUsageRecorder,
        strandProvisioner: this.strandProvisioner,
        partyId: this.partyId,
        cadrePeerAddrs: this.cadrePeerAddrs,
        config: this.formationConfig
      });
    }
    return this.formationManager;
  }
  /**
   * Register as a responder on a libp2p node.
   * This enables the node to handle incoming strand formation requests.
   */
  registerResponder(node) {
    this.getFormationManager().registerResponder(node);
    log("Registered as responder");
  }
  /**
   * Unregister as a responder from a libp2p node.
   */
  unregisterResponder(node) {
    this.getFormationManager().unregisterResponder(node);
    log("Unregistered as responder");
  }
  /**
   * Form a strand with a responder via an open invitation.
   *
   * Called by the initiator (the party who received an out-of-band invitation).
   * This generates a member key, contacts the responder's cadre, and negotiates
   * strand formation.
   *
   * @param invitation The open invitation (or just token for legacy API)
   * @param disclosure Identity/context information to share with the responder
   * @param node Optional libp2p node for real protocol handling
   * @returns The member key and strand info if successful
   */
  async formStrand(invitation, disclosure, node) {
    const token = typeof invitation === "string" ? invitation : invitation.token;
    log("Forming strand with token: %s", token);
    const privateKey = await generateKeyPair("Ed25519");
    const peerId = peerIdFromPrivateKey(privateKey);
    const privateKeyBytes = privateKeyToProtobuf(privateKey);
    const memberKey = peerId.toString();
    const invitePrivateKey = uint8ArrayToString(privateKeyBytes, "base64");
    log("Generated member key: %s", memberKey);
    if (typeof invitation !== "string" && node) {
      log("Using strand-proto for real protocol handling");
      const result = await this.getFormationManager().formStrand(
        invitation,
        { ...disclosure, partyId: memberKey },
        node
      );
      return {
        memberKey,
        invitePrivateKey,
        strandId: result.strandId
      };
    }
    log("No node provided, using placeholder strandId");
    const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      memberKey,
      invitePrivateKey,
      strandId
    };
  }
  /**
   * Validate a strand formation request.
   *
   * Called by the responder (the party who created the open invitation) when
   * an initiator contacts them to form a strand. Validates the disclosure
   * and returns a signed approval.
   *
   * @param token The invitation token being used
   * @param disclosure The disclosure from the initiator
   * @returns Validation key and signature if approved
   * @throws If validation fails or token is invalid
   */
  async validateStrandFormation(token, disclosure) {
    log("Validating strand formation for token: %s", token);
    if (this.formationUsageRecorder) {
      const tokenCheck = await this.formationUsageRecorder.isTokenValid(token);
      if (!tokenCheck.valid) {
        log("Token invalid or expired: %s", token);
        throw new Error("Invalid or expired token");
      }
      const isUsed = await this.formationUsageRecorder.isTokenUsed(token);
      if (isUsed) {
        log("Token already used: %s", token);
        throw new Error("Token has already been used");
      }
    }
    if (this.disclosureValidator) {
      const isValid = await this.disclosureValidator.validateDisclosure(token, disclosure);
      if (!isValid) {
        log("Disclosure validation failed for token: %s", token);
        throw new Error("Disclosure validation failed");
      }
    }
    if (!this.formationSigner) {
      throw new Error("FormationSigner not configured");
    }
    const { validationKey, validationSignature } = await this.formationSigner.signFormation(
      token,
      disclosure
    );
    log("Formation validated, key: %s", validationKey);
    return {
      validationKey,
      validationSignature
    };
  }
  /**
   * Create an open invitation for others to form strands with this party.
   *
   * @param sAppId The sApp to use for formed strands
   * @param expirationMs How long the invitation is valid (ms from now)
   * @param bootstrap Bootstrap addresses for contacting this party's cadre
   * @returns The open invitation to share out-of-band
   */
  async createOpenInvitation(sAppId, expirationMs, bootstrap) {
    const token = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const expiration = new Date(Date.now() + expirationMs);
    log("Created open invitation: %s (expires %s)", token, expiration.toISOString());
    return {
      token,
      sAppId,
      expiration,
      bootstrap
    };
  }
  /**
   * Record that a formation was completed successfully.
   * Called after strand provisioning to track usage.
   */
  async recordFormationComplete(token, initiatorKey, strandId) {
    if (this.formationUsageRecorder) {
      await this.formationUsageRecorder.recordUsage(token, initiatorKey, strandId);
      log("Recorded formation usage: token=%s strand=%s", token, strandId);
    }
  }
}
export {
  StrandSolicitationService
};
