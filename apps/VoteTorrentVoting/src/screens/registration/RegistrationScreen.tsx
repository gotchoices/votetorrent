/**
 * RegistrationScreen — Registration tab root. Renders the branded blue NetworkHeader (Figma) then
 * the not-registered / registered RegistrationCard, reading isRegistered/registeredAt from
 * useVotingApp() and draft from useRegistrationDraft(). Card callbacks map to navigation:
 * Register now -> DeviceAttestation, Update registration -> RegisterPersonal, (?) help ->
 * RegistrationInfo.
 *
 * headerShown:false for RegistrationHome (navigation/index.tsx) — NetworkHeader replaces the plain
 * native header. A __DEV__-gated isRegistered toggle is kept for manual QA (compiled out of release).
 */
import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import type {RegistrationStackParamList} from '../../navigation/types';
import {RegistrationCard} from '../../components/RegistrationCard';
import {NetworkHeader} from '../../components/NetworkHeader';

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
