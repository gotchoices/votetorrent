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
				<ThemedText type="subtitle" numberOfLines={1}>
					{election.title}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1}>
					{isElectionSummary(election) ? election.authorityName : election.authorityId}
				</ThemedText>
				<ThemedText type="default" numberOfLines={1}>
					{new Date(election.date).toLocaleDateString()}
				</ThemedText>
			</View>
			<FontAwesome6 name="chevron-right" size={16} color={colors.text} style={styles.icon} />
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	card: {
		flexDirection: "row",
		alignItems: "center",
		padding: 12,
		marginVertical: 8,
		marginHorizontal: 4,
		borderRadius: 12,
		shadowColor: "#000",
		shadowOffset: {
			width: 0,
			height: 2,
		},
		shadowOpacity: 0.1,
		shadowRadius: 4,
		elevation: 3,
	},
	cardContent: {
		flex: 1,
		marginLeft: 16,
		marginRight: 8,
		paddingRight: 16,
	},
	icon: {
		marginLeft: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
