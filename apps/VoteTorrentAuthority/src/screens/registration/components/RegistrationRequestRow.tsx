import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RegistrationRequestListRow } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import {
	registrationRequestDisplayName,
	resolveRequestRowStatusMeta,
	resolveBridgeLabel,
	resolveRowTimestamps,
} from "../registration-request-display";
import { tintPill, pillStyles } from "./pill";
import { BridgeSourceBadge, BRIDGE_SOURCE_COLOR_KEY, BRIDGE_MARKER_BORDER_WIDTH } from "./BridgeSourceBadge";

export interface RegistrationRequestRowProps {
	row: RegistrationRequestListRow;
	onPress: () => void;
}

/**
 * RegistrationRequestRow — the inbox list row (D-03/D-06 — the phase's
 * headline UI requirement). Renders a display name (or truncated
 * `RequesterKey`/`RequestId`), a tinted status pill, the reserved bridge
 * left border + badge + bridge label, the observed-vs-claimed timestamp
 * pair, and a muted prior-rejection glyph. Owns no state, makes no engine
 * call of its own, and takes NO `canWrite` prop — opening a request is a
 * read, not a write, exactly `RegistrantRow`'s reasoning.
 *
 * Renders identifiers, names, status, both timestamps, and the bridge label
 * only — no request payload field, no `requesterSignature`, no CID.
 */
export function RegistrationRequestRow({ row, onPress }: RegistrationRequestRowProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	// A duplicate-closed request keeps status 'p'; the pill must read closed (UAT 62 test 12).
	const meta = resolveRequestRowStatusMeta(row);
	const isBridge = row.issuerType === "bridge";
	const bridgeLabel = isBridge ? resolveBridgeLabel(row) : undefined;
	const stamps = resolveRowTimestamps(row);

	// This left border is imported from BridgeSourceBadge.tsx (width + color
	// key), not re-declared, so the row's border and the badge cannot drift
	// apart. It is applied IFF `issuerType === 'bridge'` and for NO OTHER
	// REASON — never for a lifecycle status, never for a prior rejection,
	// never for an error state. That reservation is what keeps the
	// triple-purposed `colors.warning` token readable: a bridge-signed
	// *pending* request carries warning on the border (who signed this) AND
	// on the status pill (what stage it is at) simultaneously, and an
	// officer reads them as two independent facts because they differ in
	// position and shape. Any future left border on this row for a
	// non-bridge reason breaks D-03.
	const bridgeMarkerStyle = isBridge
		? { borderLeftWidth: BRIDGE_MARKER_BORDER_WIDTH, borderLeftColor: colors[BRIDGE_SOURCE_COLOR_KEY] }
		: undefined;

	return (
		<TouchableOpacity
			testID={"registration-request-row-" + row.requestId}
			onPress={onPress}
			style={[styles.cardSurface, { backgroundColor: colors.card }, bridgeMarkerStyle]}
		>
			<View style={localStyles.row}>
				<View style={localStyles.leftColumn}>
					<View style={localStyles.headerLine}>
						<ThemedText
							testID={"registration-request-row-name-" + row.requestId}
							type="defaultSemiBold"
							numberOfLines={1}
							style={localStyles.name}
						>
							{registrationRequestDisplayName(row)}
						</ThemedText>
						{meta ? (
							<View
								testID={"registration-request-row-status-" + row.requestId}
								style={[pillStyles.pill, localStyles.headerTrailing, { backgroundColor: tintPill(colors[meta.colorKey]) }]}
							>
								<ThemedText type="smallBold" style={{ color: colors[meta.colorKey] }}>
									{t(meta.labelKey)}
								</ThemedText>
							</View>
						) : (
							// An unknown status code (a future schema revision) must never
							// crash the inbox — render the raw code with no pill instead of
							// throwing on the REGISTRATION_REQUEST_STATUS_META lookup miss.
							<ThemedText type="small" style={[localStyles.headerTrailing, { color: colors.textSecondary }]}>
								{row.status}
							</ThemedText>
						)}
					</View>

					<BridgeSourceBadge
						issuerType={row.issuerType}
						testID={"registration-request-row-bridge-badge-" + row.requestId}
					/>

					{isBridge && bridgeLabel ? (
						<ThemedText
							testID={"registration-request-row-bridge-label-" + row.requestId}
							type="tiny"
							numberOfLines={1}
							style={{ color: colors.textSecondary }}
						>
							{bridgeLabel}
						</ThemedText>
					) : null}

					{/*
					 * The timestamp pair — both values, and neither ever substituted
					 * for the other.
					 *
					 * (a) Why both. `submittedAt` is submitter-chosen — a *claim*
					 * inside the request's own signature, attacker-controlled within
					 * 48-07's skew bound — while `receivedAt` is the authority's own
					 * observation, inside no digest. Three accepted threat
					 * dispositions (T-48-05-09, T-48-07-12, T-48-08-11) accept a
					 * misstated `submittedAt` on the explicit ground that the
					 * reviewing officer can see the divergence. The labels are what
					 * carry that distinction: one is what the requester *claims*, one
					 * is what the authority *observed*. Never render the claim alone,
					 * and never label the claim as though it were an observation.
					 *
					 * (b) Why the claim line is conditional, and why it is muted. It
					 * renders IFF the two differ at the rendered date precision, so
					 * the ordinary (converged) case costs one line and the divergent
					 * case is the *visible* one — the presence of the second line is
					 * itself the marker, matching this phase's absence-is-default
					 * convention (D-02's "Extra Field" badge, D-03's registrant-row
					 * silence). It is `colors.textSecondary` with NO tint, NO pill,
					 * and NO glyph, for the same reason the D-06 prior-rejection flag
					 * below it is muted: the D-03 bridge marking is this row's
					 * headline signal, and `colors.warning` on this row is reserved
					 * EXCLUSIVELY for bridge provenance (T-48-14-03). Do not "improve"
					 * this line to a warning tint, a badge, or an icon.
					 *
					 * `resolveRowTimestamps` is the single pure rule that decides
					 * which values render — do NOT call `formatRequestTimestamp`
					 * directly on `row.submittedAt` anywhere in this file.
					 */}
					<ThemedText
						testID={"registration-request-row-received-at-" + row.requestId}
						type="tiny"
						numberOfLines={1}
						style={{ color: colors.textSecondary }}
					>
						{t("registrationRequestReceivedAtLabel") + " " + stamps.received}
					</ThemedText>
					{stamps.claimed !== undefined ? (
						<ThemedText
							testID={"registration-request-row-claimed-submitted-at-" + row.requestId}
							type="tiny"
							numberOfLines={1}
							style={{ color: colors.textSecondary }}
						>
							{t("registrationRequestClaimedSubmittedAtLabel") + " " + stamps.claimed}
						</ThemedText>
					) : null}

					{row.hasPriorRejections ? (
						// This glyph is deliberately muted, not warning-tinted, so it
						// cannot visually compete with the D-03 bridge marker on the
						// same row (D-06); the full history is one tap away on the
						// approval screen's PriorRejectionsCallout. Do not "improve"
						// this to colors.warning.
						<View
							testID={"registration-request-row-prior-rejected-" + row.requestId}
							style={localStyles.priorRejectedRow}
						>
							<FontAwesome6 name="circle-exclamation" size={12} color={colors.textSecondary} />
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("registrationRequestPreviouslyRejectedFlag")}
							</ThemedText>
						</View>
					) : null}
				</View>
				<FontAwesome6 name="chevron-right" size={16} color={colors.accent} style={localStyles.chevron} />
			</View>
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	// minWidth 0 (RN's default, declared as intent): the column takes the width left after the
	// chevron and never grows past it to fit a long name.
	leftColumn: {
		flex: 1,
		minWidth: 0,
		gap: 4,
	},
	// Yoga defaults flexShrink to 0, so a one-line name measured at the FULL column width and
	// the status pill then hung past the card's right edge over the chevron (360dp, a long
	// "Last, First"). The name gives up width first and ellipsizes; a short name is unchanged.
	name: {
		flexShrink: 1,
		minWidth: 0,
	},
	// The status pill (incl. the duplicate-closed variant) and the raw-status fallback never shrink.
	headerTrailing: {
		flexShrink: 0,
	},
	chevron: {
		flexShrink: 0,
	},
	headerLine: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	priorRejectedRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
