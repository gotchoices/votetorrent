import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import type {IElectionsEngine} from '@votetorrent/vote-core';
import type {ElectionResults, ElectionResultsEngine} from '@votetorrent/vote-engine/rn';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';
import {pickElectionId} from '../../engines/election-read';

/**
 * ResultsScreen — the election's results, counted on this phone. After enough keyholders release their key
 * shares, vote-engine's ElectionResultsEngine rebuilds the election key from the PUBLIC shares, decrypts and
 * validates every published vote block, and tallies it. Nothing is written and the key is wiped inside the call.
 * Picks the same election as the other Timeline screens (pickElectionId).
 */

type ScreenState = {kind: 'loading'} | {kind: 'ready'; results: ElectionResults} | {kind: 'failed'};

const percent = (count: number, of: number): number => (of > 0 ? Math.round((count / of) * 100) : 0);

export default function ResultsScreen() {
	const {getEngine, seededElectionId} = useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');
	const [state, setState] = useState<ScreenState>({kind: 'loading'});
	const [reloadNonce, setReloadNonce] = useState(0);

	useEffect(() => {
		let live = true;
		setState({kind: 'loading'});
		(async () => {
			try {
				const electionsEngine = await getEngine<IElectionsEngine>('elections');
				const summaries = await electionsEngine.getElections();
				const electionId = pickElectionId(summaries, __DEV__ ? seededElectionId : undefined);
				if (!electionId) {
					if (live) setState({kind: 'ready', results: {status: 'no-election', electionId: ''}});
					return;
				}
				const engine = await getEngine<ElectionResultsEngine>('electionResults');
				const results = await engine.getElectionResults(electionId);
				if (live) setState({kind: 'ready', results});
			} catch {
				if (live) setState({kind: 'failed'});
			}
		})();
		return () => {
			live = false;
		};
	}, [getEngine, seededElectionId, reloadNonce]);

	const body = {color: colors.text, fontFamily: fonts.regular.fontFamily, fontWeight: fonts.regular.fontWeight, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	const secondary = {...body, color: colors.textSecondary};
	const heading = {...body, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight};
	const results = state.kind === 'ready' ? state.results : null;

	return (
		<ScrollView testID="results-scroll" style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={styles.content}>
			{state.kind === 'loading' ? (
				<Text testID="results-loading" style={secondary}>
					{t('results.computing')}
				</Text>
			) : null}

			{state.kind === 'failed' ? (
				<Text testID="results-failed" style={{...body, color: colors.error}}>
					{t('results.loadFailed')}
				</Text>
			) : null}

			{results?.status === 'no-election' ? (
				<Text testID="results-no-election" style={body}>
					{t('results.noElection')}
				</Text>
			) : null}

			{results?.status === 'awaiting-keys' ? (
				<View testID="results-awaiting-keys" style={[styles.card, {backgroundColor: colors.card, borderColor: colors.border}]}>
					<Text style={heading}>{t('results.lockedTitle')}</Text>
					<Text style={body}>{t('results.lockedBody')}</Text>
					{results.threshold !== null ? (
						<Text testID="results-released-count" style={body}>
							{t('results.releasedCount', {released: results.releasedCount, needed: results.threshold})}
						</Text>
					) : (
						<Text testID="results-no-key" style={secondary}>
							{t('results.noKey')}
						</Text>
					)}
				</View>
			) : null}

			{results?.status === 'unavailable' ? (
				<View testID="results-unavailable" style={[styles.card, {backgroundColor: colors.card, borderColor: colors.border}]}>
					<Text style={{...heading, color: colors.error}}>{t('results.unavailableTitle')}</Text>
					<Text testID="results-unavailable-reason" style={secondary}>
						{t('results.unavailableReason', {reason: results.reason})}
					</Text>
				</View>
			) : null}

			{results?.status === 'tallied' && results.blockCount === 0 ? (
				<View testID="results-no-blocks" style={[styles.card, {backgroundColor: colors.card, borderColor: colors.border}]}>
					<Text style={{...body, color: colors.warning}}>{t('results.noBlocksYet')}</Text>
				</View>
			) : null}

			{results?.status === 'tallied' && results.blockCount > 0 ? (
				<>
					<View testID="results-summary" style={[styles.card, {backgroundColor: colors.card, borderColor: colors.border}]}>
						<Text testID="results-valid-total" style={heading}>
							{t('results.validVotes', {count: results.totals.valid})}
						</Text>
						{results.totals.invalid + results.totals.excluded > 0 ? (
							<Text testID="results-not-counted" style={{...body, color: colors.warning}}>
								{t('results.notCountedVotes', {count: results.totals.invalid + results.totals.excluded})}
							</Text>
						) : null}
						<Text style={secondary}>{t('results.checkedNote')}</Text>
					</View>
					{results.ballots.length === 0 ? (
						<Text testID="results-no-ballots" style={body}>
							{t('results.noBallots')}
						</Text>
					) : null}
					{results.ballots.map(b => (
						<View key={b.ballotId} testID={`results-ballot-${b.ballotId}`} style={[styles.card, {backgroundColor: colors.card, borderColor: colors.border}]}>
							{b.description ? <Text style={heading}>{b.description}</Text> : null}
							{b.questions.map(q => {
								const total = q.options.reduce((n, o) => n + o.count, 0);
								return (
									<View key={q.code} testID={`results-question-${q.code}`} style={styles.question}>
										<Text style={{...body, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}}>{q.title}</Text>
										{q.counted ? (
											q.options.map(o => (
												<View key={o.code} style={styles.option}>
													<View style={styles.optionLabel}>
														<Text style={[body, styles.shrink]}>{o.title}</Text>
														<Text testID={`results-count-${q.code}-${o.code}`} style={body}>
															{t('results.optionCount', {count: o.count, percent: percent(o.count, total)})}
														</Text>
													</View>
													<View style={[styles.barTrack, {backgroundColor: colors.progressTrack}]}>
														<View style={[styles.barFill, {backgroundColor: colors.progressFill, width: `${percent(o.count, total)}%`}]} />
													</View>
												</View>
											))
										) : (
											<Text style={secondary}>{t('results.questionNotCounted')}</Text>
										)}
										{q.counted && q.blank > 0 ? <Text style={secondary}>{t('results.blank', {count: q.blank})}</Text> : null}
									</View>
								);
							})}
						</View>
					))}
				</>
			) : null}

			<Pressable
				testID="results-refresh"
				accessibilityRole="button"
				style={styles.refresh}
				disabled={state.kind === 'loading'}
				onPress={() => setReloadNonce(n => n + 1)}>
				<Text style={{...body, color: colors.link}}>{t('results.refreshCta')}</Text>
			</Pressable>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		...globalStyles.container,
		padding: 16,
		gap: 16,
	},
	card: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 16,
		gap: 8,
	},
	question: {
		marginTop: 8,
		gap: 6,
	},
	option: {
		gap: 4,
	},
	optionLabel: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		gap: 8,
	},
	shrink: {
		flexShrink: 1,
	},
	barTrack: {
		height: 8,
		borderRadius: 4,
		overflow: 'hidden',
	},
	barFill: {
		height: 8,
		borderRadius: 4,
	},
	refresh: {
		minHeight: 44,
		justifyContent: 'center',
		alignItems: 'center',
	},
});
