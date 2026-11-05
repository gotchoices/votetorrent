import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { RegistrationTransparencyStats } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";

/**
 * TransparencyStatsCard — the D-09 counts display.
 *
 * This card is the ENTIRE transparency surface this phase ships: four plain
 * counts (pending / approved / rejected / median time to decision), always
 * visible, non-collapsible. There is deliberately no five-point selector, no
 * upvote/downvote glyph, no numeric quality figure, and no head-to-head or
 * leaderboard-style ordering of requesters or registrants anywhere in this
 * component. `doc/registration.md`'s reputation-style feature is explicitly
 * out of scope for this phase — an implementer must not add one here, and
 * this absence is enforced by the co-located negative-space suite, not by
 * review.
 *
 * Purely presentational: props in, no callbacks, no state. No engine call,
 * no navigation. Imports only a type from `@votetorrent/vote-core`, which
 * erases at build time.
 */

/**
 * A single guard shared by every hostile-input branch below: anything that
 * is not a finite, non-negative `number` is treated identically, whether it
 * arrives as `undefined`, `null`, `NaN`, `Infinity`, or a negative value.
 * Collapsing all of these to one branch is what keeps a raw millisecond
 * count, `"NaN"`, or `"Invalid Date"` from ever reaching the screen — each
 * of those reaching the UI is a D-09 defect, not a display nicety.
 */
function isHostileNumber(value: unknown): boolean {
	return typeof value !== "number" || !Number.isFinite(value) || value < 0;
}

/** Coerces a missing or hostile count to `0` — a `NaN`/negative/missing count is as much a D-09 defect as a hostile median. */
function safeCount(value: number | undefined): number {
	return isHostileNumber(value) ? 0 : (value as number);
}

export type DecisionDurationResult = { kind: "unknown" } | { kind: "duration"; text: string };

/**
 * Formats a decision-latency duration for display. A discriminated result,
 * not a nullable string, so a caller cannot accidentally render `undefined`.
 *
 * Rules, in order:
 * - `undefined`, `null`, a non-`number`, `NaN`, non-finite, or negative ->
 *   `{ kind: "unknown" }`. The UI renders `transparencyStatsMedianTimeUnknown`
 *   for this branch.
 * - `>= 1 day` -> `"{d}d {h}h"`, hours floored, the `{h}h` segment omitted
 *   when the floored hour remainder is `0` (e.g. `"3d"`).
 * - `>= 1 hour` -> `"{h}h {m}m"`, minutes floored, the `{m}m` segment omitted
 *   when the floored minute remainder is `0`.
 * - `>= 1 minute` -> `"{m}m"`.
 * - `>= 0` and under a minute -> `"<1m"`.
 *
 * All arithmetic is `Math.floor` over integer-millisecond constants. Units
 * are non-localized ASCII letters (`d`/`h`/`m`) because the UI-SPEC's
 * Copywriting Contract defines no unit keys for this string — that is
 * spec-conformant, not an oversight; adding unit keys is the i18n plan's
 * territory, not this one's. No locale-aware number/date formatting API and
 * no date library are used: Hermes locale behavior is non-deterministic
 * across devices and this app has already been bitten by locale/bundling
 * divergence between jest and device.
 */
export function formatDecisionDuration(ms: number | undefined): DecisionDurationResult {
	if (isHostileNumber(ms)) return { kind: "unknown" };

	const value = ms as number;
	const MINUTE_MS = 60_000;
	const HOUR_MS = 60 * MINUTE_MS;
	const DAY_MS = 24 * HOUR_MS;

	if (value >= DAY_MS) {
		const days = Math.floor(value / DAY_MS);
		const hours = Math.floor((value % DAY_MS) / HOUR_MS);
		return { kind: "duration", text: hours > 0 ? `${days}d ${hours}h` : `${days}d` };
	}
	if (value >= HOUR_MS) {
		const hours = Math.floor(value / HOUR_MS);
		const minutes = Math.floor((value % HOUR_MS) / MINUTE_MS);
		return { kind: "duration", text: minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h` };
	}
	if (value >= MINUTE_MS) {
		const minutes = Math.floor(value / MINUTE_MS);
		return { kind: "duration", text: `${minutes}m` };
	}
	return { kind: "duration", text: "<1m" };
}

export interface TransparencyStatsCardProps {
	/**
	 * When `undefined` (e.g. still loading), the card still renders — all
	 * three counts as `0` and the median in its unknown branch. The UI-SPEC
	 * requires this card always be visible and non-collapsible, so a loading
	 * state must not remove it from the layout and shift everything below.
	 */
	stats: RegistrationTransparencyStats | undefined;
	testIDPrefix?: string;
}

export function TransparencyStatsCard({ stats, testIDPrefix = "transparency-stats" }: TransparencyStatsCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const medianResult = formatDecisionDuration(stats?.medianTimeToDecisionMs);
	const medianText = medianResult.kind === "duration" ? medianResult.text : t("transparencyStatsMedianTimeUnknown");

	// A single local array, `.map()`'d below, so a fifth tile cannot be
	// added without editing a list the renderer suite counts.
	const tiles: ReadonlyArray<{ id: string; testIDSuffix: string; value: string; captionKey: string }> = [
		{
			id: "pending",
			testIDSuffix: "pending",
			value: String(safeCount(stats?.pending)),
			captionKey: "transparencyStatsPendingLabel",
		},
		{
			id: "approved",
			testIDSuffix: "approved",
			value: String(safeCount(stats?.approved)),
			captionKey: "transparencyStatsApprovedLabel",
		},
		{
			id: "rejected",
			testIDSuffix: "rejected",
			value: String(safeCount(stats?.rejected)),
			captionKey: "transparencyStatsRejectedLabel",
		},
		{
			id: "median",
			testIDSuffix: "median",
			value: medianText,
			captionKey: "transparencyStatsMedianTimeLabel",
		},
	];

	return (
		<View testID={`${testIDPrefix}-card`} style={[styles.cardSurface, { backgroundColor: colors.card }]}>
			<ThemedText type="defaultSemiBold" testID={`${testIDPrefix}-section-title`}>
				{t("transparencyStatsSectionTitle")}
			</ThemedText>
			<View style={localStyles.tileRow}>
				{tiles.map((tile) => (
					<View key={tile.id} testID={`${testIDPrefix}-${tile.testIDSuffix}-tile`} style={localStyles.tile}>
						<ThemedText type="title" testID={`${testIDPrefix}-${tile.testIDSuffix}-value`}>
							{tile.value}
						</ThemedText>
						<ThemedText
							type="small"
							testID={`${testIDPrefix}-${tile.testIDSuffix}-caption`}
							style={{ color: colors.textSecondary }}
						>
							{t(tile.captionKey)}
						</ThemedText>
					</View>
				))}
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	tileRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 12,
		marginTop: 8,
	},
	tile: {
		minWidth: 0,
	},
});

const styles = { ...globalStyles, ...localStyles };
