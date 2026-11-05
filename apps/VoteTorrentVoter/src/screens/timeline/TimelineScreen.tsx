/**
 * TimelineScreen (Phase 59, plan 59-08) — the Timeline tab's root screen, and the voter app's
 * FIRST real election read (D-01; Phase 44 swapped only the registration flow). This screen owns
 * the provider read and nothing else owns it: it resolves the election identity (D-02), reads
 * `current.timeline` through the engine chain `getEngine('elections')` -> `getElections()` ->
 * `openElection(id)` -> `getElectionDetails()`, hands the raw blob to 59-06's pure
 * `deriveTimeline()` adapter, and composes 59-07's presentational `TimelineRail`. When the answer
 * is not trustworthy it says so out loud and replaces the rail entirely (D-03) — never a partial
 * rail, never a blank tab.
 *
 * Read scope is narrow by construction (D-04): `details.election.title`, `details.election.date`
 * and `details.current.timeline` only. The voter app's mock lifecycle-content surface (the Home
 * tab's own election card and its per-state fixture data, D-12) is never referenced here — that
 * surface keeps consuming the mock data it always has, unchanged.
 *
 * The Voting Period row reflects the vote saved on this phone, read from the non-secret marker
 * through `readSavedVoteStatus` on every focus (D-12, D-19): no fingerprint, no direct storage
 * access, nothing cached. Its link opens the saved-vote receipt for the resolved election.
 *
 * `TimelineRail` / `TimelineRow` stay presentational (props only) — this file is the one place on
 * this surface that calls `useVoterApp()` and `useNavigation()`.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import type {IElectionsEngine} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {TimelineRail} from '../../components/TimelineRail';
import {InfoDialog} from '../../components/InfoDialog';
import {TimelineRegistrationPanel} from '../../components/TimelineRegistrationPanel';
import i18n from '../../i18n';
import type {TimelineStackParamList} from '../../navigation/types';
import {STAGE_TITLE_KEY, deriveTimeline} from '../../timeline';
import type {TimelineStageId, TimelineViewModelConfident} from '../../timeline';
import {resolveRegistrationStatus} from '../../engines/registration-status';
import type {RegistrationStatusResult} from '../../engines/registration-status';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {readSavedVoteStatus} from '../../engines/saved-vote-status';
import type {SavedVoteStatus} from '../../engines/saved-vote-status';
import {SavedVoteNotice} from '../../components/SavedVoteNotice';

// D-02's election-identity rule now lives in engines/election-read.ts (shared with the Home and
// Ballot reads); re-exported here so existing importers keep resolving it from this module.
import {pickElectionId} from '../../engines/election-read';
export {pickElectionId};

export interface HeaderDateRangeParts {
	startDate: string;
	endDate: string;
	// Index signature so this type structurally satisfies i18next's `t(key, options)` params
	// bag (`$Dictionary`) -- a plain interface without one fails TS2345 at the `t()` call site.
	[key: string]: string;
}

/** Resolves the device's IANA time zone once, at this screen's call boundary. `deriveTimeline`
 * (`src/timeline/`) and `computeHeaderDateRange` below are pure and take `timeZone` as an
 * argument -- neither reads this itself -- so this is the ONE place in the ready-state render
 * path that consults device configuration. `DeriveTimelineInput.timeZone`'s own doc comment
 * (`src/timeline/types.ts`) promises "the device-local zone when omitted -- deliberately NOT
 * UTC, per the contracts' 'a voter near midnight' rationale"; that promise is honored by ALWAYS
 * passing this resolved value explicitly below, never by relying on either function's internal
 * `?? 'UTC'` fallback (which stays UTC-only for callers, e.g. tests, that omit `timeZone`
 * entirely). This reads `Intl.DateTimeFormat().resolvedOptions().timeZone`, not the process
 * clock -- it is exempt from this module's "no ambient clock" contract, which is about `now`,
 * not the offset used to render it. */
export function resolveDeviceTimeZone(): string | undefined {
	// WR-01 (59-REVIEW-2): guarded exactly like every other `Intl` call site in this phase
	// (`relative-date.ts`'s `dateParts`/`weekdayName`). A device/Hermes/ICU build where the
	// zero-arg resolved-options lookup throws must degrade to the documented UTC fallback, NOT
	// crash render -- the voter app has no ErrorBoundary, so an escaping throw here would blank
	// the whole screen and defeat D-03's "never blank, never silent" guarantee that this screen
	// upholds on every other failure path. `undefined` flows into both consumers' own `?? 'UTC'`
	// defaults, so the fallback stays in one place rather than being restated here.
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

/** Numeric `YYYY-MM-DD` calendar-day key for `ms` in `timeZone`, read back from
 * `Intl.DateTimeFormat.formatToParts` (never a formatted/localized string) — mirrors
 * `src/timeline/relative-date.ts`'s `dateParts` idiom. Locale-independent (uses `'en'`
 * regardless of the caller's display language) because this key is used only for equality
 * comparisons, never rendered. */
function calendarDayKey(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The active-language `"March 20"`-shaped month-name-plus-day string for `ms`, or just the
 * bare day number when `dayOnly` is set (the UI-SPEC's "endDate is the day number alone" same-
 * month case). Built from `formatToParts`, never string concatenation of a formatted date. */
function formatHeaderDay(ms: number, language: string, timeZone: string, dayOnly: boolean): string {
	const options: Intl.DateTimeFormatOptions = dayOnly ? {timeZone, day: 'numeric'} : {timeZone, month: 'long', day: 'numeric'};
	const parts = new Intl.DateTimeFormat(language, options).formatToParts(new Date(ms));
	if (dayOnly) {
		return parts.find(p => p.type === 'day')?.value ?? '';
	}
	const month = parts.find(p => p.type === 'month')?.value ?? '';
	const day = parts.find(p => p.type === 'day')?.value ?? '';
	return `${month} ${day}`;
}

/**
 * UI-SPEC `header.dateRange` (D-20 discretion): the earliest/latest PRESENT timeline instants
 * (59-06's `rangeStartMs`/`rangeEndMs`), formatted in the active i18n language. Returns `null`
 * when the present instants collapse to a single calendar day — the date-range line is then
 * omitted entirely rather than rendering "March 20 - March 20" (a 7-of-10-key timeline still
 * produces a range from its seven present instants; it is not this function's job to decide
 * whether the INPUT was indeterminate, only whether the range is degenerate).
 */
export function computeHeaderDateRange(rangeStartMs: number, rangeEndMs: number, language: string, timeZone = 'UTC'): HeaderDateRangeParts | null {
	const startKey = calendarDayKey(rangeStartMs, timeZone);
	const endKey = calendarDayKey(rangeEndMs, timeZone);
	if (startKey === endKey) {
		return null;
	}

	const sameMonthAndYear = startKey.slice(0, 7) === endKey.slice(0, 7); // 'YYYY-MM' prefix
	return {
		startDate: formatHeaderDay(rangeStartMs, language, timeZone, false),
		endDate: formatHeaderDay(rangeEndMs, language, timeZone, sameMonthAndYear),
	};
}

type ScreenState =
	| {kind: 'loading'}
	| {kind: 'ready'; title: string; date: number; view: TimelineViewModelConfident}
	| {kind: 'indeterminate'};

export default function TimelineScreen() {
	// D-06/SHELL-03 (mirrors HomeScreen.tsx): every screen routes through useVoterApp() — no
	// inline mock-data-module import, and no direct election-record read either (D-04 read-scope
	// fence: this screen touches only the engine chain below).
	const {getEngine, seededElectionId, clockOffsetMs, setClockOffsetMs, nowMs: readSharedNowMs} = useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');
	const {t: tCommon} = useTranslation('common');
	// Read per render: `useTranslation` re-renders this screen on a language change, and the
	// timeline-read effect below depends on it so the rows' weekday names re-derive in the new
	// language (`deriveTimeline` otherwise defaults to 'en').
	const language = i18n.language;
	const navigation = useNavigation<NativeStackNavigationProp<TimelineStackParamList, 'TimelineHome'>>();

	const [state, setState] = useState<ScreenState>({kind: 'loading'});
	const [reloadNonce, setReloadNonce] = useState(0);
	// D-06/D-23 (59-09): the registrationEnds row's status panel. `electionId` is captured
	// separately from `state` so the registration-status effect below can depend on it without
	// re-running every time `nowMs` changes (the registration read carries no clock dependency at
	// all -- unlike the timeline derivation, it never reads `now`). `registrationStatus` stays
	// `null` while the read is in flight; the panel renders nothing during that window rather
	// than a guessed "not registered" placeholder (D-23 e).
	const [resolvedElectionId, setResolvedElectionId] = useState<string | undefined>(undefined);
	const [savedVote, setSavedVote] = useState<{electionId: string; status: SavedVoteStatus} | null>(null);
	const [registrationStatus, setRegistrationStatus] = useState<RegistrationStatusResult | null>(null);
	// D-20 discretion: neither `see details` nor the row `?` help affordance has a Details route
	// (59-05 fixed the Timeline stack's param list at five entries) or its own copy, so both open
	// the same in-place InfoDialog HomeScreen already uses for `onLearnAboutElection` — modal,
	// not a push, and no new i18n key.
	const [dialogStageId, setDialogStageId] = useState<TimelineStageId | null>(null);

	// D-05/D-02: the __DEV__-only clock-offset control. The offset (0 = live) now lives in
	// VoterAppProvider (D-02), so Home and the vote window gate see the same clock; the control only
	// ever moves that shared offset -- it shifts the `now` the rail compares against and nothing else
	// (never the timeline blob, never the engine read, never a write). `clockStopIndex` stays
	// component-local control-UI state: the cycling position (0 = live, 1..N = the Nth present stage
	// stop in D-09 order), tracked separately from the offset value because the offset is recomputed
	// fresh at each press. If the Timeline remounts with a non-zero shared offset, `clockStopIndex`
	// restarts at 0 and the existing IN-05 branch labels the live offset (`+N`), never as live.
	const [clockStopIndex, setClockStopIndex] = useState(0);

	// Recomputed on every clockOffsetMs/reloadNonce change, from the provider's shared __DEV__ clock
	// (D-02) AT THAT MOMENT -- never read once and cached, per the "no ambient clock capture" spirit
	// this screen owns (deriveTimeline itself never reads the clock; this is the one place that
	// does, exactly once per state change).
	// WR-10: `reloadNonce` is a deliberate CACHE-BUSTING dependency -- it is intentionally not
	// referenced in the callback body, which is exactly why the rule flags it. Do NOT "fix" this by
	// deleting the dep: `nowMs` would then stay frozen across a pull-to-reload whenever
	// `clockOffsetMs` is unchanged, so the rail would re-fetch and re-derive against a STALE now.
	// See the matching note on the effect's own dependency list below (`reloadNonce` stays explicit
	// there for the same reason). No test covers reload freshness today, so this comment is the
	// only thing standing between that dep and a well-meaning lint cleanup.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const nowMs = useMemo(() => readSharedNowMs(), [readSharedNowMs, clockOffsetMs, reloadNonce]);

	// CR-01: resolved once per mount, never re-read per render -- the device's zone does not
	// change mid-session, and re-invoking `Intl.DateTimeFormat` on every render would be wasted
	// work. Threaded through to BOTH `deriveTimeline` below and `computeHeaderDateRange` at
	// render time so every relative-date subtitle, rail `MM/DD` label, and the header date range
	// agree on the same zone.
	const deviceTimeZone = useMemo(() => resolveDeviceTimeZone(), []);

	// HomeScreen.tsx:50-61's `let live = true` cancellation-guard shape, exactly: an async IIFE
	// inside the effect, every set* call guarded by `live`, `live = false` in the cleanup. One
	// try/catch over the WHOLE chain — any rejection anywhere (getEngine, getElections,
	// openElection, getElectionDetails, or the derivation throwing) lands in the indeterminate
	// state, never a partial render.
	useEffect(() => {
		let live = true;

		(async () => {
			try {
				const electionsEngine = await getEngine<IElectionsEngine>('elections');
				const summaries = await electionsEngine.getElections();
				const electionId = pickElectionId(summaries, __DEV__ ? seededElectionId : undefined);

				if (!electionId) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				// D-06/D-23 (59-09): captured so the SEPARATE registration-status effect below can
				// depend on it without re-running on every `nowMs` change (see that effect's own
				// comment for why the registration read carries no clock dependency).
				if (live) setResolvedElectionId(electionId);

				const electionEngine = await electionsEngine.openElection(electionId);
				const details = await electionEngine.getElectionDetails();

				const view = deriveTimeline({
					timeline: details.current.timeline,
					now: nowMs,
					timeZone: deviceTimeZone,
					language,
					election: {
						ballotDeadline: details.election.ballotDeadline,
						date: details.election.date,
					},
				});

				if (view.indeterminate) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				if (live) {
					setState({kind: 'ready', title: details.election.title, date: details.election.date, view});
				}
			} catch {
				// Any rejection in the chain above (getEngine/getElections/openElection/
				// getElectionDetails) lands here — D-03's explicit indeterminate path, never silence.
				if (live) setState({kind: 'indeterminate'});
			}
		})();

		return () => {
			live = false;
		};
		// `reloadNonce` stays an explicit dependency (not folded into `nowMs` alone): two presses
		// close enough in wall-clock time could otherwise recompute the SAME `nowMs` value and
		// silently fail to re-trigger the retry the user just asked for.
	}, [getEngine, seededElectionId, reloadNonce, nowMs, deviceTimeZone, language]);

	// D-06/D-23 (59-09): the registration-status read is its OWN effect, deliberately separate
	// from the timeline-read effect above -- `resolveRegistrationStatus` never reads the clock
	// (it derives from `Association`/`Registrant`/`AssociationRequestRead` rows only), so it must
	// not re-run every time the __DEV__ clock-offset control changes `nowMs`. Same `let live =
	// true` cancellation guard; `resolveAttestationProducer().getCurrentDeviceKey` is passed --
	// NEVER `getOrCreateDeviceUser` (F1: the wrong key silently reads "not registered" forever).
	//
	// `useFocusEffect` (not a bare `useEffect`), matching `DeviceAttestationScreen.tsx`'s own
	// precedent exactly: React Navigation keeps tab screens MOUNTED across a tab switch, so a bare
	// `useEffect` here would only ever read once, at mount, and never again -- leaving a voter who
	// completes a real Register ceremony and taps back into the Timeline tab looking at whatever
	// answer was true when the screen first mounted, until the app is fully restarted. Wrapping
	// with `useCallback` (deps identical to the old bare effect's own deps list) is what makes
	// this re-run on every focus without re-running on every render -- `useFocusEffect` re-invokes
	// its callback each time the screen regains focus, not on every identity-stable render.
	useFocusEffect(
		useCallback(() => {
			let live = true;

			if (resolvedElectionId === undefined) {
				return () => {
					live = false;
				};
			}

			(async () => {
				const result = await resolveRegistrationStatus({
					getEngine,
					getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
					electionId: resolvedElectionId,
				});
				if (live) setRegistrationStatus(result);
			})();

			return () => {
				live = false;
			};
		}, [getEngine, resolvedElectionId]),
	);

	// Separate from the timeline read above: re-run on every focus so a save made in the Ballot
	// flow shows on return. Nothing is cached, and a failed read fails closed to unreadable (the
	// error is never read or logged).
	useFocusEffect(
		useCallback(() => {
			let live = true;

			if (resolvedElectionId === undefined) {
				return () => {
					live = false;
				};
			}

			readSavedVoteStatus({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}, readSharedNowMs(), resolvedElectionId).then(
				status => {
					if (live) setSavedVote({electionId: resolvedElectionId, status});
				},
				() => {
					if (live) setSavedVote({electionId: resolvedElectionId, status: {state: 'unreadable'}});
				},
			);

			return () => {
				live = false;
			};
		}, [getEngine, seededElectionId, resolvedElectionId, readSharedNowMs]),
	);

	if (state.kind === 'indeterminate') {
		return (
			<View testID="timeline-indeterminate" style={[styles.screen, styles.centered, {backgroundColor: colors.background}]}>
				<Text
					testID="timeline-indeterminate-heading"
					style={{color: colors.error, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight}}>
					{t('indeterminate.heading')}
				</Text>
				<Text
					testID="timeline-indeterminate-body"
					style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, marginTop: 8}}>
					{t('indeterminate.body')}
				</Text>
				<Pressable
					testID="timeline-indeterminate-retry"
					accessibilityRole="button"
					style={styles.retry}
					onPress={() => setReloadNonce(n => n + 1)}>
					<Text style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
						{t('indeterminate.retryCta')}
					</Text>
				</Pressable>
			</View>
		);
	}

	if (state.kind === 'loading') {
		// Loading is a THIRD, distinct state — neither the rail nor the indeterminate frame renders
		// before the first read resolves (flashing the error frame first would be its own defect).
		return <View testID="timeline-loading" style={[styles.screen, {backgroundColor: colors.background}]} />;
	}

	// From here on `state.kind === 'ready'` is narrowed for the rest of the render (both earlier
	// branches returned above).
	const dateRange = computeHeaderDateRange(state.view.rangeStartMs, state.view.rangeEndMs, i18n.language, deviceTimeZone);
	const dialogRow = dialogStageId ? state.view.rows.find(row => row.stageId === dialogStageId) : undefined;
	const dialogSubtitle = dialogRow
		? dialogRow.railLabel.kind === 'date'
			? dialogRow.railLabel.text
			: dialogRow.railLabel.kind === 'now'
				? t('rail.now')
				: ''
		: '';
	const dialogBody = dialogRow?.subtitle ? t(dialogRow.subtitle.key, dialogRow.subtitle.params) : '';

	// D-06/D-23 (59-09): "before the deadline" is read straight off the SAME row view-model +
	// dev-clock-aware `nowMs` the rail already compares against -- never a second, independent
	// `Date.now()` read and never a re-parse of the raw timeline blob. Absent (`null`) instant
	// defaults to "before" (offers Edit) rather than silently defaulting to the read-only CTA.
	const registrationEndsRow = state.view.rows.find(row => row.stageId === 'registrationEnds');
	const isBeforeRegistrationDeadline = registrationEndsRow?.instantMs == null ? true : nowMs < registrationEndsRow.instantMs;

	// D-05: the stops are the PRESENT timeline instants, in D-09 order (`state.view.rows` is
	// already in that order) -- absent instants are skipped, never offered as a dead stop. A
	// 7-of-10-key timeline therefore yields 7 stage stops plus live (8 total), not 10 plus live.
	const stageStops = state.view.rows
		.filter(row => row.instantMs !== null)
		.map(row => ({stageId: row.stageId, instantMs: row.instantMs as number, nowMs: (row.instantMs as number) + 60_000, probe: false}));

	// WR-01: every stage stop lands at `instant + 60_000`, so the Voting Period countdown -- which
	// targets `tallyingStarts` and renders only while `votingStarts` is current -- was always either
	// >24h out or already elapsed. CountdownTimer's `<24h` branch was therefore UNREACHABLE on
	// device, which is exactly how its label-width defect (CR-01) shipped past a green suite and a
	// passing geometry gate. This adds ONE synthetic stop inside the final 24 hours.
	//
	// Offered only when it genuinely lands in that branch with `votingStarts` still current: the
	// probe must sit after `votingStarts` and strictly before whatever stage comes next, otherwise
	// that later stage would take `current` and the countdown would not render at all. On the
	// shipped seed the next stage is `accruingVotes` at tallyingStarts-20h, so 23h clears it.
	const SHORT_BRANCH_PROBE_MS = 23 * 3_600_000;
	const tallyingStartsMs = state.view.rows.find(row => row.stageId === 'tallyingStarts')?.instantMs ?? null;
	const votingStartsMs = state.view.rows.find(row => row.stageId === 'votingStarts')?.instantMs ?? null;
	const probeNowMs = tallyingStartsMs !== null ? tallyingStartsMs - SHORT_BRANCH_PROBE_MS : null;
	const nextInstantAfterVotingStarts =
		votingStartsMs === null
			? null
			: state.view.rows
					.map(row => row.instantMs)
					.filter((instant): instant is number => instant !== null && instant > votingStartsMs)
					.reduce<number | null>((min, instant) => (min === null || instant < min ? instant : min), null);
	const probeIsValid =
		probeNowMs !== null &&
		votingStartsMs !== null &&
		probeNowMs > votingStartsMs &&
		(nextInstantAfterVotingStarts === null || probeNowMs < nextInstantAfterVotingStarts);
	const clockStops = probeIsValid
		? [...stageStops, {stageId: 'votingStarts' as const, instantMs: tallyingStartsMs as number, nowMs: probeNowMs as number, probe: true}]
		: stageStops;
	// IN-05: `clockStopIndex` is React state, but `clockStops` is recomputed from `state.view.rows`
	// on EVERY render -- and the timeline-read effect re-runs on every `nowMs` change, i.e. on every
	// press of this control. So the engine can answer with a timeline carrying fewer present
	// instants (or `probeIsValid` can flip) while the index stays where it was, leaving the index
	// pointing past the end of the list. Clamp back to the live stop when that happens, so the
	// press handler below steps forward from a real position instead of a phantom one.
	//
	// This is a render-time clamp rather than a `useEffect` on purpose: `clockStops` is derived
	// AFTER this component's two early returns (`indeterminate`, `loading`), so a hook here would
	// be a conditional hook. The label below closes the other half -- it must never read as live
	// while a non-zero offset is still driving the rail and the countdown.
	const effectiveStopIndex = clockStopIndex > clockStops.length ? 0 : clockStopIndex;
	const activeClockStop = effectiveStopIndex > 0 ? clockStops[effectiveStopIndex - 1] : undefined;
	const clockOffsetDays = Math.round(clockOffsetMs / 86_400_000);
	const clockOffsetLabel =
		activeClockStop !== undefined && activeClockStop.probe
			? // WR-04: `final day` used to be an inline English literal here, concatenated onto an
				// otherwise fully-translated label -- under es the control read
				// "DEV: Ajuste de reloj Período de Votación final day". The i18n-parity test only
				// walks literal single-argument translate call sites, so it could not see it. (Do NOT write
				// that call shape out longhand here: the scanner greps source text, so quoting it in a
				// comment makes this file report a missing key for the literal word in the quotes.)
				`${t('dev.clockOffsetLabel')} ${t(STAGE_TITLE_KEY[activeClockStop.stageId])} ${t('dev.finalDayStop')}`
			: activeClockStop !== undefined
			? `${t('dev.clockOffsetLabel')} ${t(STAGE_TITLE_KEY[activeClockStop.stageId])} ${
					Math.round((activeClockStop.instantMs - Date.now()) / 86_400_000) >= 0 ? '+' : ''
				}${Math.round((activeClockStop.instantMs - Date.now()) / 86_400_000)}`
			: clockOffsetMs === 0
				? `${t('dev.clockOffsetLabel')} 0`
				: // IN-05: no stop resolves, but an offset IS still applied -- report THAT, never a
					// bare zero. The old code fell straight through to the live form here, so the label
					// read as live while the rail and the countdown were shifted by up to half a year.
					// That is precisely the "label and countdown disagree" shape D-13 closed, and it is
					// reachable: press the control, the read re-fires on the new `nowMs`, and a timeline
					// with fewer present instants comes back. The live form above stays byte-identical
					// (`0`, unsigned) so it remains distinguishable from a genuine `+0`/`-0` offset that
					// happens to round to zero days.
					`${t('dev.clockOffsetLabel')} ${clockOffsetDays >= 0 ? '+' : ''}${clockOffsetDays}`;

	const handleClockOffsetPress = () => {
		const stopCount = clockStops.length + 1; // +1 for the live stop.
		const nextIndex = (effectiveStopIndex + 1) % stopCount;
		if (nextIndex === 0) {
			setClockStopIndex(0);
			setClockOffsetMs(0);
			return;
		}
		const stop = clockStops[nextIndex - 1];
		setClockStopIndex(nextIndex);
		// Computed AT PRESS TIME so a slower re-fetch afterward still lands close to the stop's
		// target. For a stage stop that target is `instant + 60_000` -- the small positive epsilon
		// that makes THIS stage (not the next one) resolve as current. The WR-01 probe carries its
		// own target instead, inside the final 24h before tallyingStarts.
		setClockOffsetMs(stop.nowMs - Date.now());
	};

	// Plain render-time values (not hooks), bound to the election on screen.
	const railSavedVote = savedVote && savedVote.electionId === resolvedElectionId ? savedVote : null;
	const savedState = railSavedVote?.status.state ?? 'none';

	return (
		<>
			<ScrollView style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={styles.content}>
				{__DEV__ ? (
					<Pressable
						testID="timeline-dev-clock-offset"
						accessibilityRole="button"
						style={[styles.devClockOffset, {borderColor: colors.warning}]}
						onPress={handleClockOffsetPress}>
						<Text testID="timeline-dev-clock-offset-label" style={{color: colors.warning, fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight}}>
							{clockOffsetLabel}
						</Text>
					</Pressable>
				) : null}

				<View testID="timeline-header" style={styles.header}>
					<Text
						testID="timeline-header-title"
						style={{
							color: colors.text,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.h2.fontSize,
							lineHeight: typeScale.h2.lineHeight,
						}}>
						{state.title}
					</Text>
					{dateRange ? (
						<Text
							testID="timeline-header-date-range"
							style={{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
								marginTop: 8,
							}}>
							{t('header.dateRange', dateRange)}
						</Text>
					) : null}
				</View>

				<TimelineRail
					rows={state.view.rows}
					nowOffsetMs={clockOffsetMs}
					renderPanel={stageId =>
						stageId === 'registrationEnds' && registrationStatus !== null ? (
							<TimelineRegistrationPanel
								status={registrationStatus.kind}
								networkName={registrationStatus.networkName}
								isBeforeDeadline={isBeforeRegistrationDeadline}
								onEditRegistration={() => navigation.navigate('RegistrationHome')}
								onViewRegistration={() => navigation.navigate('RegistrationHome')}
							/>
						) : stageId === 'votingStarts' && railSavedVote && savedState !== 'none' ? (
							<SavedVoteNotice status={railSavedVote.status} testID="timeline-saved-vote" />
						) : null
					}
					onHelp={stageId => setDialogStageId(stageId)}
					onSeeDetails={stageId => setDialogStageId(stageId)}
					onEditRegistration={() => navigation.navigate('RegistrationHome')}
					onPreviewBallot={() => navigation.navigate('Ballot')}
					// Saved and unreadable hide Vote now, mirroring the 63-08 guard (D-20); stale offers it again (D-21).
					onVoteNow={savedState === 'none' || savedState === 'stale' ? () => navigation.navigate('Ballot') : undefined}
					// Params carry only electionId and no `revealOnOpen`, so the receipt asks for a fingerprint (D-13, R-4).
					onViewSubmission={
						railSavedVote && savedState !== 'none'
							? () => navigation.navigate('VoteReceipt', {electionId: railSavedVote.electionId})
							: undefined
					}
					onViewKeyholders={() => navigation.navigate('Keyholders')}
					onViewResults={() => navigation.navigate('Results')}
				/>
			</ScrollView>

			<InfoDialog
				visible={dialogStageId !== null}
				title={dialogStageId ? t(STAGE_TITLE_KEY[dialogStageId]) : ''}
				subtitle={dialogSubtitle}
				body={dialogBody}
				closeLabel={tCommon('close')}
				onClose={() => setDialogStageId(null)}
			/>
		</>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	header: {
		paddingHorizontal: 8,
		paddingBottom: 16,
	},
	devClockOffset: {
		borderWidth: 1,
		borderStyle: 'dashed',
		alignSelf: 'flex-start',
		paddingHorizontal: 8,
		paddingVertical: 4,
		marginHorizontal: 8,
		marginBottom: 8,
		minHeight: 44,
		justifyContent: 'center',
	},
	centered: {
		justifyContent: 'center',
		alignItems: 'center',
		paddingHorizontal: 24,
	},
	retry: {
		marginTop: 24,
		minHeight: 44,
		justifyContent: 'center',
	},
});
