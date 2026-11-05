/**
 * ElectionCard (HOME-01/02/03) — the single presentational card that reshapes its body + action
 * across all 7 `LifecycleState` values, driven by the `STATE_DISPLAY` lookup map (40-RESEARCH.md
 * Pattern 1) rather than a long switch embedded in JSX.
 *
 * Pure presentational (`election: VoterElection` prop + optional navigation CALLBACK props) — does
 * NOT call `useVoterApp()` or `useNavigation()` (RESEARCH.md Anti-Patterns / SHELL-03 spirit), so
 * every state is unit-testable directly with a fixture election, no provider/navigator required.
 * The saved-vote notice (D-12) arrives from a prop too, read by the screen from the marker, never here.
 * `HomeScreen` owns the provider read and maps these callbacks to real navigation. The `__DEV__`
 * shared-clock offset (D-02) likewise arrives by the `nowOffsetMs` prop, matching `CountdownTimer`.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';
import type {LifecycleState, VoterElection} from '../providers/types';
import {CountdownTimer} from './CountdownTimer';
import {ProgressBar} from './ProgressBar';
import {SavedVoteNotice} from './SavedVoteNotice';
import type {SavedVoteStatus} from '../engines/saved-vote-status';

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

/**
 * States whose summary copy interpolates counts or a certification that have no engine source
 * yet. A real read leaves those fields absent, so the card falls back to copy that states only
 * what is known — never "undefined/5" and never an implied "0 released". The `__DEV__` review
 * fixture fills the fields, so the counted copy is still reviewable.
 */
const SUMMARY_FALLBACK: Partial<Record<LifecycleState, {isKnown: (election: VoterElection) => boolean; summaryKey: string}>> = {
	ReleasingKeys: {
		isKnown: election => election.keysReleased !== undefined && election.keysTotal !== undefined,
		summaryKey: 'states.releasingKeys.pendingSummary',
	},
	Validation: {
		isKnown: election => election.checksComplete !== undefined && election.checksTotal !== undefined,
		summaryKey: 'states.validation.pendingSummary',
	},
	ValidationDetails: {
		isKnown: election => election.checksComplete !== undefined && election.checksTotal !== undefined,
		summaryKey: 'states.validation.pendingSummary',
	},
	Complete: {
		isKnown: election => election.certified === true,
		summaryKey: 'states.complete.closedSummary',
	},
};

export interface ElectionCardProps {
	election: VoterElection;
	onVoteNow?: () => void;
	onViewValidationDetails?: () => void;
	onLearnAboutElection?: () => void;
	/**
	 * The saved-vote status the screen read from the marker (D-19). The card never reads it itself.
	 */
	savedVote?: SavedVoteStatus;
	/** Opens the saved-vote receipt. The link renders only when this is supplied. */
	onViewSavedVote?: () => void;
	/**
	 * The `__DEV__` shared-clock offset (D-02), passed by the screen and never read from a provider.
	 * 0 by default.
	 */
	nowOffsetMs?: number;
}

export function ElectionCard({election, onVoteNow, onViewValidationDetails, onLearnAboutElection, savedVote, onViewSavedVote, nowOffsetMs = 0}: ElectionCardProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('home');

	const display = STATE_DISPLAY[election.lifecycleState];
	const savedState = savedVote?.state ?? 'none';
	// Mirrors the 63-08 guard (D-20 convenience): a saved, sent or unreadable vote hides Vote now, and a
	// stale one offers it again (D-21). The guard inside the submit path is the enforcement.
	const voteBlocked = savedState === 'saved' || savedState === 'sent' || savedState === 'unreadable';
	const fallback = SUMMARY_FALLBACK[election.lifecycleState];
	const summaryKey = fallback && !fallback.isKnown(election) ? fallback.summaryKey : display.summaryKey;
	// No engine source for turnout yet: the bar renders only when a progress value exists.
	const showProgress = display.showProgress && election.progress !== undefined;
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
					{t(summaryKey, {
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
					<CountdownTimer targetIso={election.countdownTarget} nowOffsetMs={nowOffsetMs} />
				</View>
			) : null}

			{showProgress ? (
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

			{savedVote && savedState !== 'none' ? (
				<View style={styles.savedVote}>
					<SavedVoteNotice status={savedVote} onView={onViewSavedVote} testID="election-card-saved-vote" />
				</View>
			) : null}

			{display.showAction === 'vote' && !voteBlocked ? (
				<Pressable
					testID="election-card-vote-now"
					onPress={onVoteNow}
					style={[styles.actionButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.actionLabel, {color: colors.light}]}>{t('voteNowCta')}</Text>
				</Pressable>
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
	// D-11 deliberate divergence: this wrapper stays intentionally left-aligned (no alignItems),
	// unlike TimelineRow's countdown wrapper, which centres. The two must not be reconciled.
	// (The values are no longer the same either: 61-08's C1 moved TimelineRow's to marginTop 24
	// while Home's stays 16. The contract is the ALIGNMENT, not the spacing.)
	countdown: {
		marginTop: 16, // md-ish spacing, matches card padding rhythm
	},
	progress: {
		marginTop: 16,
	},
	savedVote: {
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
