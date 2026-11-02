/**
 * TimelineRow (59-07, D-10/D-11/D-20) — the speech-bubble card rendered once per lifecycle
 * stage on the Timeline tab's rail. Pure presentational (`row` view-model + optional `panel`
 * slot + optional `countdownTargetIso` + a callback set) — does NOT read the app provider or the
 * navigator hooks (mirrors `ElectionCard.tsx:1-10` / `CountdownTimer.tsx:11-12`), so every one
 * of the ten stages is unit-testable directly from a fixture with no provider and no navigator
 * mounted. `TimelineScreen` (59-08) owns the provider read and maps these callbacks to real
 * navigation.
 *
 * **D-20 convention:** an action renders only when its callback prop is supplied. This lets the
 * screen express state (e.g. "a vote is already saved on this phone") by choosing which callback to
 * pass, without this file learning anything about the domain reason behind that choice. The
 * `view-submission` action id and the `onViewSubmission` prop are internal names for the
 * saved-vote link, which is labelled 'View saved vote'.
 *
 * **Resolving the UI-SPEC's future-row de-emphasis note, explicitly recorded so a later reader
 * does not "fix" it back:** the de-emphasis paragraph says future rows show "only title +
 * subtitle + `?` help", but the same document places "View Keyholders" on the `releasingKeys`
 * row and the mockup draws that row as a future row. De-emphasis is implemented as: a
 * secondary-colored title and no inset `panel` — the row's own `ROW_DISPLAY` action stays
 * visible regardless of status.
 *
 * **`unknown` status** (a settled-neither-way absent instant, `../timeline/types.ts`'s own doc
 * comment) is treated with the SAME de-emphasised treatment as `future` here — that module's
 * header states this is 59-07's contract to implement, not 59-06's.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';
import {CountdownTimer} from './CountdownTimer';
import {TIMELINE_CARD_MARGIN_V} from './timeline-layout';
import type {TimelineRow as TimelineRowViewModel, TimelineRowStatus, TimelineStageId} from '../timeline';

// The notch's own geometry constants (61-06, D-08): the accent bar's split below consumes
// `NOTCH_HEIGHT` and `notchTop` -- the notch's own computed values -- rather than a second,
// independently-guessed pixel pair. Value-preserving: every number the notch renders is
// byte-identical to before (top 21, borders 8/8/8, left -8 on the default theme); only the
// SOURCE of those numbers changed.
const NOTCH_BORDER_W = 8;
const NOTCH_HEIGHT = NOTCH_BORDER_W * 2;

export interface RowDisplay {
	/** Flat dotted `timeline` namespace key -- D-21's one trap: `votingStarts` maps to
	 * `'stage.votingPeriod.title'` (the INTERVAL name), every other stage maps to
	 * `'stage.<id>.title'` (the `ElectionEvent` instant name). Mirrors `stages.ts`'s
	 * `STAGE_TITLE_KEY`, restated here as a literal object (not imported) so this file follows
	 * the same `STATE_DISPLAY`-literal-map convention as `ElectionCard.tsx:37-94`. */
	titleKey: string;
}

// `Record<TimelineStageId, RowDisplay>` makes a missing stage id a COMPILE error -- the
// established anti-inline-JSX-switch pattern (ElectionCard.tsx:37-94, D-20). Exported so the
// i18n-key-resolution test can walk every `titleKey` this component names against both EN/ES
// `timeline` resources (D-11 negative-assertion also walks this key set).
export const ROW_DISPLAY: Record<TimelineStageId, RowDisplay> = {
	registrationEnds: {titleKey: 'stage.registrationEnds.title'},
	ballotsFinal: {titleKey: 'stage.ballotsFinal.title'},
	votingStarts: {titleKey: 'stage.votingPeriod.title'},
	accruingVotes: {titleKey: 'stage.accruingVotes.title'},
	hashingVotes: {titleKey: 'stage.hashingVotes.title'},
	releasingKeys: {titleKey: 'stage.releasingKeys.title'},
	tallyingStarts: {titleKey: 'stage.tallyingStarts.title'},
	validation: {titleKey: 'stage.validation.title'},
	certificationStarts: {titleKey: 'stage.certificationStarts.title'},
	closed: {titleKey: 'stage.closed.title'},
};

type ActionVariant = 'primary' | 'outline' | 'link';

interface ActionDescriptor {
	id: string;
	labelKey: string;
	onPress: () => void;
	variant: ActionVariant;
}

export interface TimelineRowCallbacks {
	onHelp?: (stageId: TimelineStageId) => void;
	onSeeDetails?: (stageId: TimelineStageId) => void;
	onEditRegistration?: () => void;
	onPreviewBallot?: () => void;
	onVoteNow?: () => void;
	onViewSubmission?: () => void;
	onViewKeyholders?: () => void;
	onViewResults?: () => void;
}

export interface TimelineRowProps extends TimelineRowCallbacks {
	row: TimelineRowViewModel;
	/** Render slot for a bespoke per-row panel (e.g. 59-09's Registration Ends status panel).
	 * Rendered only when the row is not de-emphasised (`status` is `'past'` or `'current'`). */
	panel?: React.ReactNode;
	/**
	 * The `tallyingStarts` instant (the moment voting CLOSES), as an ISO string -- NOT this row's
	 * own start instant. Only consumed when `row.stageId === 'votingStarts'` and
	 * `row.status === 'current'`. The rail (59-07 Task 2) computes and supplies this; this
	 * component never reaches for another stage's instant.
	 */
	countdownTargetIso?: string;
	/** Dev instrumentation (D-12/D-14): the `__DEV__` clock-offset control's offset, forwarded to
	 * the countdown so the rail's "Now" label and the countdown cannot disagree. Optional,
	 * defaults to `0` -- inert in release builds. */
	nowOffsetMs?: number;
}

/** Builds the time-conditional action list for one row (CONTEXT `<specifics>` table). Every
 * descriptor is only added when its callback prop was actually supplied (D-20). */
function buildActions(stageId: TimelineStageId, status: TimelineRowStatus, callbacks: TimelineRowCallbacks): ActionDescriptor[] {
	const actions: ActionDescriptor[] = [];

	if (stageId === 'registrationEnds') {
		if (status !== 'past' && callbacks.onEditRegistration) {
			actions.push({id: 'edit-registration', labelKey: 'registration.editCta', onPress: callbacks.onEditRegistration, variant: 'link'});
		}
	}

	if (stageId === 'votingStarts') {
		if (status === 'future') {
			if (callbacks.onPreviewBallot) {
				actions.push({id: 'preview-ballot', labelKey: 'voting.previewBallotCta', onPress: callbacks.onPreviewBallot, variant: 'link'});
			}
		} else if (status === 'current') {
			if (callbacks.onVoteNow) {
				actions.push({id: 'vote-now', labelKey: 'voting.voteNowCta', onPress: callbacks.onVoteNow, variant: 'primary'});
			}
			// A saved vote is linked from the current row too, not only once voting has closed.
			if (callbacks.onViewSubmission) {
				actions.push({id: 'view-submission', labelKey: 'voting.viewSubmissionCta', onPress: callbacks.onViewSubmission, variant: 'link'});
			}
		} else if (status === 'past' && callbacks.onViewSubmission) {
			actions.push({id: 'view-submission', labelKey: 'voting.viewSubmissionCta', onPress: callbacks.onViewSubmission, variant: 'link'});
		}
	}

	// Shown on releasingKeys in ANY status (mockup draws it on a future, hollow-dot row).
	if (stageId === 'releasingKeys' && callbacks.onViewKeyholders) {
		actions.push({id: 'view-keyholders', labelKey: 'keyholders.viewCta', onPress: callbacks.onViewKeyholders, variant: 'outline'});
	}

	// Results: on tallyingStarts once that stage has begun (the keys are released by then, or the screen says how many are).
	if (stageId === 'tallyingStarts' && (status === 'current' || status === 'past') && callbacks.onViewResults) {
		actions.push({id: 'view-results', labelKey: 'results.viewCta', onPress: callbacks.onViewResults, variant: 'outline'});
	}

	// Universal "see details" -- every row, only once its event has passed.
	if (status === 'past' && callbacks.onSeeDetails) {
		const onSeeDetails = callbacks.onSeeDetails;
		actions.push({id: 'see-details', labelKey: 'row.detailsCta', onPress: () => onSeeDetails(stageId), variant: 'link'});
	}

	return actions;
}

export function TimelineRow({row, panel, countdownTargetIso, nowOffsetMs = 0, onHelp, onSeeDetails, onEditRegistration, onPreviewBallot, onVoteNow, onViewSubmission, onViewKeyholders, onViewResults}: TimelineRowProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');

	const {stageId, status, subtitle} = row;
	const display = ROW_DISPLAY[stageId];

	// `unknown` rows get the SAME de-emphasised treatment as `future` (../timeline/types.ts's
	// own doc comment names this as 59-07's contract).
	const isDeemphasized = status === 'future' || status === 'unknown';
	const titleColor = isDeemphasized ? colors.textSecondary : colors.text;
	const helpIconColor = isDeemphasized ? colors.textSecondary : colors.text;
	const showPanel = !isDeemphasized && panel != null;
	// IN-07: the countdown's render gate and its target are the SAME value, so the target narrows
	// to `string` on its own and the render site needs no `as string`. The previous shape was a
	// boolean gate (`... && !!countdownTargetIso`) plus an assertion at the call site, which meant
	// TypeScript was proving nothing there: rewriting this line to drop the `!!countdownTargetIso`
	// clause would have pushed `undefined` into `CountdownTimer.targetIso` with no compile error
	// and no test failure. Keep the gate and the value bound together.
	const countdownIso = stageId === 'votingStarts' && status === 'current' ? countdownTargetIso : undefined;
	// D-08 (Developer-Ruled Decision #2): the left accent bar renders only on the current row.
	// Mutually exclusive with `isDeemphasized` (`'current'` is disjoint from `'future'`/`'unknown'`
	// in the row model), so a de-emphasized row can never render it.
	const isCurrent = status === 'current';

	const actions = buildActions(stageId, status, {
		onSeeDetails,
		onEditRegistration,
		onPreviewBallot,
		onVoteNow,
		onViewSubmission,
		onViewKeyholders,
		onViewResults,
	});

	// Notch vertical position derives from the theme's OWN h4 line height, so it tracks a theme
	// change rather than a guessed pixel value (UI-SPEC's "not an approximation" requirement).
	const cardPaddingTop = 16; // globalStyles.cardSurface.paddingVertical
	const notchTop = cardPaddingTop + typeScale.h4.lineHeight / 2 - NOTCH_HEIGHT / 2;

	return (
		<View style={[globalStyles.cardSurface, styles.card, {backgroundColor: colors.card}]}>
			{/* Left-pointing tail (RN border-triangle technique). `'transparent'` is a color
			    keyword, not a hex literal -- passes the no-hardcoded-hex gate (Task 3). */}
			<View
				testID={'timeline-row-notch-' + stageId}
				style={[
					styles.notch,
					{
						left: -NOTCH_BORDER_W,
						borderTopWidth: NOTCH_BORDER_W,
						borderBottomWidth: NOTCH_BORDER_W,
						borderRightWidth: NOTCH_BORDER_W,
						top: notchTop,
						borderTopColor: 'transparent',
						borderBottomColor: 'transparent',
						borderRightColor: colors.card,
					},
				]}
			/>

			{/* D-08 (Developer-Ruled Decision #2): a 4px colors.primary left accent bar, current row
			    only, split around the notch using the notch's OWN notchTop/NOTCH_HEIGHT values --
			    never a second independently-guessed pixel pair. Mirrors the rail's own existing
			    "above"/"below" connector-segment convention around each dot. */}
			{isCurrent ? (
				<View
					testID={'timeline-row-accent-' + stageId + '-above'}
					style={[styles.accentBar, {top: 0, height: notchTop, backgroundColor: colors.primary, borderTopLeftRadius: radii.lg}]}
				/>
			) : null}
			{isCurrent ? (
				<View
					testID={'timeline-row-accent-' + stageId + '-below'}
					style={[styles.accentBar, {top: notchTop + NOTCH_HEIGHT, bottom: 0, backgroundColor: colors.primary, borderBottomLeftRadius: radii.lg}]}
				/>
			) : null}

			<View style={styles.titleRow}>
				<Text
					testID={'timeline-row-title-' + stageId}
					style={{
						color: titleColor,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.h4.fontSize,
						lineHeight: typeScale.h4.lineHeight,
					}}>
					{t(display.titleKey)}
				</Text>
				<Pressable
					testID={'timeline-row-help-' + stageId}
					accessibilityRole="button"
					accessibilityLabel={t('help.accessibilityLabel', {stage: t(display.titleKey)})}
					hitSlop={14}
					style={styles.helpTarget}
					onPress={() => onHelp?.(stageId)}>
					<FontAwesome6 name="circle-question" size={16} color={helpIconColor} />
				</Pressable>
			</View>

			{subtitle ? (
				<Text
					testID={'timeline-row-subtitle-' + stageId}
					style={{
						color: colors.textSecondary,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					}}>
					{t(subtitle.key, subtitle.params)}
				</Text>
			) : null}

			{showPanel ? <View testID={'timeline-row-panel-' + stageId}>{panel}</View> : null}

			{countdownIso ? (
				<View testID={'timeline-row-countdown-' + stageId} style={styles.countdown}>
					<CountdownTimer targetIso={countdownIso} nowOffsetMs={nowOffsetMs} />
				</View>
			) : null}

			{actions.length > 0 ? (
				<View style={styles.actions}>
					{actions.map(action => (
						<Pressable
							key={action.id}
							testID={'timeline-row-' + action.id + '-' + stageId}
							accessibilityRole="button"
							onPress={action.onPress}
							style={
								action.variant === 'primary'
									? [styles.actionButton, {backgroundColor: colors.primary, borderRadius: radii.pill}]
									: action.variant === 'outline'
										? [
												styles.actionButton,
												styles.actionButtonOutline,
												{backgroundColor: colors.secondaryButtonSurface, borderColor: colors.primary, borderRadius: radii.pill},
											]
										: styles.actionLink
							}>
							<Text
								style={[
									{
										...(action.id === 'see-details' ? fonts.regular : fonts.bold),
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
									action.variant === 'primary'
										? {color: colors.light}
										: action.variant === 'outline'
											? {color: colors.primary}
											: {color: colors.link, textDecorationLine: 'underline' as const},
								]}>
								{t(action.labelKey)}
							</Text>
						</Pressable>
					))}
				</View>
			) : null}
		</View>
	);
}

export default TimelineRow;

const styles = StyleSheet.create({
	card: {
		marginHorizontal: 0,
		marginVertical: TIMELINE_CARD_MARGIN_V,
	},
	notch: {
		position: 'absolute',
		width: 0,
		height: 0,
	},
	// D-08: 4px reuses the existing `xs` spacing token as a width value, not a new arbitrary
	// number. Position/dimensions here; color and per-segment corner radius are supplied inline
	// per-segment above, since only one outer corner of each segment is rounded.
	accentBar: {
		position: 'absolute',
		left: 0,
		width: 4,
	},
	titleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8, // sm spacing token
	},
	helpTarget: {
		minWidth: 44,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
	// D-10/D-11: centres the countdown horizontally on this surface only. `alignItems` -- not
	// `justifyContent` -- because this wrapper has no `flexDirection` and therefore defaults to
	// `column`, whose cross (horizontal) axis is controlled by `alignItems`; `justifyContent` on a
	// column acts on the vertical axis and would be an inert no-op.
	// D-11 deliberate divergence: Home's `ElectionCard` countdown wrapper is intentionally NOT
	// centred (stays left-aligned) and must not be "fixed" to match this one.
	// D-09 addendum (61-08, C1, developer-approved): 16 (md) -> 24 (lg) -- the focal
	// display-size countdown gets more air than an ordinary body-text gap.
	countdown: {
		marginTop: 24,
		alignItems: 'center',
	},
	// D-09 addendum (61-08, C2, developer-approved): marginTop 8 (sm) -> 16 (md), matching the
	// same "one repeated unit instead of two different ones" rhythm fix already applied to the
	// card-gap constant. `gap: 8` between stacked actions is unchanged.
	actions: {
		marginTop: 16,
		gap: 8,
		alignItems: 'flex-start',
	},
	actionButton: {
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	actionButtonOutline: {
		borderWidth: 1,
	},
	actionLink: {
		minHeight: 44,
		// IN-07: `leg_touch_targets` measures BOTH dimensions, and `styles.actions` uses
		// `alignItems: 'flex-start'`, so a link shrinks to its text width. Every current label in EN
		// and ES is comfortably wider than 44dp, but a future short one would trip the gate.
		// Symmetric with `helpTarget`.
		minWidth: 44,
		justifyContent: 'center',
	},
});
