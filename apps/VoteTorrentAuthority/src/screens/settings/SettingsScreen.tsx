import React, { useState, useEffect, useCallback } from "react";
import { View, StyleSheet, Switch } from "react-native";
import { useNavigation, useTheme, useFocusEffect } from "@react-navigation/native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { useTranslation } from "react-i18next";
import { ExtendedTheme } from "@react-navigation/native";
import { useApp } from "../../providers/AppProvider";
import {
	DefaultUser,
	IDefaultUserEngine,
	INetworkEngine,
	IUserEngine,
	User,
} from "@votetorrent/vote-core";
import type { NavigationProp } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";

export default function SettingsScreen() {
	const [showHelpIcons, setShowHelpIcons] = useState(false);
	const [defaultUserEngine, setDefaultUserEngine] = useState<IDefaultUserEngine | null>(null);
	const [defaultUser, setDefaultUser] = useState<DefaultUser | null>(null);
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [currentNetwork, setCurrentNetwork] = useState<string | null>(null);
	const [userEngine, setUserEngine] = useState<IUserEngine | null>(null);
	const [currentUser, setCurrentUser] = useState<User | null>(null);
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const navigation = useNavigation<NavigationProp>();

	useEffect(() => {
		const loadBaseEngines = async () => {
			if (defaultUserEngine && networkEngine) {
				return;
			}

			try {
				const userEnginePromise = defaultUserEngine
					? Promise.resolve(defaultUserEngine) // Already loaded, resolve immediately
					: getEngine("defaultUser");

				const networkEnginePromise = networkEngine
					? Promise.resolve(networkEngine) // Already loaded, resolve immediately
					: getEngine("network");

				const [userEngineResult, networkEngineResult] = await Promise.all([
					userEnginePromise,
					networkEnginePromise,
				]);

				if (!defaultUserEngine && userEngineResult) {
					setDefaultUserEngine(userEngineResult as IDefaultUserEngine);
				}
				if (!networkEngine && networkEngineResult) {
					setNetworkEngine(networkEngineResult as INetworkEngine);
				}
			} catch (error) {
				console.error("Failed to load base engines:", error);
			}
		};
		loadBaseEngines();
	}, [getEngine, defaultUserEngine, networkEngine]);

	useEffect(() => {
		const loadNetworkName = async () => {
			if (!networkEngine) {
				setCurrentNetwork(null);
				return;
			}
			const networkDetails = await networkEngine.getDetails();
			setCurrentNetwork(networkDetails.network.name);
		};
		loadNetworkName();
	}, [networkEngine]);

	useEffect(() => {
		const loadUserEngine = async () => {
			if (!networkEngine) {
				if (userEngine) setUserEngine(null);
				return;
			}

			try {
				const engine = await getEngine("user");
				if (engine) {
					setUserEngine(engine as IUserEngine);
				} else {
					console.warn("networkEngine.getCurrentUser() returned null or undefined.");
					setUserEngine(null);
				}
			} catch (error) {
				console.error("Failed to get current user engine:", error);
				setUserEngine(null);
			}
		};

		loadUserEngine();
	}, [networkEngine]);

	useFocusEffect(
		useCallback(() => {
			const loadUserSummary = async () => {
				if (!userEngine) {
					if (currentUser) setCurrentUser(null);
					return;
				}

				try {
					const summary = await userEngine.getSummary();
					if (summary) {
						setCurrentUser(summary);
					} else {
						console.warn("userEngine.getSummary() returned null or undefined.");
						setCurrentUser(null);
					}
				} catch (error) {
					console.error("Failed to get user summary:", error);
					setCurrentUser(null);
				}
			};

			loadUserSummary();
		}, [userEngine])
	);

	useFocusEffect(
		useCallback(() => {
			async function loadDefaultUser() {
				if (defaultUserEngine) {
					const defaultUser = await defaultUserEngine.get();
					if (defaultUser) {
						console.log("Refetched defaultUser on focus:", defaultUser);
						setDefaultUser(defaultUser);
					} else {
						setDefaultUser(null);
					}
				}
			}
			loadDefaultUser();
		}, [defaultUserEngine])
	);

	return (
		<View style={styles.content}>
			<View style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={styles.helpIconsRow}>
					<View style={styles.helpIcons}>
						<ThemedText type="default">{t("showHelpIcons")}</ThemedText>
						<FontAwesome6
							name="circle-info"
							size={16}
							color={colors.text}
							style={styles.infoIcon}
						/>
					</View>
					<Switch
						value={showHelpIcons}
						onValueChange={setShowHelpIcons}
						trackColor={{ false: colors.accent, true: colors.primary }}
						thumbColor={colors.card}
					/>
				</View>

				<ThemedText type="title" style={styles.sectionTitle}>
					{t("user")}
				</ThemedText>

				{defaultUser ? (
					<InfoCard
						title={t("defaultUser")}
						subtitle={defaultUser.name}
						image={{ uri: defaultUser.image?.url || "" }}
						icon="chevron-right"
						onPress={() => {
							navigation.navigate("DefaultUser", {
								defaultUser: defaultUser,
								defaultUserEngine: defaultUserEngine,
							});
						}}
					/>
				) : (
					<ThemedText type="default" style={styles.noUserText}>
						{t("noDefaultUserFound")}
					</ThemedText>
				)}

				<CustomButton
					title={t("connectDevice")}
					icon="qrcode"
					backgroundColor={colors.important}
					forceDarkText={true}
					size="thin"
					onPress={() => {
						navigation.navigate("AddDevice");
					}}
				/>

				<ThemedText type="subtitle" style={styles.networkTitle}>
					{currentNetwork}
				</ThemedText>

				{currentUser ? (
					<InfoCard
						title={currentUser.name}
						image={{ uri: currentUser.image?.url || "" }}
						additionalInfo={[{ label: "SID", value: currentUser.sid }]}
						icon="chevron-right"
						onPress={() => {
							navigation.navigate("UserDetails", {
								user: currentUser,
								userEngine: userEngine,
							});
						}}
					/>
				) : (
					<ThemedText type="default" style={styles.noUserText}>
						{t("noUserFound")}
					</ThemedText>
				)}
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	helpIconsRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 24,
	},
	helpIcons: {
		flexDirection: "row",
		alignItems: "center",
	},
	infoIcon: {
		marginLeft: 8,
	},
	sectionTitle: {
		marginBottom: 16,
	},
	networkTitle: {
		marginTop: 24,
		marginBottom: 8,
	},
	noUserText: {
		textAlign: "center",
		marginTop: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
