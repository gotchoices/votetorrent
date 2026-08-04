/**
 * HomeScreen — Vote tab root (D-07 per-domain screen file). Reads through `useVoterApp()`
 * (D-06 / SHELL-03 — no direct mock-data-module import), fetches the election on mount and
 * whenever `lifecycleState` changes, and composes the real `ElectionCard` (Phase 40, HOME-01/02/
 * 03) once loaded. Also hosts the `__DEV__`-gated lifecycle-state cycler (D-03) — dev-only
 * affordance, compiled out of release builds.
 *
 * HomeScreen remains the only `useVoterApp()` caller on this surface (SHELL-03) — `ElectionCard`
 * is presentational (election prop + navigation callback props), never reading the provider or
 * `useNavigation()` itself (RESEARCH.md Anti-Patterns).
 *
 * Phase 44-07 (D-02): `hasVoted` is no longer a `useVoterApp()` context field (the mock booleans
 * were removed alongside the registration-flow real-engine swap) — it is now local, session-only
 * component state, mirroring `ReviewSubmitScreen`'s own local `submitted` flag. This is a
 * deliberate, documented simplification (not a silent regression): Phase 44's scope is the
 * registration flow only (44-CONTEXT.md Phase Boundary), so cross-screen vote-status sync via a
 * shared real engine read is deferred to the phase that swaps the ballot/vote surface for real.
 */
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {MockElection} from '../../providers/types';
import type {VoteStackParamList} from '../../navigation/types';
import {ElectionCard} from '../../components/ElectionCard';
import {NetworkHeader} from '../../components/NetworkHeader';
import {InfoDialog} from '../../components/InfoDialog';

type HomeNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Home'>;

export default function HomeScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	const {isInitialized, lifecycleState, setLifecycleState, getElection} = useVoterApp();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<HomeNavigationProp>();
	const [election, setElection] = useState<MockElection | null>(null);
	const [electionInfoVisible, setElectionInfoVisible] = useState(false);
	// Phase 44-07 (D-02): local session-only flag — see file header comment.
	const [hasVoted] = useState(false);

	// Fetch on mount and re-fetch whenever lifecycleState changes — getElection's identity
	// changes with lifecycleState (VoterAppProvider's useCallback([lifecycleState]) shape), so
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
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader />

			<ScrollView contentContainerStyle={styles.content}>
				{isInitialized && election ? (
					<ElectionCard
						election={election}
						onVoteNow={() => navigation.navigate('Ballot')}
						onViewValidationDetails={() => navigation.navigate('ValidationDetails')}
						onLearnAboutElection={() => setElectionInfoVisible(true)}
						hasVoted={hasVoted}
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
			</ScrollView>

			<InfoDialog
				visible={electionInfoVisible}
				title={t('electionInfo.title')}
				subtitle={t('electionInfo.subtitle')}
				body={t('electionInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setElectionInfoVisible(false)}
			/>
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
	devCycler: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
