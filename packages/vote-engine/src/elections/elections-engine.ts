import type {
  ElectionInit,
  ElectionSummary,
  IElectionEngine,
  IElectionsEngine,
  Proposal
} from '@votetorrent/vote-core'

export class ElectionsEngine implements IElectionsEngine {
  async adjustElection (election: ElectionInit): Promise<void> {
    throw new Error('Not implemented')
  }

  async createElection (election: ElectionInit): Promise<void> {
    throw new Error('Not implemented')
  }

  async getElectionHistory (): Promise<ElectionSummary[]> {
    throw new Error('Not implemented')
  }

  async getElections (): Promise<ElectionSummary[]> {
    throw new Error('Not implemented')
  }

  async getProposedElections (): Promise<Array<Proposal<ElectionInit>>> {
    throw new Error('Not implemented')
  }

  async openElection (electionId: string): Promise<IElectionEngine> {
    throw new Error('Not implemented')
  }
}
