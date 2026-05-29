import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { CustomButton } from "../../components/CustomButton";
import { useTheme, ExtendedTheme } from "@react-navigation/native";

const MOCK_MULTIADDRESS = "/dns/relayrus.com/tcp/22134/vtad";
const MOCK_TOKEN = "1234567890";

export function AddDeviceScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

	return (
		<View style={styles.content}>
			<View style={styles.container}>
				<ThemedText type="defaultSemiBold">{t("qrInformation")}:</ThemedText>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("multiaddress")}:</ThemedText>
						<ThemedText>{MOCK_MULTIADDRESS}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("token")}:</ThemedText>
						<ThemedText>{MOCK_TOKEN}</ThemedText>
					</View>
				</View>
				<ThemedText type="default">{t("fromOtherDevice")}</ThemedText>
			</View>
			<View style={[styles.footer, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
				<CustomButton
					title={t("done")}
					icon="check"
					backgroundColor={colors.success}
					onPress={() => navigation.navigate("AddedDevice", { multiaddress: MOCK_MULTIADDRESS, token: MOCK_TOKEN })}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		marginLeft: 8,
	},
	detail: {
		flexDirection: "row",
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default AddDeviceScreen;
