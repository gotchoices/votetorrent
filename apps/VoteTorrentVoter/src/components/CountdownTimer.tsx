/**
 * CountdownTimer (HOME-01, D-09) — presentational, self-ticking live countdown rendered from a
 * fixed ISO target. First `setInterval`/`AppState` component in this codebase (RESEARCH.md
 * Pattern 2, PATTERNS.md §CountdownTimer — copied verbatim in structure).
 *
 * Drift-free by construction: every tick recomputes `remaining(targetIso)` from `Date.now()`
 * rather than decrementing a held counter (Pattern 2 / Pitfall 2) — so it neither drifts against
 * real elapsed time nor goes stale while the app is backgrounded (JS timers suspend in the
 * background; the `AppState` listener forces an immediate resync on return to `'active'`).
 *
 * Pure presentational (`targetIso: string`, optional `nowOffsetMs?: number`) — does NOT call
 * `useVoterApp()` (RESEARCH.md Anti-Patterns: keep provider reads confined to screens, not this
 * leaf component).
 *
 * `nowOffsetMs` (D-14, dev-instrumentation): optional, defaults to `0`, inert in release builds.
 * It shifts the reference clock from a bare `Date.now()` to `Date.now() + nowOffsetMs`, letting
 * the Timeline's `__DEV__` clock-offset control move this countdown's reference clock in step
 * with the rail's own `nowMs`. It arrives by prop only — never a provider read (Phase 59 D-20).
 */
import React, {useEffect, useState} from 'react';
import {AppState, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';

/**
 * WR-09: returns `null` for a `targetIso` this component cannot parse. Previously an unparsable
 * value produced `NaN`, which `format()` then padded into a literal `NaN : NaN : NaN` -- and
 * because `'NaN'.length === 3`, `maxDigits > 2` selected the SMALLER `h2` shrink step, so the
 * failure rendered as a legitimately shrunken long countdown rather than as an error.
 */
function remaining(targetIso: string, nowOffsetMs = 0): number | null {
	const targetMs = new Date(targetIso).getTime();
	if (!Number.isFinite(targetMs)) return null;
	return Math.max(0, targetMs - (Date.now() + nowOffsetMs));
}

/** D2 root-cause fix: adaptive units at the 24h boundary, discriminated union. */
type FormattedCountdown =
	| {unit: 'long'; days: string; hours: string; minutes: string}
	| {unit: 'short'; hours: string; minutes: string; seconds: string};

function format(ms: number): FormattedCountdown {
	const totalSeconds = Math.floor(ms / 1000);
	const pad = (n: number) => String(n).padStart(2, '0');

	// 86400 = seconds in a day — the exact D2 discriminant. totalSeconds === 86400 picks 'long';
	// totalSeconds === 86399 picks 'short'.
	if (totalSeconds >= 86400) {
		const days = Math.floor(totalSeconds / 86400);
		// Hours/minutes bounded 0-23 / 0-59 because the >=86400 case is routed away first — this
		// bound is D2's root-cause fix (was unbounded Math.floor(totalSeconds / 3600)).
		const hours = Math.floor((totalSeconds % 86400) / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		return {unit: 'long', days: String(days), hours: pad(hours), minutes: pad(minutes)};
	}

	// hours is bounded 0-23 here because the >=86400 case above already routed away anything
	// larger — no seconds group is dropped, this branch keeps today's derivation exactly.
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return {unit: 'short', hours: pad(hours), minutes: pad(minutes), seconds: pad(seconds)};
}

/**
 * WR-01 -- OS TEXT SCALING IS CAPPED ON THIS SURFACE. RATIFIED PRODUCT DECISION, NOT AN
 * OVERSIGHT. DO NOT "FIX" IT BACK WITHOUT REVERSING THE DECISION.
 *
 * RN `<Text>` defaults to `allowFontScaling: true`, so every `fontSize` this component resolves
 * is multiplied by the OS text-size setting. `maxFontSizeMultiplier` clamps that multiplier per
 * node (RN 0.78 `Libraries/Text/Text.d.ts`: `>= 1` sets this node's max; `1` therefore means "no
 * scaling"). Applied below to ALL THREE text nodes -- digits, colons AND labels.
 *
 * WHY THE CAP EXISTS. Every width claim this component rests on -- the two shrink steps picked by
 * `needsShrink`, and `themes.ts` `captionSmall`'s own derivation -- is a PIXEL measurement taken
 * on the Redmi 8 at DEFAULT scale only, against a ~371px card inner width:
 *
 *   row                      measured width   max scale before it clips
 *   <24h  labels @12px, EN   ~329px           1.128
 *   <24h  labels @12px, ES   ~345px           1.075
 *   >=24h labels @16px       ~362px           1.025
 *
 * Uncapped, those measurements hold at 1.0x and nowhere else. Android's first step above default
 * is *Large* = 1.15x, which clips every row in that table -- and the <24h branch is ALREADY on
 * the smaller of the two shrink steps, so there is no third step to fall back to.
 *
 * WHY ONE VALUE, NOT ONE PER BRANCH. A single cap is governed by the tightest row, and that is
 * the >=24h row at 1.025 -- which is also the most common render on the screen. Per-branch caps
 * were considered and rejected on two grounds. (1) The headroom they buy is imperceptible: a 1.07
 * cap on the <24h branch takes a 12px label to 12.84px. (2) `needsShrink` is NOT the <24h/>=24h
 * discriminant -- it also fires for a >=100-day >=24h render, whose width nobody has measured --
 * so the looser cap would silently extend to an unmeasured case, which is the exact defect class
 * WR-01 raised. 1.025 itself is not used as the value because it sits inside the error bar of the
 * ~20.6px/glyph average the table is derived from, and no OS exposes a step between 1.0 and
 * 1.025, so any cap in that interval renders identically to 1 on real hardware while reading as
 * a measured allowance it is not. Hence 1.
 *
 * THE TRADE-OFF, STATED PLAINLY. This deliberately pins the sub-labels (and the digits) at their
 * authored sizes for a user who has enlarged system text. That is a real accessibility cost and
 * it was accepted knowingly. The countdown is a fixed-width numeric display inside a fixed-width
 * card that cannot reflow -- `styles.row` is a `flexDirection: 'row'` with no wrap -- so scaled-up
 * text does not move onto a second line, it clips, and clipped digits are unreadable outright.
 * Pinned-but-legible was judged better than scaled-but-clipped. This was raised twice as a code
 * review finding and skipped twice as too large a call for a fixer agent to make silently; the
 * product owner then decided it on the record. A future reader must not read the cap as a missed
 * accessibility default and remove it.
 *
 * IF THE DECISION IS EVER REVERSED, the remedy is layout, not a looser multiplier: let the label
 * row wrap/reflow, or measure it (`onTextLayout`/`onLayout` against the wrapper's measured width)
 * and shrink from the observed overflow -- the same measured fix the WR-02 note below names for
 * the character-count proxy. Either way it needs a device run to confirm.
 *
 * SCOPE. Confined to the countdown surface on purpose: WR-01 is about the COUNTDOWN's pixel-width
 * claim. Nothing else in either app controls font scaling today, and whether the apps should do
 * so globally is a separate question that has NOT been decided. Do not generalise this constant
 * outward without deciding that question first.
 */
const COUNTDOWN_MAX_FONT_SCALE = 1;

export function CountdownTimer({targetIso, nowOffsetMs = 0}: {targetIso: string; nowOffsetMs?: number}) {
	const [remainingMs, setRemainingMs] = useState(() => remaining(targetIso, nowOffsetMs));
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');

	useEffect(() => {
		// Resync immediately whenever targetIso or nowOffsetMs changes (covers the effect's own
		// mount too). Omitting nowOffsetMs from the deps array below leaves the running interval on
		// a stale offset and reproduces the "label and countdown disagree" defect D-13 closes.
		setRemainingMs(remaining(targetIso, nowOffsetMs));
		const id = setInterval(() => setRemainingMs(remaining(targetIso, nowOffsetMs)), 1000);

		// JS timers are suspended while the app is backgrounded (reactnative.dev/docs/appstate) —
		// force an immediate resync on return to 'active' instead of waiting for the next tick.
		const sub = AppState.addEventListener('change', state => {
			if (state === 'active') setRemainingMs(remaining(targetIso, nowOffsetMs));
		});

		return () => {
			clearInterval(id);
			sub.remove();
		};
	}, [targetIso, nowOffsetMs]);

	// WR-09: render nothing rather than a NaN countdown. Consistent with TimelineRail's CR-02
	// guard -- degrade to "no countdown", never to a plausible-looking wrong one.
	if (remainingMs === null) return null;

	const formatted = format(remainingMs);

	// Shrink-to-fit (D2): derived after `groups` values are known, from the longest displayed
	// group only. Two steps only — type.display (2 digits or fewer) or type.h2 (more than 2) —
	// applied uniformly to every displayed group and the colons in a given render.
	const groups: Array<{value: string; labelKey: string; testId: string}> =
		formatted.unit === 'long'
			? [
					{value: formatted.days, labelKey: 'countdown.days', testId: 'days'},
					{value: formatted.hours, labelKey: 'countdown.hours', testId: 'hours'},
					{value: formatted.minutes, labelKey: 'countdown.minutes', testId: 'minutes'},
				]
			: [
					{value: formatted.hours, labelKey: 'countdown.hours', testId: 'hours'},
					{value: formatted.minutes, labelKey: 'countdown.minutes', testId: 'minutes'},
					{value: formatted.seconds, labelKey: 'countdown.seconds', testId: 'seconds'},
				];

	// CR-01: the shrink trigger used to be `maxDigits > 2` alone, and the step reached only the
	// digits. Both halves were wrong for the case that actually clips:
	//   1. In the `short` (<24h) branch every group is pad()'d to 2 chars, so maxDigits is ALWAYS
	//      2 and the shrink could never fire there at all.
	//   2. The LABELS, not the digits, are the widest element -- on the Redmi 8 the >=24h labels
	//      already span ~362px of a ~371px card inner width, and the `short` branch swaps the
	//      narrowest label (DAYS/DÍAS) for the widest (SECONDS/SEGUNDOS).
	// So the trigger now also counts label characters, and the step applies to labelStyle too.
	// The budget is the >=24h row's own 16 characters -- the widest label row device-verified to
	// fit (evidence/61-08-after-current-row-en.png).
	//
	// WR-02 -- READ THIS BEFORE TRUSTING THE BUDGET. It is a LATIN-ONLY CHARACTER-COUNT PROXY for
	// a width measurement, not a width measurement. The 12px step it selects was derived in
	// PIXELS (themes.ts `captionSmall`: ~20.6px per Latin glyph against a ~371px card inner width
	// on the Redmi 8); this counts CHARACTERS. Any locale whose glyphs are wider than Latin --
	// CJK, Devanagari, Thai -- fits 16 characters into far more than the measured 362px, never
	// trips the trigger, and clips silently. An earlier version of this comment claimed the budget
	// "keeps this correct for future locales rather than just for ES": it does not, and that claim
	// is withdrawn. The real fix is to MEASURE -- onTextLayout/onLayout on the label row against
	// the wrapper's measured width, shrinking from the observed overflow. Until that lands this
	// covers EN and ES only, and adding a third locale means re-deriving the budget for it.
	//
	// BOTH shipped locales' >=24h rows land EXACTLY on the budget, against a `> 16` test:
	//   en  days(4)  + hours(5) + minutes(7) = 16  -> does not shrink
	//   es  días(4)  + horas(5) + minutos(7) = 16  -> does not shrink
	// ('días' is FOUR characters, not five: U+00ED is precomposed, so String.length is 4. The
	// >=24h branch is therefore symmetric across en/es -- measured, not assumed.) The <24h rows
	// clear it comfortably: en 5+7+7 = 19, es 5+7+8 = 20.
	//
	// The budget cannot simply be raised to buy margin off that boundary: 16 characters is the
	// widest label row DEVICE-VERIFIED to fit (~362px of a ~371px inner width), so 17 would admit
	// a width nobody has measured. What guards the boundary is a test, not a margin --
	// CountdownTimer.test.tsx pins the expected step for BOTH locales on this branch, so a
	// one-character copy change to any of those six labels turns that assertion red instead of
	// silently flipping the most common render on the screen into the shrunken step.
	const LABEL_CHAR_BUDGET = 16;
	const labels = groups.map(group => t(group.labelKey));
	const maxDigits = Math.max(...groups.map(group => group.value.length));
	const totalLabelChars = labels.reduce((sum, label) => sum + label.length, 0);
	const needsShrink = maxDigits > 2 || totalLabelChars > LABEL_CHAR_BUDGET;
	const shrinkStep = needsShrink ? typeScale.h2 : typeScale.display;
	const labelStep = needsShrink ? typeScale.captionSmall : typeScale.caption;

	const digitStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: shrinkStep.fontSize,
		lineHeight: shrinkStep.lineHeight,
		color: colors.text,
	};
	const labelStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: labelStep.fontSize,
		lineHeight: labelStep.lineHeight,
		color: colors.textSecondary,
	};

	return (
		<View style={styles.row}>
			{groups.map((group, index) => (
				<React.Fragment key={group.testId}>
					{index > 0 && (
						<Text style={[digitStyle, styles.colon]} maxFontSizeMultiplier={COUNTDOWN_MAX_FONT_SCALE}>
							:
						</Text>
					)}
					<View style={styles.group}>
						<Text style={digitStyle} maxFontSizeMultiplier={COUNTDOWN_MAX_FONT_SCALE} testID={`countdown-${group.testId}-value`}>
							{group.value}
						</Text>
						<Text
							style={[labelStyle, styles.label]}
							maxFontSizeMultiplier={COUNTDOWN_MAX_FONT_SCALE}
							testID={`countdown-${group.testId}-label`}>
							{t(group.labelKey)}
						</Text>
					</View>
				</React.Fragment>
			))}
		</View>
	);
}

export default CountdownTimer;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		alignItems: 'flex-start',
	},
	group: {
		alignItems: 'center',
		marginHorizontal: 4, // sm(8px) gap between groups == 4px on each side
	},
	// D-09 addendum (61-08, C3, developer-approved): marginTop 0 -> 4 (xs) -- `styles.row`'s
	// `alignItems: 'flex-start'` (untouched) top-aligns every group, so the shorter colon glyph
	// reads slightly high against the taller digit groups at the `display` step; this nudges it
	// toward the digits' optical middle. Shared with Home's `ElectionCard`.
	colon: {
		marginTop: 4,
	},
	label: {
		textTransform: 'uppercase',
		letterSpacing: 1,
		marginTop: 4, // xs(4px) gap to sub-labels
	},
});
