/**
 * StepDots (REG-03) — the 3-step progress indicator used at the top of the register form steps,
 * matching the Figma register frames (2868:1522 / 2891:1542 / 2891:1590): three dots where the
 * ACTIVE step is an elongated primary-colored pill and the other two are small track-colored dots.
 * Replaces the earlier equal-width bar look (StepProgressBar) which did not match the design.
 *
 * Prop-driven (`step: 1 | 2 | 3`), presentational-only — no useVoterApp()/useNavigation().
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';

export interface StepDotsProps {
	step: 1 | 2 | 3;
}

const STEPS = [1, 2, 3] as const;

export function StepDots({step}: StepDotsProps) {
	const {colors, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	return (
		<View style={styles.row} accessibilityLabel={t('form.stepLabel', {step})}>
			{STEPS.map(n => {
				const active = n === step;
				return (
					<View
						key={n}
						testID={`step-dot-${n}`}
						accessibilityState={{selected: active}}
						style={[
							styles.dot,
							active ? styles.dotActive : null,
							{
								borderRadius: radii.pill,
								backgroundColor: active ? colors.primary : colors.progressTrack,
							},
						]}
					/>
				);
			})}
		</View>
	);
}

export default StepDots;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		justifyContent: 'center',
		alignItems: 'center',
		gap: 8, // sm/8px between dots
	},
	dot: {
		width: 8,
		height: 8,
	},
	dotActive: {
		width: 24, // active step elongates into a pill
	},
});
