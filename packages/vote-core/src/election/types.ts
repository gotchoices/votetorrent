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
