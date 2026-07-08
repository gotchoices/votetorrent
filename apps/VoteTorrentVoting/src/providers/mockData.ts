import type {MockElection} from './types';

/**
 * App-local seed fixture for VotingAppProvider (D-04). This is the ONLY module holding literal
 * mock data — screens must never import it directly; they read through `useVotingApp()` instead
 * so SHELL-03's source scan of `screens/` finds zero inline mock-data imports.
 */
export const mockElection: MockElection = {
	id: 'mock-election-1',
	title: 'Utah Network General Election',
	lifecycleState: 'Upcoming',
	countdownTarget: '2026-08-01T00:00:00.000Z',
	progress: 0,
};
