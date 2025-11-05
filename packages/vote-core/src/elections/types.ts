import type { Proposal } from '../common';
import type { ElectionInit, ElectionSummary } from '../election/models';
import type { IElectionEngine } from '../election/types';

export type IElectionsEngine = {
	adjustElection(election: ElectionInit): Promise<void>;
	createElection(election: ElectionInit): Promise<void>;
	getElectionHistory(): Promise<ElectionSummary[]>;
	getElections(): Promise<ElectionSummary[]>;
	getProposedElections(): Promise<Proposal<ElectionInit>[]>;
	openElection(electionId: string): Promise<IElectionEngine>;
};
