import React, { useCallback, useEffect, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { ExtendedTheme, useRoute, useTheme, useNavigation, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import type { BallotSummary, ElectionDetails, IElectionEngine } from "@votetorrent/vote-core";
import { globalStyles } from "../../theme/styles";
import { ElectionDetailsBlock } from "./components/ElectionDetailsBlock";
import { ChipButton } from "../../components/ChipButton";
import { KeyholderCard } from "./components/KeyholderCard";
import { CustomButton } from "../../components/CustomButton";
import { InfoCard } from "../../components/InfoCard";
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
 *   7. Ballot templates list — G2/G12 (09-10): loaded from electionEngine.getBallots()
 *      via useFocusEffect; one card per template when >=1 exists; empty-state
 *      (noBallotYet text + CREATE BALLOT TEMPLATE button) shown only when 0 templates.
 */
export default function ElectionDetailsScreen() {
	const { t } = useTranslation();
	const { electionEngine } = useRoute().params as { electionEngine: IElectionEngine };
	const [electionDetails, setElectionDetails] = useState<ElectionDetails | null>(null);
	const [ballots, setBallots] = useState<BallotSummary[]>([]);
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

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

	// G2/G12: Refresh ballot list on every focus so newly proposed templates appear
	// immediately on return from CreateBallot/EditBallot.
	useFocusEffect(
		useCallback(() => {
			const loadBallots = async () => {
				try {
					if (electionEngine) {
						const summaries = await electionEngine.getBallots();
						setBallots(summaries);
					}
				} catch (error) {
					console.error("Error loading ballots:", error);
				}
			};
			loadBallots();
		}, [electionEngine])
	);

	if (!electionDetails) {
		return (
			<View style={styles.container}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
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

			{/* Ballot Templates section — G1/G2/G12 (09-10):
			    Show one InfoCard per template when >=1 exists (each navigates EditBallot
			    with ballotId+electionEngine for upsert). When 0 templates, show only
			    the empty-state text + CREATE BALLOT TEMPLATE button (G1 label). */}
			<View style={styles.section}>
				<ThemedText type="title">{t("ballotTemplates")}</ThemedText>
				{ballots.length > 0 ? (
					ballots.map((ballot) => (
						<InfoCard
							key={ballot.id}
							title={ballot.authorityId || t("ballotTemplate")}
							icon="chevron-right"
							onPress={() =>
								navigation.navigate("EditBallot", {
									electionId: electionDetails.election.id,
									electionTitle: electionDetails.election.title,
									electionDate: formatDate(electionDetails.election.revisionDeadline),
									ballotId: ballot.id,
									electionEngine,
								} as any)
							}
						/>
					))
				) : (
					<>
						<ThemedText type="small">{t("noBallotYet")}</ThemedText>
						<CustomButton
							title={t("createBallotTemplate")}
							size="thin"
							icon="plus"
							backgroundColor={colors.accent}
							onPress={() =>
								navigation.navigate("CreateBallot", {
									electionId: electionDetails.election.id,
									electionTitle: electionDetails.election.title,
									electionDate: formatDate(electionDetails.election.revisionDeadline),
									electionEngine,
								} as any)
							}
						/>
					</>
				)}
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
