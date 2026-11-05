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
 * `getBallot` is a real engine read and rejects when there is no election to read, so the hook
 * also reports `failed` — screens render an unavailable state instead of an empty ballot that
 * looks like a loading one forever.
 */
import {useEffect, useState} from 'react';
import type {VoterBallot} from '../providers/types';

export function useBallot(getBallot: () => Promise<VoterBallot>): {ballot: VoterBallot | null; failed: boolean} {
	const [ballot, setBallot] = useState<VoterBallot | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let live = true;
		setFailed(false);
		getBallot().then(
			result => {
				if (live) {
					setBallot(result);
				}
			},
			() => {
				if (live) {
					setFailed(true);
				}
			},
		);
		return () => {
			live = false;
		};
	}, [getBallot]);

	return {ballot, failed};
}
