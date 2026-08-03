/**
 * RegistrationScreen — Registration tab root. Renders the branded blue NetworkHeader (Figma) then
 * the not-registered / registered RegistrationCard, reading draft from useRegistrationDraft().
 * Card callbacks map to navigation: Register now -> DeviceAttestation, Update registration ->
 * RegisterPersonal, (?) help -> RegistrationInfo.
 *
 * Phase 44-07 (D-02): `isRegistered`/`registeredAt` are no longer `useVoterApp()` context fields
 * (the mock booleans were removed alongside the registration-flow real-engine swap) — they are now
 * local, session-only component state (same shape/behavior as the old context setter: flipping
 * true freezes `registeredAt` to the confirm-time ISO timestamp). This is a deliberate, documented
 * simplification: deriving real registration status from the engine's `Registrant` rows is a later
 * phase's concern (44-CONTEXT.md Phase Boundary scopes this phase to the registration FLOW, not
 * the status-read surface).
 *
 * headerShown:false for RegistrationHome (navigation/index.tsx) — NetworkHeader replaces the plain
 * native header. A __DEV__-gated isRegistered toggle is kept for manual QA (compiled out of release).
 */
import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import type {RegistrationStackParamList} from '../../navigation/types';
import {RegistrationCard} from '../../components/RegistrationCard';
import {NetworkHeader} from '../../components/NetworkHeader';

type RegistrationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegistrationHome'
>;

export default function RegistrationScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	const {isInitialized} = useVoterApp();
	const {draft} = useRegistrationDraft();
	// Phase 44-07 (D-02): local session-only state — see file header comment.
	const [isRegistered, setIsRegisteredState] = useState(false);
	const [registeredAt, setRegisteredAt] = useState<string | null>(null);
	const setIsRegistered = useCallback((value: boolean) => {
		setIsRegisteredState(value);
		if (value) {
			setRegisteredAt(new Date().toISOString());
		}
	}, []);
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<RegistrationNavigationProp>();

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader onPressNetwork={() => navigation.navigate('RegistrationInfo')} />

			<ScrollView contentContainerStyle={styles.content}>
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
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	devToggle: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
