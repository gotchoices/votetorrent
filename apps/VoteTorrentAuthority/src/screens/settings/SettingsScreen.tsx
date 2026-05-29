import React, { useState, useEffect, useCallback } from "react";
import { View, StyleSheet, Switch, TouchableOpacity } from "react-native";
import { useNavigation, useTheme, useFocusEffect } from "@react-navigation/native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n from "../../i18n";
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
	const [currentLang, setCurrentLang] = useState<'en' | 'es'>(i18n.language as 'en' | 'es');
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

	const handleLanguageChange = async (lang: 'en' | 'es') => {
		await i18n.changeLanguage(lang);
		await AsyncStorage.setItem('appLanguage', lang);
		setCurrentLang(lang);
	};

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
				{/* Phase 11 plan 11-02 (D-01/D-02/D-03) — Language toggle: EN | ES segmented control */}
				<View style={styles.helpIconsRow}>
					<ThemedText type="default">{t('language')}</ThemedText>
					<View
						style={styles.languageToggle}
						accessibilityRole="radiogroup"
						accessibilityLabel={t('language')}
					>
						<TouchableOpacity
							onPress={() => handleLanguageChange('en')}
							style={[styles.langBtn, { backgroundColor: currentLang === 'en' ? colors.primary : colors.accent }]}
							accessibilityRole="button"
							accessibilityState={{ selected: currentLang === 'en' }}
						>
							<ThemedText type={currentLang === 'en' ? 'defaultSemiBold' : 'default'}>
								{t('english')}
							</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							onPress={() => handleLanguageChange('es')}
							style={[styles.langBtn, { backgroundColor: currentLang === 'es' ? colors.primary : colors.accent }]}
							accessibilityRole="button"
							accessibilityState={{ selected: currentLang === 'es' }}
						>
							<ThemedText type={currentLang === 'es' ? 'defaultSemiBold' : 'default'}>
								Español
							</ThemedText>
						</TouchableOpacity>
					</View>
				</View>

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
						image={{ uri: (defaultUser as any).image?.url || "" }}
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
						image={{ uri: (currentUser as any).image?.url || "" }}
						additionalInfo={[{ label: "ID", value: currentUser.id }]}
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

				<CustomButton
					title={t("screenScaffoldsDebugTitle")}
					icon="wrench"
					size="thin"
					onPress={() => {
						navigation.navigate("ScreenScaffoldsDebug");
					}}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	helpIconsRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 16,
	},
	languageToggle: {
		flexDirection: "row",
		borderRadius: 8,
		overflow: "hidden",
	},
	langBtn: {
		paddingHorizontal: 16,
		paddingVertical: 8,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
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
