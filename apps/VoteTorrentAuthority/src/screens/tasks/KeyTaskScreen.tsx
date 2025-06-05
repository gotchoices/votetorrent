import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useRoute } from "@react-navigation/native";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { formatDate } from "../../utils/displayUtils";
import { CustomButton } from "../../components/CustomButton";
import { ReleaseKeyTask } from "@votetorrent/vote-core";
import { ElectionDetailsBlock } from "../elections/components/ElectionDetailsBlock";

export default function KeyTaskScreen() {
	const { task } = useRoute().params as { task: ReleaseKeyTask };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	const timeRemaining = () => {
		return "1h 30m";
	};

	const releaseKey = () => {
		console.log("releaseKey");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
						<ThemedText>{task.network.name}</ThemedText>
					</View>
				</View>
				<ElectionDetailsBlock electionDetails={task.election} />
				<View style={[styles.section, styles.ready]}>
					<ThemedText type="subtitle">{t("ready") + " - "}</ThemedText>
					<ThemedText type="subtitle" style={{ color: colors.error }}>
						{timeRemaining() + " " + t("remaining")}
					</ThemedText>
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("release")}
					icon="save"
					backgroundColor={colors.success}
					size="thin"
					onPress={() => {
						releaseKey();
					}}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
	},
	ready: {
		flexDirection: "row",
	},
});

const styles = { ...globalStyles, ...localStyles };
