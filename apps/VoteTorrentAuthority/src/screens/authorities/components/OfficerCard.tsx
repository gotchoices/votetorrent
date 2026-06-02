import React from "react";
import {
	Image,
	ImageSourcePropType,
	StyleSheet,
	TouchableOpacity,
	View,
} from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { Officer } from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { globalStyles } from "../../../theme/styles";

export interface OfficerCardProps {
	officer: Officer;
	userName?: string;
	image?: ImageSourcePropType;
	/** Invitation id for this proposed officer. Optional — populated by the real
	 *  engine; the row is hidden when absent (Figma frame 14). */
	inviteId?: string;
	status?: { label: string; tone: "accepted" | "pending" | "warning" };
	onPress?: () => void;
	onInvite?: () => void;
	onRemove?: () => void;
}

/**
 * OfficerCard — shared officer-rendering primitive (Phase 8 D-06).
 *
 * Authorities-local: consumed by AuthorityDetailsScreen (current + proposed
 * sections), ProposedAdministrationScreen (08-02), and the invitation screens
 * (08-03). Promotion to global `src/components/` deferred until a non-authority
 * flow (Elections/Users) produces a second consumer (mirrors Phase 7 D-06).
 *
 * Status tone color mapping (D-07):
 *   "accepted" → colors.success
 *   "warning"  → colors.warning
 *   "pending"  → colors.textSecondary (default)
 *
 * Officer name: vote-core's Officer interface has no `name` field — pass the
 * resolved name via the optional `userName` prop (sourced from a User lookup).
 * Falls back to officer.userId when userName is omitted.
 *
 * Permissions: renders bulleted scope list using scopeDescriptions, falling
 * back to the raw scope code when a description is missing (covers the
 * undefined `rnp` entry in vote-core's scopeDescriptions).
 */
export function OfficerCard({
	officer,
	userName,
	image,
	inviteId,
	status,
	onPress,
	onInvite,
	onRemove,
}: OfficerCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const statusColor =
		status?.tone === "accepted"
			? colors.success
			: status?.tone === "warning"
				? colors.warning
				: colors.textSecondary;

	const displayName = userName ?? officer.userId;

	const body = (
		<>
			{image ? <Image source={image} style={styles.officerImage} /> : null}
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
				<ThemedText numberOfLines={1} ellipsizeMode="tail">
					{displayName}
				</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
				<ThemedText style={styles.italicText}>{officer.title}</ThemedText>
			</View>
			{inviteId ? (
				<View style={styles.detail}>
					<ThemedText type="smallBold">{t("inviteId")}: </ThemedText>
					<ThemedText type="small">{inviteId}</ThemedText>
				</View>
			) : null}
			<ThemedText type="defaultSemiBold">{t("permissions")}:</ThemedText>
			<View style={styles.subDetails}>
				{officer.scopes.map((scope) => (
					<View key={scope} style={styles.bulletRow}>
						<ThemedText>{"• "}</ThemedText>
						<ThemedText>{scopeDescriptions[scope] ?? scope}</ThemedText>
					</View>
				))}
			</View>
			{(status || onInvite || onRemove) && (
				<View style={styles.officerStatusRow}>
					{status ? (
						<ThemedText type="defaultSemiBold" style={[styles.statusText, { color: statusColor }]}>
							{status.label}
						</ThemedText>
					) : (
						<View />
					)}
					<View style={styles.officerActions}>
						{onInvite ? (
							<ChipButton
								label={t("invite")}
								icon="share-nodes"
								onPress={onInvite}
							/>
						) : null}
						{onRemove ? (
							<TouchableOpacity
								onPress={onRemove}
								style={[styles.removeButton, { borderColor: colors.error }]}
							>
								<FontAwesome6
									name="xmark"
									size={12}
									color={colors.error}
								/>
							</TouchableOpacity>
						) : null}
					</View>
				</View>
			)}
		</>
	);

	// Frame 14 renders proposed administrators as flat inline entries (no card
	// surface), separated by spacing — unlike the boxed InfoCard elsewhere.
	const outerStyle = styles.officerEntry;

	if (onPress) {
		return (
			<TouchableOpacity onPress={onPress} style={outerStyle}>
				{body}
			</TouchableOpacity>
		);
	}
	return <View style={outerStyle}>{body}</View>;
}

const localStyles = StyleSheet.create({
	officerEntry: {
		marginTop: 16,
		marginHorizontal: 4,
	},
	statusText: {
		flex: 1,
		marginRight: 8,
	},
	officerImage: {
		width: "100%",
		height: 160,
		borderRadius: 8,
		marginBottom: 12,
	},
	detail: {
		flexDirection: "row",
		marginVertical: 1,
	},
	subDetails: {
		marginLeft: 8,
	},
	italicText: {
		fontStyle: "italic",
	},
	bulletRow: {
		flexDirection: "row",
	},
	officerStatusRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 8,
	},
	officerActions: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	removeButton: {
		width: 28,
		height: 28,
		borderRadius: 14,
		borderWidth: 1.5,
		alignItems: "center",
		justifyContent: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };
