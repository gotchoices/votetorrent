import React, { useEffect, useState } from "react";
import { View, ScrollView, StyleSheet, TouchableOpacity } from "react-native";
import { NoNetwork } from "../../components/NoNetwork";
import { useApp } from "../../providers/AppProvider";
import { ChipButton } from "../../components/ChipButton";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import {
	ElectionInit,
	ElectionSummary,
	IElectionsEngine,
	INetworkEngine,
	Proposal,
	SID,
} from "@votetorrent/vote-core";
import { ElectionCard } from "./components/ElectionCard";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import type { NavigationProp } from "../../navigation/types";
import { ThemedText } from "../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";

// Mock data for elections
const mockElections = [
	{
		id: "1",
		title: "2024 Presidential Election",
		authority: "Federal Election Commission",
		date: "2024-11-05",
	},
	{
		id: "2",
		title: "State Senate District 12",
		authority: "State Election Board",
		date: "2024-08-15",
	},
	{
		id: "3",
		title: "City Council Special Election",
		authority: "City Clerk",
		date: "2024-06-20",
	},
];

export const ElectionsScreen = () => {
	const { getEngine, hasNetwork } = useApp();
	const navigation = useNavigation<NavigationProp>();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine>();
	const [electionsEngine, setElectionsEngine] = useState<IElectionsEngine>();
	const [elections, setElections] = useState<ElectionSummary[]>([]);
	const [proposedElections, setProposedElections] = useState<Proposal<ElectionInit>[]>([]);
	const [electionHistory, setElectionHistory] = useState<ElectionSummary[]>([]);
	const [showHistory, setShowHistory] = useState(false);
	const { colors } = useTheme() as ExtendedTheme;
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

				const [elections, proposedElections, electionHistory] = await Promise.all([
					engine.getElections(),
					engine.getProposedElections(),
					engine.getElectionHistory(),
				]);

				setElections(elections);
				console.log("elections", elections);
				setProposedElections(proposedElections);
				setElectionHistory(electionHistory);
			} catch (error) {
				console.error("Error loading elections:", error);
			}
		}
		initializeElectionsEngine();
	}, [electionsEngine]);

	if (!hasNetwork) {
		return <NoNetwork />;
	}

	const toggleHistory = () => {
		setShowHistory(!showHistory);
	};

	const navigateToElectionDetails = async (electionSid: SID) => {
		const engine = await electionsEngine?.openElection(electionSid);
		if (engine) {
			navigation.navigate("ElectionDetails", {
				electionEngine: engine,
			});
		}
	};

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				{elections.length > 0 ? (
					elections.map((election) => (
						<ElectionCard
							key={election.sid}
							election={election}
							onPress={() => {
								navigateToElectionDetails(election.sid);
							}}
						/>
					))
				) : (
					<ThemedText style={styles.noElectionsText}>{t("noCurrentElections")}</ThemedText>
				)}
				<View style={styles.buttonContainer}>
					<ChipButton label={t("createElection")} icon="plus" onPress={() => {}} />
				</View>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("proposedElections")}</ThemedText>
				{proposedElections.length > 0 ? (
					proposedElections.map((election) => (
						<ElectionCard
							key={election.proposed.election.sid}
							election={election.proposed.election}
							onPress={() => {
								navigateToElectionDetails(election.proposed.election.sid);
							}}
						/>
					))
				) : (
					<ThemedText style={styles.noElectionsText}>{t("noProposedElections")}</ThemedText>
				)}
			</View>

			<View style={styles.section}>
				<TouchableOpacity style={styles.historyHeader} onPress={toggleHistory}>
					<FontAwesome6
						name={showHistory ? "chevron-down" : "chevron-right"}
						size={14}
						color={colors.text}
					/>
					<ThemedText type="title">{t("electionHistory")}</ThemedText>
				</TouchableOpacity>
				{showHistory && (
					<View style={styles.section}>
						{electionHistory.length > 0 ? (
							electionHistory.map((historyItem, index) => (
								<ElectionCard
									key={index}
									election={historyItem}
									onPress={() => {
										navigateToElectionDetails(historyItem.sid);
									}}
								/>
							))
						) : (
							<ThemedText>{t("noHistoryFound", "No history found.")}</ThemedText>
						)}
					</View>
				)}
			</View>
		</ScrollView>
	);
};

const localStyles = StyleSheet.create({
	buttonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
		padding: 16,
	},
	noElectionsText: {
		padding: 16,
	},
	historyHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default ElectionsScreen;
