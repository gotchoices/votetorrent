/**
 * StepProgressBar (REG-03) — a 3-segment horizontal progress bar + "Step X of 3" caption,
 * reusing Phase 40's exact `colors.progressFill`/`colors.progressTrack` tokens (no new color
 * role) so Registration ties into the same "progress" visual language as `ProgressBar.tsx`
 * (imported by `ElectionCard.tsx`). Rendered identically at the top of all 3 form-step screens.
 *
 * Prop-driven (`step: 1 | 2 | 3`), no own state; presentational-only — does NOT call
 * useVotingApp()/useNavigation(). Segments 1..step render `progressFill`; the rest render
 * `progressTrack`.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';

export interface StepProgressBarProps {
	step: 1 | 2 | 3;
}

const STEPS = [1, 2, 3] as const;

export function StepProgressBar({step}: StepProgressBarProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	return (
		<View>
			<Text
				style={[
					styles.caption,
					{
						color: colors.textSecondary, // type.caption/colors.textSecondary
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.caption.fontSize,
						lineHeight: typeScale.caption.lineHeight,
					},
				]}>
				{t('form.stepLabel', {step})}
			</Text>
			<View style={styles.row}>
				{STEPS.map(n => (
					<View
						key={n}
						testID={`step-segment-${n}`}
						style={[
							styles.segment,
							{
								borderRadius: radii.pill,
								backgroundColor: n <= step ? colors.progressFill : colors.progressTrack,
							},
						]}
					/>
				))}
			</View>
		</View>
	);
}

export default StepProgressBar;

const styles = StyleSheet.create({
	caption: {
		textAlign: 'center',
		marginBottom: 4, // xs/4px gap above the bar
	},
	row: {
		flexDirection: 'row',
		gap: 8, // sm/8px gaps between segments
	},
	segment: {
		flex: 1,
		height: 8,
	},
});
