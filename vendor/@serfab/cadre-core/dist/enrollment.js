import debug from "debug";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
const log = debug("sereus:cadre:enrollment");
class EnrollmentService {
  constructor(options) {
    this.memberVerifier = options?.memberVerifier;
    this.memberRegistry = options?.memberRegistry;
    log("EnrollmentService created");
  }
  /**
   * Create a new cadre peer identity
   *
   * Generates a new Ed25519 keypair for a cadre node.
   * The private key should be stored securely by the node.
   * The PeerId can be used with the Seed Bootstrap API for authorization.
   */
  async createCadrePeer() {
    log("Creating new cadre peer identity");
    const privateKey = await generateKeyPair("Ed25519");
    const peerId = peerIdFromPrivateKey(privateKey);
    const privateKeyBytes = privateKeyToProtobuf(privateKey);
    log("Created peer with ID: %s", peerId.toString());
    return {
      peerId,
      privateKey: privateKeyBytes
    };
  }
  // ============================================================================
  // Member Registration API
  // ============================================================================
  /**
   * Register a member into a strand.
   *
   * Called by an invited party to accept an invitation and join as a member.
   * The signature proves ownership of the member key.
   *
   * @param registration The member registration data (strandId, key, peerIds)
   * @param signature Signature over the registration proving key ownership
   * @returns Success/failure with optional reason
   */
  async registerMember(registration, signature) {
    const { strandId, key, peerIds } = registration;
    log("Registering member %s for strand %s with %d peers", key, strandId, peerIds.length);
    if (!this.memberVerifier) {
      log("MemberVerifier not configured");
      return { success: false, reason: "MemberVerifier not configured" };
    }
    if (!this.memberRegistry) {
      log("MemberRegistry not configured");
      return { success: false, reason: "MemberRegistry not configured" };
    }
    const isValidSignature = await this.memberVerifier.verifyMember(registration, signature);
    if (!isValidSignature) {
      log("Invalid signature for member registration: %s", key);
      return { success: false, reason: "Invalid signature" };
    }
    const isAuthorized = await this.memberVerifier.isAuthorizedToJoin(strandId, key);
    if (!isAuthorized) {
      log("Member %s not authorized to join strand %s", key, strandId);
      return { success: false, reason: "Not authorized to join strand" };
    }
    const alreadyRegistered = await this.memberRegistry.isMemberRegistered(strandId, key);
    if (alreadyRegistered) {
      log("Member %s already registered in strand %s", key, strandId);
      return { success: false, reason: "Member already registered" };
    }
    try {
      await this.memberRegistry.registerMember(strandId, key, peerIds);
      log("Member %s successfully registered in strand %s", key, strandId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Failed to register member %s: %s", key, message);
      return { success: false, reason: `Registration failed: ${message}` };
    }
  }
  /**
   * Validate a member registration without actually registering
   * Useful for pre-flight checks
   */
  async validateMemberRegistration(registration, signature) {
    const { strandId, key } = registration;
    if (!this.memberVerifier) {
      return { valid: false, reason: "MemberVerifier not configured" };
    }
    if (!this.memberRegistry) {
      return { valid: false, reason: "MemberRegistry not configured" };
    }
    const isValidSignature = await this.memberVerifier.verifyMember(registration, signature);
    if (!isValidSignature) {
      return { valid: false, reason: "Invalid signature" };
    }
    const isAuthorized = await this.memberVerifier.isAuthorizedToJoin(strandId, key);
    if (!isAuthorized) {
      return { valid: false, reason: "Not authorized to join strand" };
    }
    const alreadyRegistered = await this.memberRegistry.isMemberRegistered(strandId, key);
    if (alreadyRegistered) {
      return { valid: false, reason: "Member already registered" };
    }
    return { valid: true };
  }
}
export {
  EnrollmentService
};
