/**
 * VoteReceiptScreen (Phase 63 plan 12) - the dedicated vote receipt (D-10), replacing the old
 * old inline mock confirmation view.
 *
 * D-11 / D-22: the status line and the loss line render from the non-secret marker with no
 * fingerprint prompt. D-13 / D-15: choices and vote codes appear only after `revealVoteReceipt`
 * (which goes through `openVoteRecord` and prompts), and never before it. R-4: `revealOnOpen` is
 * consumed once, on first focus; every later visit needs an explicit tap. The decrypted record
 * lives only in this component's state and is cleared on blur, on app background and on unmount.
 * D-17: a code is copied only on a tap through `copyVoteCode`, with the warning rendered beside
 * each button; there is no share sheet and no selectable text. The copy result is a toast. D-18: each code is shown as 16
 * wrapped groups of the exact stored characters. D-21: a revision mismatch shows the stale line.
 *
 * Storage is reached only through `engines/vote-receipt.ts` (gate K1). Nothing is logged.
 *
 * CR-01 (review): FLAG_SECURE while focused, and an opaque privacy cover instead of the revealed
 * record while the app is not active (see utils/receipt-privacy.ts).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useRoute, useTheme} from '@react-navigation/native';
import type {ExtendedTheme, RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import type {Ballot} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useToast} from '../../components/Toast';
import {globalStyles} from '../../theme/styles';
import type {VoteStackParamList} from '../../navigation/types';
import {
	buildReceiptBallots,
	loadVoteReceipt,
	readReceiptElection,
	revealVoteReceipt,
} from '../../engines/vote-receipt';
import type {VoteReceiptLoad} from '../../engines/vote-receipt';
import type {VoteRecord, VoteRecordEnvelope} from '../../engines/vote-record-vault';
import {copyVoteCode} from '../../utils/vote-code-clipboard';
import type {VoteCodeCopyResult} from '../../utils/vote-code-clipboard';
import {usePrivacyCover, useSecureScreenWhileFocused} from '../../utils/receipt-privacy';
import SendVoteCard from './SendVoteCard';

type ReceiptRoute = RouteProp<VoteStackParamList, 'VoteReceipt'>;
type ReceiptNavigation = NativeStackNavigationProp<VoteStackParamList, 'VoteReceipt'>;
type RevealNotice = 'canceled' | 'biometric-unavailable' | 'failed';

const NOTICE_KEY: Record<RevealNotice, string> = {
	canceled: 'receipt.revealCanceled',
	// resolved per platform at render (the biometric copy names the platform's own biometric, D-101)
	'biometric-unavailable': 'receipt.revealBiometricUnavailable',
	failed: 'receipt.revealFailed',
};

export default function VoteReceiptScreen() {
	// SHELL-03: every screen routes through useVoterApp().
	const {getEngine, seededElectionId, nowMs} = useVoterApp();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	// Literal keys per platform branch (D-101) so the i18n parity scan resolves every key.
	const isIos = Platform.OS === 'ios';
	const route = useRoute<ReceiptRoute>();
	const navigation = useNavigation<ReceiptNavigation>();
	useSecureScreenWhileFocused();
	const covered = usePrivacyCover();
	const showToast = useToast();

	const rawId: unknown = route.params?.electionId;
	const electionId = typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;

	const [load, setLoad] = useState<VoteReceiptLoad | null>(null);
	const [ballots, setBallots] = useState<Ballot[]>([]);
	const [record, setRecord] = useState<VoteRecord | null>(null);
	const [notice, setNotice] = useState<RevealNotice | null>(null);
	const [busy, setBusy] = useState(false);
	const [allSent, setAllSent] = useState(false);

	const autoRevealConsumed = useRef(false);
	const focused = useRef(false);
	const busyRef = useRef(false);
	// Latest values, read inside the focus effect so a changing identity cannot re-trigger a load.
	const latest = useRef({getEngine, seededElectionId, nowMs, t, params: route.params});
	latest.current = {getEngine, seededElectionId, nowMs, t, params: route.params};

	const reveal = useCallback(
		async (envelope: VoteRecordEnvelope) => {
			if (electionId === undefined || busyRef.current) {
				return;
			}
			busyRef.current = true;
			setBusy(true);
			const tr = latest.current.t;
			const result = await revealVoteReceipt(electionId, envelope, {
				title: tr('receipt.prompt.title'),
				subtitle: Platform.OS === 'ios' ? tr('receipt.prompt.subtitle') : tr('receipt.prompt.subtitle.android'),
				negativeButton: tr('receipt.prompt.negativeButton'),
			});
			busyRef.current = false;
			setBusy(false);
			// The screen lost focus while the prompt was up: never hold the record.
			if (!focused.current) {
				return;
			}
			if (result.kind === 'ok') {
				setRecord(result.record);
				setNotice(null);
			} else if (result.kind === 'unreadable') {
				setRecord(null);
				setLoad({kind: 'unreadable'});
			} else {
				setNotice(result.kind);
			}
		},
		[electionId],
	);

	useFocusEffect(
		useCallback(() => {
			focused.current = true;
			let live = true;
			if (electionId === undefined) {
				setLoad({kind: 'none'});
				return () => {
					live = false;
					focused.current = false;
				};
			}
			(async () => {
				const cur = latest.current;
				const election = await readReceiptElection(
					{getEngine: cur.getEngine, fallbackElectionId: __DEV__ ? cur.seededElectionId : undefined},
					cur.nowMs(),
					electionId,
				);
				const result = await loadVoteReceipt(electionId, election?.revision ?? null);
				if (!live) {
					return;
				}
				setBallots(election?.ballots ?? []);
				setLoad(result);
				if (
					(result.kind === 'saved' || result.kind === 'stale') &&
					latest.current.params?.revealOnOpen === true &&
					!autoRevealConsumed.current
				) {
					autoRevealConsumed.current = true;
					navigation.setParams({revealOnOpen: false});
					await reveal(result.envelope);
				}
			})().catch(() => {
				if (live) {
					setLoad({kind: 'unreadable'});
				}
			});
			return () => {
				// Blur: re-hide (D-13 / R-4).
				live = false;
				focused.current = false;
				setRecord(null);
				setNotice(null);
			};
		}, [electionId, navigation, reveal]),
	);

	useEffect(() => {
		const sub = AppState.addEventListener('change', state => {
			// Not 'inactive': iOS goes inactive while its own biometric sheet is up.
			if (state === 'background') {
				setRecord(null);
			}
		});
		return () => sub.remove();
	}, []);

	const bodyFont = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.body.fontSize,
		lineHeight: typeScale.body.lineHeight,
	};
	const captionFont = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.caption.fontSize,
		lineHeight: typeScale.caption.lineHeight,
	};
	const mediumFont = {fontFamily: fonts.medium.fontFamily, fontWeight: fonts.medium.fontWeight};
	const mono = Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'});

	const saved = load !== null && (load.kind === 'saved' || load.kind === 'stale') ? load : null;
	const views = record !== null ? buildReceiptBallots(record, ballots) : [];

	const onCopy = (index: number, nonce: string) => {
		let result: VoteCodeCopyResult;
		try {
			result = copyVoteCode(nonce);
		} catch {
			result = 'unavailable';
		}
		if (result === 'copied') {
			showToast(t('receipt.copied'), {testID: `receipt-copied-${index}`});
		} else {
			showToast(t('receipt.copyFailed'), {testID: `receipt-copy-failed-${index}`});
		}
	};

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				{load === null ? (
					<Text testID="receipt-loading" style={[bodyFont, {color: colors.textSecondary}]}>
						{t('receipt.loading')}
					</Text>
				) : null}

				{load !== null && load.kind === 'none' ? (
					<Text testID="receipt-none" style={[bodyFont, {color: colors.text}]}>
						{t('receipt.none')}
					</Text>
				) : null}

				{load !== null && load.kind === 'unreadable' ? (
					<>
						<Text testID="receipt-unreadable" style={[bodyFont, mediumFont, {color: colors.error}]}>
							{t('receipt.unreadable')}
						</Text>
						<Text testID="receipt-loss" style={[styles.block, bodyFont, {color: colors.textSecondary}]}>
							{t('receipt.loss')}
						</Text>
					</>
				) : null}

				{saved !== null ? (
					<>
						<Text testID="receipt-status" style={[bodyFont, mediumFont, {color: colors.text}]}>
							{t(allSent ? 'receipt.statusSent' : 'receipt.status')}
						</Text>
						{saved.kind === 'stale' ? (
							<Text testID="receipt-stale" style={[styles.block, bodyFont, mediumFont, {color: colors.error}]}>
								{t('receipt.stale')}
							</Text>
						) : null}
						{!saved.revisionKnown ? (
							<Text testID="receipt-revision-unknown" style={[styles.block, bodyFont, {color: colors.textSecondary}]}>
								{t('receipt.revisionUnknown')}
							</Text>
						) : null}
						<Text testID="receipt-loss" style={[styles.block, bodyFont, {color: colors.textSecondary}]}>
							{t('receipt.loss')}
						</Text>

						{saved.kind === 'saved' && saved.revisionKnown && electionId !== undefined ? (
							<SendVoteCard
								electionId={electionId}
								electionRevision={saved.marker.electionRevision}
								envelope={saved.envelope}
								ballotIds={saved.marker.ballotIds}
								onAllSentChange={setAllSent}
							/>
						) : null}

						{record === null ? (
							<View style={styles.block}>
								<Pressable
									testID="receipt-reveal"
									accessibilityRole="button"
									disabled={busy}
									onPress={() => {
										void reveal(saved.envelope);
									}}
									style={[
										styles.revealButton,
										{
											backgroundColor: colors.secondaryButtonSurface,
											borderColor: colors.primary,
											borderRadius: radii.pill,
											opacity: busy ? 0.5 : 1,
										},
									]}>
									<Text style={[styles.buttonLabel, {color: colors.primary}]}>{t('receipt.revealCta')}</Text>
								</Pressable>
								<Text style={[styles.hint, captionFont, {color: colors.textSecondary}]}>{isIos ? t('receipt.revealHint') : t('receipt.revealHint.android')}</Text>
								{notice !== null ? (
									<Text testID="receipt-reveal-notice" style={[styles.hint, bodyFont, {color: colors.error}]}>
										{notice === 'biometric-unavailable'
										? (isIos ? t('receipt.revealBiometricUnavailable') : t('receipt.revealBiometricUnavailable.android'))
										: t(NOTICE_KEY[notice])}
									</Text>
								) : null}
							</View>
						) : null}

						{record !== null && !covered ? (
							<View style={styles.block}>
								<Text style={[bodyFont, mediumFont, {color: colors.text}]}>{t('receipt.choicesHeading')}</Text>
								{views.map((view, i) => (
									<View
										key={`${view.ballotId}-${i}`}
										testID={`receipt-ballot-${i}`}
										style={[globalStyles.cardSurface, styles.card, {backgroundColor: colors.card}]}>
										{view.description !== null ? (
											<Text style={[bodyFont, mediumFont, {color: colors.text}]}>{view.description}</Text>
										) : null}
										{view.questions.map(q => (
											<View key={q.questionCode} testID={`receipt-question-${i}-${q.questionCode}`} style={styles.question}>
												<Text style={[captionFont, {color: colors.textSecondary}]}>{q.title ?? q.questionCode}</Text>
												<Text style={[bodyFont, {color: q.blank ? colors.textSecondary : colors.success}]}>
													{q.blank ? t('receipt.leftBlank') : q.choices.join(', ')}
												</Text>
											</View>
										))}
										<Text style={[styles.nonceLabel, captionFont, {color: colors.textSecondary}]}>{t('receipt.nonceLabel')}</Text>
										{view.nonceGroups === null ? (
											<Text style={[bodyFont, {color: colors.error}]}>{t('receipt.unreadable')}</Text>
										) : (
											<>
												<View testID={`receipt-nonce-${i}`} style={styles.nonceRow}>
													{view.nonceGroups.map((group, j) => (
														<Text
															key={j}
															testID={`receipt-nonce-group-${i}-${j}`}
															style={[styles.nonceGroup, bodyFont, {color: colors.text, fontFamily: mono}]}>
															{group}
														</Text>
													))}
												</View>
												<View style={styles.copyRow}>
													<Pressable
														testID={`receipt-copy-${i}`}
														accessibilityRole="button"
														onPress={() => onCopy(i, view.nonce)}
														style={[
															styles.copyButton,
															{
																backgroundColor: colors.secondaryButtonSurface,
																borderColor: colors.primary,
																borderRadius: radii.pill,
															},
														]}>
														<Text style={[styles.buttonLabel, {color: colors.primary}]}>{t('receipt.copyCta')}</Text>
													</Pressable>
													<Text
														testID={`receipt-copy-warning-${i}`}
														style={[styles.warning, captionFont, mediumFont, {color: colors.error}]}>
														{t('receipt.copyWarning')}
													</Text>
												</View>
											</>
										)}
									</View>
								))}
							</View>
						) : null}
					</>
				) : null}
			</ScrollView>

			{covered && record !== null ? (
				<View testID="receipt-privacy-cover" style={[StyleSheet.absoluteFill, {backgroundColor: colors.background}]} />
			) : null}

			<View style={[globalStyles.footerButtonsContainer, styles.footer]}>
				<Pressable
					testID="receipt-done"
					accessibilityRole="button"
					onPress={() => navigation.popToTop()}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.buttonLabel, {color: colors.light}]}>{t('receipt.doneCta')}</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {flex: 1},
	scroll: {flex: 1},
	scrollContent: {flexGrow: 1},
	block: {marginTop: 16},
	card: {marginTop: 12},
	question: {marginTop: 8},
	nonceLabel: {marginTop: 12},
	nonceRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},
	nonceGroup: {marginRight: 8},
	copyRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 8},
	copyButton: {
		minHeight: 44,
		justifyContent: 'center',
		paddingHorizontal: 20,
		paddingVertical: 8,
		borderWidth: 1,
		marginRight: 12,
	},
	warning: {flexShrink: 1, flex: 1},
	revealButton: {
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderWidth: 1,
	},
	hint: {marginTop: 8},
	footer: {marginTop: 24},
	footerButton: {
		flex: 1,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	buttonLabel: {fontWeight: '600'},
});
