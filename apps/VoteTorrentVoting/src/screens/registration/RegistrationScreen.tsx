/**
 * RegistrationScreen — Registration tab root (D-07 per-domain screen file). Placeholder stub this
 * phase: reads through `useVotingApp()` (D-06 / SHELL-03), renders the generic
 * `common.placeholderBody` copy, and exposes modal-open triggers for the 2 modals it owns
 * (`DeviceAttestation`, `Confirmation`) so they're reachable on device once 39-07 wires the
 * RootNavigator (SHELL-02).
 *
 * Real Registration content (not-registered home card, 3-step form, confirmation) lands in
 * Phase 41.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type RegistrationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegistrationHome'
>;

export default function RegistrationScreen() {
	// D-06/SHELL-03: every placeholder screen routes through useVotingApp() — no inline mockData import.
	const {isInitialized} = useVotingApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<RegistrationNavigationProp>();

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="user-plus" size={48} color={colors.muted} />
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

			<View style={styles.triggers}>
				<Pressable
					onPress={() => navigation.navigate('DeviceAttestation')}
					style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Device Attestation (dev)</Text>
				</Pressable>
				<Pressable onPress={() => navigation.navigate('Confirmation')} style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Confirmation (dev)</Text>
				</Pressable>
			</View>

			{__DEV__ ? (
				<Text style={[styles.devLine, {color: colors.muted, fontSize: typeScale.caption.fontSize}]}>
					isInitialized: {String(isInitialized)}
				</Text>
			) : null}
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
	triggers: {
		gap: 8,
		marginBottom: 16,
	},
	triggerButton: {
		alignItems: 'center',
		paddingVertical: 8,
	},
	devLine: {
		textAlign: 'center',
		marginBottom: 8,
	},
});
