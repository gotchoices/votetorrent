import React, { createContext, useContext, useState, useCallback } from "react";
import type { PropsWithChildren } from "react";
import type { Ballot, Question, Option } from "@votetorrent/vote-core";

/**
 * BallotDraftProvider — React Context scoped to the Ballot flow per Phase 9 D-11.
 *
 * Holds the in-progress ballot draft (questions[] with nested options[]).
 *
 * Mounted ONCE above the navigator (App.tsx) so all four ballot screens
 * (CreateBallot / EditBallot / EditQuestion / EditQuestionOption) share a
 * single draft instance. `screenLayout` was previously used but wraps each
 * screen separately, giving every screen its own empty draft — which broke
 * edit pre-population. Because the instance now persists across ballot-flow
 * entries, callers reset per flow: CreateBallot clears the draft on mount
 * (fresh create); EditBallot replaces it via getBallotDetails (edit mode).
 *
 * Pattern reference: apps/VoteTorrentAuthority/src/providers/AppProvider.tsx
 * (createContext + useContext + hook + Provider).
 */

interface BallotDraftContextType {
	ballotDraft: Partial<Ballot>;
	setBallotDraft: (b: Partial<Ballot>) => void;
	addQuestion: (q: Question) => void;
	updateQuestion: (code: string, q: Question) => void;
	removeQuestion: (code: string) => void;
	addOption: (questionCode: string, o: Option) => void;
	updateOption: (questionCode: string, optionCode: string, o: Option) => void;
	removeOption: (questionCode: string, optionCode: string) => void;
}

const BallotDraftContext = createContext<BallotDraftContextType | null>(null);

export function useBallotDraft() {
	const context = useContext(BallotDraftContext);
	if (!context) {
		throw new Error("useBallotDraft must be used within a BallotDraftProvider");
	}
	return context;
}

export function BallotDraftProvider({ children }: PropsWithChildren) {
	const [ballotDraft, setBallotDraftState] = useState<Partial<Ballot>>({ questions: [] });

	const setBallotDraft = useCallback((b: Partial<Ballot>) => {
		setBallotDraftState(b);
	}, []);

	const addQuestion = useCallback((q: Question) => {
		setBallotDraftState((prev) => ({
			...prev,
			questions: [...(prev.questions ?? []), q],
		}));
	}, []);

	const updateQuestion = useCallback((code: string, q: Question) => {
		setBallotDraftState((prev) => ({
			...prev,
			questions: (prev.questions ?? []).map((existing) =>
				existing.code === code ? q : existing
			),
		}));
	}, []);

	const removeQuestion = useCallback((code: string) => {
		setBallotDraftState((prev) => ({
			...prev,
			questions: (prev.questions ?? []).filter((existing) => existing.code !== code),
		}));
	}, []);

	const addOption = useCallback((questionCode: string, o: Option) => {
		setBallotDraftState((prev) => ({
			...prev,
			questions: (prev.questions ?? []).map((existing) =>
				existing.code === questionCode
					? { ...existing, options: [...(existing.options ?? []), o] }
					: existing
			),
		}));
	}, []);

	const updateOption = useCallback(
		(questionCode: string, optionCode: string, o: Option) => {
			setBallotDraftState((prev) => ({
				...prev,
				questions: (prev.questions ?? []).map((existing) =>
					existing.code === questionCode
						? {
								...existing,
								options: (existing.options ?? []).map((opt) =>
									opt.code === optionCode ? o : opt
								),
							}
						: existing
				),
			}));
		},
		[]
	);

	const removeOption = useCallback((questionCode: string, optionCode: string) => {
		setBallotDraftState((prev) => ({
			...prev,
			questions: (prev.questions ?? []).map((existing) =>
				existing.code === questionCode
					? {
							...existing,
							options: (existing.options ?? []).filter((opt) => opt.code !== optionCode),
						}
					: existing
			),
		}));
	}, []);

	return (
		<BallotDraftContext.Provider
			value={{
				ballotDraft,
				setBallotDraft,
				addQuestion,
				updateQuestion,
				removeQuestion,
				addOption,
				updateOption,
				removeOption,
			}}
		>
			{children}
		</BallotDraftContext.Provider>
	);
}
