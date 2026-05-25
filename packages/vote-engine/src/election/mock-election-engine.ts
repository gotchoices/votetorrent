import { ElectionEvent, ElectionType } from '@votetorrent/vote-core'
import type {
  Ballot,
  BallotDetails,
  BallotSummary,
  ElectionDetails,
  ElectionRevisionInit,
  IElectionEngine,
  IElectionInviteKeyholderBuilder,
  IElectionProposeBallotBuilder,
  IElectionProposeRevisionBuilder,
  IElectionRevokeKeyholderBuilder,
  KeyholderInvite,
  Timestamp
} from '@votetorrent/vote-core'
import { ElectionProposeBallotBuilder } from './builders/election-propose-ballot-builder.js'
import { ElectionProposeRevisionBuilder } from './builders/election-propose-revision-builder.js'
import { ElectionInviteKeyholderBuilder } from './builders/election-invite-keyholder-builder.js'
import { ElectionRevokeKeyholderBuilder } from './builders/election-revoke-keyholder-builder.js'

export class MockElectionEngine implements IElectionEngine {
  async getBallotDetails (id: string): Promise<BallotDetails> {
    throw new Error('Not implemented')
  }

  async getBallots (): Promise<BallotSummary[]> {
    throw new Error('Not implemented')
  }

  async getElectionDetails (): Promise<ElectionDetails> {
    // Mock data for Utah General Election
    const mockElection: ElectionDetails = {
      election: {
        id: 'utah-general-2024',
        authorityId: 'utah-election-authority',
        title: 'Utah General Election 2024',
        date: new Date('2024-11-05').getTime(), // Election Day
        revisionDeadline: new Date('2024-10-15').getTime(), // 3 weeks before election
        type: ElectionType.official,
        ballotDeadline: new Date('2024-10-22').getTime() // 2 weeks before election
      },
      current: {
        electionId: 'utah-general-2024',
        revision: 1,
        revisionTimestamp: [new Date().getTime()],
        tags: ['general', 'state', '2024'],
        instructions: `# Utah General Election 2024

This election will determine various state and local offices in Utah, including:
- Governor
- State Legislature
- Congressional Representatives
- State Supreme Court Justices
- Local County Officials

Please review all candidates and measures carefully before voting.`,
        keyholders: [
          {
            invite: {
              name: 'Dr. Sarah Chen'
            }
          },
          {
            invite: {
              name: 'Judge Michael Rodriguez'
            },
            result: {
              isAccepted: false,
              invitationSignature: 'mock-invitation-signature-2',
              invokedId: 'mock-invoked-id-2'
            }
          },
          {
            invite: {
              name: 'Prof. James Wilson'
            },
            result: {
              isAccepted: true,
              invitationSignature: 'mock-invitation-signature-3',
              invokedId: 'mock-invoked-id-3'
            }
          }
        ],
        timeline: {
          [ElectionEvent.registrationEnds]: new Date('2024-10-25').getTime(),
          [ElectionEvent.ballotsFinal]: new Date('2024-10-15').getTime(),
          [ElectionEvent.votingStarts]: new Date('2024-10-22').getTime(),
          [ElectionEvent.tallyingStarts]: new Date(
            '2024-11-05T20:00:00'
          ).getTime(),
          [ElectionEvent.validation]: new Date('2024-11-06').getTime(),
          [ElectionEvent.certificationStarts]: new Date('2024-11-07').getTime(),
          [ElectionEvent.closed]: new Date('2024-11-08').getTime()
        },
        keyholderThreshold: 3
      }
    }

    return Promise.resolve(mockElection)
  }

  async inviteKeyholder (
    keyholder: KeyholderInvite,
    electionId: string
  ): Promise<void> {
    throw new Error('Not implemented')
  }

  async proposeBallot (ballot: Ballot): Promise<void> {
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

  buildProposeBallot (): IElectionProposeBallotBuilder {
    return new ElectionProposeBallotBuilder(this)
  }

  buildProposeRevision (): IElectionProposeRevisionBuilder {
    return new ElectionProposeRevisionBuilder(this)
  }

  buildInviteKeyholder (): IElectionInviteKeyholderBuilder {
    return new ElectionInviteKeyholderBuilder(this)
  }

  buildRevokeKeyholder (): IElectionRevokeKeyholderBuilder {
    return new ElectionRevokeKeyholderBuilder(this)
  }
}
