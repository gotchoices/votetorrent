import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, ScrollView, StyleSheet, Switch, TouchableOpacity } from "react-native";
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
import { isNoNetworkEstablishedError } from "../../engines/engine-factory";
import { PeerReadUnavailableNotice } from "../../components/PeerReadUnavailableNotice";
import { classifyPeerReadFailure } from "../../engines/peer-read-unavailable";
import { OwnerTrustNotice } from "../../components/OwnerTrustNotice";
import { ToggleRow } from "../../components/ToggleRow";
import { readRequireOwnerTrust, writeRequireOwnerTrust } from "../../engines/owner-trust-setting";
import { useCadreNode } from "../../providers/CadreNodeProvider";
import { voterInviteCapability, type VoterInviteNode } from "../../engines/voter-invite";
import {
	readMintLog,
	readPairingSwitch,
	writePairingSwitch,
	type OwnerMintLogEntry,
} from "../../engines/pairing-owner-store";

const LANGUAGES: { code: 'en' | 'es'; label: string }[] = [
	{ code: 'en', label: 'English' },
	{ code: 'es', label: 'Español' },
];

/** How many of the owner's pairing requests the Browser pairing section shows (D-28). */
export const MINT_LOG_SHOWN = 20;

/**
 * The outcome word for one pairing request (pure, total). Only an exact `approved` reads Approved;
 * every other refusal and any value this version does not know reads the generic Refused.
 */
export function mintLogOutcomeKey(outcome: string): string {
	switch (outcome) {
		case "approved":
			return "pairingMintLogOutcomeApproved";
		case "refused:bad-signature":
			return "pairingMintLogOutcomeKeyNotValid";
		case "refused:switched-off":
			return "pairingMintLogOutcomeSwitchOff";
		case "refused:not-officer":
			return "pairingMintLogOutcomeNotOfficer";
		case "unreachable":
			return "pairingMintLogOutcomeUnreachable";
		default:
			return "pairingMintLogOutcomeRefused";
	}
}

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

/**
 * Local `YYYY-MM-DD HH:MM` (plain Date getters, never Intl). Duplicates the paired-browsers list's
 * formatter on purpose, so Settings does not import that screen and its engine graph.
 */
function formatLogTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

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
	const [peerUnavailable, setPeerUnavailable] = useState(false);
	// Bumped by the notice's Try Again so every network-scoped load re-runs.
	const [retryNonce, setRetryNonce] = useState(0);
	// D-11: "Require saved owner trust". Off by default. requireOwnerTrustRef mirrors what is shown;
	// the touched flag and the write sequence keep a late first read, or an older write's re-read,
	// from overwriting what the officer just chose.
	const [requireOwnerTrust, setRequireOwnerTrust] = useState(false);
	const requireOwnerTrustRef = useRef(false);
	const requireOwnerTrustTouchedRef = useRef(false);
	const requireOwnerTrustWriteSeqRef = useRef(0);
	const mountedRef = useRef(false);
	// D-28: the owner-only "Browser pairing" section. Shown only when this phone's identity is a
	// cadre owner (the same predicate that starts the pair-mint host). The switch mirrors the
	// owner-trust row's touched-ref + write-sequence idiom; an unreadable switch shows OFF, as the
	// mint host reads it. An unreadable log shows as unreadable, never as empty.
	const { node } = useCadreNode();
	const [isPairingOwner, setIsPairingOwner] = useState(false);
	const [pairingSwitchOn, setPairingSwitchOn] = useState(true);
	const [pairingSwitchSaveFailed, setPairingSwitchSaveFailed] = useState(false);
	const [mintLog, setMintLog] = useState<OwnerMintLogEntry[] | null>(null);
	const [mintLogUnreadable, setMintLogUnreadable] = useState(false);
	const [officerNames, setOfficerNames] = useState<Record<string, string | null>>({});
	const pairingSwitchRef = useRef(true);
	const pairingSwitchTouchedRef = useRef(false);
	const pairingSwitchWriteSeqRef = useRef(0);
	const pairingLoadSeqRef = useRef(0);
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine } = useApp();
	const navigation = useNavigation<NavigationProp>();

	// Settings is reachable before any network exists, and its Language / help-icon
	// controls work fine without one — so "no network selected" is expected here and
	// must not paint an error banner carrying an internal EngineFactory message.
	// Unlike the Tasks tab we do NOT swap in <NoNetwork />: that would hide the
	// network-independent controls the user came here to change. Real failures still
	// surface. The network-scoped sections below already handle a null engine.
	const reportSettingsError = useCallback((error: unknown) => {
		if (isNoNetworkEstablishedError(error)) {
			return;
		}
		const peer = classifyPeerReadFailure(error);
		if (peer) {
			console.warn("Settings load: peer unavailable:", peer.reason);
			setPeerUnavailable(true);
			return;
		}
		setSettingsError(t("settingsLoadFailed"));
	}, [t]);

	const retryPeerLoads = useCallback(() => {
		setPeerUnavailable(false);
		setSettingsError("");
		setRetryNonce((n) => n + 1);
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Only sets state when the value changes and the screen is mounted, so the default-off first read
	// causes no update.
	const showRequireOwnerTrust = useCallback((on: boolean) => {
		if (!mountedRef.current || on === requireOwnerTrustRef.current) {
			return;
		}
		requireOwnerTrustRef.current = on;
		setRequireOwnerTrust(on);
	}, []);

	// An unreadable setting is shown ON: the cadre-node provider treats it as strict, so the row
	// must never show OFF while the next start would block (fail closed).
	useEffect(() => {
		readRequireOwnerTrust()
			.then((on) => {
				if (!requireOwnerTrustTouchedRef.current) showRequireOwnerTrust(on);
			})
			.catch(() => {
				console.warn("[owner-trust] setting: unreadable");
				if (!requireOwnerTrustTouchedRef.current) showRequireOwnerTrust(true);
			});
	}, [showRequireOwnerTrust]);

	// The change takes effect at the next start (the help text says so), so no prompt.
	const handleRequireOwnerTrustChange = useCallback(
		(next: boolean) => {
			requireOwnerTrustTouchedRef.current = true;
			const seq = ++requireOwnerTrustWriteSeqRef.current;
			showRequireOwnerTrust(next);
			writeRequireOwnerTrust(next).catch(() => {
				console.warn("[owner-trust] setting: write failed");
				if (seq !== requireOwnerTrustWriteSeqRef.current) return;
				// Show what is stored, never a value that was not saved.
				readRequireOwnerTrust()
					.then(showRequireOwnerTrust)
					.catch(() => showRequireOwnerTrust(true));
			});
		},
		[showRequireOwnerTrust]
	);

	const showPairingSwitch = useCallback((on: boolean) => {
		if (!mountedRef.current) return;
		pairingSwitchRef.current = on;
		setPairingSwitchOn(on);
	}, []);

	// Re-read on every focus: the owner check, the switch (unless the owner already toggled it) and
	// the log, then the officers' names (at most one lookup per distinct officer, at most 20).
	useFocusEffect(
		useCallback(() => {
			const seq = ++pairingLoadSeqRef.current;
			const current = () => mountedRef.current && seq === pairingLoadSeqRef.current;
			const loadBrowserPairing = async () => {
				if (!node) {
					if (current()) setIsPairingOwner(false);
					return;
				}
				let owner = false;
				try {
					owner = (await voterInviteCapability(node as unknown as VoterInviteNode)) === "ready";
				} catch {
					owner = false;
				}
				if (!current()) return;
				setIsPairingOwner(owner);
				if (!owner) return;
				try {
					const on = await readPairingSwitch();
					if (current() && !pairingSwitchTouchedRef.current) showPairingSwitch(on);
				} catch {
					console.warn("[browser-pairing] switch: unreadable");
					if (current() && !pairingSwitchTouchedRef.current) showPairingSwitch(false);
				}
				let entries: OwnerMintLogEntry[] | null = null;
				try {
					entries = await readMintLog(MINT_LOG_SHOWN);
				} catch {
					console.warn("[browser-pairing] log: unreadable");
					entries = null;
				}
				if (!current()) return;
				if (entries === null || !Array.isArray(entries)) {
					setMintLog(null);
					setMintLogUnreadable(true);
					return;
				}
				setMintLog(entries);
				setMintLogUnreadable(false);
				const ids: string[] = [];
				for (const entry of entries) {
					if (ids.length >= MINT_LOG_SHOWN) break;
					if (typeof entry.userId === "string" && !ids.includes(entry.userId)) ids.push(entry.userId);
				}
				const names: Record<string, string | null> = {};
				for (const id of ids) {
					try {
						const officer = await networkEngine?.getUser(id);
						const summary = officer ? await officer.getSummary() : undefined;
						names[id] = typeof summary?.name === "string" && summary.name.length > 0 ? summary.name : null;
					} catch {
						names[id] = null;
					}
				}
				if (current()) setOfficerNames(names);
			};
			void loadBrowserPairing();
		}, [node, networkEngine, showPairingSwitch])
	);

	const handlePairingSwitchChange = useCallback(
		(next: boolean) => {
			pairingSwitchTouchedRef.current = true;
			const seq = ++pairingSwitchWriteSeqRef.current;
			showPairingSwitch(next);
			if (mountedRef.current) setPairingSwitchSaveFailed(false);
			writePairingSwitch(next).catch(() => {
				console.warn("[browser-pairing] switch: write failed");
				if (seq !== pairingSwitchWriteSeqRef.current || !mountedRef.current) return;
				setPairingSwitchSaveFailed(true);
				// Show what is stored, never a value that was not saved.
				readPairingSwitch()
					.then((on) => {
						if (seq === pairingSwitchWriteSeqRef.current) showPairingSwitch(on);
					})
					.catch(() => {
						if (seq === pairingSwitchWriteSeqRef.current) showPairingSwitch(false);
					});
			});
		},
		[showPairingSwitch]
	);

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
				reportSettingsError(error);
			}
		};
		loadBaseEngines();
	}, [getEngine, defaultUserEngine, networkEngine, reportSettingsError, retryNonce]);

	useEffect(() => {
		const loadNetworkName = async () => {
			if (!networkEngine) {
				setCurrentNetwork(null);
				return;
			}
			try {
				const networkDetails = await networkEngine.getDetails();
				setCurrentNetwork(networkDetails.network.name);
			} catch (error) {
				console.warn("Failed to load network name:", error);
				reportSettingsError(error);
			}
		};
		loadNetworkName();
	}, [networkEngine, reportSettingsError, retryNonce]);

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
				reportSettingsError(error);
				setUserEngine(null);
			}
		};

		loadUserEngine();
	}, [networkEngine, reportSettingsError, retryNonce]);

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
					reportSettingsError(error);
					setCurrentUser(null);
				}
			};

			loadUserSummary();
		}, [userEngine, reportSettingsError, retryNonce])
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

	// The owner-trust notice is persistent, has no dismiss control and reads the cadre-node context. It gets no
	// Open Settings action here, because the setting row is on this screen.
	return (
		<View style={styles.content}>
			<InlineError message={settingsError} />
			{peerUnavailable ? <PeerReadUnavailableNotice variant="unavailable" onRetry={retryPeerLoads} /> : null}
			<ScrollView
				testID="settings-scroll"
				style={[styles.content, { backgroundColor: colors.background }]}
				contentContainerStyle={styles.container}
			>
				<OwnerTrustNotice onNeedsReinvite={() => navigation.navigate("JoinNetwork")} />
				<View style={[styles.helpIconsRow, { zIndex: 10 }]}>
					<ThemedText type="default">{t('language')}</ThemedText>
					<View style={styles.langSelector}>
						<TouchableOpacity
							onPress={() => setShowLangModal(prev => !prev)}
							style={[styles.langDropdownBtn, { backgroundColor: colors.accent }]}
							accessibilityRole="button"
							accessibilityLabel={`${t("language")}: ${LANGUAGES.find(l => l.code === currentLang)?.label ?? currentLang}`}
							testID="settings-language-toggle"
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

				{/* Phase 47 plan 47-21 (D-09) — device-level provisioning entry, placed
				    above the {currentNetwork} boundary because Play Console key
				    provisioning is a build/device concern, not per-network and not
				    per-authority. Deliberately NO scope gate: 47-19's screen reads a
				    build-state boolean, makes no engine call and holds no registrant
				    data, so gating it would make it unreachable for exactly the
				    operator who needs to diagnose a build. */}
				<View testID="settings-attestation-provisioning-entry">
					<InfoCard
						title={t("attestationProvisioningScreenTitle")}
						titleType="defaultSemiBold"
						icon="chevron-right"
						onPress={() => navigation.navigate("AttestationProvisioningStatus")}
					/>
				</View>

				{/* Phase 49 plan 49-10 (D-14) — device-level signing-key provisioning entry, placed
				    adjacent to the attestation-provisioning row above for the same reason: a
				    device/build concern, not per-network and not per-authority. No scope gate for
				    the same reason as that row — this is exactly the entry point an unprovisioned
				    device needs before it can complete ANY signing action. */}
				<View testID="settings-signing-key-provisioning-entry">
					<InfoCard
						title={t("settingsSigningKeyRow")}
						titleType="defaultSemiBold"
						icon="chevron-right"
						onPress={() => navigation.navigate("ProvisionSigningKey", { reason: "first-run" })}
					/>
				</View>

				{/* Accept an Invitation: the production entry into every invitation accept flow.
				    Deliberately NO scope gate: an invitee holds no scopes yet, by definition, the
				    same reasoning as the provisioning rows above. Accepting still needs the
				    sender's one-time key from the pasted share and a device-key act. */}
				<View testID="settings-accept-invitation-entry">
					<InfoCard
						title={t("invitationAcceptTitle")}
						titleType="defaultSemiBold"
						icon="chevron-right"
						onPress={() => navigation.navigate("AcceptInvitation")}
					/>
				</View>

				{/* Pair a browser: this officer pairs their own browser. Not
				    scope-gated (every officer may pair their own browser); the
				    destination screen holds the confirm step and the signature. */}
				<View testID="settings-pair-browser-entry">
					<InfoCard
						title={t("dashboardPairingTitle")}
						titleType="defaultSemiBold"
						icon="chevron-right"
						onPress={() => navigation.navigate("PairBrowser")}
					/>
				</View>

				<View testID="settings-require-owner-trust-entry" style={{ marginTop: 8, marginBottom: 16 }}>
					<ToggleRow
						label={t("settingsRequireOwnerTrust")}
						accessibilityLabel={t("settingsRequireOwnerTrust")}
						testID="settings-require-owner-trust"
						value={requireOwnerTrust}
						onValueChange={handleRequireOwnerTrustChange}
					/>
					<ThemedText type="small" testID="settings-require-owner-trust-help" style={{ color: colors.text }}>
						{t("settingsRequireOwnerTrustHelp")}
					</ThemedText>
				</View>

				{isPairingOwner ? (
					<View testID="settings-browser-pairing-section" style={{ marginBottom: 16 }}>
						<ThemedText type="subtitle" style={styles.sectionTitle}>
							{t("pairingMintLogSectionTitle")}
						</ThemedText>
						<ToggleRow
							label={t("pairingMintLogSwitchLabel")}
							accessibilityLabel={t("pairingMintLogSwitchLabel")}
							testID="settings-browser-pairing-switch"
							value={pairingSwitchOn}
							onValueChange={handlePairingSwitchChange}
						/>
						<ThemedText type="small" testID="settings-browser-pairing-help" style={{ color: colors.text }}>
							{pairingSwitchOn ? t("pairingMintLogSwitchHelpOn") : t("pairingMintLogSwitchHelpOff")}
						</ThemedText>
						{pairingSwitchSaveFailed ? (
							<View testID="settings-browser-pairing-save-failed">
								<InlineError message={t("pairingMintLogSwitchSaveFailed")} />
							</View>
						) : null}
						<ThemedText type="defaultSemiBold" style={{ marginTop: 16, marginBottom: 8 }}>
							{t("pairingMintLogTitle")}
						</ThemedText>
						{mintLogUnreadable ? (
							<View testID="settings-browser-pairing-log-unreadable">
								<InlineError message={t("pairingMintLogUnreadable")} />
							</View>
						) : mintLog === null ? null : mintLog.length === 0 ? (
							<ThemedText type="small" testID="settings-browser-pairing-log-empty">
								{t("pairingMintLogEmpty")}
							</ThemedText>
						) : (
							<View testID="settings-browser-pairing-log">
								{mintLog.map((entry, index) => (
									<View
										key={`${index}-${entry.at}`}
										testID="settings-browser-pairing-log-row"
										style={styles.mintLogRow}
									>
										<ThemedText type="small" style={styles.mintLogRowText}>
											{t("pairingMintLogRow", {
												officerName: officerNames[entry.userId] ?? t("pairingMintLogUnknownOfficer"),
												date: formatLogTime(entry.at),
											})}
										</ThemedText>
										<ThemedText type="smallBold">{t(mintLogOutcomeKey(entry.outcome))}</ThemedText>
									</View>
								))}
								<ThemedText type="small" testID="settings-browser-pairing-log-footnote" style={{ marginTop: 8 }}>
									{t("pairingMintLogFootnote", { n: mintLog.length })}
								</ThemedText>
							</View>
						)}
					</View>
				) : null}

				{/* Per-network block: only shown once a network is selected. Without a
				    network the empty subtitle left a blank gap, and "No user found for this
				    network" repeated the "No default user found" line above. */}
				{currentNetwork ? (
					<ThemedText type="subtitle" style={styles.networkTitle}>
						{currentNetwork}
					</ThemedText>
				) : null}

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
				) : currentNetwork ? (
					<ThemedText type="default" style={styles.noUserText}>
						{t("noUserFound")}
					</ThemedText>
				) : null}

				{__DEV__ && (
					<>
						<CustomButton
							title={t("screenScaffoldsDebugTitle")}
							icon="wrench"
							size="thin"
							onPress={() => {
								navigation.navigate("ScreenScaffoldsDebug");
							}}
						/>
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
			</ScrollView>
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
	mintLogRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 8,
		paddingVertical: 4,
	},
	mintLogRowText: {
		flexShrink: 1,
		flexGrow: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
