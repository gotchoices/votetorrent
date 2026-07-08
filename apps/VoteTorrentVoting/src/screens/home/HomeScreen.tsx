/**
 * HomeScreen — Vote tab root (D-07 per-domain screen file). Placeholder stub this phase: reads
 * through `useVotingApp()` (D-06 / SHELL-03 — no direct mock-data-module import), renders the
 * generic `common.placeholderBody` copy, and exposes modal-open triggers (`ElectionInfo` modal +
 * "Go to Ballot" push) so those routes are reachable on device once 39-07 wires the RootNavigator
 * (SHELL-02 back-navigation verification). Also hosts the `__DEV__`-gated lifecycle-state cycler
 * (D-03) — dev-only affordance, compiled out of release builds.
 *
 * Real Home content (election card, progress, countdown) lands in Phase 40.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {LIFECYCLE_ORDER} from '../../providers/types';
import {globalStyles} from '../../theme/styles';
import type {VoteStackParamList} from '../../navigation/types';

type HomeNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Home'>;

export default function HomeScreen() {
	// D-06/SHELL-03: every placeholder screen routes through useVotingApp() — no inline mockData import.
	const {isInitialized, lifecycleState, setLifecycleState} = useVotingApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<HomeNavigationProp>();

	const nextLifecycleState = () => {
		const currentIndex = LIFECYCLE_ORDER.indexOf(lifecycleState);
		const next = LIFECYCLE_ORDER[(currentIndex + 1) % LIFECYCLE_ORDER.length];
		setLifecycleState(next);
	};

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="check-to-slot" size={48} color={colors.muted} />
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
				<Pressable onPress={() => navigation.navigate('ElectionInfo')} style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Election Info (dev)</Text>
				</Pressable>
				<Pressable onPress={() => navigation.navigate('Ballot')} style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Go to Ballot (dev)</Text>
				</Pressable>
			</View>

			{/* D-03: __DEV__-gated lifecycle-state cycler — never ships to release builds. */}
			{__DEV__ && isInitialized ? (
				<Pressable onPress={nextLifecycleState} style={styles.devCycler}>
					<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
						Next state: {lifecycleState}
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
	devCycler: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
