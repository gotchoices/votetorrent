import type { Proposal } from '../common'
import type { Signature } from '../common/signature'
import type { ElectionCoreInit, ElectionInit, ElectionSummary } from '../election/models'
import type { IElectionEngine } from '../election/types'
import type { IBuilder } from '../common/builder.js'

export interface IElectionsEngine {
  adjustElection(election: ElectionInit): Promise<void>
  // DEBT-02: revisionSigningNonce added to options (was missing — screen used `as unknown as`)
  createElection(
    election: ElectionInit,
    options?: { signingNonce?: string; revisionSigningNonce?: string }
  ): Promise<void>
  getElectionHistory(): Promise<ElectionSummary[]>
  getElections(): Promise<ElectionSummary[]>
  getProposedElections(): Promise<Array<Proposal<ElectionInit>>>
  openElection(electionId: string): Promise<IElectionEngine>
  buildCreateElection(): IElectionsCreateElectionBuilder
  buildAdjustElection(): IElectionsAdjustElectionBuilder

  // DEBT-02: promote signing seam methods from concrete class onto interface
  seedElectionSigning(
    electionFields: Pick<ElectionCoreInit, 'id' | 'authorityId' | 'title' | 'date' | 'revisionDeadline' | 'ballotDeadline' | 'type'>,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<string>

  seedElectionRevisionSigning(
    electionId: string,
    authorityId: string,
    revision: {
      revision: number
      revisionTimestamp: number
      tags: string[]
      instructions: string
      timeline: Record<string, number>
      keyholderThreshold: number
    },
    tid: number,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<string>
}

export interface IElectionsCreateElectionBuilder extends IBuilder<ElectionInit, void> {
  fromPayload(payload: ElectionInit): this
}

export interface IElectionsAdjustElectionBuilder extends IBuilder<ElectionInit, void> {
  fromPayload(payload: ElectionInit): this
}
