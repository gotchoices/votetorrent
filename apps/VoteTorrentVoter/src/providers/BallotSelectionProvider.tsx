import React, { createContext, useContext, useState, useCallback } from 'react';
import type { PropsWithChildren } from 'react';
import type { Candidate, Office } from './types';

/**
 * BallotSelectionProvider — the Vote-stack-scoped, session-only in-memory selection Context
 * (Phase 42, VOTE-01/02, D-01). Mirrors `RegistrationDraftProvider`'s structural mechanics
 * (createContext + useContext + throw-if-outside hook + Provider) but holds a `selectionMap`
 * (officeId → selected candidate id[]) plus the provider-held `currentQuestionIndex` that
 * `IndividualQuestionScreen` walks via Next/Previous (42-RESEARCH.md Pattern 5 — no route
 * param, keeping every `ParamList` entry `undefined` per the established convention).
 *
 * Held in-memory React state ONLY (D-01/D-07) — never persisted to AsyncStorage/SecureStore/
 * disk, and never logged (threat T-42-01). Exiting and re-entering the ballot within the same
 * session resumes where the voter left off; a full app restart clears it (mock milestone).
 *
 * App-local only — does NOT import from `vote-core` and does NOT call `useVoterApp()` (this
 * is a provider, not a screen; it intentionally lives outside the `src/screens/` scan root
 * exercised by `__tests__/no-inline-mock-imports.test.ts`).
 *
 * Pattern references: apps/VoteTorrentVoter/src/providers/RegistrationDraftProvider.tsx
 * (skeleton), apps/VoteTorrentAuthority/src/screens/ballots/providers/BallotDraftProvider.tsx
 * (immutable nested-array update discipline).
 */

export interface BallotSelectionContextType {
	/** officeId -> selected candidate id[]. Never mutated in place — always a new array/object. */
	selectionMap: Record<string, string[]>;
	/** Index into the current ballot's flat `offices[]` array (D-05 — single index space). */
	currentQuestionIndex: number;
	setCurrentQuestionIndex: (index: number) => void;
	/**
	 * voteFor === 1: replaces the selection; re-tapping the already-selected candidate
	 * deselects it (Pitfall 3, intentional deviation from native-radio semantics).
	 * voteFor > 1: toggles membership, capped at `voteFor` — a tap past the cap is a silent
	 * no-op that never evicts an existing selection (Pitfall 4).
	 */
	toggleCandidate: (officeId: string, candidateId: string, voteFor: number) => void;
	/** Advances currentQuestionIndex, clamped at `offices.length - 1` (no overrun). */
	goToNextQuestion: (offices: Office[]) => void;
	/** Decrements currentQuestionIndex, clamped at 0 (no wrap-around, D-06). */
	goToPreviousQuestion: () => void;
}

const BallotSelectionContext = createContext<BallotSelectionContextType | null>(null);

export function useBallotSelection(): BallotSelectionContextType {
	const context = useContext(BallotSelectionContext);
	if (!context) {
		throw new Error('useBallotSelection must be used within a BallotSelectionProvider');
	}
	return context;
}

export function BallotSelectionProvider({ children }: PropsWithChildren) {
	const [selectionMap, setSelectionMap] = useState<Record<string, string[]>>({});
	const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(0);

	const toggleCandidate = useCallback((officeId: string, candidateId: string, voteFor: number) => {
		setSelectionMap((prev) => {
			const current = prev[officeId] ?? [];

			if (voteFor === 1) {
				// Radio: tapping the already-selected candidate deselects it (Pitfall 3 — a
				// deliberate deviation from strict native-radio semantics, documented in
				// 42-RESEARCH.md, needed to demonstrate D-04's "leaving blank = incomplete"
				// round-trip without a separate "Clear Selections" affordance).
				const next = current[0] === candidateId ? [] : [candidateId];
				return { ...prev, [officeId]: next };
			}

			// Checkbox capped at voteFor: toggle membership; silently no-op past the cap
			// (D-03 — the voteFor cap is the ONLY selection constraint, no error/toast state).
			if (current.includes(candidateId)) {
				return { ...prev, [officeId]: current.filter((id) => id !== candidateId) };
			}
			if (current.length >= voteFor) {
				// At cap — ignore the tap, do NOT replace/evict an existing pick (Pitfall 4).
				return prev;
			}
			return { ...prev, [officeId]: [...current, candidateId] };
		});
	}, []);

	const goToNextQuestion = useCallback((offices: Office[]) => {
		setCurrentQuestionIndex((prev) => Math.min(prev + 1, Math.max(offices.length - 1, 0)));
	}, []);

	const goToPreviousQuestion = useCallback(() => {
		setCurrentQuestionIndex((prev) => Math.max(prev - 1, 0));
	}, []);

	return (
		<BallotSelectionContext.Provider
			value={{
				selectionMap,
				currentQuestionIndex,
				setCurrentQuestionIndex,
				toggleCandidate,
				goToNextQuestion,
				goToPreviousQuestion,
			}}>
			{children}
		</BallotSelectionContext.Provider>
	);
}

/**
 * Derived N/M progress — a pure function, never a stored counter (D-04). An office counts as
 * completed once it has at least one candidate selected; `total` is ALWAYS `offices.length`
 * regardless of any office's `voteFor` value — one office is always exactly one "question"
 * (Pitfall 5 — never voteFor-weighted).
 */
export function computeCompletedCount(
	offices: Office[],
	selectionMap: Record<string, string[]>,
): { completed: number; total: number } {
	const completed = offices.filter((o) => (selectionMap[o.id]?.length ?? 0) > 0).length;
	return { completed, total: offices.length };
}

/**
 * Resolves an office's selection summary (42-REVIEW WR-02/IN-02) — the joined localized names of
 * every selected candidate, or the localized `notYetAnswered` fallback when the office has no
 * selection — plus `hasSelection`, derived from the SAME `selectedIds` lookup rather than being
 * recomputed independently by each call site. Previously duplicated verbatim between
 * `BallotScreen` and `ReviewSubmitScreen`; centralized here alongside `computeCompletedCount`,
 * the codebase's established convention for shared selectionMap-derived logic.
 */
export function resolveSelectionSummary(
	officeId: string,
	candidates: Candidate[],
	selectionMap: Record<string, string[]>,
	t: (key: string) => string,
): { summary: string; hasSelection: boolean } {
	const selectedIds = selectionMap[officeId] ?? [];
	const hasSelection = selectedIds.length > 0;
	if (!hasSelection) {
		return { summary: t('notYetAnswered'), hasSelection };
	}
	const summary = selectedIds
		.map((id) => candidates.find((candidate) => candidate.id === id))
		.filter((candidate): candidate is Candidate => Boolean(candidate))
		.map((candidate) => t(candidate.nameKey))
		.join(', ');
	return { summary, hasSelection };
}
