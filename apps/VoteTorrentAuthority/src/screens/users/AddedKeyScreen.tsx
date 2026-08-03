import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { User, UserKeyType } from "@votetorrent/vote-core";
import type { RootStackParamList } from "../../navigation/types";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { formatDate, getKeyTypeDisplayName } from "../../utils/displayUtils";

export function AddedKeyScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { user, keyValue, keyType, expiration } = useRoute().params as {
		user: User;
		keyValue: string;
		keyType: string;
		expiration: number;
	};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	const onDone = () => {
		// Stack is UserDetails -> AddKey -> AddedKey; pop both so Done returns to User Details
		// (where the new key appears), not the Add Key form.
		navigation.pop(2);
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("id")}: </ThemedText>
						<ThemedText>{user.id}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
						<ThemedText>{user.name}</ThemedText>
					</View>
				</View>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("key")}: </ThemedText>
						<ThemedText style={styles.keyValue} numberOfLines={2} ellipsizeMode="middle">
							{keyValue}
						</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
						<ThemedText>{t(getKeyTypeDisplayName(keyType as UserKeyType))}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("expiration")}: </ThemedText>
						<ThemedText>{formatDate(expiration)}</ThemedText>
					</View>
				</View>
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("done")}
					icon="check"
					backgroundColor={colors.success}
					onPress={onDone}
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
	keyValue: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default AddedKeyScreen;
