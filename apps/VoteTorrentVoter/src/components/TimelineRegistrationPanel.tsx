/**
 * TimelineRegistrationPanel (Phase 59 plan 59-09, D-06 real read via D-23) — the inset
 * "Registration Ends" status panel `TimelineScreen` (59-08) injects through `TimelineRail`'s
 * `renderPanel` seam into the `registrationEnds` row's `panel` slot (`TimelineRow.tsx`, 59-07).
 *
 * Pure presentational leaf: `status`/`networkName`/`isBeforeDeadline` props plus two navigation
 * CALLBACKS — never `useVoterApp()`, never `useNavigation()` (mirrors `ElectionCard.tsx` /
 * `CountdownTimer.tsx`'s established convention). `TimelineScreen` owns the
 * `resolveRegistrationStatus()` engine read and maps the two callbacks to real navigation; this
 * file only renders whatever four-outcome answer it is handed.
 *
 * **Write no i18n.** Every string this panel needs was landed by 59-05 in the `timeline`
 * namespace's `registration.*` keys — this file reads them only, never edits
 * `src/i18n/index.ts` (verified as an acceptance criterion: `git diff --exit-code` on that file
 * must pass after this plan).
 *
 * **The `{{bold}}` sentinel contract (F6/F6b in `59-09-PLAN.md` — the single most important
 * contract in this file):** `timeline.registration.isRegistered` is authored with a `{{bold}}`
 * placeholder (`"You {{bold}} in the {{network}}"` / `"{{bold}} en la {{network}}"` in ES,
 * sentence-initial). i18next only resolves that placeholder if a `bold` interpolation param is
 * actually supplied — a caller that omits it and then tries to locate the resolved
 * `isRegisteredBold` text inside the result would find nothing, because the placeholder was
 * never filled, and would ship a literal, visible `{{bold}}` to the voter. The fix used
 * throughout this file: resolve every sentence with `bold: BOLD_SENTINEL` (a control-character
 * constant that cannot occur in any resource value and contains no `{`), then split the
 * RESOLVED string on that sentinel — never on the resolved bold substring itself. Two parts
 * (only `registered` ever produces this, since it is the only key carrying `{{bold}}`) render a
 * nested bold `<Text>`; one part (the three plain keys — `pending`/`notRegistered`/`unknown`
 * carry no `{{bold}}` at all) renders as a single plain `<Text>`, degrading gracefully rather
 * than ever dropping or truncating text.
 *
 * The `accessibilityLabel` for the whole panel is the SAME call shape with `bold` set to the
 * RESOLVED `registration.isRegisteredBold` text instead of the sentinel — one more resolution,
 * never manual string surgery on the sentinel-split result.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import type {RegistrationStatusKind} from '../engines/registration-status';

/** Never rendered — always split away before the text reaches the screen. A NUL-bracketed
 * literal so it can never occur in authored copy and never resembles an unresolved i18next
 * `{{placeholder}}` itself (no `{` anywhere in the constant). */
const BOLD_SENTINEL = '\u0000BOLD\u0000';

export interface TimelineRegistrationPanelProps {
	status: RegistrationStatusKind;
	/** The real network's display name (`resolveRegistrationStatus`'s `networkName`). May be
	 * `undefined` on the `indeterminate` path, where it is never interpolated regardless. */
	networkName?: string;
	/** Whether `now` is before the row's own `registrationEnds` instant — the CTA branches on
	 * THIS alone (F7), never on `status`. Editing stays offered even to an already-registered
	 * voter before the deadline; the registered/unregistered distinction is carried entirely by
	 * the sentence copy above the CTA, not by which CTA is shown. */
	isBeforeDeadline: boolean;
	onEditRegistration: () => void;
	onViewRegistration: () => void;
}

/**
 * F6b's binding status -> sentence-key map (do not deviate — no `registration.isPending`,
 * `.notRegisteredBold` or `.indeterminate` key exists in the `timeline` namespace and this file
 * must never reference one). `registered` is the only kind whose key carries `{{bold}}`; the
 * other three are plain sentences that happen to accept (and ignore) the same `bold` param for a
 * single uniform call shape below.
 */
const SENTENCE_KEY: Record<RegistrationStatusKind, string> = {
	registered: 'registration.isRegistered',
	pending: 'registration.pending',
	notRegistered: 'registration.notRegistered',
	indeterminate: 'registration.unknown',
};

export function TimelineRegistrationPanel({
	status,
	networkName,
	isBeforeDeadline,
	onEditRegistration,
	onViewRegistration,
}: TimelineRegistrationPanelProps) {
	const {colors, fonts, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');

	const sentenceKey = SENTENCE_KEY[status];
	// `registration.unknown` carries no `{{network}}` (F6b) -- the network name may be
	// unresolved on the indeterminate read-failure path, so it is never interpolated there.
	// Every other key expects `{{network}}` and always receives one (falling back to an empty
	// string rather than ever rendering "undefined" if the upstream read somehow omitted it).
	const resolvedSentence =
		status === 'indeterminate'
			? t(sentenceKey, {bold: BOLD_SENTINEL})
			: t(sentenceKey, {bold: BOLD_SENTINEL, network: networkName ?? ''});
	const sentenceParts = resolvedSentence.split(BOLD_SENTINEL);

	// Resolved once, reused both for the nested bold run's own text and for the
	// accessibilityLabel's non-sentinel resolution below -- never a string-surgery substitute.
	const boldRunText = t('registration.isRegisteredBold');
	const accessibilityLabel =
		status === 'indeterminate'
			? t(sentenceKey, {bold: boldRunText})
			: t(sentenceKey, {bold: boldRunText, network: networkName ?? ''});

	const ctaLabelKey = isBeforeDeadline ? 'registration.editCta' : 'registration.viewCta';
	const onCtaPress = isBeforeDeadline ? onEditRegistration : onViewRegistration;

	const sentenceTextStyle = {
		color: colors.text,
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
	};

	return (
		<View
			testID="timeline-registration-panel"
			accessibilityLabel={accessibilityLabel}
			style={[styles.panel, {backgroundColor: colors.secondaryButtonSurface, borderRadius: radii.sm}]}>
			{sentenceParts.length === 2 ? (
				// Exactly two parts -- ONLY `registration.isRegistered` ever splits this way, since
				// it is the sole key carrying `{{bold}}`. `sentenceParts[0]` is the empty string on
				// the ES sentence-initial phrasing, which React Native renders as nothing, correctly
				// leading with the bold run.
				<Text testID="timeline-registration-panel-sentence" style={sentenceTextStyle}>
					{sentenceParts[0]}
					<Text style={{fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}}>{boldRunText}</Text>
					{sentenceParts[1]}
				</Text>
			) : (
				// One part -- every non-registered key (none of which carry `{{bold}}`). Degrades
				// to a single unbolded sentence; never drops or truncates the resolved text.
				<Text testID="timeline-registration-panel-sentence" style={sentenceTextStyle}>
					{resolvedSentence}
				</Text>
			)}

			<Pressable
				testID="timeline-registration-panel-cta"
				accessibilityRole="button"
				style={styles.cta}
				onPress={onCtaPress}>
				<Text
					style={{
						color: colors.link,
						fontFamily: fonts.bold.fontFamily,
						fontWeight: fonts.bold.fontWeight,
						textDecorationLine: 'underline',
					}}>
					{t(ctaLabelKey)}
				</Text>
			</Pressable>
		</View>
	);
}

export default TimelineRegistrationPanel;

const styles = StyleSheet.create({
	panel: {
		marginTop: 16, // md spacing token
		padding: 16, // md spacing token
	},
	cta: {
		marginTop: 8, // sm spacing token
		minHeight: 44, // minimum touch target
		justifyContent: 'center',
		alignSelf: 'flex-start',
	},
});
