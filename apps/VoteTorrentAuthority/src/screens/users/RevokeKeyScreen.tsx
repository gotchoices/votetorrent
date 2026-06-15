import { ScrollView, StyleSheet, View, TouchableOpacity } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { globalStyles } from "../../theme/styles";
import type { IUserEngine, Signature } from "@votetorrent/vote-core";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { User } from "@votetorrent/vote-core";
import { ExtendedTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { formatDate } from "../../utils/displayUtils";
import { getKeyTypeDisplayName } from "../../utils/displayUtils";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useState } from "react";
import { CustomTextInput } from "../../components/CustomTextInput";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { createDeviceSigner } from "../../engines/device-signer";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export function RevokeKeyScreen() {
	const { user, userEngine } = useRoute().params as { user: User; userEngine: IUserEngine };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [confirmText, setConfirmText] = useState("");
	const [readyToSign, setReadyToSign] = useState(false);
	const [isSigned, setIsSigned] = useState(false);
	const [realSignature, setRealSignature] = useState<Signature | null>(null);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const navigation = useNavigation();

	const toggleKeySelection = (keyId: string) => {
		setSelectedKeys((prevSelectedKeys) => {
			const newSelectedKeys = new Set(prevSelectedKeys);
			if (newSelectedKeys.has(keyId)) {
				newSelectedKeys.delete(keyId);
			} else {
				newSelectedKeys.add(keyId);
			}
			return newSelectedKeys;
		});
	};

	const checkConfirmText = (text: string) => {
		setConfirmText(text);
		if (text === t("iConfirm")) {
			setReadyToSign(true);
		} else {
			setReadyToSign(false);
		}
	};

	const handleSign = async () => {
		setErrorMessage("");
		try {
			// D-01: createDeviceSigner closes over the private key app-side —
			// only the resulting Signature crosses into vote-engine.
			// D-03: the callback signs EXACTLY the bytes handed to it; we sign a
			// representative revoke payload tied to the selected keys and user.
			// WR-10: secp256k1.sign called with v2 defaults (prehash:true) inside signer.
			const signer = await createDeviceSigner(user.name);
			const keysHex = Array.from(selectedKeys).sort().join(",");
			const payloadBytes = utf8ToBytes(
				`revokeKey:${user.id}:${keysHex}`
			);
			const sig = await signer(payloadBytes);
			setRealSignature(sig);
			setIsSigned(true);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	const handleRevoke = async () => {
		setErrorMessage("");
		try {
			if (!realSignature) {
				setErrorMessage("Signature is required — please sign before revoking.");
				return;
			}
			await Promise.all(
				Array.from(selectedKeys).map((key) => userEngine.revokeKey(key, realSignature))
			);
			navigation.goBack();
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
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
							{(user as any).image?.url ?? "N/A"}
						</ThemedText>
					</View>
				</View>

				<View>
					<ThemedText type="subtitle" style={localStyles.activeKeysTitle}>
						{t("activeKeys")}:{" "}
					</ThemedText>
					<View style={styles.keysListContainer}>
						{user.activeKeys.length > 0 ? (
							user.activeKeys.map((key, index) => {
								const isSelected = selectedKeys.has(key.key);
								const revokeTextStyle = isSelected
									? { color: colors.error }
									: { color: colors.warning };
								const revokeText = isSelected ? t("revoke") : t("unchanged");
								const iconName = isSelected ? "square-check" : "square";

								return (
									<View key={key.key || index} style={styles.keyRow}>
										<TouchableOpacity
											onPress={() => toggleKeySelection(key.key)}
											style={styles.keyCheckContainer}
										>
											<FontAwesome6
												style={styles.keyCheck}
												name={iconName}
												size={16}
												color={colors.text}
											/>
										</TouchableOpacity>
										<View style={styles.keyIdContainer}>
											<ThemedText style={styles.keyIdText} numberOfLines={1} ellipsizeMode="middle">
												{key.key}
											</ThemedText>
											<ThemedText type="tiny" style={revokeTextStyle}>
												{revokeText}
											</ThemedText>
										</View>
										<View style={styles.keyDetails}>
											<View style={styles.keyDetailRow}>
												<ThemedText type="tinyBold">{t("type")}: </ThemedText>
												<ThemedText type="tiny">{t(getKeyTypeDisplayName(key.type))}</ThemedText>
											</View>
											<View style={styles.keyDetailRow}>
												<ThemedText type="tinyBold">{t("expiration")}: </ThemedText>
												<ThemedText type="tiny">{formatDate(key.expiration)}</ThemedText>
											</View>
										</View>
									</View>
								);
							})
						) : (
							<ThemedText style={styles.noKeysText}>{t("noActiveKeysFound")}</ThemedText>
						)}
					</View>
				</View>
				<ThemedText type="default">{t("warningIrrevocableAction")}</ThemedText>
				<View style={styles.largeWarningIconContainer}>
					<FontAwesome6 name="triangle-exclamation" size={70} color={colors.warning} />
				</View>
				<CustomTextInput
					title={t("typeIConfirm")}
					placeholder={t("confirmIfSure")}
					value={confirmText}
					onChangeText={(text) => checkConfirmText(text)}
				/>
				<CustomButton
					title={t("sign")}
					icon={"signature"}
					backgroundColor={colors.important}
					onPress={() => handleSign()}
					disabled={!readyToSign || selectedKeys.size === 0}
				/>
				{isSigned && realSignature && (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("signed")}: </ThemedText>
						<ThemedText style={styles.imageUrl} numberOfLines={1} ellipsizeMode="middle">
							{realSignature.signature}
						</ThemedText>
					</View>
				)}
				{errorMessage ? (
					<ThemedText type="small" style={{ color: colors.error }}>
						{errorMessage}
					</ThemedText>
				) : null}
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("revoke")}
					icon={"trash"}
					backgroundColor={colors.success}
					onPress={() => handleRevoke()}
					disabled={!isSigned || selectedKeys.size === 0}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		width: "100%",
	},
	detail: {
		flexDirection: "row",
		gap: 4,
	},
	imageUrl: {
		flex: 1,
	},
	activeKeysTitle: {
		marginBottom: 10,
		fontWeight: "bold",
		fontSize: 16,
	},
	keysListContainer: {
		marginTop: 5,
	},
	keyRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 8,
		paddingLeft: 12,
	},
	keyIdText: {
		flexShrink: 1,
		marginRight: 10,
	},
	keyDetails: {
		justifyContent: "space-between",
		alignItems: "flex-end",
		paddingTop: 4,
	},
	keyDetailRow: {
		flexDirection: "row",
		paddingBottom: 16,
	},
	noKeysText: {
		fontStyle: "italic",
		marginTop: 5,
	},
	keyCheck: {
		marginRight: 16,
		marginTop: 10,
	},
	keyIdContainer: {
		flex: 1,
	},
	keyCheckContainer: {
		padding: 4,
	},
	largeWarningIconContainer: {
		marginVertical: 10,
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default RevokeKeyScreen;
