import { StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { useTranslation } from "react-i18next";

export function AddDeviceScreen() {
	const { t } = useTranslation();

	return (
		<View style={styles.container}>
			<ThemedText type="defaultSemiBold">{t("qrInformation")}:</ThemedText>
			<View style={[styles.section, styles.detailContainer]}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("multiaddress")}:</ThemedText>
					<ThemedText>/dns/relayrus.com/tcp/22134/vtad</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("token")}:</ThemedText>
					<ThemedText>1234567890</ThemedText>
				</View>
			</View>
			<ThemedText type="default">{t("fromOtherDevice")}</ThemedText>
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
