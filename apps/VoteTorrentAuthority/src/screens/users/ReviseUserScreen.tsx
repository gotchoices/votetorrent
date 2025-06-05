import React, { useState } from "react";
import { View, StyleSheet, Image, ScrollView } from "react-native";
import { useTheme, ExtendedTheme, useRoute, useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomTextInput } from "../../components/CustomTextInput";
import { CustomButton } from "../../components/CustomButton";
import { globalStyles } from "../../theme/styles";
import type { User, IUserEngine, ImageRef, ReviseUserHistory } from "@votetorrent/vote-core";
import { UserHistoryEvent } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import type { RootStackParamList } from "../../navigation/types";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

export function ReviseUserScreen() {
	const { user, userEngine } = useRoute().params as {
		user: User;
		userEngine: IUserEngine;
	};
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	const [userState, setUserState] = useState<User>(user);
	const [newSignature, setNewSignature] = useState<string>("");
	const [edited, setEdited] = useState(false);

	const handleSave = async () => {
		try {
			if (!newSignature) {
				console.error("Signature is missing");
				return;
			}

			const reviseUserHistory: ReviseUserHistory = {
				event: UserHistoryEvent.revise,
				info: {
					name: userState.name,
					image: userState.image as ImageRef,
				},
				timestamp: Date.now(),
				signature: {
					signature: newSignature,
					signerKey: "mock-signer-key",
				},
			};
			await userEngine.revise(reviseUserHistory);
			navigation.popTo("UserDetails", { user: userState, userEngine });
		} catch (error) {
			console.error("Error saving user:", error);
			//TODO: Show an alert to the user
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

	const handleSign = () => {
		setNewSignature(userState.sid);
		//TODO: Actually handle the signing
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.section, styles.detailContainer]}>
					<ThemedText type="defaultSemiBold">{t("sid")}:</ThemedText>
					<ThemedText>{userState.sid}</ThemedText>
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
					{newSignature && (
						<View style={styles.detailContainer}>
							<ThemedText type="defaultSemiBold">{t("signature")}:</ThemedText>
							<ThemedText>{newSignature}</ThemedText>
						</View>
					)}
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("save")}
					onPress={handleSave}
					forceDarkText={false}
					icon={"save"}
					disabled={!newSignature}
					backgroundColor={colors.success}
				/>
			</View>
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
