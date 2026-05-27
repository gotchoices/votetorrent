import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import type { ElectionCoreInit, ElectionSummary } from "@votetorrent/vote-core";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";

interface ElectionCardProps {
	election: ElectionSummary | ElectionCoreInit;
	onPress?: () => void;
}

// Type guard to check if the election is an ElectionSummary
function isElectionSummary(
	election: ElectionSummary | ElectionCoreInit
): election is ElectionSummary {
	return "authorityName" in election;
}

/**
 * ElectionCard — Figma-parity polish per Phase 9 ELECUI-01 / D-16.
 *
 * Renders three distinct fields in order:
 *   1. Election title (ThemedText type="cardTitle")
 *   2. Authority name (from `authorityName` for ElectionSummary,
 *      fallback to `authorityId` for ElectionCoreInit)
 *   3. Formatted date (routed through `formatDate` so the format matches
 *      the rest of the app — Phase 7 D-13 consistency)
 *
 * All visual surfaces (card background, border, chevron) flow through
 * theme tokens via useTheme() as ExtendedTheme — zero hardcoded hex.
 */
export function ElectionCard({ election, onPress }: ElectionCardProps) {
	const { colors } = useTheme() as ExtendedTheme;

	const title = election.title;
	const authorityName = isElectionSummary(election)
		? election.authorityName
		: election.authorityId;
	const dateLabel = formatDate(election.date);

	return (
		<TouchableOpacity
			onPress={onPress}
			style={[
				styles.card,
				{ backgroundColor: colors.card, borderColor: colors.border },
			]}
		>
			<View style={styles.cardContent}>
				<ThemedText type="cardTitle" numberOfLines={1}>
					{title}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1} style={{ color: colors.textSecondary }}>
					{authorityName}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1} style={{ color: colors.textSecondary }}>
					{dateLabel}
				</ThemedText>
			</View>
			<FontAwesome6 name="chevron-right" size={20} color={colors.text} style={styles.icon} />
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	card: {
		...globalStyles.cardSurface,
		flexDirection: "row",
		alignItems: "center",
		borderWidth: 1,
	},
	cardContent: {
		flex: 1,
		marginRight: 8,
		paddingRight: 8,
	},
	icon: {
		marginLeft: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
