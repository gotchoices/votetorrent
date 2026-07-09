/**
 * HomeScreen — Vote tab root (D-07 per-domain screen file). Reads through `useVotingApp()`
 * (D-06 / SHELL-03 — no direct mock-data-module import), fetches the election on mount and
 * whenever `lifecycleState` changes, and composes the real `ElectionCard` (Phase 40, HOME-01/02/
 * 03) once loaded. Also hosts the `__DEV__`-gated lifecycle-state cycler (D-03) — dev-only
 * affordance, compiled out of release builds.
 *
 * HomeScreen remains the only `useVotingApp()` caller on this surface (SHELL-03) — `ElectionCard`
 * is presentational (election prop + navigation callback props), never reading the provider or
 * `useNavigation()` itself (RESEARCH.md Anti-Patterns).
 */
import React, {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {MockElection} from '../../providers/types';
import {globalStyles} from '../../theme/styles';
import type {VoteStackParamList} from '../../navigation/types';
import {ElectionCard} from '../../components/ElectionCard';

type HomeNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Home'>;

export default function HomeScreen() {
	// D-06/SHELL-03: every screen routes through useVotingApp() — no inline mockData import.
	const {isInitialized, lifecycleState, setLifecycleState, getElection} = useVotingApp();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<HomeNavigationProp>();
	const [election, setElection] = useState<MockElection | null>(null);

	// Fetch on mount and re-fetch whenever lifecycleState changes — getElection's identity
	// changes with lifecycleState (VotingAppProvider's useCallback([lifecycleState]) shape), so
	// this effect naturally re-runs on every cycler step.
	useEffect(() => {
		let live = true;
		getElection().then(result => {
			if (live) {
				setElection(result);
			}
		});
		return () => {
			live = false;
		};
	}, [getElection]);

	const nextLifecycleState = () => {
		const currentIndex = LIFECYCLE_ORDER.indexOf(lifecycleState);
		const next = LIFECYCLE_ORDER[(currentIndex + 1) % LIFECYCLE_ORDER.length];
		setLifecycleState(next);
	};

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			{isInitialized && election ? (
				<ElectionCard
					election={election}
					onVoteNow={() => navigation.navigate('Ballot')}
					onViewValidationDetails={() => navigation.navigate('ValidationDetails')}
					onLearnAboutElection={() => navigation.navigate('ElectionInfo')}
				/>
			) : null}

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
	devCycler: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
