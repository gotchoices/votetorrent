import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import type { ElectionCoreInit, ElectionSummary } from "@votetorrent/vote-core";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../../theme/styles";

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

export function ElectionCard({ election, onPress }: ElectionCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: colors.card }]}>
			<View style={styles.cardContent}>
				<ThemedText type="cardTitle" numberOfLines={1}>
					{election.title}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1}>
					{isElectionSummary(election) ? election.authorityName : election.authorityId}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1}>
					{new Date(election.date).toLocaleDateString()}
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
