/**
 * ScanScreen — Scan tab root (D-07 per-domain screen file). Branded "not available yet"
 * placeholder this phase: reads through `useVoterApp()` (D-06 / SHELL-03), renders its own
 * `scan.*` copy (title + body) instead of the generic `common.placeholderBody` stub, giving the
 * Scan tab its own identity (D-01). No modals owned by this tab (per D-08/D-09 topology) — no
 * navigation triggers here.
 *
 * Real Scan content (camera/QR) lands in a future phase (SCAN-01 covers the placeholder only).
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';

export default function ScanScreen() {
	// D-06/SHELL-03: every placeholder screen routes through useVoterApp() — no inline mockData import.
	useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('scan');

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="qrcode" size={48} color={colors.muted} />
				<Text
					style={[
						styles.title,
						{
							color: colors.text,
							fontFamily: fonts.bold.fontFamily,
							fontWeight: fonts.bold.fontWeight,
							fontSize: typeScale.h4.fontSize,
							lineHeight: typeScale.h4.lineHeight,
						},
					]}>
					{t('notAvailableTitle')}
				</Text>
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
					{t('notAvailableBody')}
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
	title: {
		textAlign: 'center',
	},
	placeholderBody: {
		textAlign: 'center',
	},
});
