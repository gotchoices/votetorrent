import React, { useState } from "react";
import { View, StyleSheet, Image, ScrollView } from "react-native";
import { useTheme, ExtendedTheme, useRoute, useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomTextInput } from "../../components/CustomTextInput";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { globalStyles } from "../../theme/styles";
import type { User, IUserEngine, ImageRef, ReviseUserHistory, Signature } from "@votetorrent/vote-core";
import { UserHistoryEvent } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import type { RootStackParamList } from "../../navigation/types";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { createDeviceSigner } from "../../engines/device-signer";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export function ReviseUserScreen() {
	const { user, userEngine } = useRoute().params as {
		user: User;
		userEngine: IUserEngine;
	};
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	const [userState, setUserState] = useState<User>(user);
	const [realSignature, setRealSignature] = useState<Signature | null>(null);
	const [edited, setEdited] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>("");

	const handleSave = async () => {
		setErrorMessage("");
		try {
			if (!realSignature) {
				setErrorMessage("Signature is required — please sign before saving.");
				return;
			}

			const reviseUserHistory: ReviseUserHistory = {
				event: UserHistoryEvent.revise,
				info: {
					name: userState.name,
					image: userState.image as ImageRef,
				},
				timestamp: Date.now(),
				signature: realSignature,
			};
			await userEngine.revise(reviseUserHistory);
			navigation.popTo("UserDetails", { user: userState, userEngine });
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	const handleImageUrlChange = (text: string) => {
		setUserState({ ...userState, image: { url: text } });
		if (text.startsWith("http")) {
			setUserState({ ...userState, image: { url: text } });
		}
		setEdited(true);
	};

	const handleNameChange = (text: string) => {
		setUserState({ ...userState, name: text });
		setEdited(true);
	};

	const handleSign = async () => {
		setErrorMessage("");
		try {
			// D-01: createDeviceSigner closes over the private key app-side —
			// only the resulting Signature crosses into vote-engine.
			// D-03: the callback signs EXACTLY the bytes handed to it; we sign
			// a representative revise payload so the signature is tied to this revision.
			// WR-10: secp256k1.sign called with v2 defaults (prehash:true) inside the signer.
			const signer = await createDeviceSigner(userState.name);
			const payloadBytes = utf8ToBytes(
				`revise:${userState.id}:${userState.name}`
			);
			const sig = await signer(payloadBytes);
			setRealSignature(sig);
		} catch (error) {
			setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.section, styles.detailContainer]}>
					<ThemedText type="defaultSemiBold">{t("id")}:</ThemedText>
					<ThemedText>{userState.id}</ThemedText>
				</View>
				<View style={styles.section}>
					<CustomTextInput
						title={t("name")}
						value={userState.name}
						onChangeText={handleNameChange}
						placeholder={t("enterName")}
					/>
					<CustomTextInput
						title={t("imageUrl")}
						value={userState.image?.url}
						onChangeText={handleImageUrlChange}
						isImageUrlField={true}
						makePermanentPressed={() => {}}
						placeholder={t("enterImageUrl")}
						keyboardType="url"
						autoCapitalize="none"
					/>
					{userState.image?.url && (
						<Image
							source={{ uri: userState.image.url }}
							style={styles.image}
							resizeMode="contain"
						/>
					)}
				</View>
				<View style={styles.section}>
					<CustomButton
						title={t("sign")}
						backgroundColor={colors.important}
						icon="signature"
						disabled={!edited}
						forceDarkText={true}
						onPress={() => {
							handleSign();
						}}
					/>
					{realSignature && (
						<View style={styles.detailContainer}>
							<ThemedText type="defaultSemiBold">{t("signature")}:</ThemedText>
							<ThemedText numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
								{realSignature.signature}
							</ThemedText>
						</View>
					)}
				</View>
				{errorMessage ? (
					<ThemedText type="small" style={{ color: colors.error }}>
						{errorMessage}
					</ThemedText>
				) : null}
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("save")}
					onPress={handleSave}
					forceDarkText={false}
					icon={"save"}
					disabled={!realSignature}
					backgroundColor={colors.success}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	image: {
		height: 200,
		marginTop: 10,
	},
	detailContainer: {
		flexDirection: "row",
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default ReviseUserScreen;
