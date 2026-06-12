import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { IUserEngine, UserKeyType } from "@votetorrent/vote-core";
import { useNavigation, useRoute } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { User } from "@votetorrent/vote-core";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useState } from "react";
import type { NavigationProp, RootStackParamList } from "../../navigation/types";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSettings } from "../../providers/SettingsProvider";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";

export function AddKeyScreen() {
	const { user, userEngine } = useRoute().params as { user: User; userEngine: IUserEngine };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const [isAddingKey, setIsAddingKey] = useState(false);
	const [isSigned, setIsSigned] = useState(false);
	const [newKey, setNewKey] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState("");
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { showHelpIcons } = useSettings();

	// Phase 22: scan device (P2P external-key flow) — not available yet
	const scanDevice = () => {
		// Available in Phase 22
	};

	// Phase 22: generate external (Yubico/hardware) key — not available yet
	const generateExternalKey = () => {
		// Available in Phase 22
	};

	const handleGenerateAndAddKey = async () => {
		setErrorMessage("");

		// D-04: the device user always has one key from getOrCreateDeviceUser.
		// first-key path only fires for a user created WITHOUT a key (e.g. in tests).
		const isFirstKey = user.activeKeys.length === 0;
		if (!isFirstKey) {
			// D-04 honest state — adding a subsequent key requires signing (Phase 21)
			setErrorMessage("Adding a subsequent key requires signing (Phase 21).");
			return;
		}

		try {
			// Generate a real secp256k1 keypair (CSPRNG — T-20-09 mitigation)
			// Mirror device-user.ts:49-54 exactly
			const privKey = secp256k1.utils.randomSecretKey();
			const pubKey = secp256k1.getPublicKey(privKey, true); // compressed (33 bytes)
			// AUTH-01: bytesToHex is mandatory — do NOT use native Uint8Array serializer
			const pubHex = bytesToHex(pubKey);
			// Security: privKey stays local — NEVER logged, NEVER passed to addKey (T-20-08)

			const expiration = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
			await userEngine.addKey({ key: pubHex, type: UserKeyType.mobile, expiration });
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("id")}:</ThemedText>
						<ThemedText>{user.id}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("name")}:</ThemedText>
						<ThemedText>{user.name}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("imageUrl")}:</ThemedText>
						<ThemedText style={styles.imageUrl} numberOfLines={1} ellipsizeMode="tail">
							{(user as any).image?.url}
						</ThemedText>
					</View>
				</View>
				{isAddingKey ? (
					<View>
						<View>
							<ThemedText type="defaultSemiBold">{t("successfullyScannedKey")}:</ThemedText>
							<ThemedText>{newKey}</ThemedText>
						</View>
						<CustomButton
							title={t("sign")}
							icon="signature"
							backgroundColor={colors.important}
							onPress={() => {
								setIsSigned(true);
							}}
						/>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("signed")}:</ThemedText>
							<ThemedText>{newKey}</ThemedText>
						</View>
					</View>
				) : (
					<View>
						<View style={styles.section}>
							<ThemedText type="title">{t("scanQrCode")}</ThemedText>
							<ThemedText type="default">{t("addAnotherDeviceQrCode")}</ThemedText>
							<CustomButton
								title={t("scanDevice")}
								icon="qrcode"
								disabled={true}
								onPress={() => scanDevice()}
							/>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{"(Available in Phase 22)"}
							</ThemedText>
						</View>
						<View style={styles.section}>
							<View style={styles.titleRow}>
								<ThemedText type="title">{t("addYubicoDongleKey")}</ThemedText>
								{showHelpIcons && <FontAwesome6 name="circle-info" size={24} color={colors.text} />}
							</View>
							<ThemedText type="link">{t("detailedInstructions")}</ThemedText>
							<ThemedText type="default">{t("addYubicoInstructions")}</ThemedText>
							<CustomButton
								title={t("generateExternalKey")}
								icon="hard-drive"
								disabled={true}
								onPress={() => generateExternalKey()}
							/>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{"(Available in Phase 22)"}
							</ThemedText>
						</View>
					</View>
				)}
				{errorMessage ? (
					<View style={styles.section}>
						<ThemedText type="small" style={{ color: colors.error }}>
							{errorMessage}
						</ThemedText>
					</View>
				) : null}
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("addKey")}
					icon="save"
					backgroundColor={colors.success}
					onPress={() => {
						handleGenerateAndAddKey();
					}}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		gap: 4,
	},
	imageUrl: {
		flex: 1,
	},
	detailContainer: {
		width: "100%",
	},
	titleRow: {
		flexDirection: "row",
		justifyContent: "space-between",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default AddKeyScreen;
