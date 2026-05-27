import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { ExtendedTheme, useRoute, useTheme, useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import type { ElectionDetails, IElectionEngine } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";
import { ElectionDetailsBlock } from "./components/ElectionDetailsBlock";
import { ChipButton } from "../../components/ChipButton";
import { KeyholderCard } from "./components/KeyholderCard";
import { CustomButton } from "../../components/CustomButton";
import { Timeline } from "./components/Timeline";
import { formatDate } from "../../utils/displayUtils";
import type { NavigationProp } from "../../navigation/types";

/**
 * ElectionDetailsScreen — timeline-focal stacked layout per Phase 9 D-07.
 *
 * Order (top → bottom):
 *   1. Header (title + metadata via ElectionDetailsBlock)
 *   2. Timeline (vertical, 5 milestones with status dots) — focal section
 *   3. Keyholders (compact list)
 *   4. Tags (chip row)
 *   5. Revision deadline (callout)
 *   6. Revise / Clone actions
 *   7. Ballot templates list — replaced by CreateBallot empty-state action
 *      per D-09 when no ballot is attached.
 */
export default function ElectionDetailsScreen() {
	const { t } = useTranslation();
	const { electionEngine } = useRoute().params as { electionEngine: IElectionEngine };
	const [electionDetails, setElectionDetails] = useState<ElectionDetails | null>(null);
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();

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

	if (!electionDetails) {
		return (
			<View style={styles.container}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	return (
		<ScrollView style={styles.container}>
			{/* Header + immutable metadata */}
			<View style={styles.section}>
				<ElectionDetailsBlock electionDetails={electionDetails} />
			</View>

			{/* Timeline — focal section per D-07 */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("timeline")}</ThemedText>
				<Timeline electionDetails={electionDetails} />
			</View>

			{/* Keyholders */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("keyholders")}</ThemedText>
				{electionDetails.current.keyholders.map((keyholder, index) => (
					<KeyholderCard
						key={keyholder.invite?.name ?? `keyholder-${index}`}
						invitationStatus={keyholder}
						onPress={() => {}}
					/>
				))}
			</View>

			{/* Tags chip row */}
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold">{t("tags")}</ThemedText>
				<View style={styles.tagRow}>
					{electionDetails.current.tags.map((tag) => (
						<ChipButton key={tag} label={tag} />
					))}
				</View>
			</View>

			{/* Revision deadline callout */}
			<View style={[styles.section, styles.calloutBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
				<ThemedText type="defaultSemiBold">{t("revisionDeadline")}</ThemedText>
				<ThemedText>{formatDate(electionDetails.election.revisionDeadline)}</ThemedText>
			</View>

			{/* Revise / Clone actions */}
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

			{/* Create-ballot empty-state action — D-09 entry point to CreateBallot
			    route. Route is registered by Plan 09-04; verify-time the call must
			    exist with electionId param. */}
			<View style={styles.section}>
				<ThemedText type="title">{t("ballotTemplates")}</ThemedText>
				<ThemedText type="small">{t("noBallotYet")}</ThemedText>
				<CustomButton
					title={t("createBallot")}
					size="thin"
					icon="plus"
					backgroundColor={colors.accent}
					onPress={() =>
						navigation.navigate("CreateBallot", {
							electionId: electionDetails.election.id,
						})
					}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	tagRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 8,
	},
	calloutBox: {
		padding: 12,
		borderRadius: 8,
		borderWidth: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
