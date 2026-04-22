import type {
  BallotDetails,
  ElectionDetails,
  ElectionRevisionInit,
  KeyholderInvite,
  BallotSummary,
  IElectionEngine
} from '@votetorrent/vote-core/'

export class ElectionEngine implements IElectionEngine {
  async getBallotDetails (id: string): Promise<BallotDetails> {
    throw new Error('Not implemented')
  }

  async getBallots (): Promise<BallotSummary[]> {
    throw new Error('Not implemented')
  }

  async getElectionDetails (): Promise<ElectionDetails> {
    throw new Error('Not implemented yet')
  }

  async inviteKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    throw new Error('Not implemented')
  }

  async proposeBallot (ballot): Promise<void> {
    throw new Error('Not implemented')
  }

  async proposeRevision (revision: ElectionRevisionInit): Promise<void> {
    throw new Error('Not implemented')
  }

  async revokeKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    throw new Error('Not implemented')
  }
}
