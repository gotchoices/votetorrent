// TEMPORARY mirror: mirrors apps/VoteTorrentVoter/src/engines/voter-request-transports.ts (peer branch of
// createVoterRequestTransportSource). Pinned by test/voter-mirror-drift.spec.ts. Must be replaced by a
// shared extraction before 67-33.
//
// Why a mirror and not an import: the app file holds a bare `require(` of a deep vote-engine dist path for
// the REST route (D-29), so it cannot move verbatim into @votetorrent/workflows yet. The CLI has no REST
// route at all: when the replicated AuthorityIntakePolicy names a valid REST bridge, the voter verb
// refuses `rest-bridge-configured` (the lean rig's rule), never falls back to P2P (D-28/D-29: a double
// path could stage the same request twice). Everything else is the app's composition in the app's order
// with the app's option keys, over the shared strand port and digest functions (67-19).

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
  listOwnStagedRegistrationRequestIds,
  type RegistrationCeremonyTransports,
  type VoterStrandPort
} from '@votetorrent/workflows/voter'
import { VoterVerbRefusal } from './voter-deps.js'

export interface CliVoterRequestStrand {
  /** The shared strand port over the joined network's database. */
  port: VoterStrandPort
  /** The network hash, which is the staging rows' StrandId. */
  strandId: string
  /** The joined network's primary authority (the sealer's recipient set and the policy row). */
  authorityId: string
}

/** The ceremony's transports plus the own-association lister `read-decision` and the status read use. */
export interface CliVoterRequestTransports extends RegistrationCeremonyTransports {
  registrationRoute: 'peer'
  registrationTransport: RegistrationCeremonyTransports['registrationTransport'] & {
    pollDecisions(sinceCursor?: string): Promise<Array<{ requestId: string, status: string, cursor: string }>>
  }
  ownAssociationRequestIds(requesterKey: string): Promise<string[]>
}

/**
 * The peer branch of the Voter's transport source. Composes, in the app's order: the intake query port,
 * the sealer, the association transport, then the policy read; a valid REST bridge URL refuses
 * `rest-bridge-configured`; otherwise the P2P registration transport and the two own-id listers.
 */
export async function createCliVoterRequestTransports(strand: CliVoterRequestStrand): Promise<CliVoterRequestTransports> {
  const { port, strandId, authorityId } = strand
  const reads = intakeQueryPortFromStrandPort(port)
  const sealer = createIntakeSealer({ port: reads, authorityId })
  const openStrand = async (): Promise<VoterStrandPort> => port

  const associationTransport = new P2pAssociationTransport({
    openStrand,
    computeDigest: createAssociationRequestDigestFn(port),
    computeAttestationDigest: createAssociationAttestationDigestFn(port),
    strandId,
    sealer
  })

  const policy = await readIntakePolicyFrom(reads, authorityId)

  if (policy.restBridgeUrl !== null && isValidRestBridgeUrl(policy.restBridgeUrl)) {
    throw new VoterVerbRefusal('rest-bridge-configured')
  }
  const registrationTransport = new P2pRegistrationTransport({
    openStrand,
    computeDigest: createRegistrationRequestDigestFn(port),
    strandId,
    sealer
  })

  return {
    registrationTransport,
    associationTransport,
    registrationRoute: 'peer',
    ownAssociationRequestIds: (requesterKey: string) => listOwnStagedAssociationRequestIds(port, strandId, requesterKey),
    ownStagedRegistrationRequestIds: (requesterKey: string) => listOwnStagedRegistrationRequestIds(port, strandId, requesterKey)
  }
}
