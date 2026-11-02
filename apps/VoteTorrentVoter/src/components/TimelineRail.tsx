/**
 * TimelineRail (59-07, D-10/D-11/D-20) — the ten-dot vertical rail: donut/hollow dots, the
 * single connector break point, and the `MM/DD` / "Now" date column. Pure presentational (`rows`
 * + an optional `renderPanel` slot + the same callback set `TimelineRow` defines, forwarded
 * through) — does NOT read the app provider or the navigator hooks, so the whole rail is
 * unit-testable from a fixture with no provider and no navigator mounted (D-10). `TimelineScreen`
 * (59-08) owns the provider read and maps these callbacks to real navigation.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {TimelineRow} from './TimelineRow';
import type {TimelineRowCallbacks} from './TimelineRow';
import {TIMELINE_STAGE_IDS} from '../timeline';
import type {TimelineRow as TimelineRowViewModel, TimelineStageId} from '../timeline';
import {TIMELINE_CARD_MARGIN_V} from './timeline-layout';

const DOT_SIZE = 20;
// D-08: the current row's dot alone renders larger, still centred on the same dotCenterY as every
// other dot (Developer-Ruled Decision #2).
const CURRENT_DOT_SIZE = 24;
const CARD_PADDING = 16; // globalStyles.cardSurface.paddingVertical
const DATE_COLUMN_WIDTH = 64;
const DOT_COLUMN_WIDTH = 44;
const CONNECTOR_LEFT = 21; // half of the 44 dot column minus half of the 2px connector stroke

export interface TimelineRailProps extends TimelineRowCallbacks {
	/** The ordered row view-models from 59-06's `deriveTimeline()`. Must be exactly the ten D-09
	 * stage ids or the rail renders nothing at all (D-03 backstop, below). */
	rows: TimelineRowViewModel[];
	/** Render slot forwarded into each row's `panel` prop -- the seam 59-09 uses to inject the
	 * Registration Ends status panel without editing this file or `TimelineRow.tsx`. */
	renderPanel?: (stageId: TimelineStageId) => React.ReactNode;
	/** Dev instrumentation (D-12/D-14): the `__DEV__` clock-offset control's offset, forwarded to
	 * the Voting Period row's countdown so the rail's "Now" label and the countdown cannot
	 * disagree. Optional, defaults to `0` -- inert in release builds. */
	nowOffsetMs?: number;
}

export function TimelineRail({
	rows,
	renderPanel,
	nowOffsetMs = 0,
	onHelp,
	onSeeDetails,
	onEditRegistration,
	onPreviewBallot,
	onVoteNow,
	onViewSubmission,
	onViewKeyholders,
	onViewResults,
}: TimelineRailProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');

	// D-03 backstop (defence in depth, NOT the product's visible indeterminate behaviour): a
	// seven-key pre-D-08 signed row, or any input that is not exactly the ten expected stage ids,
	// must never produce a partial rail with guessed dots. The VISIBLE indeterminate frame
	// (heading + body + retry) is TimelineScreen's job (59-08) -- a silent `null` here without
	// that screen-level state would be exactly the silence D-03 forbids.
	const stageIdSet = new Set(rows.map(row => row.stageId));
	const isCompleteTenStageRail = rows.length === 10 && TIMELINE_STAGE_IDS.every(id => stageIdSet.has(id));
	if (!isCompleteTenStageRail) {
		if (__DEV__) {
			// eslint-disable-next-line no-console
			console.warn(`TimelineRail: refusing to render a partial rail (${rows.length} row(s) supplied, expected exactly the ten D-09 stage ids).`);
		}
		return null;
	}

	const currentIndex = rows.findIndex(row => row.status === 'current');
	// Degenerate cases (explicit, per the plan's contract): no row is 'current' because every row
	// is past -> whole connector primary; every row is future -> whole connector border. Folded
	// into ONE effective-index formula so the per-dot loop below stays a single comparison.
	const effectiveCurrentIndex = currentIndex !== -1 ? currentIndex : rows.every(row => row.status === 'past') ? rows.length - 1 : -1;

	// UI-SPEC: the Voting Period countdown targets the moment voting CLOSES (tallyingStarts), not
	// the moment it opens. Wired here, once, so TimelineRow never reaches for a neighbour's
	// instant.
	const tallyingStartsRow = rows.find(row => row.stageId === 'tallyingStarts');
	// CR-02: `!= null` admits NaN and values outside the representable Date range, and
	// `toISOString()` throws `RangeError: Invalid time value` on both -- in the component BODY,
	// i.e. during render. That state is reachable: `normalizeInstant` (timeline-core) admits any
	// finite number, the Timeline blob carries no CHECK bounding the instant, and relative-date's
	// `dateParts` try/catch means `deriveTimeline` returns a CONFIDENT result with NaN labels
	// instead of throwing -- so `TimelineScreen`'s own try/catch never fires and the throw escapes
	// on a screen that states it has no ErrorBoundary. Degrade to "no countdown", never to a blank
	// screen (D-03: never blank, never silent). 8.64e15 is the max time value per ECMA-262.
	const MAX_TIME_VALUE_MS = 8.64e15;
	const tallyingInstantMs = tallyingStartsRow?.instantMs;
	const countdownTargetIso =
		typeof tallyingInstantMs === 'number' && Number.isFinite(tallyingInstantMs) && Math.abs(tallyingInstantMs) <= MAX_TIME_VALUE_MS
			? new Date(tallyingInstantMs).toISOString()
			: undefined;

	const dotCenterY = TIMELINE_CARD_MARGIN_V + CARD_PADDING + typeScale.h4.lineHeight / 2;

	return (
		<View testID="timeline-rail">
			{rows.map((row, index) => {
				const isFilledDot = row.status === 'past' || row.status === 'current';
				// D-08: the `current` literal, not `isFilledDot` (which also covers `past`).
				const dotSize = row.status === 'current' ? CURRENT_DOT_SIZE : DOT_SIZE;
				const aboveColor = index <= effectiveCurrentIndex ? colors.primary : colors.border;
				const belowColor = index < effectiveCurrentIndex ? colors.primary : colors.border;
				const dateLabel = row.railLabel.kind === 'now' ? t('rail.now') : row.railLabel.kind === 'date' ? row.railLabel.text : '—';

				return (
					<View key={row.stageId} style={styles.rowContainer}>
						<View style={styles.dateColumn}>
							<Text
								testID={'timeline-rail-label-' + row.stageId}
								style={{
									position: 'absolute',
									top: dotCenterY - typeScale.body.lineHeight / 2,
									right: 8,
									fontFamily: row.railLabel.kind === 'now' ? fonts.bold.fontFamily : fonts.regular.fontFamily,
									fontWeight: row.railLabel.kind === 'now' ? fonts.bold.fontWeight : fonts.regular.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
									color: row.railLabel.kind === 'now' ? colors.primary : colors.textSecondary,
								}}>
								{dateLabel}
							</Text>
						</View>

						<View style={styles.dotColumn}>
							{index > 0 ? (
								<View
									testID={'timeline-rail-connector-' + row.stageId + '-above'}
									style={[styles.connectorSegment, {top: 0, height: dotCenterY, backgroundColor: aboveColor}]}
								/>
							) : null}
							{index < rows.length - 1 ? (
								<View
									testID={'timeline-rail-connector-' + row.stageId + '-below'}
									style={[styles.connectorSegment, {top: dotCenterY, bottom: 0, backgroundColor: belowColor}]}
								/>
							) : null}
							<View
								testID={'timeline-rail-dot-' + row.stageId}
								style={[
									styles.dot,
									{
										top: dotCenterY - dotSize / 2,
										left: (DOT_COLUMN_WIDTH - dotSize) / 2,
										width: dotSize,
										height: dotSize,
										borderRadius: dotSize / 2,
									},
									isFilledDot
										? {borderWidth: 4, borderColor: colors.primary, backgroundColor: colors.card}
										: {borderWidth: 2, borderColor: colors.border, backgroundColor: colors.background},
								]}
							/>
						</View>

						<View style={styles.rowSlot}>
							<TimelineRow
								row={row}
								panel={renderPanel?.(row.stageId)}
								countdownTargetIso={row.stageId === 'votingStarts' ? countdownTargetIso : undefined}
								nowOffsetMs={nowOffsetMs}
								onHelp={onHelp}
								onSeeDetails={onSeeDetails}
								onEditRegistration={onEditRegistration}
								onPreviewBallot={onPreviewBallot}
								onVoteNow={onVoteNow}
								onViewSubmission={onViewSubmission}
								onViewKeyholders={onViewKeyholders}
								onViewResults={onViewResults}
							/>
						</View>
					</View>
				);
			})}
		</View>
	);
}

export default TimelineRail;

const styles = StyleSheet.create({
	rowContainer: {
		flexDirection: 'row',
	},
	dateColumn: {
		width: DATE_COLUMN_WIDTH,
		position: 'relative',
	},
	dotColumn: {
		width: DOT_COLUMN_WIDTH,
		position: 'relative',
	},
	rowSlot: {
		flex: 1,
	},
	connectorSegment: {
		position: 'absolute',
		left: CONNECTOR_LEFT,
		width: 2,
	},
	dot: {
		position: 'absolute',
	},
});
