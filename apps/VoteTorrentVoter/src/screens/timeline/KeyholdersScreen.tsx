/**
 * KeyholdersScreen (Phase 59, plan 59-10, D-15) — the voter-facing keyholder names list, reached
 * from the Timeline tab's "View Keyholders" outline button (`releasingKeys` row). Shows keyholder
 * names and a single election-level released-count line, and **nothing else**: no invite/accept/
 * revoke status of any kind. Omitting that badge entirely is the contract — see the source-scan
 * test in this file's `__tests__/KeyholdersScreen.test.tsx` for the enforced boundary.
 *
 * Read chain mirrors `TimelineScreen.tsx`'s own election-resolution shape exactly (same D-02
 * `pickElectionId` helper, same `let live = true` cancellation guard, one try/catch over the
 * whole chain): `getEngine('elections')` -> `getElections()` -> `openElection(id)` ->
 * `getElectionDetails()` -> `details.current.keyholders`. The released/total counts are a
 * SEPARATE read via `useVoterApp().getElection()` (D-04). The election-level released count is the
 * release engine's accepted-release count (D-17), carried on `getElection()`; it is absent, and the
 * count line HIDDEN, when no election key is published or the read fails. Never "0 of N": that
 * would claim a release state nobody measured.
 */
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {IElectionsEngine, InviteStatus, SentKeyholderInvite} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';
import {pickElectionId} from '../../engines/election-read';

type Keyholder = InviteStatus<SentKeyholderInvite>;

type ScreenState =
	| {kind: 'loading'}
	| {kind: 'ready'; keyholders: Keyholder[]; released: number | null; total: number}
	| {kind: 'indeterminate'};

export default function KeyholdersScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mock-data-module
	// import, and no direct election-record read either (D-04 read-scope fence stays narrow: the
	// engine chain below for the keyholder list, `getElection()` for the released/total count
	// only, never the Home tab's own election card fixture surface).
	const {getEngine, getElection, seededElectionId} = useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');

	const [state, setState] = useState<ScreenState>({kind: 'loading'});
	const [reloadNonce, setReloadNonce] = useState(0);

	// HomeScreen.tsx / TimelineScreen.tsx's `let live = true` cancellation-guard shape, exactly.
	// One try/catch over the WHOLE chain — any rejection anywhere (getEngine, getElections,
	// openElection, getElectionDetails, getElection) lands in the indeterminate state, never a
	// partial render, never a false "no keyholders yet".
	useEffect(() => {
		let live = true;

		(async () => {
			try {
				const electionsEngine = await getEngine<IElectionsEngine>('elections');
				const summaries = await electionsEngine.getElections();
				const electionId = pickElectionId(summaries, __DEV__ ? seededElectionId : undefined);

				if (!electionId) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				const electionEngine = await electionsEngine.openElection(electionId);
				const details = await electionEngine.getElectionDetails();
				const keyholders = details.current?.keyholders;

				if (!keyholders) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				// Election-level released/total (D-04): read via getElection(), NEVER the engine
				// chain above — it is the release engine's accepted-release count (D-17), carried by getElection().
				// A failed election read only costs the count line, never the keyholder list. The
				// clamp prevents an incoherent "9 of 2" when a review-fixture released count outruns
				// the real keyholder count.
				const election = await getElection().catch(() => null);
				const total = election?.keysTotal ?? keyholders.length;
				const released = election?.keysReleased === undefined ? null : Math.min(election.keysReleased, total);

				if (live) setState({kind: 'ready', keyholders, released, total});
			} catch {
				// Any rejection in the chain above lands here — D-03's explicit indeterminate path,
				// never silence, and never a fall-through to the empty state.
				if (live) setState({kind: 'indeterminate'});
			}
		})();

		return () => {
			live = false;
		};
	}, [getEngine, getElection, seededElectionId, reloadNonce]);

	const isEmpty = state.kind === 'ready' && state.keyholders.length === 0;
	const isList = state.kind === 'ready' && state.keyholders.length > 0;

	return (
		<ScrollView
			testID="keyholders-scroll"
			style={[styles.screen, {backgroundColor: colors.background}]}
			contentContainerStyle={isList ? styles.listContent : [globalStyles.container, styles.centerColumn]}>
			{state.kind === 'indeterminate' ? (
				<View testID="keyholders-indeterminate" style={styles.centerColumn}>
					<Text
						testID="keyholders-indeterminate-heading"
						style={{color: colors.error, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight}}>
						{t('indeterminate.heading')}
					</Text>
					<Text
						testID="keyholders-indeterminate-body"
						style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, marginTop: 8}}>
						{t('indeterminate.body')}
					</Text>
					<Pressable
						testID="keyholders-indeterminate-retry"
						accessibilityRole="button"
						style={styles.retry}
						onPress={() => setReloadNonce(n => n + 1)}>
						<Text style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
							{t('indeterminate.retryCta')}
						</Text>
					</Pressable>
				</View>
			) : null}

			{isEmpty ? (
				<View testID="keyholders-empty" style={styles.centerColumn}>
					<FontAwesome6 name="key" size={48} color={colors.muted} />
					<Text
						testID="keyholders-empty-heading"
						style={[
							styles.heading,
							{
								// Regular weight (not bold) -- 59-UI-SPEC.md's 2-weight budget reserves
								// bold for exactly three named sites (the rail "Now" label, the CTA/
								// button label, and the Registration Ends panel's "are registered" run),
								// none of which is this heading; hierarchy here comes from size alone,
								// mirroring TimelineScreen.tsx's own h2/h4 headings.
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('keyholders.emptyHeading')}
					</Text>
					<Text
						testID="keyholders-empty-body"
						style={{
							color: colors.textSecondary,
							textAlign: 'center',
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						}}>
						{t('keyholders.emptyBody')}
					</Text>
				</View>
			) : null}

			{isList && state.kind === 'ready' ? (
				<View testID="keyholders-list">
					{state.released !== null ? (
						<Text
							testID="keyholders-released-count"
							style={{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
								marginBottom: 16,
							}}>
							{t('keyholders.releasedCount', {released: state.released, total: state.total})}
						</Text>
					) : null}
					{state.keyholders.map((kh, index) => (
						<View key={index} testID="keyholders-row" style={styles.row}>
							<Text
								numberOfLines={2}
								style={{
									color: colors.text,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								}}>
								{kh.invite.name}
							</Text>
						</View>
					))}
				</View>
			) : null}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flexGrow: 1,
		justifyContent: 'center',
		alignItems: 'center',
		gap: 24, // lg spacing token
	},
	listContent: {
		padding: 16,
	},
	heading: {
		textAlign: 'center',
	},
	row: {
		marginBottom: 16, // md spacing token — row-to-row vertical gap
	},
	retry: {
		marginTop: 24,
		minHeight: 44,
		justifyContent: 'center',
	},
});
