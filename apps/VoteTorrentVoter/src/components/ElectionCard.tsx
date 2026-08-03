/**
 * ElectionCard (HOME-01/02/03) — the single presentational card that reshapes its body + action
 * across all 7 `LifecycleState` values, driven by the `STATE_DISPLAY` lookup map (40-RESEARCH.md
 * Pattern 1) rather than a long switch embedded in JSX.
 *
 * Pure presentational (`election: MockElection` prop + optional navigation CALLBACK props) — does
 * NOT call `useVoterApp()` or `useNavigation()` (RESEARCH.md Anti-Patterns / SHELL-03 spirit), so
 * every state is unit-testable directly with a fixture election, no provider/navigator required.
 * `HomeScreen` owns the provider read and maps these callbacks to real navigation.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';
import type {LifecycleState, MockElection} from '../providers/types';
import {CountdownTimer} from './CountdownTimer';
import {ProgressBar} from './ProgressBar';

type IconColorRole = 'muted' | 'success' | 'primary';

interface StateDisplay {
	showCountdown: boolean;
	showProgress: boolean;
	showAction: 'vote' | 'validationDetails' | null;
	summaryKey: string;
	/** FontAwesome6 glyph name, or null for the Open state (no icon — countdown/progress/CTA already carry it). */
	icon: string | null;
	iconColorRole: IconColorRole | null;
}

// D-07: only Open and ValidationDetails render an action; D-10: only Open renders the progress
// bar; D-09: countdown hidden on ReviewSelections/ValidationDetails/Complete (Assumption A3).
// SC2: ReleasingKeys (lock/muted) vs Validation (lock-open/success) — distinct glyph AND color.
const STATE_DISPLAY: Record<LifecycleState, StateDisplay> = {
	Upcoming: {
		showCountdown: true,
		showProgress: false,
		showAction: null,
		summaryKey: 'states.upcoming.summary',
		icon: 'clock',
		iconColorRole: 'muted',
	},
	Open: {
		showCountdown: true,
		showProgress: true,
		showAction: 'vote',
		summaryKey: 'states.open.summary',
		icon: null,
		iconColorRole: null,
	},
	ReviewSelections: {
		showCountdown: false,
		showProgress: false,
		showAction: null,
		summaryKey: 'states.reviewSelections.summary',
		icon: 'list-check',
		iconColorRole: 'muted',
	},
	ReleasingKeys: {
		showCountdown: true,
		showProgress: false,
		showAction: null,
		summaryKey: 'states.releasingKeys.summary',
		icon: 'lock',
		iconColorRole: 'muted',
	},
	Validation: {
		showCountdown: true,
		showProgress: false,
		showAction: null,
		summaryKey: 'states.validation.summary',
		icon: 'lock-open',
		iconColorRole: 'success',
	},
	ValidationDetails: {
		showCountdown: false,
		showProgress: false,
		showAction: 'validationDetails',
		summaryKey: 'states.validationDetails.summary',
		icon: 'magnifying-glass-chart',
		iconColorRole: 'primary',
	},
	Complete: {
		showCountdown: false,
		showProgress: false,
		showAction: null,
		summaryKey: 'states.complete.summary',
		icon: 'circle-check',
		iconColorRole: 'success',
	},
};

export interface ElectionCardProps {
	election: MockElection;
	onVoteNow?: () => void;
	onViewValidationDetails?: () => void;
	onLearnAboutElection?: () => void;
	hasVoted?: boolean;
}

export function ElectionCard({election, onVoteNow, onViewValidationDetails, onLearnAboutElection, hasVoted}: ElectionCardProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');

	const display = STATE_DISPLAY[election.lifecycleState];
	const percent = Math.round((election.progress ?? 0) * 100);

	return (
		<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
			<Text
				style={[
					styles.title,
					{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h2.fontSize,
						lineHeight: typeScale.h2.lineHeight,
					},
				]}>
				{election.title}
			</Text>

			{/* Figma: "Learn about this election" sits directly beneath the election title. */}
			{display.showAction === 'vote' ? (
				<Pressable
					testID="election-card-learn-link"
					onPress={onLearnAboutElection}
					style={styles.learnLink}>
					<Text
						style={[
							styles.learnLinkText,
							{color: colors.link, fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight},
						]}>
						{t('learnAboutElection')}
					</Text>
				</Pressable>
			) : null}

			<View style={styles.summaryRow}>
				{display.icon ? (
					<FontAwesome6
						name={display.icon}
						size={16}
						color={display.iconColorRole ? colors[display.iconColorRole] : colors.muted}
					/>
				) : null}
				<Text
					testID="election-card-summary"
					style={[
						styles.summary,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t(display.summaryKey, {
						released: election.keysReleased,
						total: election.keysTotal,
						checksComplete: election.checksComplete,
						checksTotal: election.checksTotal,
						percent,
					})}
				</Text>
			</View>

			{display.showCountdown && election.countdownTarget ? (
				<View style={styles.countdown}>
					<CountdownTimer targetIso={election.countdownTarget} />
				</View>
			) : null}

			{display.showProgress ? (
				<View style={styles.progress}>
					<Text
						style={[
							styles.progressLabel,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{t('progressLabel', {percent})}
					</Text>
					<ProgressBar progress={election.progress ?? 0} />
				</View>
			) : null}

			{display.showAction === 'vote' ? (
				hasVoted ? (
					<View
						testID="election-card-voted"
						style={[styles.actionButton, styles.actionButtonOutline, {backgroundColor: colors.secondaryButtonSurface, borderColor: colors.muted, borderRadius: radii.pill}]}>
						<Text style={[styles.actionLabel, {color: colors.muted}]}>{t('votedCta')}</Text>
					</View>
				) : (
					<Pressable
						testID="election-card-vote-now"
						onPress={onVoteNow}
						style={[styles.actionButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
						<Text style={[styles.actionLabel, {color: colors.light}]}>{t('voteNowCta')}</Text>
					</Pressable>
				)
			) : null}

			{display.showAction === 'validationDetails' ? (
				<Pressable
					testID="election-card-view-validation-details"
					onPress={onViewValidationDetails}
					style={[
						styles.actionButton,
						styles.actionButtonOutline,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: colors.primary,
							borderRadius: radii.pill,
						},
					]}>
					<Text style={[styles.actionLabel, {color: colors.primary}]}>{t('states.validationDetails.cta')}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

export default ElectionCard;

const styles = StyleSheet.create({
	title: {
		marginBottom: 8, // sm spacing token
	},
	summaryRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8, // sm spacing token
	},
	summary: {
		flex: 1,
	},
	countdown: {
		marginTop: 16, // md-ish spacing, matches card padding rhythm
	},
	progress: {
		marginTop: 16,
	},
	progressLabel: {
		marginBottom: 8, // sm spacing token
	},
	learnLink: {
		alignSelf: 'flex-start',
		marginTop: 2, // snug under the title (Figma)
		marginBottom: 12,
	},
	learnLinkText: {
		textDecorationLine: 'underline',
	},
	actionButton: {
		marginTop: 16,
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	actionButtonOutline: {
		borderWidth: 1,
	},
	actionLabel: {
		fontWeight: '600',
	},
});
