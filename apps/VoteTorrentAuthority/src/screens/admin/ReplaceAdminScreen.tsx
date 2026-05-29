import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { InfoCard } from "../../components/InfoCard";
import type { RootStackParamList } from "../../navigation/types";
import type { Authority, Officer, Admin, INetworkEngine } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { globalStyles } from "../../theme/styles";

export default function ReplaceAdminScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { authority, officer, removeOfficer } = useRoute().params as {
		authority: Authority;
		officer?: Officer;
		removeOfficer?: boolean;
	};
	const { getEngine } = useApp();
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [currentAdmin, setCurrentAdmin] = useState<Admin | null>(null);
	const [proposedOfficers, setProposedOfficers] = useState<Officer[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [hasLoadedInitialData, setHasLoadedInitialData] = useState(false);
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	useEffect(() => {
		async function loadNetworkEngine() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				setNetworkEngine(engine);
			} catch (error) {
				console.error("Error loading network engine:", error);
				setIsLoading(false);
			}
		}
		loadNetworkEngine();
	}, [getEngine]);

	useEffect(() => {
		async function loadAdmin() {
			if (!networkEngine) return;
			try {
				setIsLoading(true);
				const authorityEngine = await networkEngine.openAuthority(authority.id, authority);
				const adminDetails = await authorityEngine.getAdminDetails();
				console.log("Loaded admin:", adminDetails.admin);
				setCurrentAdmin(adminDetails.admin);
				if (!hasLoadedInitialData) {
					setProposedOfficers(adminDetails.admin.officers);
					setHasLoadedInitialData(true);
				}
			} catch (error) {
				console.error("Error loading admin:", error);
			} finally {
				setIsLoading(false);
			}
		}
		loadAdmin();
	}, [networkEngine, authority]);

	useEffect(() => {
		if (officer) {
			if (removeOfficer) {
				// Remove the officer from the list
				setProposedOfficers((current) => {
					console.log("Before removal - Current list:", current);
					console.log("Current admin:", currentAdmin);
					const filtered = current.filter((a) => a.userId !== officer.userId);
					console.log("After removal - New list:", filtered);
					return filtered;
				});
			} else {
				// Add or update the officer
				setProposedOfficers((current) => {
					console.log("Before add/update - Current list:", current);
					// If editing an existing officer, replace it
					const existingIndex = current.findIndex((a) => a.userId === officer.userId);
					if (existingIndex >= 0) {
						const newOfficers = [...current];
						newOfficers[existingIndex] = officer;
						console.log("After update - New list:", newOfficers);
						return newOfficers;
					}
					// If adding a new officer, append it
					const newList = [...current, officer];
					console.log("After add - New list:", newList);
					return newList;
				});
			}
		}
	}, [officer, removeOfficer]);

	if (!networkEngine || isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	const handleEditOfficer = (officer?: Officer) => {
		navigation.navigate("EditOfficer", {
			authority: authority,
			officerId: officer?.userId,
		});
	};

	const handleCreateProposal = () => {
		// v1.1 milestone scope: functional interaction beyond navigation is OOS.
		// setProposedAdmin is not exposed on INetworkEngine. Stub the save and
		// navigate back; real proposal creation lands when the engine API is
		// extended in a later phase.
		console.log("replaceAdmin-createProposal stub", { authorityId: authority.id, proposedOfficers });
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<ThemedText type="title" style={styles.sectionTitle}>
					{t("createProposedReplacement")}
				</ThemedText>

				<View style={styles.section}>
					{proposedOfficers.map((officer) => (
						<InfoCard
							key={officer.userId}
							title={officer.title}
							additionalInfo={[
								{ label: t("title"), value: officer.title },
								{ label: t("userId"), value: officer.userId },
							]}
							icon="pen"
							onPress={() => handleEditOfficer(officer)}
						/>
					))}
					<View style={styles.addButtonContainer}>
						<ChipButton label={t("addOfficer")} icon="circle-plus" onPress={handleEditOfficer} />
					</View>
				</View>
			</ScrollView>

			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("createProposal")}
					icon="floppy-disk"
					onPress={handleCreateProposal}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
});
const styles = { ...globalStyles, ...localStyles };
