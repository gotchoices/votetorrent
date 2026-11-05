/**
 * BallotScreen — the real Ballot Page (VOTE-01/VOTE-03), pushed within the Vote stack (D-08
 * topology; not its own tab). Reads through `useVoterApp()` (D-06/SHELL-03) for `getElection()` /
 * `getBallot()` and through `useBallotSelection()` (Phase 42 Pattern 1/4/5) for `selectionMap` /
 * `setCurrentQuestionIndex`.
 *
 * Layout matches the Figma Ballot frame (2764:1181): the native header title is set to the election
 * name, a "Home › Ballot" breadcrumb sits at the top of the scroll, a full-width "Continue Voting"
 * CTA jumps to the first unanswered question, a green progress bar + "N/M questions completed"
 * label follows, then offices in one section per published `Question.group` (first-appearance
 * order; an ungrouped section has no header) rendered as `OfficeRow` cards (chevron when
 * unanswered, green check + selection summary when answered). When the ballot cannot be read, or
 * has no questions this app can show, an unavailable message replaces all of that. The footer stacks
 * two full-width buttons: Save & Exit (outline, `popToTop()`) over Review & Submit Ballot (solid).
 */
import React, {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {
	useBallotSelection,
	computeCompletedCount,
	resolveSelectionSummary,
} from '../../providers/BallotSelectionProvider';
import {ProgressBar} from '../../components/ProgressBar';
import {OfficeRow} from '../../components/OfficeRow';
import {InfoDialog} from '../../components/InfoDialog';
import {InfoDetails} from '../../components/InfoDetails';
import {readOfficeInfo} from '../../engines/info-read';
import {useInfoRead} from '../../hooks/useInfoRead';
import {globalStyles} from '../../theme/styles';
import {useBallot} from '../../hooks/useBallot';
import type {VoteStackParamList} from '../../navigation/types';
import type {Office, VoterElection} from '../../providers/types';

type BallotNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Ballot'>;

export default function BallotScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {getElection, getBallot, getEngine, seededElectionId} = useVoterApp();
	const {selectionMap, setCurrentQuestionIndex} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<BallotNavigationProp>();
	// 42-REVIEW IN-01: shared live-guarded fetch-on-mount effect, extracted out of the screen.
	const {ballot, failed} = useBallot(getBallot);
	const [election, setElection] = useState<VoterElection | null>(null);
	// The office whose "Learn about this office" dialog is open, or null when it is closed.
	const [officeInfoId, setOfficeInfoId] = useState<string | null>(null);
	const loadOfficeInfo = useCallback(
		() =>
			officeInfoId === null
				? Promise.reject(new Error('no office selected'))
				: readOfficeInfo({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}, officeInfoId),
		[getEngine, seededElectionId, officeInfoId],
	);
	const officeInfo = useInfoRead(officeInfoId === null ? null : loadOfficeInfo);

	// Fetch the election once so the native header can read its title (Figma: the header shows the
	// election name, not a generic "Ballot" label).
	useEffect(() => {
		let live = true;
		// The title is cosmetic here — a failed read leaves the navigator's default header title.
		getElection().then(
			result => {
				if (live) {
					setElection(result);
				}
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [getElection]);

	useLayoutEffect(() => {
		if (election?.title) {
			navigation.setOptions({title: election.title});
		}
	}, [navigation, election?.title]);

	const offices = ballot?.offices ?? [];
	const unavailable = failed || (ballot !== null && offices.length === 0);
	// Sections in first-appearance order of `group` — `offices` is already sorted by group
	// (election-read.ts), so each section's rows stay contiguous in the flat index space.
	const groups = [...new Set(offices.map(office => office.group))];
	// D-04: derived every render from selectionMap, never a stored counter.
	const {completed, total} = computeCompletedCount(offices, selectionMap);
	const progress = total > 0 ? completed / total : 0;

	// Continue Voting jumps to the first unanswered office (or the first office if all answered).
	const onContinueVoting = () => {
		const firstUnanswered = offices.findIndex(office => !(selectionMap[office.id]?.length));
		setCurrentQuestionIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
		navigation.navigate('IndividualQuestion');
	};

	const renderOfficeSection = (group: Office['group']) =>
		offices
			.filter(office => office.group === group)
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
						title={office.title}
						selectionSummary={summary}
						hasSelection={hasSelection}
						learnLabel={t('learnAboutOffice')}
						onOpen={() => {
							// Pattern 5: set the flat index BEFORE navigating — currentQuestionIndex
							// lives on BallotSelectionProvider, not a route param.
							setCurrentQuestionIndex(offices.indexOf(office));
							navigation.navigate('IndividualQuestion');
						}}
						onLearnAboutOffice={() => setOfficeInfoId(office.id)}
					/>
				);
			});

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				{/* Breadcrumb (Figma): Home › Ballot — Home returns to the Vote stack root. */}
				<View style={styles.breadcrumb}>
					<Pressable testID="ballot-breadcrumb-home" onPress={() => navigation.popToTop()} hitSlop={6}>
						<Text
							style={[
								styles.crumb,
								{
									color: colors.textSecondary,
									fontSize: typeScale.caption.fontSize,
									lineHeight: typeScale.caption.lineHeight,
								},
							]}>
							{tCommon('breadcrumb.home')}
						</Text>
					</Pressable>
					<FontAwesome6 name="chevron-right" size={10} color={colors.textSecondary} />
					<Text
						style={[
							styles.crumb,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.caption.fontSize,
								lineHeight: typeScale.caption.lineHeight,
							},
						]}>
						{tCommon('breadcrumb.ballot')}
					</Text>
				</View>

				{unavailable ? (
					<Text
						testID="ballot-unavailable"
						style={[
							styles.notice,
							{
								color: colors.textSecondary,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{t('ballotUnavailable')}
					</Text>
				) : (
					<>
						<Pressable
							testID="ballot-continue-voting"
							onPress={onContinueVoting}
							style={[styles.continueCta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text
								style={[
									styles.continueLabel,
									{
										color: colors.light,
										fontFamily: fonts.medium.fontFamily,
										fontWeight: fonts.medium.fontWeight,
										fontSize: typeScale.body.fontSize,
									},
								]}>
								{t('continueVotingCta')}
							</Text>
						</Pressable>

						<View style={styles.progressSection}>
							<ProgressBar progress={progress} />
							<Text
								style={[
									styles.progressLabel,
									{
										color: colors.textSecondary,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{t('progressLabel', {completed, total})}
							</Text>
						</View>

						{ballot && ballot.unsupportedQuestionCount > 0 ? (
							<Text
								testID="ballot-unsupported-notice"
								style={[
									styles.notice,
									{
										color: colors.textSecondary,
										fontSize: typeScale.caption.fontSize,
										lineHeight: typeScale.caption.lineHeight,
									},
								]}>
								{t('unsupportedQuestions', {count: ballot.unsupportedQuestionCount})}
							</Text>
						) : null}

						{groups.map(group => (
							<View key={group ?? ''} style={globalStyles.section}>
								{group ? (
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
										{group}
									</Text>
								) : null}
								<View style={styles.officeList}>{renderOfficeSection(group)}</View>
							</View>
						))}

						{/* D-07: Save & Exit + Review & Submit, stacked full-width at the END of the page
							content (Figma) — scrolls with the ballot, not a fixed footer bar. */}
						<View style={styles.footer}>
							<Pressable
								testID="ballot-save-exit"
								onPress={() => navigation.popToTop()}
								style={[
									styles.footerButton,
									styles.saveExitButton,
									{
										backgroundColor: colors.secondaryButtonSurface,
										borderColor: colors.primary,
										borderRadius: radii.pill,
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
					</>
				)}
			</ScrollView>

			<InfoDialog
				visible={officeInfoId !== null}
				title={t('officeInfo.title')}
				subtitle={t('officeInfo.subtitle')}
				body={t('officeInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setOfficeInfoId(null)}>
				<InfoDetails
					testID="office-info-details"
					loading={officeInfo.loading}
					failed={officeInfo.failed}
					unavailableLabel={tCommon('info.unavailable')}
					rows={[
						{label: t('officeInfo.instructions'), value: officeInfo.data?.instructions},
						{
							label: t('officeInfo.voteFor'),
							value: officeInfo.data ? t('officeInfo.voteForValue', {count: officeInfo.data.voteFor}) : undefined,
						},
					]}
				/>
			</InfoDialog>
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
	breadcrumb: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
		marginBottom: 16,
	},
	crumb: {},
	continueCta: {
		minHeight: 48,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 14,
	},
	continueLabel: {
		textAlign: 'center',
	},
	progressSection: {
		gap: 8, // sm spacing token
		marginTop: 20,
	},
	progressLabel: {},
	notice: {
		marginTop: 16,
	},
	sectionTitle: {
		marginBottom: 16,
	},
	officeList: {
		gap: 12,
	},
	footer: {
		gap: 12,
		marginTop: 8,
		paddingBottom: 16,
	},
	footerButton: {
		minHeight: 48,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 14,
	},
	saveExitButton: {
		borderWidth: 1,
	},
	footerButtonLabel: {
		fontWeight: '600',
	},
});
