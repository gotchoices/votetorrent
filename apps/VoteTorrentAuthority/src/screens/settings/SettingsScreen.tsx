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
import { useSettings } from "../../providers/SettingsProvider";
import { InlineError } from "../../components/InlineError";

const LANGUAGES: { code: 'en' | 'es'; label: string }[] = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Español' },
];

export default function SettingsScreen() {
	const { showHelpIcons, setShowHelpIcons } = useSettings();
	const [currentLang, setCurrentLang] = useState<'en' | 'es'>(i18n.language as 'en' | 'es');
	const [showLangModal, setShowLangModal] = useState(false);
	const [defaultUserEngine, setDefaultUserEngine] = useState<IDefaultUserEngine | null>(null);
	const [defaultUser, setDefaultUser] = useState<DefaultUser | null>(null);
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [currentNetwork, setCurrentNetwork] = useState<string | null>(null);
	const [userEngine, setUserEngine] = useState<IUserEngine | null>(null);
	const [currentUser, setCurrentUser] = useState<User | null>(null);
	const [seedStatus, setSeedStatus] = useState<string | null>(null);
	const [settingsError, setSettingsError] = useState("");
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const navigation = useNavigation<NavigationProp>();

	const handleLanguageChange = async (lang: 'en' | 'es') => {
		await i18n.changeLanguage(lang);
		await AsyncStorage.setItem('appLanguage', lang);
		setCurrentLang(lang);
	};

	// HI-01 — keep currentLang in sync when language changes elsewhere
	// (e.g. App.tsx boot restore fires i18n.changeLanguage before this mounts)
	useEffect(() => {
		const handler = (lang: string) => setCurrentLang(lang as 'en' | 'es');
		i18n.on('languageChanged', handler);
		return () => i18n.off('languageChanged', handler);
	}, []);

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
				console.warn("Failed to load base engines:", error);
				setSettingsError(error instanceof Error ? error.message : String(error));
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
				console.warn("Failed to get current user engine:", error);
				setSettingsError(error instanceof Error ? error.message : String(error));
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
					console.warn("Failed to get user summary:", error);
					setSettingsError(error instanceof Error ? error.message : String(error));
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
						console.info("Refetched defaultUser on focus:", defaultUser);
						setDefaultUser(defaultUser);
					} else {
						setDefaultUser(null);
					}
				}
			}
			loadDefaultUser();
		}, [defaultUserEngine])
	);

	// DEBUG-ONLY: seed pending tasks for the device user so Tasks list/badge light up.
	// Guarded by __DEV__ at render time — never shown in a release build.
	// Approach B (debug seed): inserts AdminSignatureTaskExtension + ReleaseKeyTaskExtension
	// using real Authority/Election rows already present in the DB.
	const handleDebugSeedTasks = async () => {
		if (!currentUser) {
			setSeedStatus(t("seedTasksNoUser", { defaultValue: "No device user — connect to a network first" }));
			return;
		}
		try {
			const electionsEng = await getEngine<any>("elections");
			await (electionsEng as any).debugSeedPendingTasks(currentUser.id);
			setSeedStatus(t("debugSeedTasksSuccess"));
		} catch (err) {
			setSeedStatus(t("debugSeedTasksError") + String(err));
		}
	};

	return (
		<View style={styles.content}>
			<InlineError message={settingsError} />
			<View style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.helpIconsRow, { zIndex: 10 }]}>
					<ThemedText type="default">{t('language')}</ThemedText>
					<View style={styles.langSelector}>
						<TouchableOpacity
							onPress={() => setShowLangModal(prev => !prev)}
							style={[styles.langDropdownBtn, { backgroundColor: colors.accent }]}
							accessibilityRole="button"
						>
							<ThemedText type="defaultSemiBold">
								{LANGUAGES.find(l => l.code === currentLang)?.label ?? currentLang}
							</ThemedText>
							<FontAwesome6
								name={showLangModal ? "chevron-up" : "chevron-down"}
								size={12}
								color={colors.text}
								style={{ marginLeft: 6 }}
							/>
						</TouchableOpacity>
						{showLangModal && (
							<View style={[styles.langDropdown, { backgroundColor: colors.card }]}>
								{LANGUAGES.map(lang => (
									<TouchableOpacity
										key={lang.code}
										style={[styles.langDropdownItem, currentLang === lang.code && { backgroundColor: colors.primary + '33' }]}
										onPress={() => { handleLanguageChange(lang.code).then(() => setShowLangModal(false)); }}
									>
										<ThemedText type={currentLang === lang.code ? 'defaultSemiBold' : 'default'}>
											{lang.label}
										</ThemedText>
										{currentLang === lang.code && (
											<FontAwesome6 name="check" size={14} color={colors.primary} />
										)}
									</TouchableOpacity>
								))}
							</View>
						)}
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
						image={(defaultUser as any).image?.url ? { uri: (defaultUser as any).image.url } : undefined}
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
						image={(currentUser as any).image?.url ? { uri: (currentUser as any).image.url } : undefined}
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
				{__DEV__ && (
					<>
						<CustomButton
							title={t("debugSeedTasksTitle")}
							icon="vial"
							size="thin"
							onPress={handleDebugSeedTasks}
						/>
						{seedStatus ? (
							<ThemedText type="default" style={styles.noUserText}>
								{seedStatus}
							</ThemedText>
						) : null}
					</>
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
		marginBottom: 16,
	},
	langSelector: {
		position: "relative",
	},
	langDropdownBtn: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 12,
		paddingVertical: 8,
		borderRadius: 8,
		minHeight: 44,
	},
	langDropdown: {
		position: "absolute",
		top: 48,
		right: 0,
		borderRadius: 8,
		minWidth: 140,
		zIndex: 999,
		elevation: 8,
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.15,
		shadowRadius: 4,
		overflow: "hidden",
	},
	langDropdownItem: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 14,
		paddingVertical: 12,
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
