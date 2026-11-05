import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RegistrationRequestIssuerType } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import { resolveBridgeLabel } from "../registration-request-display";
import { tintPill, pillStyles } from "./pill";

/**
 * BridgeSourceBadge.tsx — the D-03 provenance treatments, from ONE file so
 * the two D-03 treatments cannot drift apart (the same reason `pill.ts`
 * exists): the inbox row's `BridgeSourceBadge` pill and the approval
 * screen's `BridgeSourceCallout`, plus the constants they share.
 *
 * A rendering marker is a LEGIBILITY control, not a boundary. What makes the
 * distinction trustworthy is the machine-distinguishable issuer marker at
 * the data layer — `IssuerType`/`BridgeId` plus the schema's
 * `BridgeIdValid` CHECK binding a bridge row to a registered
 * `RegistrationBridgeKey` (48-02/48-07). This file renders that fact; it
 * does not establish it.
 */

/**
 * FontAwesome6 **Free** glyph. `wifi-slash` (a different phase's badge) is
 * Pro-only — that recorded trap means every glyph named in this phase must
 * be confirmed present in the Free set before use. `sitemap` is Free.
 */
export const BRIDGE_SOURCE_ICON = "sitemap";

/**
 * A KEY into `ExtendedTheme["colors"]`, never a resolved color — the same
 * discipline `registration-request-display.ts`'s status ladder uses.
 */
export const BRIDGE_SOURCE_COLOR_KEY = "warning" as const;

/**
 * The shared left-border width used by `BridgeSourceCallout` here and by
 * `RegistrationRequestRow` (Task 3). A 4px `colors.warning` left border on a
 * registration-request surface is RESERVED EXCLUSIVELY for bridge
 * provenance and must never be applied for a lifecycle-status reason — the
 * status pill is a small, top-right, same-row pill and never gets a left
 * border, so a bridge-signed *pending* request legitimately carries warning
 * in two places at once without conflating them.
 */
export const BRIDGE_MARKER_BORDER_WIDTH = 4;

export interface BridgeSourceBadgeProps {
	issuerType: RegistrationRequestIssuerType;
	testID?: string;
}

/**
 * The row-level D-03 pill. Renders `null` when `issuerType !== "bridge"`.
 * The render condition is `issuerType === "bridge"` and NOTHING else — never
 * the presence of `bridgeId`, never the presence of `bridgeLabel`. `issuerType`
 * is the only authoritative issuer signal (48-05 pins this on
 * `RegistrantSignatureTask.bridgeLabel` too), so a missing label must never
 * be read as "registrant-submitted".
 */
export function BridgeSourceBadge({ issuerType, testID = "bridge-source-badge" }: BridgeSourceBadgeProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (issuerType !== "bridge") return null;

	const color = colors[BRIDGE_SOURCE_COLOR_KEY];

	return (
		<View testID={testID} style={[pillStyles.pill, { backgroundColor: tintPill(color) }]}>
			<FontAwesome6 name={BRIDGE_SOURCE_ICON} size={12} color={color} />
			<ThemedText type="smallBold" style={{ color }}>
				{t("bridgeSourceBadgeLabel")}
			</ThemedText>
		</View>
	);
}

export interface BridgeSourceCalloutProps {
	issuerType: RegistrationRequestIssuerType;
	bridgeLabel?: string;
	bridgeId?: string;
	testID?: string;
}

/**
 * The approval screen's D-03 callout. Renders `null` when
 * `issuerType !== "bridge"` — nothing, not a muted or neutral variant
 * (absence-is-default, same rule as the badge).
 */
export function BridgeSourceCallout({
	issuerType,
	bridgeLabel,
	bridgeId,
	testID = "bridge-source-callout",
}: BridgeSourceCalloutProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (issuerType !== "bridge") return null;

	const color = colors[BRIDGE_SOURCE_COLOR_KEY];

	// The interpolated bridgeLabel resolves through resolveBridgeLabel,
	// falling back to bridgeSourceBadgeLabel when it returns undefined — so
	// the sentence never renders as "signed by undefined". No new i18n key is
	// introduced here; 48-03 owns the i18n map and this component consumes
	// only keys that already exist there.
	const resolvedLabel = resolveBridgeLabel({ bridgeLabel, bridgeId }) ?? t("bridgeSourceBadgeLabel");

	return (
		<View
			testID={testID}
			style={[
				styles.cardSurface,
				{
					backgroundColor: colors.card,
					borderLeftWidth: BRIDGE_MARKER_BORDER_WIDTH,
					borderLeftColor: color,
				},
			]}
		>
			<View style={localStyles.headerLine}>
				<FontAwesome6 name={BRIDGE_SOURCE_ICON} size={16} color={color} />
				<ThemedText type="defaultSemiBold">{t("bridgeSourceCalloutHeading")}</ThemedText>
			</View>
			<ThemedText type="default">{t("bridgeSourceCalloutBody", { bridgeLabel: resolvedLabel })}</ThemedText>
		</View>
	);
}

const localStyles = StyleSheet.create({
	headerLine: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
