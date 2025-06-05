import { View, StyleSheet } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import type { AuthoritySignatureTask } from "@votetorrent/vote-core";

export function AuthoritySignatureTaskDetails({ task }: { task: AuthoritySignatureTask }) {
	const { t } = useTranslation();
	return (
		<View style={[styles.section, styles.detailContainer]}>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
				<ThemedText>{task.type}</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
				<ThemedText>{task.network.name}</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("userSid")}: </ThemedText>
				<ThemedText>{task.userSid}</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
				<ThemedText>{task.authority.proposed.name}</ThemedText>
			</View>
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
});

const styles = { ...globalStyles, ...localStyles };
