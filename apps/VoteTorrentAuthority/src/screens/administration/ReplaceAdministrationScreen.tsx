import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { InfoCard } from "../../components/InfoCard";
import type { RootStackParamList } from "../../navigation/types";
import type { Authority, Administrator, Administration } from "@votetorrent/vote-core";
import { useRoute, useNavigation } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { globalStyles } from "../../theme/styles";

export default function ReplaceAdministrationScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const colorScheme = useColorScheme();
	const { t } = useTranslation();
	const { authority, administrator, removeAdministrator } = useRoute().params as {
		authority: Authority;
		administrator?: Administrator;
		removeAdministrator?: boolean;
	};
	const { networkEngine } = useApp();
	const [currentAdministration, setCurrentAdministration] = useState<Administration | null>(null);
	const [proposedAdministrators, setProposedAdministrators] = useState<Administrator[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [hasLoadedInitialData, setHasLoadedInitialData] = useState(false);
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	useEffect(() => {
		async function loadAdministration() {
			if (!networkEngine) return;
			try {
				setIsLoading(true);
				const administration = await networkEngine.getAdministration(authority.sid);
				console.log("Loaded administration:", administration);
				setCurrentAdministration(administration);
				// Only set proposed administrators if we haven't loaded initial data
				if (!hasLoadedInitialData) {
					setProposedAdministrators(administration.administrators);
					setHasLoadedInitialData(true);
				}
			} catch (error) {
				console.error("Error loading administration:", error);
			} finally {
				setIsLoading(false);
			}
		}
		loadAdministration();
	}, [networkEngine, authority]);

	useEffect(() => {
		if (administrator) {
			if (removeAdministrator) {
				// Remove the administrator from the list
				setProposedAdministrators((current) => {
					console.log("Before removal - Current list:", current);
					console.log("Current administration:", currentAdministration);
					const filtered = current.filter((a) => a.sid !== administrator.sid);
					console.log("After removal - New list:", filtered);
					return filtered;
				});
			} else {
				// Add or update the administrator
				setProposedAdministrators((current) => {
					console.log("Before add/update - Current list:", current);
					// If editing an existing administrator, replace it
					const existingIndex = current.findIndex((a) => a.sid === administrator.sid);
					if (existingIndex >= 0) {
						const newAdministrators = [...current];
						newAdministrators[existingIndex] = administrator;
						console.log("After update - New list:", newAdministrators);
						return newAdministrators;
					}
					// If adding a new administrator, append it
					const newList = [...current, administrator];
					console.log("After add - New list:", newList);
					return newList;
				});
			}
		}
	}, [administrator, removeAdministrator]);

	if (!networkEngine || isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t("loading")}</ThemedText>
			</View>
		);
	}

	const handleEditAdministrator = (administrator?: Administrator) => {
		navigation.navigate("EditAdministrator", {
			authority: authority,
			administratorSid: administrator?.sid,
		});
	};

	const handleCreateProposal = async () => {
		try {
			const newAdministration: Administration = {
				sid: "",
				authoritySid: authority.sid,
				administrators: proposedAdministrators,
				expiration: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).getTime(), // 30 days from now
			};
			await networkEngine.setProposedAdministration(authority.sid, newAdministration);
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
					{proposedAdministrators.map((admin) => (
						<InfoCard
							key={admin.sid}
							title={admin.name}
							image={{ uri: admin.imageRef?.url }}
							additionalInfo={[
								{ label: t("title"), value: admin.title },
								{ label: t("sid"), value: admin.sid },
							]}
							icon="pen"
							onPress={() => handleEditAdministrator(admin)}
						/>
					))}
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addAdministrator")}
							icon="circle-plus"
							onPress={handleEditAdministrator}
						/>
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
