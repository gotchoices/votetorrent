/**
 * election-read.ts — binding over the voter's election/ballot read, which moved to
 * `packages/workflows/src/voter/election-read.ts` (phase 67 plan 19). This path stays so existing
 * imports (`VoterAppProvider`, the screens, `vote-casting`), `jest.mock` paths and tests keep working;
 * the R11 source gate in `__tests__/election-read.test.ts` reads the shared file. Same eight values
 * and two types, re-exported by name.
 */
export {
	NoElectionError,
	lifecycleFromTimeline,
	pickElectionId,
	readVoteContext,
	readVoterBallot,
	readVoterElection,
	resolveCurrentElectionId,
	toVoterBallot,
} from '@votetorrent/workflows/voter'
export type { ElectionReadDeps, VoteContext } from '@votetorrent/workflows/voter'
