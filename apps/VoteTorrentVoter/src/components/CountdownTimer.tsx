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
 * Pure presentational (`targetIso: string` only) — does NOT call `useVoterApp()` (RESEARCH.md
 * Anti-Patterns: keep provider reads confined to screens, not this leaf component).
 */
import React, {useEffect, useState} from 'react';
import {AppState, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';

function remaining(targetIso: string): number {
	return Math.max(0, new Date(targetIso).getTime() - Date.now());
}

function format(ms: number): {hours: string; minutes: string; seconds: string} {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return {hours: pad(hours), minutes: pad(minutes), seconds: pad(seconds)};
}

export function CountdownTimer({targetIso}: {targetIso: string}) {
	const [remainingMs, setRemainingMs] = useState(() => remaining(targetIso));
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');

	useEffect(() => {
		// Resync immediately whenever targetIso changes (covers the effect's own mount too).
		setRemainingMs(remaining(targetIso));
		const id = setInterval(() => setRemainingMs(remaining(targetIso)), 1000);

		// JS timers are suspended while the app is backgrounded (reactnative.dev/docs/appstate) —
		// force an immediate resync on return to 'active' instead of waiting for the next tick.
		const sub = AppState.addEventListener('change', state => {
			if (state === 'active') setRemainingMs(remaining(targetIso));
		});

		return () => {
			clearInterval(id);
			sub.remove();
		};
	}, [targetIso]);

	const {hours, minutes, seconds} = format(remainingMs);

	const digitStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.display.fontSize,
		lineHeight: typeScale.display.lineHeight,
		color: colors.text,
	};
	const labelStyle = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.caption.fontSize,
		lineHeight: typeScale.caption.lineHeight,
		color: colors.textSecondary,
	};

	const groups: Array<{value: string; labelKey: string; testId: string}> = [
		{value: hours, labelKey: 'countdown.hours', testId: 'hours'},
		{value: minutes, labelKey: 'countdown.minutes', testId: 'minutes'},
		{value: seconds, labelKey: 'countdown.seconds', testId: 'seconds'},
	];

	return (
		<View style={styles.row}>
			{groups.map((group, index) => (
				<React.Fragment key={group.testId}>
					{index > 0 && <Text style={[digitStyle, styles.colon]}>:</Text>}
					<View style={styles.group}>
						<Text style={digitStyle} testID={`countdown-${group.testId}-value`}>
							{group.value}
						</Text>
						<Text style={[labelStyle, styles.label]} testID={`countdown-${group.testId}-label`}>
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
	colon: {
		marginTop: 0,
	},
	label: {
		textTransform: 'uppercase',
		letterSpacing: 1,
		marginTop: 4, // xs(4px) gap to sub-labels
	},
});
