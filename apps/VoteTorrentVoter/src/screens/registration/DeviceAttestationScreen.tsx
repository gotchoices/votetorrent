/**
 * DeviceAttestationScreen (REG-02/D-07/D-08/D-10/D-11) — the branded "Verifying your device..."
 * interstitial. On focus it runs the D-10 StrongBox/TEE CAPABILITY PROBE
 * (`resolveAttestationProducer().provisionDeviceKey()`) BEFORE ever advancing — Open Question 2
 * (45-RESEARCH.md) LOCKED this probe on THIS screen rather than reordering ConfirmationScreen's
 * ceremony, because nothing is persisted yet at this point (`register()` runs later, on
 * `ConfirmationScreen`), so a terminal capability failure here needs no rollback (T-45-06-01).
 * `provisionDeviceKey()` is key CREATION only — it never prompts biometric (that happens later,
 * inside `ConfirmationScreen`'s `produce()` call, preserving D-15/D-16 biometric-last).
 *
 * On resolve, it replaces itself with `RegisterPersonal` (Step 1 of the form) so the interstitial
 * is not left on the back stack (`navigation.replace`, not `navigate` — 41-RESEARCH.md Pattern 4):
 * Android hardware back from Step 1 then returns to `RegistrationHome`, not this screen. On a
 * TERMINAL-class rejection (release build only — `classifyAttestationFailure` downgrades it under
 * `__DEV__`, D-09), the screen renders a terminal wall instead of advancing: no retry, no
 * `Registrant` row ever written (D-10 no-op rollback).
 *
 * The probe is scoped to `useFocusEffect` (not a bare `useEffect`) with a cancelled/mounted flag
 * captured in the effect cleanup, so it can never fire `navigation.replace()` (or set state) after
 * the screen has left focus/unmounted (Pitfall 4), and it never fires more than once per focus.
 */
import React, {useCallback, useState} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {classifyAttestationFailure} from '../../engines/attestation-failure';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type DeviceAttestationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'DeviceAttestation'
>;

export default function DeviceAttestationScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate, Pitfall 1) — this screen has no other data
	// need of its own; a token call satisfies the gate.
	useVoterApp();
	const navigation = useNavigation<DeviceAttestationNavigationProp>();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const [isTerminal, setIsTerminal] = useState(false);

	useFocusEffect(
		useCallback(() => {
			let cancelled = false;

			(async () => {
				try {
					const producer = resolveAttestationProducer();
					await producer.provisionDeviceKey();
					if (!cancelled) {
						navigation.replace('RegisterPersonal');
					}
				} catch (err) {
					if (cancelled) {
						return;
					}
					const failureClass = classifyAttestationFailure(err);
					if (failureClass === 'terminal') {
						// D-09/D-10: terminal capability wall — release-only (classifyAttestationFailure
						// downgrades this under __DEV__), no Registrant row exists yet, no retry.
						setIsTerminal(true);
						return;
					}
					// Transient capability hiccups must not wall the voter at this probe — the real
					// biometric/attestation attempt and its retry UX live on ConfirmationScreen.
					navigation.replace('RegisterPersonal');
				}
			})();

			return () => {
				cancelled = true;
			};
		}, [navigation]),
	);

	if (isTerminal) {
		return (
			<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
				<View style={styles.centerColumn}>
					<FontAwesome6 name="shield-halved" size={96} color={colors.primary} />
					<Text
						testID="device-attestation-terminal-heading"
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
						{t('deviceAttestation.terminalHeading')}
					</Text>
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
						{t('deviceAttestation.terminalBody')}
					</Text>
				</View>
			</View>
		);
	}

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="shield-halved" size={96} color={colors.primary} />
				<ActivityIndicator size="large" color={colors.primary} style={styles.spinner} />
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
					{t('deviceAttestation.heading')}
				</Text>
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
					{t('deviceAttestation.caption')}
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
	},
	spinner: {
		marginTop: 8, // sm spacing token
	},
	heading: {
		marginTop: 32, // xl spacing token
		textAlign: 'center',
	},
	caption: {
		marginTop: 8, // sm spacing token
		textAlign: 'center',
	},
});
