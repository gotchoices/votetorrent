/**
 * RegistrationScreen — Registration tab root (D-07 per-domain screen file). The real
 * not-registered/registered card host (REG-01/REG-05): reads `isRegistered`/`setIsRegistered`/
 * `registeredAt` from `useVotingApp()` (D-06/SHELL-03) and `draft` from `useRegistrationDraft()`
 * (both providers wrap the whole Registration stack — `navigation/index.tsx`), and composes the
 * presentational `RegistrationCard` (41-05), wiring its callbacks straight to navigation:
 * Register now -> DeviceAttestation, Update registration -> RegisterPersonal (skipping
 * DeviceAttestation entirely, D-04 — the draft is never cleared so no separate pre-fill logic is
 * needed), (?) help -> RegistrationInfo.
 *
 * The Phase-39 `__DEV__` dev-trigger Pressables (Open Device Attestation/Confirmation) are
 * removed — dead code now that the real card branches reach those routes via `isRegistered`. A
 * single `__DEV__`-gated `isRegistered` toggle is kept for manual QA (mirrors HomeScreen's
 * lifecycle-state cycler, D-03 pattern) — compiled out of release builds.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';
import {RegistrationCard} from '../../components/RegistrationCard';

type RegistrationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegistrationHome'
>;

export default function RegistrationScreen() {
	// D-06/SHELL-03: every screen routes through useVotingApp() — no inline mockData import.
	const {isInitialized, isRegistered, setIsRegistered, registeredAt} = useVotingApp();
	const {draft} = useRegistrationDraft();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<RegistrationNavigationProp>();

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			{isInitialized ? (
				<RegistrationCard
					isRegistered={isRegistered}
					draft={draft}
					registeredAt={registeredAt}
					onRegisterNow={() => navigation.navigate('DeviceAttestation')}
					onUpdateRegistration={() => navigation.navigate('RegisterPersonal')}
					onHelp={() => navigation.navigate('RegistrationInfo')}
				/>
			) : null}

			{/* D-03: __DEV__-gated isRegistered toggle — manual QA only, never ships to release. */}
			{__DEV__ && isInitialized ? (
				<Pressable
					onPress={() => setIsRegistered(!isRegistered)}
					style={styles.devToggle}
					testID="registration-dev-toggle">
					<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
						Toggle isRegistered (dev): {String(isRegistered)}
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	devToggle: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
