/**
 * BallotScreen — the real Ballot Page (VOTE-01/VOTE-03), pushed within the Vote stack (D-08
 * topology; not its own tab). Reads through `useVoterApp()` (D-06/SHELL-03) for `getElection()` /
 * `getBallot()` and through `useBallotSelection()` (Phase 42 Pattern 1/4/5) for `selectionMap` /
 * `setCurrentQuestionIndex`.
 *
 * Layout matches the Figma Ballot frame (2764:1181): the native header title is set to the election
 * name, a "Home › Ballot" breadcrumb sits at the top of the scroll, a full-width "Continue Voting"
 * CTA jumps to the first unanswered question, a green progress bar + "N/M questions completed"
 * label follows, then offices grouped into Federal / State (UT) sections rendered as `OfficeRow`
 * cards (chevron when unanswered, green check + selection summary when answered). The footer stacks
 * two full-width buttons: Save & Exit (outline, `popToTop()`) over Review & Submit Ballot (solid).
 */
import React, {useEffect, useLayoutEffect, useState} from 'react';
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
import {globalStyles} from '../../theme/styles';
import {useBallot} from '../../hooks/useBallot';
import type {VoteStackParamList} from '../../navigation/types';
import type {MockElection, Office} from '../../providers/types';

type BallotNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Ballot'>;

export default function BallotScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	const {getElection, getBallot} = useVoterApp();
	const {selectionMap, setCurrentQuestionIndex} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<BallotNavigationProp>();
	// 42-REVIEW IN-01: shared live-guarded fetch-on-mount effect, extracted out of the screen.
	const {ballot} = useBallot(getBallot);
	const [election, setElection] = useState<MockElection | null>(null);
	const [officeInfoVisible, setOfficeInfoVisible] = useState(false);

	// Fetch the election once so the native header can read its title (Figma: the header shows the
	// election name, not a generic "Ballot" label).
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

	useLayoutEffect(() => {
		if (election?.title) {
			navigation.setOptions({title: election.title});
		}
	}, [navigation, election?.title]);

	const offices = ballot?.offices ?? [];
	// D-04: derived every render from selectionMap, never a stored counter.
	const {completed, total} = computeCompletedCount(offices, selectionMap);
	const progress = total > 0 ? completed / total : 0;

	// Continue Voting jumps to the first unanswered office (or the first office if all answered).
	const onContinueVoting = () => {
		const firstUnanswered = offices.findIndex(office => !(selectionMap[office.id]?.length));
		setCurrentQuestionIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
		navigation.navigate('IndividualQuestion');
	};

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
						onLearnAboutOffice={() => setOfficeInfoVisible(true)}
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
			</ScrollView>

			<InfoDialog
				visible={officeInfoVisible}
				title={t('officeInfo.title')}
				subtitle={t('officeInfo.subtitle')}
				body={t('officeInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setOfficeInfoVisible(false)}
			/>
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
