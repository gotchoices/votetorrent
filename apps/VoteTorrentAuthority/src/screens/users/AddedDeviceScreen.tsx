import { StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { useRoute } from "@react-navigation/native";

export function AddedDeviceScreen() {
	const { t } = useTranslation();
	const { multiaddress, token } = useRoute().params as { multiaddress: string; token: string };

	return (
		<View style={styles.container}>
			<ThemedText type="defaultSemiBold">{t("deviceAdded")}:</ThemedText>
			<View style={[styles.section, styles.detailContainer]}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("multiaddress")}:</ThemedText>
					<ThemedText style={styles.valueText} numberOfLines={2} ellipsizeMode="middle">
						{multiaddress}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("token")}:</ThemedText>
					<ThemedText>{token}</ThemedText>
				</View>
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
	valueText: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default AddedDeviceScreen;
