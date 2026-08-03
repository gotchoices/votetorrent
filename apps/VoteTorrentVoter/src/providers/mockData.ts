import type {
	Candidate,
	LifecycleContent,
	LifecycleState,
	MockBallot,
	MockElection,
	Office,
	ValidationCheck,
} from './types';

/**
 * App-local seed fixture for VoterAppProvider (D-04). This is the ONLY module holding literal
 * mock data — screens must never import it directly; they read through `useVoterApp()` instead
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

/**
 * The mock ballot (Phase 42, VOTE-01/02, D-02). `42-FIGMA-EXTRACT.md`'s "What was NOT captured"
 * item 1 confirms no fresh Figma pull captured a literal Ballot Page office/candidate list this
 * session (Starter-plan rate limit, same constraint as Phases 40/41) — every office/candidate
 * below is `[ASSUMED]` content authored to plausibly match "offices grouped Federal/State,
 * party-labeled candidates, a per-office voteFor count" (D-02/D-03), not transcribed from a
 * live pull. Flat `offices` array (RESEARCH Pattern 3) — Federal/State grouping is a display-time
 * filter over this one order-stable array, never a split `{federal, state}` shape, so
 * `currentQuestionIndex` (BallotSelectionProvider, Plan 42-02+) can walk a single index space.
 *
 * Mixed voteFor by design (must-haves): US Senate/US House/Governor/State Senate are all
 * `voteFor: 1` (radio); State Board of Education is `voteFor: 2` (capped checkbox) — so both
 * CandidateSelector variants are demonstrable downstream.
 */
export const mockBallot: MockBallot = {
	electionId: mockElection.id,
	offices: [
		// [ASSUMED] Federal — US Senate, voteFor 1 (radio).
		{
			id: 'office-us-senate',
			titleKey: 'office.usSenate',
			jurisdiction: 'Federal',
			voteFor: 1,
			candidates: [
				{id: 'cand-us-senate-diana', nameKey: 'candidate.usSenate.diana', partyKey: 'candidateParty.democratic'},
				{id: 'cand-us-senate-marcus', nameKey: 'candidate.usSenate.marcus', partyKey: 'candidateParty.republican'},
				{id: 'cand-us-senate-elena', nameKey: 'candidate.usSenate.elena', partyKey: 'candidateParty.independent'},
			] satisfies Candidate[],
		},
		// [ASSUMED] Federal — US House, District 2, voteFor 1 (radio).
		{
			id: 'office-us-house',
			titleKey: 'office.usHouse',
			jurisdiction: 'Federal',
			voteFor: 1,
			candidates: [
				{id: 'cand-us-house-james', nameKey: 'candidate.usHouse.james', partyKey: 'candidateParty.democratic'},
				{id: 'cand-us-house-laura', nameKey: 'candidate.usHouse.laura', partyKey: 'candidateParty.republican'},
			] satisfies Candidate[],
		},
		// [ASSUMED] State — Governor, voteFor 1 (radio).
		{
			id: 'office-governor',
			titleKey: 'office.governor',
			jurisdiction: 'State',
			voteFor: 1,
			candidates: [
				{id: 'cand-governor-priya', nameKey: 'candidate.governor.priya', partyKey: 'candidateParty.democratic'},
				{id: 'cand-governor-robert', nameKey: 'candidate.governor.robert', partyKey: 'candidateParty.republican'},
			] satisfies Candidate[],
		},
		// [ASSUMED] State — State Board of Education, voteFor 2 (capped checkbox) — the
		// voteFor>1 demonstration office (must-haves).
		{
			id: 'office-state-board-education',
			titleKey: 'office.stateBoardEducation',
			jurisdiction: 'State',
			voteFor: 2,
			candidates: [
				{id: 'cand-sboe-angela', nameKey: 'candidate.stateBoardEducation.angela', partyKey: 'candidateParty.nonpartisan'},
				{id: 'cand-sboe-brian', nameKey: 'candidate.stateBoardEducation.brian', partyKey: 'candidateParty.nonpartisan'},
				{id: 'cand-sboe-cynthia', nameKey: 'candidate.stateBoardEducation.cynthia', partyKey: 'candidateParty.nonpartisan'},
				{id: 'cand-sboe-david', nameKey: 'candidate.stateBoardEducation.david', partyKey: 'candidateParty.nonpartisan'},
			] satisfies Candidate[],
		},
		// [ASSUMED] State — State Senate, District 8, voteFor 1 (radio).
		{
			id: 'office-state-senate',
			titleKey: 'office.stateSenate',
			jurisdiction: 'State',
			voteFor: 1,
			candidates: [
				{id: 'cand-state-senate-maria', nameKey: 'candidate.stateSenate.maria', partyKey: 'candidateParty.democratic'},
				{id: 'cand-state-senate-thomas', nameKey: 'candidate.stateSenate.thomas', partyKey: 'candidateParty.republican'},
			] satisfies Candidate[],
		},
	] satisfies Office[],
};
