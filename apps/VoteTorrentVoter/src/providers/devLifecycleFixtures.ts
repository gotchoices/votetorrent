import type {LifecycleContent, LifecycleState, ValidationCheck} from './types';

/**
 * `__DEV__`-only design-review content for the Home card's lifecycle states (D-03 cycler).
 *
 * The real election read (`engines/election-read.ts`) only fills what the engine can source.
 * Voting progress, validation checks/fingerprint and certification have NO engine source yet, so a
 * real card simply omits them (keys released is engine-sourced now; this fixture still sets it so
 * every card variant can be reviewed without a published key). When a developer forces a state with the cycler,
 * `VoterAppProvider` overlays that state's entry below so every card variant can still be
 * reviewed. It is never applied in a release build (`lifecycleOverride` is always null there).
 *
 * Screens must never import this module directly — they read through `useVoterApp()` (SHELL-03's
 * source scan, `__tests__/no-inline-mock-imports.test.ts`).
 */

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
// Keys are bare (no `home.` namespace prefix) — `useTranslation('home')`'s `t()` resolves
// flat dotted keys directly against the active `home` namespace (keySeparator: false, no
// nsSeparator match without a colon); a leading `home.` prefix here would fail to resolve
// (Rule 1 fix, discovered while wiring ValidationDetailsScreen — verified via direct i18next
// probe that 'home.validationDetails.check1.name' does not resolve but
// 'validationDetails.check1.name' does).
const VALIDATION_EVIDENCE: ValidationCheck[] = [
	{
		nameKey: 'validationDetails.check1.name',
		resultKey: 'validationDetails.check1.result',
		elapsedSeconds: 5.3,
		verified: true,
	},
	{
		nameKey: 'validationDetails.check2.name',
		resultKey: 'validationDetails.check2.result',
		elapsedSeconds: 0.2,
		verified: true,
	},
	{
		nameKey: 'validationDetails.check3.name',
		resultKey: 'validationDetails.check3.result',
		// [ASSUMED] placeholder — no documented Figma elapsed time for check 3 (RESEARCH A4).
		elapsedSeconds: 1.1,
		verified: false,
	},
];

const VALIDATION_CHECKS_COMPLETE = VALIDATION_EVIDENCE.filter(c => c.verified).length;
const VALIDATION_CHECKS_TOTAL = VALIDATION_EVIDENCE.length;

/**
 * Per-lifecycle-state content overlaid onto `getElection()`'s result under a `__DEV__` override (RESEARCH
 * Pitfall 1 / D-05). One entry per `LifecycleState`, sourced from `40-FIGMA-EXTRACT.md`'s older
 * numbered reference frames + `40-UI-SPEC.md`'s Copywriting Contract data notes.
 */
export const DEV_LIFECYCLE_CONTENT: Record<LifecycleState, LifecycleContent> = {
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
