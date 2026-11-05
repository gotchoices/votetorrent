import { ExtendedTheme, useTheme, useNavigation, useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { multiaddr } from "@multiformats/multiaddr";
import { InfoCard } from "../../components/InfoCard";
import { ThemedText } from "../../components/ThemedText";
import { useApp } from "../../providers/AppProvider";
import { useCadreNode } from "../../providers/CadreNodeProvider";
import type { NetworkReference } from "@votetorrent/vote-core";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { NavigationProp } from "../../navigation/types";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { globalStyles } from "../../theme/styles";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { usePreserveScrollOnResize } from "../../hooks/usePreserveScrollOnResize";
import { FoundingBundleExportCard } from "./components/FoundingBundleExportCard";
import { VoterInviteCard } from "./components/VoterInviteCard";
import { OwnerTrustNotice } from "../../components/OwnerTrustNotice";
import { reprobeAfterConnect } from "./reprobeAfterConnect";

export default function NetworksScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const keyboardInset = useKeyboardInset();
	const { networksEngine } = useApp();
	const { node } = useCadreNode();
	const [recentNetworkRefs, setRecentNetworkRefs] = useState<NetworkReference[]>([]);
	const [bootstrapAddr, setBootstrapAddr] = useState("");
	// NETOP-03 inline feedback — surfaces validation / join failures without crashing (T-22-09).
	const [joinError, setJoinError] = useState("");
	// D-35/D-36: which recent network's export card is open (one at a time), keyed on networkHash.
	const [exportTargetHash, setExportTargetHash] = useState<string | null>(null);
	// Spike 100: which recent network's "Invite voters" card is open (one at a time).
	const [inviteTargetHash, setInviteTargetHash] = useState<string | null>(null);
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();
	const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
	const directFocusedRef = useRef(false);
	// O-04: keep the scroll position across a rotation (width change); never reacts to the IME.
	const preserveScroll = usePreserveScrollOnResize(scrollRef);

	// The Direct (advanced) field and CONNECT are the LAST section. On API 35+ (forced
	// edge-to-edge) the window is not resized for the IME, so useKeyboardInset pads the content
	// and we scroll to the end once that padding is laid out (next frame) so the field and CONNECT
	// sit above the keyboard. Only while the Direct field is focused. On API < 35 the platform
	// resizes the window (useKeyboardInset returns 0) and scrollToEnd is harmless; the separate
	// post-IME relayout defect on API 29 is diagnosed elsewhere, not fixed here.
	const scrollDirectIntoView = useCallback(() => {
		requestAnimationFrame(() => {
			scrollRef.current?.scrollToEnd({ animated: true });
		});
	}, []);
	useEffect(() => {
		const sub = Keyboard.addListener("keyboardDidShow", () => {
			if (directFocusedRef.current) {
				scrollDirectIntoView();
			}
		});
		return () => sub.remove();
	}, [scrollDirectIntoView]);

	// NETOP-03 / D-39: join a bootstrap peer from a pasted multiaddr (advanced / dev fallback).
	// The multiaddr is parsed/validated BEFORE any use so a malformed paste produces an inline
	// error instead of crashing the node (T-22-09 DoS mitigation, Security V5).
	//
	// D-39: this field DIALS a bootstrap peer only — it never opens a strand. A strand is opened
	// solely by the networks engine's DbFactory, keyed on `strandId = networkHash`
	// (`rn-db-factory.ts`'s `createStrandDbFactory`), on create, open and founding-bundle import.
	// Connecting to a peer here lets that factory's founder probe see a reachable peer and join
	// instead of founding a parallel strand (D-05's `founder: !hasPeers`); the UI-SPEC freezes
	// this field and its copy, so no `networkHash` input is added here.
	const handleBootstrapConnect = useCallback(async () => {
		setJoinError("");
		let parsed: ReturnType<typeof multiaddr>;
		try {
			parsed = multiaddr(bootstrapAddr.trim());
		} catch {
			setJoinError(t("invalidBootstrapAddress"));
			return;
		}
		// The dial target needs a specific peer id — decode the /p2p component.
		const peerId = parsed.getComponents().find((c) => c.name === "p2p")?.value;
		if (!peerId) {
			setJoinError(t("invalidBootstrapAddress"));
			return;
		}
		const control = node?.getControlNode();
		if (!control) {
			setJoinError(t("invalidBootstrapAddress"));
			return;
		}
		try {
			await control.dial(parsed);
		} catch {
			setJoinError(t("joinFailed"));
			return;
		}
		// Success only: ask cadre-core for an immediate cohort pass so already-running strands
		// refresh their peer addresses now rather than on the next periodic pass. Fire and
		// forget; no UI state or copy changes. Never opens a strand (D-39).
		if (node) {
			void reprobeAfterConnect(node);
		}
	}, [bootstrapAddr, node, t]);

	// QR scanning is not yet wired (no camera dependency — see Plan 05). Honest
	// placeholder: surface an inline note rather than a console stub.
	const handleScanQr = useCallback(() => {
		setJoinError(t("qrScanUnavailable"));
	}, [t]);

	// Open Settings from the owner-trust notice: Home > Settings is where the "Require saved owner
	// trust" row lives. The same navigation call the app already uses for the Settings tab.
	const openSettings = useCallback(() => navigation.navigate("Home", { screen: "Settings" }), [navigation]);

	// Re-query recent networks whenever this screen regains focus (not just on
	// mount / engine change) — otherwise a network created via AddNetwork and
	// navigated-back-from would not appear until an app restart, since the engine
	// reference is unchanged. useFocusEffect fires on every focus.
	useFocusEffect(
		useCallback(() => {
			let cancelled = false;
			async function loadNetworks() {
				if (!networksEngine) {
					return;
				}
				const networkRefs = await networksEngine.getRecentNetworks();
				if (!cancelled) {
					setRecentNetworkRefs(networkRefs);
				}
			}
			loadNetworks();
			return () => {
				cancelled = true;
			};
		}, [networksEngine]),
	);

	// Phase 7 D-14: headerRight via useLayoutEffect (avoids first-frame flicker).
	useLayoutEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={t("addNetwork")}
					icon={"circle-plus"}
					onPress={() => navigation.navigate("AddNetwork")}
				/>
			),
		});
	}, [navigation, t]);

	// The owner-trust notice is persistent, has no dismiss control, reads the cadre-node context and is the
	// first child of the scroll content. The Import Network and Join a network buttons sit together in the
	// first section (UI-SPEC A1), and Join a network is always visible.
	return (
		<ScrollView
			testID="networks-scroll"
			ref={scrollRef}
			{...preserveScroll}
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 16 + keyboardInset }}
		>
			<OwnerTrustNotice onOpenSettings={openSettings} onNeedsReinvite={() => navigation.navigate("JoinNetwork")} />
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.section}>
					{t("useOneOfTheFollowingToGetConnected")}
				</ThemedText>
				<ThemedText type="title">{t("recentNetworks")}</ThemedText>
				{recentNetworkRefs.length === 0 && (
					// NETUI-01 empty-state: short hint when no recent networks.
					// The find/scan/bootstrap sections below remain the primary
					// entry points; this is purely an explanatory line.
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("noRecentNetworks")}
					</ThemedText>
				)}
				{recentNetworkRefs.map((networkRef) => (
					<React.Fragment key={networkRef.hash}>
						<View style={styles.networkContainer}>
							<View style={styles.infoCardContainer}>
								<InfoCard
									image={{ uri: networkRef.imageUrl }}
									title={networkRef.name}
									additionalInfo={[
										{
											label: t("address"),
											value: networkRef.primaryAuthorityDomainName,
										},
									]}
									onPress={() => navigation.navigate("NetworkDetails", { networkRef })}
								/>
							</View>
							<View style={styles.iconContainer}>
								<TouchableOpacity
									accessibilityRole="button"
									accessibilityLabel={t("networkFoundingExportButton")}
									testID={`founding-export-entry-${networkRef.hash}`}
									style={styles.iconButton}
									onPress={() => setExportTargetHash(networkRef.hash)}
								>
									<FontAwesome6 name="share-nodes" size={20} color={colors.text} />
								</TouchableOpacity>
								<TouchableOpacity
									accessibilityRole="button"
									accessibilityLabel={t("voterInviteButton")}
									testID={`voter-invite-entry-${networkRef.hash}`}
									style={styles.iconButton}
									onPress={() => setInviteTargetHash(networkRef.hash)}
								>
									<FontAwesome6 name="user-plus" size={20} color={colors.text} />
								</TouchableOpacity>
								<TouchableOpacity
									style={styles.iconButton}
									onPress={() => navigation.navigate("Hosting", { networkRef })}
								>
									<FontAwesome6 name="database" size={20} color={colors.text} />
								</TouchableOpacity>
							</View>
						</View>
						{exportTargetHash === networkRef.hash && (
							<FoundingBundleExportCard
								networkRef={networkRef}
								onClose={() => setExportTargetHash(null)}
							/>
						)}
						{inviteTargetHash === networkRef.hash && (
							<VoterInviteCard networkRef={networkRef} onClose={() => setInviteTargetHash(null)} />
						)}
					</React.Fragment>
				))}
				<CustomButton
					title={t("networkFoundingImportButton")}
					onPress={() => navigation.navigate("ImportFoundingBundle")}
				/>
				<CustomButton
					title={t("joinNetworkButton")}
					icon="right-to-bracket"
					testID="networks-join-network-button"
					onPress={() => navigation.navigate("JoinNetwork")}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("find")}</ThemedText>
				<CustomTextInput placeholder={t("enterAddressOrLocation")} />
				<ThemedText type="defaultSemiBold" style={styles.orSeparator}>
					{t("or")}
				</ThemedText>
				<CustomButton
					// Not implemented yet — say so, so the disabled styling reads as intended.
					title={t("useLocationComingSoon")}
					backgroundColor={colors.important}
					forceDarkText={true}
					disabled={true}
				/>
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("scanQrCode")}</ThemedText>
				<CustomButton title={t("scan")} icon="qrcode" onPress={handleScanQr} />
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("directAdvanced")}</ThemedText>
				<CustomTextInput
					placeholder={t("enterBootstrapPlaceholder")}
					value={bootstrapAddr}
					onChangeText={setBootstrapAddr}
					autoCapitalize="none"
					autoCorrect={false}
					onFocus={() => {
						directFocusedRef.current = true;
						if (Keyboard.isVisible()) {
							scrollDirectIntoView();
						}
					}}
					onBlur={() => {
						directFocusedRef.current = false;
					}}
				/>
				<CustomButton title={t("connect")} onPress={handleBootstrapConnect} />
				{joinError !== "" && (
					<ThemedText type="small" style={{ color: colors.error }}>
						{joinError}
					</ThemedText>
				)}
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	networkContainer: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 8,
	},
	infoCardContainer: {
		flex: 1,
		marginRight: 8,
	},
	// No fixed height: the column sizes to its buttons. A fixed 80 held two buttons; the third
	// (invite) overflowed it and the database button drew underneath Import Network.
	iconContainer: {
		justifyContent: "center",
	},
	// D-36: every entry in the column gets the minimum touch target (44x44).
	iconButton: {
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	input: {
		marginTop: 8,
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
	},
	orSeparator: {
		textAlign: "center",
		marginVertical: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
