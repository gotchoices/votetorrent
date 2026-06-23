import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View, Image } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { globalStyles } from "../../theme/styles";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useApp } from "../../providers/AppProvider";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import type { IDefaultUserEngine, INetworksEngine, NetworkInit, NetworkReference } from "@votetorrent/vote-core";
import { ElectionType } from "@votetorrent/vote-core";
import type { RootStackParamList } from "../../navigation/types";

export default function AddNetworkScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine, networksEngine, selectNetwork } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const [networkName, setNetworkName] = useState("");
	const [networkImageUrl, setNetworkImageUrl] = useState("");
	const [authorityName, setAuthorityName] = useState("");
	const [authorityImageUrl, setAuthorityImageUrl] = useState("");
	const [domainName, setDomainName] = useState("");
	const [adminName, setAdminName] = useState("");
	const [adminTitle, setAdminTitle] = useState("");
	const [isSigned, setIsSigned] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [relayAddresses, setRelayAddresses] = useState([""]);
	// Election Characteristics (Figma "New Network" frame) — keyholder usage and
	// single-vs-multiple authority.
	const [useKeyholders, setUseKeyholders] = useState(true);
	// CR-01: single-vs-multiple authority is not yet representable in NetworkInit;
	// the network is always created single-authority, so no toggle state is kept.
	// 16-08 item 4: surface the ACTUAL submit failure inline (not just console.error).
	const [errorMessage, setErrorMessage] = useState<string>("");
	const scrollViewRef = useRef<ScrollView>(null);

	const toggleAdvanced = () => {
		if (!showAdvanced) {
			setTimeout(() => {
				scrollViewRef.current?.scrollToEnd({ animated: true });
			}, 100);
		}
		setShowAdvanced(!showAdvanced);
	};

	const addRelayField = () => {
		setRelayAddresses([...relayAddresses, ""]);
	};

	const updateRelayAddress = (index: number, value: string) => {
		const newAddresses = [...relayAddresses];
		newAddresses[index] = value;
		setRelayAddresses(newAddresses);
	};

	const removeRelayField = (index: number) => {
		if (relayAddresses.length > 1) {
			const newAddresses = relayAddresses.filter((_, i) => i !== index);
			setRelayAddresses(newAddresses);
		}
	};

	const handleMakePermanent = () => {
		// Phase 22: media-pin to content-addressed storage (CID) — not yet implemented.
	};

	const handleCreate = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		// CR-01: the "Sign" affordance gates creation of a signed permanent record.
		// Do not create the network unless the administrator has signed.
		if (!isSigned) {
			setErrorMessage(t("mustSignBeforeCreating"));
			return;
		}
		try {
			// Resolve NetworksEngine — available directly from AppProvider context (D-03).
			if (!networksEngine) {
				console.error("handleCreate: networksEngine not yet initialized");
				setErrorMessage("Networks engine not yet initialized — please wait and try again.");
				return;
			}
			const networksEng = networksEngine as INetworksEngine;

			// Resolve device identity (D-02 / generate-on-first-run).
			const defaultUserEng = await getEngine<IDefaultUserEngine>("defaultUser");
			const defaultUser = await defaultUserEng.get();
			const user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");

			// Assemble NetworkInit from the 11 form-state fields (D-03).
			// ThresholdPolicy uses `policy` field (not `scope`) per vote-core interface.
			const networkInit: NetworkInit = {
				name: networkName,
				imageUrl: networkImageUrl || undefined,
				relays: relayAddresses.filter(Boolean),
				primaryAuthority: {
					name: authorityName,
					domainName: domainName,
				},
				admin: {
					officers: [
						{
							init: {
								name: adminName,
								title: adminTitle,
								scopes: ["rn", "rad", "iad", "uai", "mel", "ceb"],
							},
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [
						{ policy: "rn", threshold: 1 },
						{ policy: "mel", threshold: 1 },
						{ policy: "ceb", threshold: 1 },
					],
				},
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 0,
					electionType: useKeyholders ? ElectionType.official : ElectionType.adhoc,
				},
			};

			// Route through v1.1 NetworksCreateBuilder (D-03).
			// INetworksCreateBuilder.update() is the typed API for setting both fields
			// (setNetworkInit/setUser are on the concrete class, not the interface).
			const builder = networksEng.buildCreate().update({ networkInit, user });
			if (!builder.isValid()) {
				console.error("handleCreate: validation errors", builder.errors());
				setErrorMessage(
					builder.errors().map((e) => e.message).join("\n") || "Validation failed.",
				);
				return;
			}
			const networkEngine = await builder.commit();

			// Pitfall 4: re-establish currentNetworkHash in the factory by calling
			// getEngine("network", ref) with the full NetworkReference that the concrete
			// NetworkEngine exposes via its `init` property. INetworkEngine does not
			// declare `init` in the interface, so we access it via a cast.
			// This allows sibling engines (elections, signing, etc.) to resolve the
			// established ctx immediately after create without a separate open().
			const networkRef = (networkEngine as unknown as { init: NetworkReference }).init;
			// Auto-select the just-created network: bind it AND flip hasNetwork so the
			// app lands on the populated network home instead of "No network selected".
			// (selectNetwork re-establishes currentNetworkHash like the old getEngine call,
			// plus sets hasNetwork — Pitfall 4 still satisfied via its internal getEngine.)
			await selectNetwork(networkRef);
		} catch (err) {
			console.error("handleCreate error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
			return;
		}
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView ref={scrollViewRef} style={styles.container}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("createNewNetwork")}
				</ThemedText>

				<View style={styles.section}>
					<CustomTextInput title={t("name")} value={networkName} onChangeText={setNetworkName} />
					<CustomTextInput
						title={t("imageUrl")}
						value={networkImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setNetworkImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{networkImageUrl ? (
						<Image
							source={{ uri: networkImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
				</View>

				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("electionCharacteristics")}
					</ThemedText>
					<View style={styles.characteristicsGrid}>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(true)}
						>
							<View style={[styles.radioOuter, { borderColor: useKeyholders ? colors.primary : colors.textSecondary }]}>
								{useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("useKeyholders")}</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(false)}
						>
							<View style={[styles.radioOuter, { borderColor: !useKeyholders ? colors.primary : colors.textSecondary }]}>
								{!useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("noKeyholders")}</ThemedText>
						</TouchableOpacity>
					</View>
					{/* CR-01: NetworkInit can only represent a single primary authority, so
					    the multi-authority option is disabled (rather than a live control
					    that silently drops the user's choice). Single authority is always used. */}
					<View style={styles.characteristicsGrid}>
						<View style={styles.radioOption}>
							<View style={[styles.radioOuter, { borderColor: colors.primary }]}>
								<View style={[styles.radioInner, { backgroundColor: colors.primary }]} />
							</View>
							<ThemedText style={styles.radioLabel}>{t("singleAuthority")}</ThemedText>
						</View>
						<View style={[styles.radioOption, { opacity: 0.4 }]}>
							<View style={[styles.radioOuter, { borderColor: colors.textSecondary }]} />
							<ThemedText style={styles.radioLabel}>{t("multipleAuthorityNotYetSupported")}</ThemedText>
						</View>
					</View>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("primaryAuthority")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={authorityName}
						onChangeText={setAuthorityName}
					/>
					<CustomTextInput
						title={t("imageUrl")}
						value={authorityImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setAuthorityImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{authorityImageUrl ? (
						<Image
							source={{ uri: authorityImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
					<CustomTextInput
						title={t("domainName")}
						value={domainName}
						onChangeText={setDomainName}
					/>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("initialAdministrator")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={adminName}
						placeholder={t("yourNameOnPermanentRecord")}
						onChangeText={setAdminName}
					/>
					<CustomTextInput
						title={t("title")}
						value={adminTitle}
						placeholder={t("yourTitleOnPermanentRecord")}
						onChangeText={setAdminTitle}
					/>
					<CustomButton
						title={t("sign")}
						icon={isSigned ? "square-check" : "square"}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={() => setIsSigned(!isSigned)}
					/>
				</View>

				<TouchableOpacity
					style={styles.advancedHeader}
					onPress={() => {
						toggleAdvanced();
					}}
				>
					<FontAwesome6
						name={showAdvanced ? "chevron-down" : "chevron-right"}
						size={14}
						color={colors.text}
					/>
					<ThemedText type="default">{t("advanced")}</ThemedText>
				</TouchableOpacity>
				{showAdvanced ? (
					<View style={styles.section}>
						<View style={[styles.buttonHeader, styles.sectionTitle]}>
							<ThemedText type="title">{t("relays")}</ThemedText>
							<ChipButton
								label={t("import")}
								icon="circle-plus"
								onPress={() => console.log("Import")}
							/>
						</View>
						{relayAddresses.map((address, index) => (
							<CustomTextInput
								key={index}
								placeholder={t("multiaddress")}
								value={address}
								onChangeText={(value) => updateRelayAddress(index, value)}
								icon={relayAddresses.length > 1 ? "circle-xmark" : undefined}
								onIconPress={() => removeRelayField(index)}
							/>
						))}
						<View style={styles.buttonHeader}>
							<View />
							<ChipButton label={t("addRelay")} icon="circle-plus" onPress={addRelayField} />
						</View>
					</View>
				) : null}
			</ScrollView>

			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}
			<Footer>
				<CustomButton
					title={t("create")}
					icon="floppy-disk"
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={handleCreate}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	fieldLabel: {
		marginBottom: 8,
	},
	input: {
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
		marginTop: 8,
	},
	buttonHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	permanentSection: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
	characteristicsGrid: {
		flexDirection: "row",
		marginTop: 12,
	},
	radioOption: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	radioOuter: {
		width: 20,
		height: 20,
		borderRadius: 10,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 8,
	},
	radioInner: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	radioLabel: {
		flex: 1,
	},
	signButton: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 16,
		padding: 16,
		borderRadius: 32,
		borderWidth: 1,
	},
	signText: {
		fontSize: 16,
		fontWeight: "600",
	},
	advancedHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
	relayFieldContainer: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 8,
	},
	removeButtonContainer: {
		width: 40,
		alignItems: "center",
	},
	removeButton: {
		padding: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
