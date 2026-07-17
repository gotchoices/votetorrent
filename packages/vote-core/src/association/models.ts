import type { Timestamp } from '../common/index.js'

/** ********* Association (device <-> registrant binding, admin-signed under 'vrg') ***********/
export interface Association {
  /** references Registrant.id */
  registrantId: string

  /** Public key for voting; private key held in a biometrically secured TPM */
  deviceKey: string

  /** sha256 hash of the device's ID (not the ID itself, for privacy); undefined = device uniqueness not publicly disclosed */
  deviceHash?: string

  /** Content-addressed hash of the authority-held AssociationPrivate (device attestation); undefined = no attestation committed on-network */
  attestationCid?: string

  expiration: Timestamp | string

  /** Public key of the authority signor */
  signorKey: string

  /** Signature of this record by the signor */
  signature: string
}

/**
 * Authority-issued device-attestation challenge (D-03). Before a device can
 * Associate, the authority issues a one-time nonce bound to
 * (RegistrantId, DeviceKey); the device's platform attestation must answer
 * this exact nonce. Short-lived (expiration). One-time use is structural
 * (the Association PK + nonce binding prevent replay) — no cross-row CHECK.
 */
export interface AttestationChallenge {
  /** Random challenge nonce the device must attest against */
  nonce: string

  /** Issuing authority */
  authorityId: string

  /** references Registrant.id */
  registrantId: string

  /** Device voting public key this challenge is bound to */
  deviceKey: string

  /** Short TTL */
  expiration: Timestamp | string
}

/**
 * iOS App Attest platform detail (promoted from vote-core/oldsrc/structs/device-attestation.ts).
 * Real cert-chain/statement verification is deferred (D-07 — seam-only this phase).
 */
export interface IOSAttestationDetails {
  type: 'iOS'
  /** Public key specifically for iOS Secure Enclave */
  secureEnclavePublicKey: string
  /** Optional token from Apple's DeviceCheck API */
  deviceCheckToken?: string
}

/**
 * Android Play Integrity / SafetyNet platform detail (promoted from
 * vote-core/oldsrc/structs/device-attestation.ts). Real statement/nonce
 * verification is deferred (D-07 — seam-only this phase).
 */
export interface AndroidAttestationDetails {
  type: 'Android'
  /** Base64-encoded response from Android's SafetyNet/Play Integrity API */
  safetyNetAttestation: string
  /** Public key from Android Keystore */
  keystorePublicKey: string
  /** Nonce used in the attestation request */
  nonce: string
}

/**
 * Device-produced platform attestation answering an AttestationChallenge
 * (D-03/D-04). Promoted from vote-core/oldsrc/structs/device-attestation.ts
 * into a first-class model. The authority stores the sensitive half
 * (deviceId/attestationTime/nonce promoted to columns; the remainder as
 * AssociationPrivate.attestationDetails json) and commits the public
 * Association via AttestationCid.
 */
export interface DeviceAttestation {
  /** Public key of the device */
  publicKey: string

  /** Unique identifier for the device, or the app install in the case of iOS */
  deviceId: string

  location?: { lat: number; lon: number }

  /** Encoded attestation statement from the device */
  attestationStatement?: string

  /** Unix time when attestation was performed */
  attestationTime: number

  /** Array of certificates used in the attestation */
  certificateChain: string[]

  platformDetails?: IOSAttestationDetails | AndroidAttestationDetails
}

/**
 * Authority-held private device-association data (D-04). Referenced by
 * Association.attestationCid; Association.signature commits to this record
 * via that hash. DeviceId, AttestationTime and Nonce are promoted for
 * authority-side uniqueness/replay checks; attestationDetails carries the
 * platform-specific remainder of the DeviceAttestation struct.
 */
export interface AssociationPrivate {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  /** Public voting key of the associated device (links to Association) */
  deviceKey: string

  /** Actual device / app-install id (sensitive; authority-held only) */
  deviceId: string

  /** When the platform attestation was performed */
  attestationTime: Timestamp | string

  /** The AttestationChallenge nonce this attestation answered */
  nonce: string

  /** Remaining DeviceAttestation fields: { location?, attestationStatement?, certificateChain, platformDetails? } */
  attestationDetails?: {
    location?: { lat: number; lon: number }
    attestationStatement?: string
    certificateChain: string[]
    platformDetails?: IOSAttestationDetails | AndroidAttestationDetails
  }

  expiration: Timestamp | string
}

/**
 * Draft payload for the Associate builder (D-02/D-03). Carries the device
 * key + the challenge nonce being answered + the platform-produced
 * DeviceAttestation.
 */
export interface AssociateInit {
  registrantId: string
  deviceKey: string
  deviceHash?: string

  /** The AttestationChallenge nonce this attestation answers */
  nonce: string

  attestation: DeviceAttestation
}
