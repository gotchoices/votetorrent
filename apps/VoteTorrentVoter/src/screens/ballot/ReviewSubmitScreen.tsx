/**
 * ReviewSubmitScreen (VOTE-04) - a plain-push `ReviewSubmit` route on the Vote stack. Reads
 * `getBallot()` and the engine surface from `useVoterApp()` (SHELL-03/D-06 gate) and
 * `selectionMap` from `useBallotSelection()` to render a per-office summary row, then the real
 * local Submit.
 *
 * D-10: the mock Submit and its inline "submitted" view are gone. A saved vote lands on the
 * `VoteReceipt` route.
 *
 * Eligibility is evaluated on every focus, so the reason is shown before any prompt (D-01, D-03,
 * D-04, D-05, D-06, D-07, D-20, D-21). One plain message is shown per closed reason. The
 * not-registered and rotated-key reasons share one message (R-1), because the exact-key lookup
 * cannot tell them apart.
 *
 * Blank questions are listed (D-04, R-3); an eligible all-blank vote is allowed and stated.
 *
 * WR-01: once the ballot loads, selections it no longer shows are pruned from the provider, so
 * what Review lists is exactly what Submit can sign. A selection that is unusable for a question
 * still on the ballot keeps Submit disabled and is named under the reason.
 *
 * Submit calls `castVote` with the vote prompt copy (D-09) and passes no signing override, so
 * signing is always the real device-key signer (D-08); the dev stub is never reachable from here.
 * `castVote` re-checks eligibility itself.
 *
 * Submit is disabled while pending. On success the selections are cleared and the receipt opens
 * with `revealOnOpen`. A failure keeps the selections and shows one message per closed stage and
 * reason. Error text is never shown or logged.
 *
 * The screen never touches storage (gate K1) and never logs.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import type {SecretWrapPrompt} from '@votetorrent/attestation-native';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useBallotSelection, resolveSelectionSummary} from '../../providers/BallotSelectionProvider';
import type {Office} from '../../providers/types';
import {globalStyles} from '../../theme/styles';
import {useBallot} from '../../hooks/useBallot';
import {evaluateVoteEligibility, castVote} from '../../engines/vote-casting';
import type {
	VoteEligibility,
	VoteIneligibleReason,
	VoteQuestionRef,
	CastVoteFailure,
	CastVoteResult,
} from '../../engines/vote-casting';
import type {VoteStackParamList} from '../../navigation/types';

type ReviewSubmitNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'ReviewSubmit'>;
type Translate = (key: string) => string;

/** One plain message per closed ineligibility reason. Literal keys keep the i18n scan honest. */
function ineligibleReasonText(reason: VoteIneligibleReason, t: Translate): string {
	switch (reason) {
		case 'election-unavailable':
			return t('submit.reason.electionUnavailable');
		case 'window-closed':
			return t('submit.reason.windowClosed');
		case 'ballot-unconfirmed':
			return t('submit.reason.ballotUnconfirmed');
		case 'no-ballots':
			return t('submit.reason.noBallots');
		case 'unsupported-question':
			return t('submit.reason.unsupportedQuestion');
		case 'dependent-question':
			return t('submit.reason.dependentQuestion');
		case 'selection-invalid':
			return t('submit.reason.selectionInvalid');
		case 'required-unanswered':
			return t('submit.reason.requiredUnanswered');
		case 'below-minimum':
			return t('submit.reason.belowMinimum');
		case 'device-check-failed':
			return t('submit.reason.deviceCheckFailed');
		case 'not-registered':
		case 'device-key-rotated':
			// R-1: the exact-key lookup cannot tell these apart, so both get the one honest line.
			return t('submit.reason.notRegistered');
		case 'registration-ambiguous':
			return t('submit.reason.registrationAmbiguous');
		case 'unreadable-key':
			return t('submit.reason.unreadableKey');
		case 'already-saved':
			return t('submit.reason.alreadySaved');
		default: {
			const unreachable: never = reason;
			void unreachable;
			return t('submit.reason.electionUnavailable');
		}
	}
}

/** One typed message per closed failure stage and reason; never derived from error text. */
function castFailureText(failure: Exclude<CastVoteFailure, {stage: 'ineligible'}>, t: Translate): string {
	// D-101: iOS reads the Face ID copy (base key), Android the '.android' sibling; literal keys per branch.
	const isIos = Platform.OS === 'ios';
	switch (failure.stage) {
		case 'build':
			switch (failure.reason) {
				case 'build-failed':
					return t('submit.failure.buildFailed');
				default: {
					const unreachable: never = failure;
					void unreachable;
					return t('submit.failure.unexpected');
				}
			}
		case 'sign':
			switch (failure.reason) {
				case 'canceled':
					return isIos ? t('submit.failure.canceled') : t('submit.failure.canceled.android');
				case 'biometric-unavailable':
					return isIos ? t('submit.failure.biometricUnavailable') : t('submit.failure.biometricUnavailable.android');
				case 'sign-failed':
					return t('submit.failure.signFailed');
				case 'signature-invalid':
					return t('submit.failure.signatureInvalid');
				default: {
					const unreachable: never = failure;
					void unreachable;
					return t('submit.failure.unexpected');
				}
			}
		case 'seal':
			switch (failure.reason) {
				case 'canceled':
					return isIos ? t('submit.failure.canceled') : t('submit.failure.canceled.android');
				case 'biometric-unavailable':
					return isIos ? t('submit.failure.biometricUnavailable') : t('submit.failure.biometricUnavailable.android');
				case 'key-invalidated':
					return isIos ? t('submit.failure.keyInvalidated') : t('submit.failure.keyInvalidated.android');
				case 'no-wrap-key':
				case 'policy-mismatch':
				case 'tag-mismatch':
				case 'malformed':
				case 'native-error':
					return t('submit.failure.sealFailed');
				default: {
					const unreachable: never = failure;
					void unreachable;
					return t('submit.failure.unexpected');
				}
			}
		case 'store':
			switch (failure.reason) {
				case 'already-saved':
					return t('submit.reason.alreadySaved');
				case 'unreadable':
					return t('submit.failure.storeUnreadable');
				case 'invalid-input':
				case 'storage-failed':
					return t('submit.failure.storeFailed');
				default: {
					const unreachable: never = failure;
					void unreachable;
					return t('submit.failure.unexpected');
				}
			}
		default: {
			const unreachable: never = failure;
			void unreachable;
			return t('submit.failure.unexpected');
		}
	}
}

/** The displayed title of the referenced question, else its question code. Never splits an id. */
function questionLabel(ref: VoteQuestionRef, offices: Office[]): string {
	const office = offices.find(o => o.id === ref.officeId);
	return office ? office.title : ref.questionCode;
}

/** Fail-closed stand-in when the eligibility check itself rejects. */
const CHECK_FAILED: VoteEligibility = {
	eligible: false,
	reason: 'election-unavailable',
	questions: [],
	ballotIds: [],
	lifecycleState: null,
};

export default function ReviewSubmitScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() - no inline fixture-module import.
	const {getBallot, getEngine, seededElectionId, nowMs} = useVoterApp();
	const {selectionMap, clearSelections, pruneSelections} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const navigation = useNavigation<ReviewSubmitNavigationProp>();
	// 42-REVIEW IN-01: shared live-guarded fetch-on-mount effect, extracted out of the screen.
	const {ballot, failed} = useBallot(getBallot);
	// null means "checking".
	const [eligibility, setEligibility] = useState<VoteEligibility | null>(null);
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<CastVoteFailure | 'unexpected' | null>(null);
	const inFlight = useRef(false);
	const mounted = useRef(true);

	const offices = ballot?.offices ?? [];

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// WR-01: drop selections the loaded ballot no longer shows (an office or candidate a later
	// revision removed, or another election's choice). The voter cannot see or clear them, so they
	// must neither block Submit nor be signed. Only a loaded ballot prunes; a failed read never does.
	useEffect(() => {
		if (ballot !== null && !failed) {
			pruneSelections(ballot.offices);
		}
	}, [ballot, failed, pruneSelections]);

	useFocusEffect(
		useCallback(() => {
			let live = true;
			setEligibility(null);
			setFailure(null);
			evaluateVoteEligibility({
				getEngine,
				fallbackElectionId: __DEV__ ? seededElectionId : undefined,
				nowMs: nowMs(),
				selectionMap,
			}).then(
				result => {
					if (live) {
						setEligibility(result);
					}
				},
				() => {
					if (live) {
						setEligibility(CHECK_FAILED);
					}
				},
			);
			return () => {
				live = false;
			};
		}, [getEngine, seededElectionId, nowMs, selectionMap]),
	);

	const submitVote = async () => {
		if (eligibility?.eligible !== true || inFlight.current) {
			return;
		}
		inFlight.current = true;
		setPending(true);
		setFailure(null);
		const signPrompt: SecretWrapPrompt = {
			title: t('submit.signPrompt.title'),
			subtitle: t('submit.signPrompt.subtitle'),
			negativeButton: t('submit.signPrompt.negativeButton'),
		};
		const recordPrompt: SecretWrapPrompt = {
			title: t('submit.recordPrompt.title'),
			subtitle: Platform.OS === 'ios' ? t('submit.recordPrompt.subtitle') : t('submit.recordPrompt.subtitle.android'),
			negativeButton: t('submit.recordPrompt.negativeButton'),
		};
		try {
			const result: CastVoteResult = await castVote({
				getEngine,
				fallbackElectionId: __DEV__ ? seededElectionId : undefined,
				nowMs: nowMs(),
				selectionMap,
				signPrompt,
				recordPrompt,
			});
			if (result.ok) {
				clearSelections();
				if (mounted.current) {
					setEligibility(null);
					const {electionId} = result;
					navigation.navigate('VoteReceipt', {electionId, revealOnOpen: true});
				}
			} else if (result.stage === 'ineligible') {
				setEligibility(result.eligibility);
			} else {
				setFailure(result);
			}
		} catch {
			setFailure('unexpected');
		} finally {
			inFlight.current = false;
			if (mounted.current) {
				setPending(false);
			}
		}
	};

	const submitDisabled = !eligibility?.eligible || pending;
	const blanks = offices.filter(o => (selectionMap[o.id]?.length ?? 0) === 0);
	const bodyText = {fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	const captionText = {fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight};

	let failureText: string | null = null;
	if (failure === 'unexpected' || failure?.stage === 'ineligible') {
		failureText = t('submit.failure.unexpected');
	} else if (failure) {
		failureText = castFailureText(failure, t);
	}

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				<View style={styles.rowList}>
					{failed ? (
						<Text
							testID="review-ballot-unavailable"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
							{t('ballotUnavailable')}
						</Text>
					) : null}
					{offices.map(office => {
						const {summary, hasSelection} = resolveSelectionSummary(
							office.id,
							office.candidates,
							selectionMap,
							t,
						);
						return (
							<View
								key={office.id}
								testID={`review-row-${office.id}`}
								style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
								<Text
									style={[
										styles.rowLabel,
										{
											color: colors.textSecondary,
											fontFamily: fonts.regular.fontFamily,
											fontWeight: fonts.regular.fontWeight,
											fontSize: typeScale.caption.fontSize,
											lineHeight: typeScale.caption.lineHeight,
										},
									]}>
									{office.title}
								</Text>
								<Text
									style={[
										styles.rowValue,
										{
											color: hasSelection ? colors.success : colors.textSecondary,
											fontFamily: fonts.regular.fontFamily,
											fontWeight: fonts.regular.fontWeight,
											fontSize: typeScale.body.fontSize,
											lineHeight: typeScale.body.lineHeight,
										},
									]}>
									{summary}
								</Text>
							</View>
						);
					})}
				</View>
				{offices.length > 0 && blanks.length > 0 ? (
					<View testID="review-blank-list" style={styles.block}>
						<Text style={[{color: colors.text}, bodyText]}>{t('submit.blankHeading')}</Text>
						{blanks.map(office => (
							<View key={office.id}>
								<Text testID={`review-blank-${office.id}`} style={[{color: colors.textSecondary}, bodyText]}>
									{office.title}
								</Text>
								{office.required ? (
									<Text testID={`review-blank-required-${office.id}`} style={[{color: colors.error}, captionText]}>
										{t('submit.blankRequiredTag')}
									</Text>
								) : null}
							</View>
						))}
					</View>
				) : null}
				{offices.length > 0 && eligibility?.eligible && blanks.length === offices.length ? (
					<Text testID="review-all-blank" style={[styles.block, {color: colors.text}, bodyText]}>
						{t('submit.allBlank')}
					</Text>
				) : null}
				{eligibility && !eligibility.eligible
					? eligibility.questions.map(ref => (
							<Text
								key={`${ref.ballotId}:${ref.questionCode}`}
								testID={`review-reason-question-${ref.officeId}`}
								style={[styles.block, {color: colors.textSecondary}, bodyText]}>
								{questionLabel(ref, offices)}
							</Text>
						))
					: null}
			</ScrollView>

			<View style={styles.status}>
				{eligibility === null ? (
					<Text testID="review-eligibility-checking" style={[{color: colors.textSecondary}, bodyText]}>
						{t('submit.checking')}
					</Text>
				) : null}
				{eligibility && !eligibility.eligible ? (
					<Text testID="review-ineligible" style={[{color: colors.error}, bodyText]}>
						{ineligibleReasonText(eligibility.reason, t)}
					</Text>
				) : null}
				{eligibility?.eligible && eligibility.replacesStale ? (
					<Text testID="review-stale" style={[{color: colors.text}, bodyText]}>
						{t('submit.staleReplace')}
					</Text>
				) : null}
				{failureText !== null ? (
					<Text testID="review-submit-failure" style={[{color: colors.error}, bodyText]}>
						{failureText}
					</Text>
				) : null}
				<Text testID="review-local-note" style={[{color: colors.textSecondary}, captionText]}>
					{t('submit.localNote')}
				</Text>
			</View>

			<View style={[globalStyles.footerButtonsContainer, styles.footer]}>
				<Pressable
					testID="review-continue"
					disabled={pending}
					onPress={() => navigation.goBack()}
					style={[
						styles.footerButton,
						styles.continueButton,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: colors.primary,
							borderRadius: radii.pill,
						},
					]}>
					<Text style={[styles.footerButtonLabel, {color: colors.primary}]}>{t('continueVotingCta')}</Text>
				</Pressable>
				<Pressable
					testID="review-submit"
					disabled={submitDisabled}
					accessibilityState={{disabled: submitDisabled, busy: pending}}
					onPress={submitVote}
					style={[
						styles.footerButton,
						{backgroundColor: colors.primary, borderRadius: radii.pill},
						submitDisabled ? styles.disabled : null,
					]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>
						{pending ? t('submit.saving') : t('submitCta')}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	scroll: {
		flex: 1,
	},
	scrollContent: {
		flexGrow: 1,
	},
	rowList: {
		marginTop: 8, // sm spacing token
	},
	rowLabel: {},
	rowValue: {
		marginTop: 4, // xs spacing token
	},
	block: {
		marginTop: 12,
	},
	status: {
		marginTop: 12,
		gap: 4,
	},
	disabled: {
		opacity: 0.5,
	},
	footer: {
		marginTop: 24, // lg spacing token
	},
	footerButton: {
		flex: 1,
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	continueButton: {
		borderWidth: 1,
	},
	footerButtonLabel: {
		fontWeight: '600',
	},
});
