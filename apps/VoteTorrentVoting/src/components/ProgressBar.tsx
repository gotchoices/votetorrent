/**
 * ProgressBar (HOME-01, D-10) — presentational, token-styled 0-1 fill with clamping. No in-repo
 * analog; authoritative source is RESEARCH.md's "Progress bar from Phase 38 tokens" example
 * (PATTERNS.md §ProgressBar), copied verbatim in structure.
 *
 * Bar only — the "{{percent}}% complete" label is ElectionCard's responsibility (40-04), so this
 * component takes no i18n and no label prop. Colors/radius come only from
 * `useTheme() as ExtendedTheme` — no inline hex (D-10 / 38 D-07 token discipline).
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';

export function ProgressBar({progress}: {progress: number}) {
	const {colors, radii} = useTheme() as ExtendedTheme;
	const clamped = Math.min(1, Math.max(0, progress));

	return (
		<View
			style={[styles.track, {backgroundColor: colors.progressTrack, borderRadius: radii.pill}]}
			testID="progress-bar-track">
			<View
				style={[
					styles.fill,
					{width: `${clamped * 100}%`, backgroundColor: colors.progressFill, borderRadius: radii.pill},
				]}
				testID="progress-bar-fill"
			/>
		</View>
	);
}

export default ProgressBar;

const styles = StyleSheet.create({
	track: {
		height: 8,
		overflow: 'hidden',
	},
	fill: {
		height: 8,
	},
});
