import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { globalStyles } from "../theme/styles";

/**
 * PeerTransportStatusCard — Phase 62 Plan 21 (D-31). Replaces the previous, now-deleted peer card
 * component (its name named a development status this file's own copy no longer uses).
 *
 * D-31 deliberately SUPERSEDES the old component's zero-state-prop guarantee, and narrows it to a
 * still-structural form: no prop reaches the border, caveat, heading, icon or button colour, so
 * `counts` can move the NUMERALS but never the card's framing. There is no `disabled`-adjacent or
 * success-adjacent path through which a connection or sync result could turn this card's warning
 * treatment off — the border, caveat, heading and icon are hardcoded, every render, unconditionally.
 *
 * Why this still matters with real counts showing: connectivity in a session is not verification.
 * A successful sync moving real numbers does not license success styling, because the peer-cluster
 * leg is code-complete and unverified on devices until P2P-11 closes (D-23) — a socket opening and
 * bytes moving proves nothing about the correctness or safety of the underlying protocol, only that
 * a session happened to connect this time.
 *
 * The count semantics (`pending`/`synced`/`failed`) come from `attach-peer-sync-binding.ts`'s own
 * doc comment (D-31 planner discretion) — this component only renders the numbers it is given.
 */

const NOOP = () => {};

interface PeerTransportStatusCardProps {
	counts?: { pending: number; synced: number; failed: number };
	disabled?: boolean;
	onTrySync: () => void;
}

export function PeerTransportStatusCard({ counts, disabled = false, onTrySync }: PeerTransportStatusCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<View
			testID="transport-status-card-p2p"
			style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning }]}
		>
			<View style={localStyles.headingRow}>
				<View testID="transport-status-icon-p2p">
					<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} />
				</View>
				<ThemedText type="defaultSemiBold" testID="transport-status-p2p-heading">
					{t("peerSyncCardHeading")}
				</ThemedText>
			</View>

			{/* Unconditional — no surrounding conditional of any kind, in any counts state. */}
			<ThemedText
				type="small"
				style={[localStyles.bodyText, { color: colors.warning }]}
				testID="transport-status-p2p-body"
			>
				{t("peerSyncCardCaveat")}
			</ThemedText>

			{counts !== undefined && (
				<View testID="transport-status-counts-p2p" style={localStyles.countsRow}>
					<ThemedText
						type="small"
						style={{ color: colors.textSecondary }}
						testID="peer-sync-count-pending"
					>
						{t("peerSyncCardPendingLabel", { count: counts.pending })}
					</ThemedText>
					<ThemedText
						type="small"
						style={{ color: counts.synced > 0 ? colors.success : colors.textSecondary }}
						testID="peer-sync-count-synced"
					>
						{t("peerSyncCardSyncedLabel", { count: counts.synced })}
					</ThemedText>
					<ThemedText
						type="small"
						style={{ color: counts.failed > 0 ? colors.error : colors.textSecondary }}
						testID="peer-sync-count-failed"
					>
						{t("peerSyncCardFailedLabel", { count: counts.failed })}
					</ThemedText>
				</View>
			)}

			<View testID="transport-try-peer-sync-p2p" style={localStyles.footer}>
				{/* The accent role is forbidden here so this control can never read as an
				    equally-trusted third option beside the two proven bindings' Sync Now buttons. */}
				<CustomButton
					title={t("peerSyncCardTryButton")}
					backgroundColor={colors.warning}
					forceDarkText
					size="thin"
					disabled={disabled}
					onPress={disabled ? NOOP : onTrySync}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	headingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	bodyText: {
		marginTop: 8,
	},
	countsRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		columnGap: 12,
		marginTop: 8,
	},
	footer: {
		marginTop: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
