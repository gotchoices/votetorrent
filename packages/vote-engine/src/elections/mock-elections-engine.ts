import type {
	ElectionInit,
	ElectionSummary,
	IElectionEngine,
	IElectionsEngine,
} from '@votetorrent/vote-core';
import type { ElectionType, Proposal, SID } from '@votetorrent/vote-core';
import { MockElectionEngine } from '../election/mock-election-engine';

// Helper function to get Unix timestamp
const getUnixTimestamp = (date: Date): number =>
	Math.floor(date.getTime() / 1000);

const mockElections: ElectionSummary[] = [
	{
		sid: 'election-1' as SID,
		title: 'Test Election 1 (Past)',
		authorityName: 'Mock Authority A',
		date: getUnixTimestamp(new Date('2024-01-01')),
		type: 'adhoc' as ElectionType,
	},
	{
		sid: 'election-2' as SID,
		title: 'Test Election 2 (Future)',
		authorityName: 'Mock Authority B',
		date: getUnixTimestamp(new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)), // 10 days from now
		type: 'official' as ElectionType,
	},
];

// Mock ElectionInit structure for the proposal
const mockElectionInitData: ElectionInit = {
	election: {
		sid: 'election-3' as SID,
		authoritySid: 'authority-mock' as SID,
		title: 'Proposed Election 3',
		date: getUnixTimestamp(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)), // Starts in 14 days
		revisionDeadline: getUnixTimestamp(
			new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
		), // 10 days from now
		type: 'adhoc' as ElectionType,
	},
	revision: {
		electionSid: 'election-3' as SID,
		revision: 1,
		revisionTimestamp: [], // Mock timestamp
		tags: ['proposed', 'test'],
		instructions: 'These are the instructions for the proposed election.',
		keyholders: [{ name: 'Keyholder 1' }, { name: 'Keyholder 2' }],
		timeline: {
			registrationEnds: getUnixTimestamp(
				new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
			),
			ballotsFinal: getUnixTimestamp(
				new Date(Date.now() + 16 * 24 * 60 * 60 * 1000)
			),
			votingStarts: getUnixTimestamp(
				new Date(Date.now() + 17 * 24 * 60 * 60 * 1000)
			),
			tallyingStarts: getUnixTimestamp(
				new Date(Date.now() + 21 * 24 * 60 * 60 * 1000)
			),
			validation: getUnixTimestamp(
				new Date(Date.now() + 22 * 24 * 60 * 60 * 1000)
			),
			certificationStarts: getUnixTimestamp(
				new Date(Date.now() + 23 * 24 * 60 * 60 * 1000)
			),
			closed: getUnixTimestamp(new Date(Date.now() + 24 * 24 * 60 * 60 * 1000)),
		},
		keyholderThreshold: 2,
	},
};

const mockProposedElections: Proposal<ElectionInit>[] = [
	{
		proposed: mockElectionInitData,
		timestamp: getUnixTimestamp(new Date()),
		signatures: [], // Mock signatures
	},
];

export class MockElectionsEngine implements IElectionsEngine {
	private elections: Map<SID, ElectionSummary> = new Map(
		mockElections.map((e) => [e.sid, e])
	);
	private proposedElections: Map<SID, Proposal<ElectionInit>> = new Map(
		mockProposedElections.map((p) => [p.proposed.election.sid, p])
	);

	async adjustElection(election: ElectionInit): Promise<void> {
		console.log('Adjusting election:', election);
		const electionSid = election.election.sid;
		const existing = this.elections.get(electionSid);
		if (!existing) {
			throw new Error(`Election with SID ${electionSid} not found.`);
		}
		// Simulate adjustment - in a real scenario, this would likely involve a proposal process
		const updatedSummary: ElectionSummary = {
			sid: electionSid,
			title: election.election.title,
			authorityName: existing.authorityName, // Assuming authority doesn't change easily
			date: election.election.date,
			type: election.election.type,
		};
		this.elections.set(electionSid, updatedSummary);
		console.log('Election adjusted:', updatedSummary);
	}

	async createElection(election: ElectionInit): Promise<void> {
		console.log('Creating election:', election);
		const electionSid = election.election.sid;
		if (this.elections.has(electionSid)) {
			throw new Error(`Election with SID ${electionSid} already exists.`);
		}
		// Simulate creation - usually follows a proposal approval
		const newElectionSummary: ElectionSummary = {
			sid: electionSid,
			title: election.election.title,
			authorityName: `Mock Authority for ${electionSid}`,
			date: election.election.date,
			type: election.election.type,
		};
		this.elections.set(electionSid, newElectionSummary);
		// Remove from proposed if it existed there
		this.proposedElections.delete(electionSid);
		console.log('Election created:', newElectionSummary);
	}

	async getElectionHistory(): Promise<ElectionSummary[]> {
		console.log('Getting election history');
		const now = getUnixTimestamp(new Date());
		// Simple mock logic: history = elections with date in the past
		return Array.from(this.elections.values()).filter((e) => e.date < now);
	}

	async getElections(): Promise<ElectionSummary[]> {
		console.log('Getting active elections');
		const now = getUnixTimestamp(new Date());
		// Simple mock logic: active/pending = elections with date in the future
		return Array.from(this.elections.values()).filter((e) => e.date >= now);
	}

	async getProposedElections(): Promise<Proposal<ElectionInit>[]> {
		console.log('Getting proposed elections');
		return Array.from(this.proposedElections.values());
	}

	async openElection(electionSid: SID): Promise<IElectionEngine> {
		console.log('Opening election:', electionSid);
		const electionSummary = this.elections.get(electionSid);
		if (!electionSummary) {
			throw new Error(`Election with SID ${electionSid} not found.`);
		}
		// Return a mock election engine instance for this specific election
		// MockElectionEngine constructor takes no arguments currently.
		// In a real scenario, it would likely take the electionSid or summary
		// to fetch/manage the specific election's details.
		return new MockElectionEngine();
	}
}
