import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import type { ElectionDetails, IElectionEngine } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";
import { ElectionDetailsBlock } from "./components/ElectionDetailsBlock";
import { ChipButton } from "../../components/ChipButton";
import { KeyholderCard } from "./components/KeyholderCard";
import { CustomButton } from "../../components/CustomButton";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";

export default function ElectionDetailsScreen() {
	const { t } = useTranslation();
	const { electionEngine } = useRoute().params as { electionEngine: IElectionEngine };
	const [electionDetails, setElectionDetails] = useState<ElectionDetails | null>(null);
	const [showMore, setShowMore] = useState(false);
	const { colors } = useTheme() as ExtendedTheme;

	useEffect(() => {
		const loadElectionDetails = async () => {
			try {
				if (electionEngine) {
					const details = await electionEngine.getElectionDetails();
					setElectionDetails(details);
				}
			} catch (error) {
				console.error("Error loading election details:", error);
			}
		};

		loadElectionDetails();
	}, [electionEngine]);

	const toggleShowMore = () => {
		setShowMore(!showMore);
	};

	if (!electionDetails) {
		return (
			<View style={styles.container}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<ElectionDetailsBlock electionDetails={electionDetails} />
				<View style={styles.buttonContainer}>
					<ChipButton label={t("preview")} onPress={() => {}} />
				</View>
			</View>

			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("keyholders")}</ThemedText>
				{electionDetails.current.keyholders.map((keyholder) => (
					<KeyholderCard
						key={keyholder.slot.invite.slot.invite.name}
						invitationStatus={keyholder}
						onPress={() => {}}
					/>
				))}
			</View>

			<View style={styles.section}>
				<CustomButton
					title={t("reviseElection")}
					size="thin"
					icon="pencil"
					backgroundColor={colors.accent}
					onPress={() => {}}
				/>
				<CustomButton
					title={t("cloneElection")}
					size="thin"
					icon="copy"
					backgroundColor={colors.accent}
					onPress={() => {}}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("ballotTemplates")}</ThemedText>
				<ThemedText type="small">{t("noAssociatedAuthoritiesHaveTemplates")}</ThemedText>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("pendingBallotTemplates")}</ThemedText>
				<ThemedText type="small">{t("noAssociatedAuthoritiesHaveTemplates")}</ThemedText>
			</View>

			<View style={styles.section}>
				<TouchableOpacity style={styles.moreHeader} onPress={toggleShowMore}>
					<FontAwesome6
						name={showMore ? "chevron-down" : "chevron-right"}
						size={14}
						color={colors.text}
					/>
					<ThemedText type="title">{t("more")}</ThemedText>
				</TouchableOpacity>
				{showMore && <ThemedText type="small">{t("noBallotTemplates")}</ThemedText>}
			</View>

			<View style={styles.section}>
				<CustomButton
					title={t("createBallotTemplate")}
					size="thin"
					icon="plus"
					backgroundColor={colors.accent}
					onPress={() => {}}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	buttonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
	moreHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
