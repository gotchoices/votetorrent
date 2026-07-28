import React, { useCallback, useEffect, useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { NoNetwork } from "../../components/NoNetwork";
import { useApp } from "../../providers/AppProvider";
import { ChipButton } from "../../components/ChipButton";
import { CollapsibleSection } from "../../components/CollapsibleSection";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import {
	ElectionInit,
	ElectionSummary,
	IElectionsEngine,
	INetworkEngine,
	Proposal,
} from "@votetorrent/vote-core";
import { ElectionCard } from "./components/ElectionCard";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NavigationProp } from "../../navigation/types";
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";

/**
 * ElectionsScreen — three stacked sections per Phase 9 D-13:
 *   1. Active/Future elections (no header) + right-aligned CREATE ELECTION chip
 *   2. "Proposed Elections" section (header)
 *   3. "Election History" CollapsibleSection (collapsed by default — mirrors
 *      AuthoritiesScreen's default-collapsed convention)
 *
 * The hand-rolled chevron + state previously used for the history section has
 * been replaced with the shared CollapsibleSection primitive.
 */
export const ElectionsScreen = () => {
	const { getEngine, hasNetwork } = useApp();
	const navigation = useNavigation<NavigationProp>();
	const [, setNetworkEngine] = useState<INetworkEngine>();
	const [electionsEngine, setElectionsEngine] = useState<IElectionsEngine>();
	const [elections, setElections] = useState<ElectionSummary[]>([]);
	const [proposedElections, setProposedElections] = useState<Proposal<ElectionInit>[]>([]);
	const [electionHistory, setElectionHistory] = useState<ElectionSummary[]>([]);
	const [loadError, setLoadError] = useState("");
	const { t } = useTranslation();

	useEffect(() => {
		if (hasNetwork) {
			getEngine("network").then((engine) => {
				setNetworkEngine(engine as INetworkEngine);
			});
		}
	}, [hasNetwork]);

	useEffect(() => {
		async function initializeElectionsEngine() {
			if (!hasNetwork) return;
			try {
				const engine = await getEngine<IElectionsEngine>("elections");
				setElectionsEngine(engine);

				const [activeElections, proposed, history] = await Promise.all([
					engine.getElections(),
					engine.getProposedElections(),
					engine.getElectionHistory(),
				]);

				setElections(activeElections);
				setProposedElections(proposed);
				setElectionHistory(history);
			} catch (error) {
				console.warn("Error loading elections:", error);
				setLoadError(error instanceof Error ? error.message : String(error));
			}
		}
		initializeElectionsEngine();
	}, [hasNetwork]);

	// Phase 9 plan 09-15 — re-load on screen focus so a newly created election/revision
	// appears on return (mirrors the useFocusEffect pattern from the ballot round in 09-09).
	useFocusEffect(
		useCallback(() => {
			async function reloadElections() {
				if (!hasNetwork) return;
				try {
					const engine = await getEngine<IElectionsEngine>("elections");
					setElectionsEngine(engine);

					const [activeElections, proposed, history] = await Promise.all([
						engine.getElections(),
						engine.getProposedElections(),
						engine.getElectionHistory(),
					]);

					setElections(activeElections);
					setProposedElections(proposed);
					setElectionHistory(history);
				} catch (error) {
					console.warn("Error reloading elections on focus:", error);
					setLoadError(error instanceof Error ? error.message : String(error));
				}
			}
			reloadElections();
		}, [hasNetwork, getEngine])
	);

	if (!hasNetwork) {
		return <NoNetwork />;
	}

	const navigateToElectionDetails = async (electionId: string) => {
		const engine = await electionsEngine?.openElection(electionId);
		if (engine) {
			navigation.navigate("ElectionDetails", {
				electionEngine: engine,
			});
		}
	};

	return (
		<ScrollView style={styles.container}>
			<InlineError message={loadError} />
			{/* Section 1: Active / Future elections — no header per D-13 */}
			<View style={styles.section}>
				{elections.length > 0 ? (
					elections.map((election) => (
						<ElectionCard
							key={election.id}
							election={election}
							onPress={() => {
								navigateToElectionDetails(election.id);
							}}
						/>
					))
				) : (
					<ThemedText style={styles.emptyText}>{t("noCurrentElections")}</ThemedText>
				)}
				<View style={styles.buttonContainer}>
					<ChipButton
						label={t("createElection")}
						icon="plus"
						onPress={() => navigation.navigate("CreateElection")}
					/>
				</View>
			</View>

			{/* Section 2: Proposed Elections — titled section */}
			<View style={styles.section}>
				<ThemedText type="title">{t("proposedElections")}</ThemedText>
				{proposedElections.length > 0 ? (
					proposedElections.map((election) => (
						<ElectionCard
							key={election.proposed.election.id}
							election={election.proposed.election}
							onPress={() => {
								navigateToElectionDetails(election.proposed.election.id);
							}}
						/>
					))
				) : (
					<ThemedText style={styles.emptyHint}>{t("noProposedElectionsCurrently")}</ThemedText>
				)}
			</View>

			{/* Section 3: Election History — CollapsibleSection per D-13 */}
			<CollapsibleSection title={t("electionHistory")} defaultExpanded={false}>
				{electionHistory.length > 0 ? (
					electionHistory.map((historyItem) => (
						<ElectionCard
							key={historyItem.id}
							election={historyItem}
							onPress={() => {
								navigateToElectionDetails(historyItem.id);
							}}
						/>
					))
				) : (
					<ThemedText style={styles.emptyText}>{t("noHistoryFound")}</ThemedText>
				)}
			</CollapsibleSection>
		</ScrollView>
	);
};

const localStyles = StyleSheet.create({
	buttonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
		padding: 16,
	},
	emptyText: {
		padding: 16,
	},
	emptyHint: {
		marginTop: 8,
		marginBottom: 4,
		fontStyle: "italic",
		opacity: 0.6,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default ElectionsScreen;
