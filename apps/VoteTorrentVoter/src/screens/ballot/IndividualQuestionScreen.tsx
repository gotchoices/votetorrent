/**
 * IndividualQuestionScreen (VOTE-02) — replaces the `PlaceholderModal` at the `IndividualQuestion`
 * route (navigation wiring lands in Plan 07; the route keeps its existing `presentation: 'modal'`
 * + close-X header chrome unchanged — only the rendered component swaps, 42-RESEARCH.md Pitfall 6).
 *
 * Reads `getBallot()` from `useVoterApp()` (SHELL-03/D-06 gate — satisfies
 * `no-inline-mock-imports.test.ts`'s "every screen calls useVoterApp(" rule; also supplies the
 * offices this screen renders) and `currentQuestionIndex`/`selectionMap`/`toggleCandidate`/
 * `goToPreviousQuestion`/`goToNextQuestion` from `useBallotSelection()`. The question
 * position is provider-held state, never a route param (42-RESEARCH.md Pattern 5 — every
 * `ParamList` entry across all 4 tab stacks stays `undefined`).
 *
 * The "Vote for N" heading and Previous/Next controls live in the screen BODY, not the header
 * (Pitfall 6 — React Navigation header `options` are static per-route, they can't reflect a
 * changing `currentQuestionIndex`). Previous is hidden at index 0 (D-06, no wrap-around). Next
 * advances the index, or on the last question calls `navigation.replace('ReviewSubmit')` instead
 * of `navigate()` (RESEARCH Pattern 7 / Assumption A2) so Android hardware-back from Review lands
 * on the Ballot Page, not a re-opened modal at the last question. "Learn about this candidate" is
 * an unconditional link to `CandidateInfo` (VOTE-03).
 */
import React, {useLayoutEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useBallotSelection} from '../../providers/BallotSelectionProvider';
import {CandidateSelector} from '../../components/CandidateSelector';
import {InfoDialog} from '../../components/InfoDialog';
import {globalStyles} from '../../theme/styles';
import {useBallot} from '../../hooks/useBallot';
import type {VoteStackParamList} from '../../navigation/types';

type IndividualQuestionNavigationProp = NativeStackNavigationProp<
	VoteStackParamList,
	'IndividualQuestion'
>;

export default function IndividualQuestionScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline mockData import.
	const {getBallot} = useVoterApp();
	const {
		currentQuestionIndex,
		selectionMap,
		toggleCandidate,
		goToPreviousQuestion,
		goToNextQuestion,
	} = useBallotSelection();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<IndividualQuestionNavigationProp>();
	// 42-REVIEW IN-01: shared live-guarded fetch-on-mount effect, extracted out of the screen.
	const {ballot} = useBallot(getBallot);
	const [candidateInfoVisible, setCandidateInfoVisible] = useState(false);

	const offices = ballot?.offices ?? [];
	const office = offices[currentQuestionIndex];
	// Figma: the modal header shows the current office name, not a generic "Individual Question".
	// setOptions from the screen because the header title must track currentQuestionIndex (Pitfall 6).
	const officeTitle = office ? t(office.titleKey) : '';
	useLayoutEffect(() => {
		if (officeTitle) {
			navigation.setOptions({title: officeTitle});
		}
	}, [navigation, officeTitle]);

	if (!office) {
		// Still loading (or an out-of-range index) — render the bare screen shell, nothing more.
		return <View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]} />;
	}

	const isFirst = currentQuestionIndex === 0;
	const isLast = currentQuestionIndex === offices.length - 1;

	const handleNext = () => {
		if (isLast) {
			// replace(), not navigate() — see class-level doc comment / RESEARCH Assumption A2.
			navigation.replace('ReviewSubmit');
			return;
		}
		// 42-REVIEW WR-01: route through the provider's clamp-safe, functional-update
		// goToNextQuestion(offices) rather than a render-scope-read setCurrentQuestionIndex(...)
		// increment (stale-closure/double-fire footgun).
		goToNextQuestion(offices);
	};

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
				{/* Breadcrumb (Figma): Home › Ballot › {office} — Home to the Vote root, Ballot back
					out of this modal question. */}
				<View style={styles.breadcrumb}>
					<Pressable testID="question-breadcrumb-home" onPress={() => navigation.popToTop()} hitSlop={6}>
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
					<Pressable testID="question-breadcrumb-ballot" onPress={() => navigation.goBack()} hitSlop={6}>
						<Text
							style={[
								styles.crumb,
								{
									color: colors.textSecondary,
									fontSize: typeScale.caption.fontSize,
									lineHeight: typeScale.caption.lineHeight,
								},
							]}>
							{tCommon('breadcrumb.ballot')}
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
						{officeTitle}
					</Text>
				</View>

				<Text
					style={[
						styles.heading,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.h4.fontSize,
							lineHeight: typeScale.h4.lineHeight,
						},
					]}>
					{t('voteForN', {n: office.voteFor})}
				</Text>

				<CandidateSelector
					candidates={office.candidates.map(candidate => ({
						id: candidate.id,
						name: t(candidate.nameKey),
						party: t(candidate.partyKey),
					}))}
					selectedIds={selectionMap[office.id] ?? []}
					voteFor={office.voteFor}
					onToggle={candidateId => toggleCandidate(office.id, candidateId, office.voteFor)}
					learnLabel={t('learnAboutCandidate')}
					onLearnAboutCandidate={() => setCandidateInfoVisible(true)}
				/>
			</ScrollView>

			<View style={styles.footer}>
				{!isFirst && (
					<Pressable
						testID="question-previous"
						onPress={() => goToPreviousQuestion()}
						style={[
							styles.footerButton,
							styles.previousButton,
							{
								backgroundColor: colors.secondaryButtonSurface,
								borderColor: colors.primary,
								borderRadius: radii.pill,
							},
						]}>
						<Text style={[styles.footerButtonLabel, {color: colors.primary}]}>{t('previousCta')}</Text>
					</Pressable>
				)}
				<Pressable
					testID="question-next"
					onPress={handleNext}
					style={[styles.footerButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.footerButtonLabel, {color: colors.light}]}>{t('nextCta')}</Text>
				</Pressable>
			</View>

			<InfoDialog
				visible={candidateInfoVisible}
				title={t('candidateInfo.title')}
				subtitle={t('candidateInfo.subtitle')}
				body={t('candidateInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setCandidateInfoVisible(false)}
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
	heading: {
		marginBottom: 16, // md spacing token
	},
	footer: {
		marginTop: 24, // lg spacing token
		gap: 12,
	},
	footerButton: {
		minHeight: 48,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		paddingVertical: 14,
	},
	previousButton: {
		borderWidth: 1,
	},
	footerButtonLabel: {
		fontWeight: '600',
	},
});
