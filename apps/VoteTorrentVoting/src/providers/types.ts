/**
 * App-local, future-engine-shaped interfaces for VoteTorrentVoting's mock provider (D-04).
 *
 * These shapes deliberately mirror what a future `vote-core` election read surface would look
 * like (id, title, lifecycle state, async reads) so that swapping VotingAppProvider's mock
 * implementation for a real engine later is DI-only, not a rewrite of every screen (D-01).
 *
 * Voter/Registration/Ballot-selection shapes that have no `vote-core` analog stay app-local
 * here — they are NOT promoted to `vote-core` this phase (D-04, REQUIREMENTS Out of Scope).
 * This module must never import from `vote-core`.
 */

/**
 * The 7-state election lifecycle, in canonical order (D-03). Phase 40's `__DEV__` cycler steps
 * through LIFECYCLE_ORDER to force review of every state; Phase 40 fills in each state's actual
 * screen content.
 */
export type LifecycleState =
	| 'Upcoming'
	| 'Open'
	| 'ReviewSelections'
	| 'ReleasingKeys'
	| 'Validation'
	| 'ValidationDetails'
	| 'Complete';

/** Ordered mirror of LifecycleState, for the `__DEV__` cycler (D-03) and tests. */
export const LIFECYCLE_ORDER: readonly LifecycleState[] = [
	'Upcoming',
	'Open',
	'ReviewSelections',
	'ReleasingKeys',
	'Validation',
	'ValidationDetails',
	'Complete',
];

/**
 * Future-engine-shaped mock election — mirrors the fields a real `vote-core` election read
 * would expose (id, title, lifecycle state), plus mock progress/countdown fields the Home
 * screen's placeholder needs this phase.
 */
export interface MockElection {
	id: string;
	title: string;
	lifecycleState: LifecycleState;
	/** ISO-8601 countdown target for the Home screen's placeholder countdown display. */
	countdownTarget: string;
	/** Mock progress ratio (0-1) for lifecycle states that show a progress indicator. */
	progress: number;
}

/**
 * The provider's context shape. Read methods are async (Promise-returning) even though the
 * backing data is in-memory this phase — a deliberate swap-fidelity investment (D-01) so the
 * eventual real-engine wiring becomes DI-only, not a rewrite of every screen.
 */
export interface VotingAppContextType {
	isInitialized: boolean;
	lifecycleState: LifecycleState;
	setLifecycleState: (state: LifecycleState) => void;
	getElection: () => Promise<MockElection>;
}
