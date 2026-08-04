/**
 * useBallot (42-REVIEW IN-01) — centralizes the identical "live-guarded fetch-on-mount" effect
 * that was duplicated verbatim across BallotScreen/IndividualQuestionScreen/ReviewSubmitScreen:
 * `let live = true; getBallot().then(result => { if (live) setBallot(result); }); return () => {
 * live = false; };`.
 *
 * Takes `getBallot` as a PARAMETER rather than calling `useVoterApp()` internally, so each
 * screen still makes its own literal `useVoterApp()` call — preserving SHELL-03/D-06's
 * source-scan-enforced "every screen calls useVoterApp(" convention
 * (`__tests__/no-inline-mock-imports.test.ts`). A screen-invisible `useVoterApp()` call buried
 * inside this hook would silently fail that gate.
 *
 * Also gives future engine-swap work (D-01 swap-fidelity) a single place to add loading/error
 * state later, without touching every screen.
 */
import {useEffect, useState} from 'react';
import type {MockBallot} from '../providers/types';

export function useBallot(getBallot: () => Promise<MockBallot>): {ballot: MockBallot | null} {
	const [ballot, setBallot] = useState<MockBallot | null>(null);

	useEffect(() => {
		let live = true;
		getBallot().then(result => {
			if (live) {
				setBallot(result);
			}
		});
		return () => {
			live = false;
		};
	}, [getBallot]);

	return {ballot};
}
