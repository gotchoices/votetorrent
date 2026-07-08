/**
 * ScanScreen — Scan tab root (D-07 per-domain screen file). Placeholder stub this phase: reads
 * through `useVotingApp()` (D-06 / SHELL-03), renders the generic `common.placeholderBody` copy.
 * No modals owned by this tab (per D-08/D-09 topology) — no navigation triggers here.
 *
 * Real Scan content lands in Phase 43 (SCAN-01).
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {globalStyles} from '../../theme/styles';

export default function ScanScreen() {
	// D-06/SHELL-03: every placeholder screen routes through useVotingApp() — no inline mockData import.
	useVotingApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t: tCommon} = useTranslation('common');

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="qrcode" size={48} color={colors.muted} />
				<Text
					style={[
						styles.placeholderBody,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{tCommon('placeholderBody')}
				</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
		gap: 24, // lg spacing token (39-UI-SPEC.md Spacing Scale)
	},
	placeholderBody: {
		textAlign: 'center',
	},
});
