import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { InfoCard } from "../../components/InfoCard";
import type { RootStackParamList } from "../../navigation/types";
import type { Authority, Officer, Admin } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { globalStyles } from "../../theme/styles";

export default function ReplaceAdminScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const colorScheme = useColorScheme();
	const { t } = useTranslation();
	const { authority, officer, removeOfficer } = useRoute().params as {
		authority: Authority;
		officer?: Officer;
		removeOfficer?: boolean;
	};
	const { networkEngine } = useApp();
	const [currentAdmin, setCurrentAdmin] = useState<Admin | null>(null);
	const [proposedOfficers, setProposedOfficers] = useState<Officer[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [hasLoadedInitialData, setHasLoadedInitialData] = useState(false);
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	useEffect(() => {
		async function loadAdmin() {
			if (!networkEngine) return;
			try {
				setIsLoading(true);
				const admin = await networkEngine.getAdmin(authority.sid);
				console.log("Loaded admin:", admin);
				setCurrentAdmin(admin);
				// Only set proposed officers if we haven't loaded initial data
				if (!hasLoadedInitialData) {
					setProposedOfficers(admin.officers);
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
					const filtered = current.filter((a) => a.sid !== officer.sid);
					console.log("After removal - New list:", filtered);
					return filtered;
				});
			} else {
				// Add or update the officer
				setProposedOfficers((current) => {
					console.log("Before add/update - Current list:", current);
					// If editing an existing officer, replace it
					const existingIndex = current.findIndex((a) => a.sid === officer.sid);
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
			officerSid: officer?.sid,
		});
	};

	const handleCreateProposal = async () => {
		try {
			const newAdmin: Admin = {
				sid: "",
				authoritySid: authority.sid,
				officers: proposedOfficers,
				expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).getTime(), // 30 days from now
			};
			await networkEngine.setProposedAdmin(authority.sid, newAdmin);
			navigation.popTo("AuthorityDetails", { authority });
		} catch (error) {
			console.error("Error creating proposal:", error);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("createProposedReplacement")}
				</ThemedText>

				<View style={styles.section}>
					{proposedOfficers.map((admin) => (
						<InfoCard
							key={admin.sid}
							title={admin.name}
							image={{ uri: admin.imageRef?.url }}
							additionalInfo={[
								{ label: t("title"), value: admin.title },
								{ label: t("sid"), value: admin.sid },
							]}
							icon="pen"
							onPress={() => handleEditOfficer(admin)}
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
