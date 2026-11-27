/**
 * voter-request-transports.ts - Phase 62 Plan 22 (D-28/D-29/D-32).
 * Moved verbatim from `apps/VoteTorrentVoter/src/engines/voter-request-transports.ts` (phase 67 plan 30);
 * that path is now a binding that supplies the one platform seam, the REST registration transport factory
 * (the app loads the route from its bundled engine dist; the CLI refuses a configured bridge).
 *
 * Route selection and D-32 sealing over the Voter's OWN established-network strand. This module
 * never holds key material: every signature arrives as a `createDeviceSigner` (62-08) callback or
 * an already-resolved `Signature`, never a raw private key.
 *
 * Routing rule (Claude's discretion within D-28/D-29, recorded in 62-22-PLAN.md's `<interfaces>`):
 *   - not peer-backed: `resolve()` returns `undefined` before touching the strand port at all:
 *     association is P2P-only, so a non-strand-backed network has no delivery path, and the bridge
 *     URL is only knowable from replicated rows this device does not have without a strand.
 *   - peer-backed: association ALWAYS goes over P2P (D-28). Registration goes to the
 *     authority-configured REST bridge exactly when the replicated `AuthorityIntakePolicy` carries
 *     a non-null `restBridgeUrl` that also passes `isValidRestBridgeUrl` (D-29); otherwise P2P
 *     (the D-28 default). There is no automatic fallback between the two routes: a double path
 *     could stage the same request twice.
 *   - the REST route cannot carry 62-15's `extras` (the D-45 registration code), recorded for
 *     62-28, which must branch on `registrationRoute` before minting one.
 *
 * Label: code-complete, unverified on devices (P2P-11 proof debt, tracked by 62-30).
 */
import type {
  AssociationAttestationAnswer,
  AssociationIdentityField,
  AssociationRequestInit,
  RegistrationRequestInit,
  Signature
} from '@votetorrent/vote-core'
import {
  createIntakeSealer,
  intakeQueryPortFromStrandPort,
  isValidRestBridgeUrl,
  P2pAssociationTransport,
  P2pRegistrationTransport,
  readIntakePolicyFrom
} from '@votetorrent/vote-engine/rn'
import {
  createAssociationAttestationDigestFn,
  createAssociationRequestDigestFn,
  createRegistrationRequestDigestFn,
  listOwnStagedAssociationRequestIds,
  listOwnStagedRegistrationRequestIds
} from './strand-port-adapter.js'
import type { VoterStrandPort } from './strand-port-adapter.js'

export const VOTER_REQUEST_TRANSPORTS_ENGINE = 'requestTransports'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export type VoterRegistrationRoute = 'peer' | 'rest-bridge'

export interface VoterRegistrationRequestTransport {
  submitRequest(
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback,
    extras?: { registrationCode?: string }
  ): Promise<string>
  pollDecisions(
    sinceCursor?: string
  ): Promise<Array<{ requestId: string, status: string, reason?: string, cursor: string }>>
}

export interface VoterAssociationRequestTransport {
  submitRequest(
    init: AssociationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback,
    extras?: { registrationCode?: string, identityFields?: readonly AssociationIdentityField[] }
  ): Promise<string>
  submitAttestation(
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void>
  pollDecisions(
    sinceCursor?: string
  ): Promise<
    Array<{ requestId: string, status: string, challengeNonce?: string, reason?: string, cursor: string }>
  >
}

export interface VoterRequestTransports {
  registrationTransport: VoterRegistrationRequestTransport
  /** Always P2P (D-28): association never routes to the REST bridge. */
  associationTransport: VoterAssociationRequestTransport
  registrationRoute: VoterRegistrationRoute
  ownAssociationRequestIds(requesterKey: string): Promise<string[]>
  /** Phase 62 Plan 28 (D-45): own `RegistrationRequestStaging` row ids, scoped by `RequesterKey`.
   * Wired on BOTH routes: the strand port exists whenever transports resolve, and on
   * 'rest-bridge' it simply finds no row (the REST route never stages locally). */
  ownStagedRegistrationRequestIds(requesterKey: string): Promise<string[]>
}

export interface VoterRequestStrand {
  strandId: string
  port: VoterStrandPort
  /** Whether the established network's DbFactory went through the strand path
   * (`EngineFactory`'s `strandBackedNetworks` marker) rather than the solo/local-DB fallback. */
  peerBacked: boolean
}

export interface VoterRequestTransportSource {
  /** `undefined` when `!peerBacked`. Re-reads the policy on every call; the sealer re-resolves
   * recipients on every seal (D-04/D-32). */
  resolve(authorityId: string): Promise<VoterRequestTransports | undefined>
}

/** The one platform seam: how a REST registration transport is built for a valid bridge URL (D-29). */
export interface VoterRequestTransportOptions {
  createRestRegistrationTransport: (options: { baseUrl: string }) => VoterRegistrationRequestTransport
}

/**
 * The structural shape of the app screen's `resolveVoterRequestTransports` (the engine-factory lookup of the
 * `requestTransports` source, then `resolve(authorityId)`); the registration-status read takes one injected.
 */
export type VoterRequestTransportLookup = (deps: {
  getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
  authorityId: string
}) => Promise<VoterRequestTransports | undefined>

export function createVoterRequestTransportSource (strand: VoterRequestStrand, options: VoterRequestTransportOptions): VoterRequestTransportSource {
  if (options === null || typeof options !== 'object' || typeof options.createRestRegistrationTransport !== 'function') {
    throw new TypeError('voter request transport options are required')
  }
  return {
    async resolve (authorityId: string): Promise<VoterRequestTransports | undefined> {
      if (!strand.peerBacked) return undefined

      // VoterStrandPort structurally satisfies both RegistrationStrandPort and
      // AssociationStrandPort (query/mutate/close): no cast needed.
      const reads = intakeQueryPortFromStrandPort(strand.port)
      const sealer = createIntakeSealer({ port: reads, authorityId })
      const openStrand = async (): Promise<VoterStrandPort> => strand.port

      const associationTransport = new P2pAssociationTransport({
        openStrand,
        computeDigest: createAssociationRequestDigestFn(strand.port),
        computeAttestationDigest: createAssociationAttestationDigestFn(strand.port),
        strandId: strand.strandId,
        sealer
      })

      const policy = await readIntakePolicyFrom(reads, authorityId)

      let registrationTransport: VoterRegistrationRequestTransport
      let registrationRoute: VoterRegistrationRoute
      if (policy.restBridgeUrl !== null && isValidRestBridgeUrl(policy.restBridgeUrl)) {
        registrationTransport = options.createRestRegistrationTransport({ baseUrl: policy.restBridgeUrl })
        registrationRoute = 'rest-bridge'
      } else {
        registrationTransport = new P2pRegistrationTransport({
          openStrand,
          computeDigest: createRegistrationRequestDigestFn(strand.port),
          strandId: strand.strandId,
          sealer
        })
        registrationRoute = 'peer'
      }

      return {
        registrationTransport,
        associationTransport,
        registrationRoute,
        ownAssociationRequestIds: (requesterKey: string) =>
          listOwnStagedAssociationRequestIds(strand.port, strand.strandId, requesterKey),
        ownStagedRegistrationRequestIds: (requesterKey: string) =>
          listOwnStagedRegistrationRequestIds(strand.port, strand.strandId, requesterKey)
      }
    }
  }
}
