import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { IUserEngine, UserKey, UserKeyType } from "@votetorrent/vote-core";
import { useNavigation, useRoute } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { User } from "@votetorrent/vote-core";
import { CustomButton } from "../../components/CustomButton";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useState } from "react";
import type { NavigationProp, RootStackParamList } from "../../navigation/types";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

export function AddKeyScreen() {
	const { user, userEngine } = useRoute().params as { user: User; userEngine: IUserEngine };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const [isAddingKey, setIsAddingKey] = useState(false);
	const [isSigned, setIsSigned] = useState(false);
	const [newKey, setNewKey] = useState<string | null>(null);
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;

	const scanDevice = () => {
		// TODO: Implement QR code scanning for device authentication
		setIsAddingKey(true);
	};

	const generateExternalKey = () => {
		// TODO: Implement external key generation (e.g., Yubikey)
		setIsAddingKey(true);
	};

	const addKey = async () => {
		if (!newKey) {
			// TODO: Show error message to user
			return;
		}

		const keyToAdd: UserKey = {
			key: newKey,
			type: UserKeyType.mobile,
			expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).getTime(),
		};
		userEngine
			.addKey(keyToAdd)
			.then(() => {
				setIsAddingKey(false);
				navigation.popTo("UserDetails", { user: user, userEngine: userEngine });
			})
			.catch((error) => {
				// TODO: Implement proper error logging
				setIsAddingKey(false);
			});
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("sid")}:</ThemedText>
						<ThemedText>{user.sid}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("name")}:</ThemedText>
						<ThemedText>{user.name}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("imageUrl")}:</ThemedText>
						<ThemedText style={styles.imageUrl} numberOfLines={1} ellipsizeMode="tail">
							{user.image?.url}
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
							<CustomButton title={t("scanDevice")} icon="qrcode" onPress={() => scanDevice()} />
						</View>
						<View style={styles.section}>
							<View style={styles.titleRow}>
								<ThemedText type="title">{t("addYubicoDongleKey")}</ThemedText>
								<FontAwesome6 name="circle-info" size={24} color={colors.text} />
							</View>
							<ThemedText type="link">{t("detailedInstructions")}</ThemedText>
							<ThemedText type="default">{t("addYubicoInstructions")}</ThemedText>
							<CustomButton
								title={t("generateExternalKey")}
								icon="hard-drive"
								onPress={() => generateExternalKey()}
							/>
						</View>
					</View>
				)}
			</ScrollView>
			{isAddingKey && (
				<View style={[styles.footer, { backgroundColor: colors.card }]}>
					<CustomButton
						title={t("add")}
						icon="save"
						backgroundColor={colors.success}
						disabled={!isSigned}
						onPress={() => {
							addKey();
						}}
					/>
				</View>
			)}
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
