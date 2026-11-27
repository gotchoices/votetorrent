/**
 * RegistrationConfirmationCodeCard.tsx — 62-UI-SPEC Surface 7 (D-45). The fit-to-width
 * registration-code card: `type.display` (40px) is a CAP, not a fixed size — the project has
 * already shipped the "clipped 84-char code" defect class once
 * (`project_ui_defects_invisible_to_every_tier`), so the render size is fitted to the card's
 * MEASURED frame width, never assumed from a fixed point size. `'WWWWW-WWWWW'` (the 11-character
 * `REGISTRATION_CODE_FORMATTED_LENGTH` fixture) at 40px needs ~383px in the System font — far
 * beyond the 288dp narrowest fleet inner width — so a fixed 40px would clip.
 *
 * `CODE_GLYPH_EM_BUDGET = 1.0` is a conservative, NOT measured, per-glyph width budget (1.0em is
 * an upper bound on any Crockford base32 glyph's advance in the System font); real-glyph
 * measurement on hardware is Tier 2 device debt, tracked for 62-30. The code `Text` pins its OS
 * font-scaling multiplier prop to a value of one for the SAME reason `CountdownTimer.tsx`'s own
 * ratified WR-01 trade-off does: an OS scaling multiplier would break the fit this component
 * works to guarantee.
 *
 * No "Copy Code" control is built — no clipboard package is a Voter dependency
 * (`@react-native-clipboard/clipboard` or RN core `Clipboard` are both absent); the code `Text` is
 * `selectable` instead, which gives the OS copy menu with zero added dependencies.
 * `code.copyButton`/`code.copiedConfirm` stay unused (flagged in the plan SUMMARY for the user).
 */
import React, {useState} from 'react';
import {StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {formatRegistrationCode, REGISTRATION_CODE_FORMATTED_LENGTH} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';

/** A conservative upper bound on any Crockford base32 glyph's advance, in ems — see this file's
 * header. */
export const CODE_GLYPH_EM_BUDGET = 1.0;

/** Pure. `Math.floor(availableWidth / (glyphCount * CODE_GLYPH_EM_BUDGET))`, clamped to
 * `[20, maxFontSize]` — 20 is the legibility floor, `maxFontSize` (`type.display`, 40) is the CAP,
 * never a fixed size. Monotonic non-decreasing in `availableWidth`. */
export function fitRegistrationCodeFontSize(availableWidth: number, glyphCount: number, maxFontSize: number): number {
	const fitted = Math.floor(availableWidth / (glyphCount * CODE_GLYPH_EM_BUDGET));
	return Math.max(20, Math.min(maxFontSize, fitted));
}

export type RegistrationCodeCardState = {kind: 'code'; code: string} | {kind: 'unavailable'};

export function RegistrationConfirmationCodeCard({state}: {state: RegistrationCodeCardState}) {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call, unused value is fine (mirrors
	// RegisterPersonalScreen.tsx's own precedent): this is a presentational sub-component (`state`
	// is caller-supplied), with no engine read of its own.
	useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('continuity');
	// Seeded from the window width BEFORE the frame's own onLayout fires, so the very first render
	// already satisfies the fit (never a 0-width flash that would render at the uncapped maximum).
	const windowWidth = useWindowDimensions().width;
	const [frameWidth, setFrameWidth] = useState(() => Math.max(0, windowWidth - 72));

	const fontSize =
		state.kind === 'code' ? fitRegistrationCodeFontSize(frameWidth, REGISTRATION_CODE_FORMATTED_LENGTH, typeScale.display.fontSize) : 0;

	return (
		<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
			<Text
				style={[
					styles.heading,
					{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h4.fontSize,
						lineHeight: typeScale.h4.lineHeight,
					},
				]}>
				{t('code.heading')}
			</Text>
			{state.kind === 'code' ? (
				<>
					<View
						testID="registration-code-frame"
						style={styles.frame}
						onLayout={e => setFrameWidth(e.nativeEvent.layout.width)}>
						<Text
							testID="registration-code-value"
							selectable
							accessibilityRole="text"
							maxFontSizeMultiplier={1}
							style={{
								fontSize,
								lineHeight: Math.round(fontSize * 1.2),
								textAlign: 'center',
								letterSpacing: 0,
								color: colors.primary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
							}}>
							{formatRegistrationCode(state.code)}
						</Text>
					</View>
					<Text
						style={[
							styles.body,
							{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('code.body')}
					</Text>
				</>
			) : (
				<Text
					style={[
						styles.body,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('code.unavailable')}
				</Text>
			)}
		</View>
	);
}

export default RegistrationConfirmationCodeCard;

const styles = StyleSheet.create({
	heading: {
		marginBottom: 12, // sm/md
	},
	frame: {
		alignSelf: 'stretch',
	},
	body: {
		marginTop: 12, // sm/md
	},
});
