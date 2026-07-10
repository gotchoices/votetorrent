/**
 * BallotScreen — the real Ballot Page (VOTE-01/VOTE-03), pushed within the Vote stack (D-08
 * topology; not its own tab). Reads through `useVotingApp()` (D-06/SHELL-03) for `getBallot()`
 * and through `useBallotSelection()` (Phase 42 Pattern 1/4/5) for `selectionMap` /
 * `setCurrentQuestionIndex`.
 *
 * Renders offices grouped into Federal/State sections (a display-time filter over the flat,
 * order-stable `offices` array — RESEARCH Pattern 3), a live "N/M questions completed" indicator
 * derived from `selectionMap` via `computeCompletedCount` on every render (never a stored
 * counter, D-04), a per-office `OfficeRow` (tap opens Individual Question after setting the flat
 * `currentQuestionIndex`, Pattern 5), an election-level "Learn about this election" link
 * (VOTE-03), and a footer with Save & Exit (`popToTop()`, selections retained, D-07) + Review &
 * Submit (Open Question 2 — both rendered together in the Ballot Page footer).
 */
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVotingApp} from '../../providers/VotingAppProvider';
import {
	useBallotSelection,
	computeCompletedCount,
	resolveSelectionSummary,
} from '../../providers/BallotSelectionProvider';
import {ProgressBar} from '../../components/ProgressBar';
import {OfficeRow} from '../../components/OfficeRow';
import {globalStyles} from '../../theme/styles';
import type {VoteStackParamList} from '../../navigation/types';
import type {MockBallot, Office} from '../../providers/types';

type BallotNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Ballot'>;

export default function BallotScreen() {
	// D-06/SHELL-03: every screen routes through useVotingApp() — no inline mockData import.
	const {getBallot} = useVotingApp();
	const {selectionMap, setCurrentQuestionIndex} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const {t: tHome} = useTranslation('home');
	const navigation = useNavigation<BallotNavigationProp>();
	const [ballot, setBallot] = useState<MockBallot | null>(null);

	// Fetch on mount — mirrors HomeScreen's getElection().then(setElection) async-read-into-state
	// pattern, live-guarded against a post-unmount setState.
	useEffect(() => {
		let live = true;
		getBallot().then(result => {
			if (live) {
				setBallot(result);
			}
		});
		return () => {
			live = false;
		};
	}, [getBallot]);

	const offices = ballot?.offices ?? [];
	// D-04: derived every render from selectionMap, never a stored counter.
	const {completed, total} = computeCompletedCount(offices, selectionMap);
	const progress = total > 0 ? completed / total : 0;

	const renderOfficeSection = (jurisdiction: Office['jurisdiction']) =>
		offices
			.filter(office => office.jurisdiction === jurisdiction)
			.map(office => {
				const {summary, hasSelection} = resolveSelectionSummary(
					office.id,
					office.candidates,
					selectionMap,
					t,
				);
				return (
					<OfficeRow
						key={office.id}
						title={t(office.titleKey)}
						selectionSummary={summary}
						hasSelection={hasSelection}
						learnLabel={t('learnAboutOffice')}
						onOpen={() => {
							// Pattern 5: set the flat index BEFORE navigating — currentQuestionIndex
							// lives on BallotSelectionProvider, not a route param.
							setCurrentQuestionIndex(offices.indexOf(office));
							navigation.navigate('IndividualQuestion');
						}}
						onLearnAboutOffice={() => navigation.navigate('OfficeInfo')}
					/>
				);
			});

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				<View style={styles.progressSection}>
					<Text
						style={[
							styles.progressLabel,
							{
								color: colors.textSecondary,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('progressLabel', {completed, total})}
					</Text>
					<ProgressBar progress={progress} />
				</View>

				{/* VOTE-03: election-level info entry point, unconditional (Open Question 1),
					mirrors ElectionCard's onLearnAboutElection -> navigate('ElectionInfo') callback. */}
				<Pressable
					testID="ballot-learn-election"
					onPress={() => navigation.navigate('ElectionInfo')}
					style={styles.learnLink}>
					<Text
						style={[
							styles.learnLinkText,
							{
								color: colors.link,
								fontSize: typeScale.caption.fontSize,
								lineHeight: typeScale.caption.lineHeight,
							},
						]}>
						{tHome('learnAboutElection')}
					</Text>
				</Pressable>

				<View style={globalStyles.section}>
					<Text
						style={[
							styles.sectionTitle,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('federalSection')}
					</Text>
					<View style={styles.officeList}>{renderOfficeSection('Federal')}</View>
				</View>

				<View style={globalStyles.section}>
					<Text
						style={[
							styles.sectionTitle,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('stateSection')}
					</Text>
					<View style={styles.officeList}>{renderOfficeSection('State')}</View>
				</View>
			</ScrollView>

			{/* D-07: Save & Exit + Review & Submit, side by side (Open Question 2), reusing
				globalStyles.footer's exact elevation/shadow values verbatim (VOTE-01/38 D-16). */}
			<View style={[globalStyles.footer, styles.footerRow, {backgroundColor: colors.card}]}>
				<Pressable
					testID="ballot-save-exit"
					onPress={() => navigation.popToTop()}
					style={[
						styles.footerButton,
						styles.saveExitButton,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: colors.primary,
							borderRadius: radii.md,
						},
					]}>
					<Text style={[styles.footerButtonLabel, {color: colors.primary}]}>{t('saveExitCta')}</Text>
				</Pressable>
				<Pressable
					testID="ballot-review-submit"
					onPress={() => navigation.navigate('ReviewSubmit')}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>{t('reviewCta')}</Text>
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
	progressSection: {
		gap: 8, // sm spacing token
	},
	progressLabel: {
		marginBottom: 4,
	},
	learnLink: {
		alignSelf: 'flex-start',
		marginTop: 16,
		minHeight: 44, // >=44px touch target
		justifyContent: 'center',
	},
	learnLinkText: {
		textDecorationLine: 'underline',
	},
	sectionTitle: {
		marginBottom: 16,
	},
	officeList: {
		gap: 12,
	},
	footerRow: {
		flexDirection: 'row',
		gap: 16,
	},
	footerButton: {
		flex: 1,
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 12,
	},
	saveExitButton: {
		borderWidth: 1,
	},
	footerButtonLabel: {
		fontWeight: '600',
	},
});
