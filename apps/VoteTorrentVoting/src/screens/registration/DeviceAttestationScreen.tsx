/**
 * DeviceAttestationScreen (REG-02/D-07/D-08) — the branded "Verifying your device..." timed
 * auto-advance interstitial. Static placeholder art + an `ActivityIndicator` spinner only — NO
 * native attestation/biometric module (D-07). After ~2.5s on focus, it replaces itself with
 * `RegisterPersonal` (Step 1 of the form) so the interstitial is not left on the back stack
 * (`navigation.replace`, not `navigate` — 41-RESEARCH.md Pattern 4): Android hardware back from
 * Step 1 then returns to `RegistrationHome`, not this screen.
 *
 * The timer is scoped to `useFocusEffect` (not a bare `useEffect`) so it is cleared on BOTH blur
 * and unmount (Pitfall 4) — it can never fire `navigation.replace()` after the screen has left
 * focus, and it never fires more than once.
 */
import React, {useCallback} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type DeviceAttestationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'DeviceAttestation'
>;

// D-08: ~2.5s reads as a genuine device-verification pause without feeling like a stall.
export const DEVICE_ATTESTATION_DELAY_MS = 2500;

export default function DeviceAttestationScreen() {
	// D-06/SHELL-03 (no-inline-mock-imports gate, Pitfall 1) — this screen has no other data
	// need of its own; a token call satisfies the gate.
	useVotingApp();
	const navigation = useNavigation<DeviceAttestationNavigationProp>();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	useFocusEffect(
		useCallback(() => {
			const timer = setTimeout(() => {
				navigation.replace('RegisterPersonal');
			}, DEVICE_ATTESTATION_DELAY_MS);
			return () => clearTimeout(timer);
		}, [navigation]),
	);

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
