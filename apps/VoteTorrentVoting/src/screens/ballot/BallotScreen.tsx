/**
 * BallotScreen — pushed within the Vote stack (D-08 topology; not its own tab). Placeholder stub
 * this phase: reads through `useVotingApp()` (D-06 / SHELL-03), renders the generic
 * `common.placeholderBody` copy, and exposes modal-open triggers for the 3 modals it owns
 * (`IndividualQuestion`, `OfficeInfo`, `CandidateInfo`) so they're reachable on device once 39-07
 * wires the RootNavigator (SHELL-02).
 *
 * Real Ballot content (offices grouped Federal/State, progress, Save & Exit / Review & Submit)
 * lands in Phase 42.
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
import type {VoteStackParamList} from '../../navigation/types';

type BallotNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Ballot'>;

export default function BallotScreen() {
	// D-06/SHELL-03: every placeholder screen routes through useVotingApp() — no inline mockData import.
	const {isInitialized} = useVotingApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<BallotNavigationProp>();

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<FontAwesome6 name="list-check" size={48} color={colors.muted} />
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
					onPress={() => navigation.navigate('IndividualQuestion')}
					style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Individual Question (dev)</Text>
				</Pressable>
				<Pressable onPress={() => navigation.navigate('OfficeInfo')} style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Office Info (dev)</Text>
				</Pressable>
				<Pressable
					onPress={() => navigation.navigate('CandidateInfo')}
					style={styles.triggerButton}>
					<Text style={{color: colors.primary}}>Open Candidate Info (dev)</Text>
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
});
