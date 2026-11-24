/**
 * peer-staging-transports.ts — the two staging-only P2P transports an officer process intakes and
 * decides through (D-32).
 *
 * Moved from the `createPeerStagingTransports` region of
 * `apps/VoteTorrentAuthority/src/engines/engine-factory.ts` by 67-09. The factory method keeps its
 * name, its `PeerStrandUnavailableError` refusals (`no-network`, `not-strand-backed`,
 * `network-changed`) and its `openStrand` closure over the established context, and calls this
 * function to build the transports. The vt CLI officer node builds its own `openStrand` thunk with
 * the shared strand-port adapter and calls this function the same way.
 *
 * This function receives an `openStrand` THUNK and never a raw store handle: the caller keeps the
 * no-raw-handle rule (tier-2 authorization has zero schema sites and lives only in the engine
 * layer's `context.Is*Valid` checks, so a caller holding the raw handle would silently lose it).
 * The port is built and consumed entirely by the transports.
 *
 * Neither transport is given a `sealer` — the Authority never submits staged requests, it only
 * intakes and decides them, so `computeDigest`/`computeAttestationDigest` are refusing stubs that
 * reject if ever called (submission is a REQUESTER-side-only operation).
 */

import { P2pAssociationTransport, P2pRegistrationTransport } from '@votetorrent/vote-engine/rn'
import type {
  AssociationStrandPort,
  RegistrationStrandPort,
  StagingDecisionSigner,
  StagingOpener,
} from '@votetorrent/vote-engine/rn'

/** `createPeerStagingTransports`'s return shape (D-32). */
export interface PeerStagingTransports {
  strandId: string
  registration: P2pRegistrationTransport
  association: P2pAssociationTransport
}

export interface PeerStagingTransportsInput {
  strandId: string
  /** Opens the strand lazily, at most once per transport; the caller owns the refusals. */
  openStrand: () => Promise<RegistrationStrandPort & AssociationStrandPort>
  opener: StagingOpener
  decisionSigner: StagingDecisionSigner
}

export function createPeerStagingTransports(input: PeerStagingTransportsInput): PeerStagingTransports {
  const { strandId, openStrand } = input

  const refuseSubmit = async (..._args: unknown[]): Promise<Uint8Array> => {
    throw new Error('The authority app never submits staged requests')
  }

  const registration = new P2pRegistrationTransport({
    openStrand,
    computeDigest: refuseSubmit,
    strandId,
    opener: input.opener,
    decisionSigner: input.decisionSigner,
  })
  const association = new P2pAssociationTransport({
    openStrand,
    computeDigest: refuseSubmit,
    computeAttestationDigest: refuseSubmit,
    strandId,
    opener: input.opener,
    decisionSigner: input.decisionSigner,
  })

  return { strandId, registration, association }
}
