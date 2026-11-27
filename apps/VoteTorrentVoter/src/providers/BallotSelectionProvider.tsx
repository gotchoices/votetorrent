import React, { createContext, useContext, useState, useCallback } from 'react';
import type { PropsWithChildren } from 'react';
import type { Candidate, Office } from './types';

/**
 * BallotSelectionProvider — the APP-SCOPED (Phase 59, D-22), session-only in-memory selection
 * Context (Phase 42, VOTE-01/02, D-01). Mirrors `RegistrationDraftProvider`'s structural
 * mechanics (createContext + useContext + throw-if-outside hook + Provider) but holds a
 * `selectionMap` (officeId → selected candidate id[]) plus the provider-held
 * `currentQuestionIndex` that `IndividualQuestionScreen` walks via Next/Previous
 * (42-RESEARCH.md Pattern 5 — no route param, keeping every `ParamList` entry `undefined` per
 * the established convention).
 *
 * D-22 correction: an earlier decision draft claimed this provider was `AsyncStorage`-backed —
 * false. It is, and always was, pure in-memory `useState`/`useCallback` with ZERO persistence
 * (see below) — which is exactly why lifting it above `Tab.Navigator` (mounted once via
 * `AppStateProviders` in `navigation/index.tsx`, not per-stack) was necessary: with no
 * persistence layer, two mounted instances have no mechanism to ever reconverge, so a Vote-tab
 * selection and a Timeline-tab selection (59-10's duplicate `Ballot` route) would silently
 * diverge forever, not just temporarily. See `__tests__/provider-scope.test.tsx` for the
 * committed gate enforcing exactly one instance app-wide.
 *
 * Held in-memory React state ONLY (D-01/D-07) — never persisted to AsyncStorage/SecureStore/
 * disk, and never logged (threat T-42-01). Exiting and re-entering the ballot within the same
 * session resumes where the voter left off; a full app restart clears it (mock milestone).
 *
 * App-local only — does NOT import from `vote-core` and does NOT call `useVoterApp()` (this
 * is a provider, not a screen; it intentionally lives outside the `src/screens/` scan root
 * exercised by `__tests__/no-inline-mock-imports.test.ts`).
 *
 * `clearSelections` exists for the post-save reset: Review/Submit empties the in-memory choices
 * once the vote is stored (63-13).
 *
 * `pruneSelections` (63 WR-01) drops what the current ballot no longer shows: an office that is
 * not on it, and a candidate id its office no longer offers. Such an entry is invisible on the
 * Ballot and Review screens, so the voter could neither see nor clear it, and a hidden candidate
 * would still count toward the `voteFor` cap. Review/Submit calls it whenever its ballot loads.
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
	/**
	 * Resets `selectionMap` to `{}` and `currentQuestionIndex` to 0. Review/Submit calls it only
	 * after a vote is saved on this phone (D-10), so a saved vote's choices do not linger in memory.
	 */
	clearSelections: () => void;
	/**
	 * Keeps only entries whose office is in `offices`, and only the candidate ids that office still
	 * offers. A no-op (the same map object) when nothing is stale, so calling it on every ballot load
	 * never re-renders. Never adds or re-orders a selection, and never touches `currentQuestionIndex`.
	 */
	pruneSelections: (offices: readonly Office[]) => void;
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

	const clearSelections = useCallback(() => {
		setSelectionMap({});
		setCurrentQuestionIndex(0);
	}, []);

	const pruneSelections = useCallback((offices: readonly Office[]) => {
		setSelectionMap((prev) => prunedSelectionMap(prev, offices));
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
				clearSelections,
				pruneSelections,
			}}>
			{children}
		</BallotSelectionContext.Provider>
	);
}

/**
 * The pure core of `pruneSelections` (63 WR-01): `prev` restricted to the offices and candidates
 * the given ballot shows. Returns `prev` itself when nothing was dropped.
 */
export function prunedSelectionMap(
	prev: Record<string, string[]>,
	offices: readonly Office[],
): Record<string, string[]> {
	const byId = new Map(offices.map((o) => [o.id, o]));
	const next: Record<string, string[]> = {};
	let changed = false;
	for (const [officeId, ids] of Object.entries(prev)) {
		const office = byId.get(officeId);
		if (office === undefined) {
			changed = true;
			continue;
		}
		if (!Array.isArray(ids)) {
			// Not a selection shape this provider ever writes; leave it for castVote to refuse by name.
			next[officeId] = ids;
			continue;
		}
		const offered = new Set(office.candidates.map((c) => c.id));
		const kept = ids.filter((id) => offered.has(id));
		if (kept.length !== ids.length) {
			changed = true;
		}
		next[officeId] = kept.length === ids.length ? ids : kept;
	}
	return changed ? next : prev;
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
 * Resolves an office's selection summary (42-REVIEW WR-02/IN-02) — the joined names of every
 * selected candidate (authority-published literal text, not i18n keys), or the localized `notYetAnswered` fallback when the office has no
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
		.map((candidate) => candidate.name)
		.join(', ');
	return { summary, hasSelection };
}
