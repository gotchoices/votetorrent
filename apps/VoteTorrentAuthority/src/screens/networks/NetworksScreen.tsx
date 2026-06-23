import { ExtendedTheme, useTheme, useNavigation, useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { multiaddr } from "@multiformats/multiaddr";
import { VOTETORRENT_SCHEMA_SQL } from "@votetorrent/vote-engine/rn";
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

export default function NetworksScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { networksEngine } = useApp();
	const { node } = useCadreNode();
	const [recentNetworkRefs, setRecentNetworkRefs] = useState<NetworkReference[]>([]);
	const [bootstrapAddr, setBootstrapAddr] = useState("");
	// NETOP-03 inline feedback — surfaces validation / join failures without crashing (T-22-09).
	const [joinError, setJoinError] = useState("");
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();

	// NETOP-03: join a strand from a pasted bootstrap multiaddr (advanced / dev fallback).
	// The multiaddr is parsed/validated BEFORE any use so a malformed paste produces an
	// inline error instead of crashing the node (T-22-09 DoS mitigation, Security V5).
	// The strandId is decoded from the multiaddr's peer component; binding it to the
	// network hash (D-05) for true cross-device sync is finalized in the Plan 05
	// two-device replication proof (the host advertises a known strandId there).
	const handleBootstrapConnect = useCallback(async () => {
		setJoinError("");
		let parsed: ReturnType<typeof multiaddr>;
		try {
			parsed = multiaddr(bootstrapAddr.trim());
		} catch {
			setJoinError(t("invalidBootstrapAddress"));
			return;
		}
		// Decode the peer component (/p2p/<id>) of the multiaddr as the strandId.
		const strandId = parsed.getComponents().find((c) => c.name === "p2p")?.value;
		if (!strandId || !node) {
			setJoinError(t("invalidBootstrapAddress"));
			return;
		}
		try {
			await node.addStrand({
				strandRow: { Id: strandId, MemberPrivateKey: null, Type: "o" },
				sAppConfig: {
					id: "org.votetorrent",
					version: "1.0.0",
					schema: VOTETORRENT_SCHEMA_SQL,
					latencyHint: "interactive",
				},
				// Joining an existing host → networked transactor (peers expected).
				mode: "networked",
			});
		} catch {
			setJoinError(t("joinFailed"));
		}
	}, [bootstrapAddr, node, t]);

	// QR scanning is not yet wired (no camera dependency — see Plan 05). Honest
	// placeholder: surface an inline note rather than a console stub.
	const handleScanQr = useCallback(() => {
		setJoinError(t("qrScanUnavailable"));
	}, [t]);

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

	return (
		<ScrollView
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
		>
			<View style={styles.section}>
				<ThemedText type="defaultSemiBold" style={styles.section}>
					{t("useOneOfTheFollowingToGetConnected")}
				</ThemedText>
				<ThemedText type="title">{t("connectedNetworks")}</ThemedText>
				{recentNetworkRefs.length === 0 && (
					// NETUI-01 empty-state: short hint when no recent networks.
					// The find/scan/bootstrap sections below remain the primary
					// entry points; this is purely an explanatory line.
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("noRecentNetworks")}
					</ThemedText>
				)}
				{recentNetworkRefs.map((networkRef) => (
					<View key={networkRef.hash} style={styles.networkContainer}>
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
								style={styles.iconButton}
								onPress={() => console.log("Share network:", networkRef.name)}
							>
								<FontAwesome6 name="share-nodes" size={20} color={colors.text} />
							</TouchableOpacity>
							<TouchableOpacity
								style={styles.iconButton}
								onPress={() => navigation.navigate("Hosting", { networkRef })}
							>
								<FontAwesome6 name="database" size={20} color={colors.text} />
							</TouchableOpacity>
						</View>
					</View>
				))}
			</View>

			<View style={styles.section}>
				<ThemedText type="title">{t("find")}</ThemedText>
				<CustomTextInput placeholder={t("enterAddressOrLocation")} />
				<ThemedText type="defaultSemiBold" style={styles.orSeparator}>
					{t("or")}
				</ThemedText>
				<CustomButton
					title={t("useLocation")}
					backgroundColor={colors.important}
					forceDarkText={true}
					onPress={() => console.log("Use location")}
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
	iconContainer: {
		justifyContent: "space-between",
		height: 80,
	},
	iconButton: {
		padding: 8,
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
