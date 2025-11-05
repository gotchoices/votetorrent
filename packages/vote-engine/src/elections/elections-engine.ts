import type {
	ElectionInit,
	ElectionSummary,
	IElectionEngine,
	IElectionsEngine,
	Proposal,
} from '@votetorrent/vote-core';

export class ElectionsEngine implements IElectionsEngine {
	adjustElection(election: ElectionInit): Promise<void> {
		throw new Error('Not implemented');
	}

	createElection(election: ElectionInit): Promise<void> {
		throw new Error('Not implemented');
	}

	getElectionHistory(): Promise<ElectionSummary[]> {
		throw new Error('Not implemented');
	}

	getElections(): Promise<ElectionSummary[]> {
		throw new Error('Not implemented');
	}

	getProposedElections(): Promise<Proposal<ElectionInit>[]> {
		throw new Error('Not implemented');
	}

	openElection(electionId: string): Promise<IElectionEngine> {
		throw new Error('Not implemented');
	}
}
