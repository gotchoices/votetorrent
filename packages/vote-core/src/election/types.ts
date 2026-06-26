import type {
  Ballot,
  BallotDetails,
  BallotSummary,
  ElectionDetails,
  ElectionRevisionInit,
  KeyholderInvite
} from './models.js'
import type { IBuilder } from '../common/builder.js'

export interface IElectionEngine {
  getBallotDetails(id: string): Promise<BallotDetails>
  getBallots(): Promise<BallotSummary[]>
  getElectionDetails(): Promise<ElectionDetails>
  inviteKeyholder(
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void>
  proposeBallot(ballot: Ballot): Promise<void>
  proposeRevision(revision: ElectionRevisionInit): Promise<void>
  revokeKeyholder(
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void>
  /** D-03: Creates the ballot SignatureTask (+ BallotSignatureTaskExtension + unsigned AdminSigning) so officers can sign the proposed ballot. */
  submitBallotForConfirmation(ballotId: string): Promise<void>
  /** D-05: Deletes the pending Task + BallotSignatureTaskExtension, unlocking the proposed ballot for editing. */
  withdrawBallotConfirmation(ballotId: string): Promise<void>
  /** D-05 / D-09: Returns the edit-lock state (locked = pending Task exists) and confirmation state (confirmed = finalized Ballot exists). */
  getBallotConfirmationState(ballotId: string): Promise<{ locked: boolean; confirmed: boolean }>
  buildProposeBallot(): IElectionProposeBallotBuilder
  buildProposeRevision(): IElectionProposeRevisionBuilder
  buildInviteKeyholder(): IElectionInviteKeyholderBuilder
  buildRevokeKeyholder(): IElectionRevokeKeyholderBuilder
}

export interface IElectionProposeBallotBuilder extends IBuilder<Ballot, void> {
  fromPayload(payload: Ballot): this
}

export interface IElectionProposeRevisionBuilder extends IBuilder<ElectionRevisionInit, void> {
  fromPayload(payload: ElectionRevisionInit): this
}

export interface IElectionInviteKeyholderBuilder extends IBuilder<{ keyholder: KeyholderInvite; electionId: string }, void> {
  fromPayload(payload: { keyholder: KeyholderInvite; electionId: string }): this
}

export interface IElectionRevokeKeyholderBuilder extends IBuilder<{ keyholder: KeyholderInvite; electionId: string }, void> {
  fromPayload(payload: { keyholder: KeyholderInvite; electionId: string }): this
}
