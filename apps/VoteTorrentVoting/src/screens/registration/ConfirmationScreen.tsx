/**
 * ConfirmationScreen (REG-04/D-05/D-07) — the Face-ID confirmation screen. The "Confirm with
 * Face ID" tap IS the deliberate confirming gesture (D-05), not decorative or an auto-advance.
 * `navigation.popToTop()` clears the whole `DeviceAttestation → RegisterPersonal →
 * RegisterAddressParty → RegisterConfirm → Confirmation` chain in one call (41-RESEARCH.md
 * Pattern 5) — NOT `navigate('RegistrationHome')`, which would leave that entire chain on the
 * back stack. No native biometric module (D-07); no auto-advance on this screen (unlike
 * DeviceAttestation), since D-05 requires the explicit tap.
 *
 * Phase 44-07 (D-02): the mock `setIsRegistered(true)` call is REMOVED — flipping a mock boolean
 * on tap is superseded by the real registration ceremony. `useVotingApp()` is still called
 * (unused) only to satisfy SHELL-03's "every screen calls useVotingApp()" source-scan gate,
 * mirroring `RegisterConfirmScreen`'s own established convention. Phase 44-08 (the phase's
 * capstone plan) rewires this tap handler to drive the real `RegistrationEngine.register()` →
 * `issueAttestationChallenge` → stub attestation producer → `AssociationEngine.buildAssociate()`
 * ceremony, reading the D-07 seeded `electionId`/`sign` this same `useVotingApp()` call now
 * exposes (`seededElectionId`/`sign`).
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

type ConfirmationNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'Confirmation'>;

export default function ConfirmationScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate) — token call only; the real register/associate
	// ceremony (electionId/sign) lands in Phase 44-08's rewrite of onConfirm below.
	useVotingApp();
	const navigation = useNavigation<ConfirmationNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	function onConfirm() {
		// Phase 44-08 wires the real register()->issueAttestationChallenge->associate ceremony
		// here. For now (44-07), the confirming tap only completes the navigation flow.
		navigation.popToTop();
	}

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<Text
					style={[
						styles.heading,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.h2.fontSize,
							lineHeight: typeScale.h2.lineHeight,
						},
					]}>
					{t('confirmation.heading')}
				</Text>
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
					{t('confirmation.body')}
				</Text>
				<View style={styles.iconWrap}>
					<FontAwesome6 name="fingerprint" size={96} color={colors.primary} />
				</View>
				<Text
					style={[
						styles.caption,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.caption.fontSize,
							lineHeight: typeScale.caption.lineHeight,
						},
					]}>
					{t('confirmation.caption')}
				</Text>
				<Pressable
					testID="confirmation-confirm-face-id"
					onPress={onConfirm}
					style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.ctaLabel, {color: colors.light}]}>{t('confirmation.cta')}</Text>
				</Pressable>
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
	},
	heading: {
		textAlign: 'center',
	},
	body: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	iconWrap: {
		marginTop: 32, // xl spacing token
	},
	caption: {
		marginTop: 8, // sm spacing token
		textAlign: 'center',
	},
	cta: {
		marginTop: 32, // xl spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	ctaLabel: {
		fontWeight: '600',
	},
});
