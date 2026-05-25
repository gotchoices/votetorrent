import type { Proposal } from '../common'
import type { ElectionInit, ElectionSummary } from '../election/models'
import type { IElectionEngine } from '../election/types'
import type { IBuilder } from '../common/builder.js'

export interface IElectionsEngine {
  adjustElection(election: ElectionInit): Promise<void>
  createElection(election: ElectionInit): Promise<void>
  getElectionHistory(): Promise<ElectionSummary[]>
  getElections(): Promise<ElectionSummary[]>
  getProposedElections(): Promise<Array<Proposal<ElectionInit>>>
  openElection(electionId: string): Promise<IElectionEngine>
  buildCreateElection(): IElectionsCreateElectionBuilder
  buildAdjustElection(): IElectionsAdjustElectionBuilder
}

export interface IElectionsCreateElectionBuilder extends IBuilder<ElectionInit, void> {
  fromPayload(payload: ElectionInit): this
}

export interface IElectionsAdjustElectionBuilder extends IBuilder<ElectionInit, void> {
  fromPayload(payload: ElectionInit): this
}
