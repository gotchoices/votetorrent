/**
 * ReviewSubmitScreen (VOTE-04) — a plain-push `ReviewSubmit` route on the Vote stack (navigation
 * wiring lands in Plan 07). Reads `getBallot()`/`setHasVoted` from `useVoterApp()` (SHELL-03/D-06
 * gate) and `selectionMap` from `useBallotSelection()` to render a per-office summary row: office
 * title -> the joined selected candidate name(s), or the localized "Not yet answered" placeholder
 * when the office has no selection (mirrors `BallotScreen.resolveSelectionSummary`).
 *
 * "Continue Voting" is a plain `navigation.goBack()` — returns to whichever screen pushed
 * `ReviewSubmit` (either `Ballot` directly or `IndividualQuestion` via `replace`, 42-RESEARCH.md
 * Pattern 7). "Submit" sets local `submitted` screen state, swapping the summary + footer buttons
 * for an inline mock confirmation (`t('submittedConfirmation')`) — no separate confirmation route
 * exists this phase (RESEARCH Assumption A5). No real signing or persistence is invoked anywhere
 * in this file (D-08 / threat T-42-02, accepted-low).
 *
 * Phase 44-07 (D-02): the mock `setHasVoted(true)` context call is REMOVED (the mock booleans were
 * removed alongside the registration-flow real-engine swap) — `submitted` (already local) is now
 * the sole source of truth for this screen's own confirmation view; `HomeScreen`'s `hasVoted` is
 * separately local, so this deliberately no longer syncs cross-screen (documented simplification —
 * see `HomeScreen.tsx`'s file header comment).
 */
import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useBallotSelection, resolveSelectionSummary} from '../../providers/BallotSelectionProvider';
import {globalStyles} from '../../theme/styles';
import {useBallot} from '../../hooks/useBallot';
import type {VoteStackParamList} from '../../navigation/types';

type ReviewSubmitNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'ReviewSubmit'>;

export default function ReviewSubmitScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	const {getBallot} = useVoterApp();
	const {selectionMap} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const navigation = useNavigation<ReviewSubmitNavigationProp>();
	// 42-REVIEW IN-01: shared live-guarded fetch-on-mount effect, extracted out of the screen.
	const {ballot} = useBallot(getBallot);
	const [submitted, setSubmitted] = useState(false);

	const offices = ballot?.offices ?? [];

	const handleSubmit = () => {
		// No real signing/persistence — a visual mock only (D-08, threat T-42-02).
		setSubmitted(true);
	};

	if (submitted) {
		return (
			<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
				<View testID="review-confirmation" style={styles.confirmation}>
					<Text
						style={[
							styles.confirmationText,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('submittedConfirmation')}
					</Text>
				</View>
			</View>
		);
	}

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				<View style={styles.rowList}>
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
									{t(office.titleKey)}
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
			</ScrollView>

			<View style={[globalStyles.footerButtonsContainer, styles.footer]}>
				<Pressable
					testID="review-continue"
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
					onPress={handleSubmit}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>{t('submitCta')}</Text>
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
	confirmation: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	},
	confirmationText: {
		textAlign: 'center',
	},
});
