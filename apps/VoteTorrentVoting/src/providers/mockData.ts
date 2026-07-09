import type {LifecycleContent, LifecycleState, MockElection, ValidationCheck} from './types';

/**
 * App-local seed fixture for VotingAppProvider (D-04). This is the ONLY module holding literal
 * mock data — screens must never import it directly; they read through `useVotingApp()` instead
 * so SHELL-03's source scan of `screens/` finds zero inline mock-data imports.
 */

/** Base election identity — the part of `MockElection` that does NOT vary across lifecycle states. */
export const mockElection: Pick<MockElection, 'id' | 'title'> = {
	id: 'mock-election-1',
	title: 'Utah Network General Election',
};

/**
 * A future ISO-8601 instant, `msFromNow` milliseconds ahead of read-time. Used for per-state
 * countdown targets — a read-time relative offset (rather than a stale hardcoded date) so the
 * countdown always renders a plausible small HH:MM:SS during review, regardless of when the app
 * is run (RESEARCH Pitfall 2 / this plan's Task 2 "Claude's discretion" note).
 */
function nowPlus(msFromNow: number): string {
	return new Date(Date.now() + msFromNow).toISOString();
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * ONE static evidence array of exactly 3 checks, shared identically between the `Validation`
 * state's compact-card N/3 count and the `ValidationDetails` state's summary + drill-in screen
 * (UI-SPEC "Data note") — so the two adjacent cycler states can never show a mismatched N/3.
 * Sourced from Figma frames `276:868` (checks 1-2 + timings) / `52:290` (check 3 name/result).
 * Check 3's elapsed time has no documented Figma value (RESEARCH Assumption A4) — `1.1` is a
 * plausible non-canonical placeholder, tagged here rather than presented as Figma-verified.
 */
const VALIDATION_EVIDENCE: ValidationCheck[] = [
	{
		nameKey: 'home.validationDetails.check1.name',
		resultKey: 'home.validationDetails.check1.result',
		elapsedSeconds: 5.3,
		verified: true,
	},
	{
		nameKey: 'home.validationDetails.check2.name',
		resultKey: 'home.validationDetails.check2.result',
		elapsedSeconds: 0.2,
		verified: true,
	},
	{
		nameKey: 'home.validationDetails.check3.name',
		resultKey: 'home.validationDetails.check3.result',
		// [ASSUMED] placeholder — no documented Figma elapsed time for check 3 (RESEARCH A4).
		elapsedSeconds: 1.1,
		verified: false,
	},
];

const VALIDATION_CHECKS_COMPLETE = VALIDATION_EVIDENCE.filter(c => c.verified).length;
const VALIDATION_CHECKS_TOTAL = VALIDATION_EVIDENCE.length;

/**
 * Per-lifecycle-state content merged into `getElection()`'s resolved `MockElection` (RESEARCH
 * Pitfall 1 / D-05). One entry per `LifecycleState`, sourced from `40-FIGMA-EXTRACT.md`'s older
 * numbered reference frames + `40-UI-SPEC.md`'s Copywriting Contract data notes.
 */
export const LIFECYCLE_CONTENT: Record<LifecycleState, LifecycleContent> = {
	// Frame `1:54` — "Upcoming…", "-1 day / 7 hours" until polls open. No progress (not open yet).
	Upcoming: {
		countdownTarget: nowPlus(31 * HOUR_MS),
	},
	// Frame `2761:1125` — "8 hours remaining", 30% complete progress bar + Vote now CTA.
	Open: {
		countdownTarget: nowPlus(8 * HOUR_MS),
		progress: 0.3,
	},
	// [ASSUMED] RESEARCH Pitfall 4/A1 — no dedicated Home-card Figma frame for this state; frame
	// `42:513` is the full in-flow Ballot review screen, not this card's summary. No
	// countdown/progress shown (RESEARCH A3).
	ReviewSelections: {},
	// Frame `321:770` — "locked - 3/5 election keys released", "21 min remaining".
	ReleasingKeys: {
		countdownTarget: nowPlus(21 * MINUTE_MS),
		keysReleased: 3,
		keysTotal: 5,
	},
	// Frame `52:158`/`52:290` — "unlocked - 5/5 election keys released", "20 min remaining",
	// "Validation status 2/3". Shares VALIDATION_EVIDENCE's derived counts with ValidationDetails
	// so the two adjacent states never show a mismatched N/3 (UI-SPEC Data note).
	Validation: {
		countdownTarget: nowPlus(20 * MINUTE_MS),
		keysReleased: 5,
		keysTotal: 5,
		checksComplete: VALIDATION_CHECKS_COMPLETE,
		checksTotal: VALIDATION_CHECKS_TOTAL,
	},
	// Frame `276:868` — full per-check evidence rows + timings, "fingerprint: Birddog133". No
	// countdown/progress shown (RESEARCH A3) — this is a drill-in, not a live-counting state.
	ValidationDetails: {
		checksComplete: VALIDATION_CHECKS_COMPLETE,
		checksTotal: VALIDATION_CHECKS_TOTAL,
		fingerprint: 'Birddog133',
		evidence: VALIDATION_EVIDENCE,
	},
	// Frame `53:449` — condensed per CONTEXT.md's D-07-cited example, "Certified ✓".
	Complete: {
		certified: true,
	},
};
