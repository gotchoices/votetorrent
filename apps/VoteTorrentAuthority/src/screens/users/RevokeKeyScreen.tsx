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
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { errorCopy } from "../../utils/errorCopy";

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
	const [isSigning, setIsSigning] = useState(false);
	const [isRevoking, setIsRevoking] = useState(false);
	const navigation = useNavigation();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

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
		// WR-02 / IN-02: reset the signed state when the selection changes so the user
		// must re-sign before Revoke is re-enabled — they cannot revoke under a signature
		// they did not review after toggling keys.
		setIsSigned(false);
		setRealSignature(null);
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
		setIsSigning(true);
		try {
			// WR-02: only the device user can revoke their own keys. Verify subject == device
			// user before producing any signature, so the device signer's signerKey is always
			// the subject's active key and the engine's context.UserKey authenticates the correct
			// identity.
			const deviceUser = await getOrCreateDeviceUser(user.name);
			if (deviceUser.id !== user.id) {
				setErrorMessage("You can only revoke keys for the device's own user.");
				return;
			}

			// WR-03: guard undefined firstKey before signing.
			const firstKey = Array.from(selectedKeys)[0];
			if (firstKey === undefined) {
				setErrorMessage("Select at least one key to sign.");
				return;
			}

			// D-01: createDeviceSigner closes over the private key app-side —
			// only the resulting Signature crosses into vote-engine.
			// WR-10: secp256k1.sign called with v2 defaults (prehash:true) inside signer.
			// CR-05/UKEY-02: do NOT precompute a single combined-keys signature here —
			// each key is signed at revoke time over its OWN canonical digest (D-20 / 49-05:
			// UserEngine.getRevokeKeyDigest -- Digest(UserId, PubKey), the engine's single
			// definition of the revoke pre-image; the screen never recomputes a canonical
			// form itself, per D-03) so the signature is bound to that specific key. We only
			// validate the device signer is available and gate the confirmation UX. For the
			// "Signed: <signature>" display we sign the FIRST selected key's digest, never a
			// combined-keys payload.
			const signer = await createDeviceSigner(user.name);
			const previewDigest = await userEngine.getRevokeKeyDigest(firstKey);
			const previewSig = await signer(previewDigest);
			setRealSignature(previewSig);
			setIsSigned(true);
		} catch (error) {
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? errorCopy(error, t, "write"));
		} finally {
			setIsSigning(false);
		}
	};

	const handleRevoke = async () => {
		setErrorMessage("");
		setIsRevoking(true);
		try {
			if (!isSigned) {
				setErrorMessage("Signature is required — please sign before revoking.");
				return;
			}
			// CR-05/UKEY-02: sign each key at revoke time over its OWN canonical digest
			// (D-20 / 49-05: UserEngine.getRevokeKeyDigest -- Digest(UserId, PubKey)) so every
			// revocation carries its OWN signature bound to that specific key — never a single
			// combined-key signature reused across keys. The screen never constructs the signed
			// bytes itself (D-03); it only ever signs exactly what the engine hands back.
			const signer = await createDeviceSigner(user.name);
			await Promise.all(
				Array.from(selectedKeys).map(async (key) => {
					const digest = await userEngine.getRevokeKeyDigest(key);
					const perKeySignature = await signer(digest);
					await userEngine.revokeKey(key, perKeySignature);
				})
			);
			navigation.goBack();
		} catch (error) {
			// D-20 / 49-05: a rejected revoke (forged or wrong signature) surfaces as the
			// UserKey.DeleteValid CHECK constraint failing — match on the constraint identifier
			// (not free-text English) so this narrow branch renders a real, actionable message
			// instead of the raw Quereus error string. This is evaluated FIRST, before the
			// device-signing handler: a schema CHECK rejection carries no native `code`, so
			// isDeviceSigningError would classify it as "not mine" and the handler would pass
			// it through regardless — but keeping the ordering explicit here avoids a future
			// reader reversing it. Every other revokeKey failure mode goes through the
			// shared handler below and then errorCopy: translated copy, never the raw message.
			if (error instanceof Error && error.message.includes("DeleteValid")) {
				setErrorMessage(t("revokeKeySignatureInvalid"));
				return;
			}
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? errorCopy(error, t, "write"));
		} finally {
			setIsRevoking(false);
		}
	};

	return (
		<KeyboardAvoidingScreen>
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
					title={isSigning ? `${t("sign")}…` : t("sign")}
					icon={"signature"}
					backgroundColor={colors.important}
					onPress={() => handleSign()}
					disabled={!readyToSign || selectedKeys.size === 0 || isSigning}
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
					title={isRevoking ? `${t("revoke")}…` : t("revoke")}
					icon={"trash"}
					backgroundColor={colors.success}
					onPress={() => handleRevoke()}
					disabled={!isSigned || selectedKeys.size === 0 || isRevoking}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
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
