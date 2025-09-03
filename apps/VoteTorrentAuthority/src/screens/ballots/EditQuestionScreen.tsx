import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTheme } from "@react-navigation/native";
import { ExtendedTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { ChipButton } from "../../components/ChipButton";
import QuestionTypeSelector from "./components/QuestionTypeSelector";
import { CustomButton } from "../../components/CustomButton";

export function EditQuestionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<ThemedText type="defaultSemiBold">Election Title</ThemedText>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						Election Date
					</ThemedText>
				</View>
				<ThemedText>{t("Code")}</ThemedText>
				<CustomTextInput />
				<ThemedText>{t("Title")}</ThemedText>
				<CustomTextInput />
				<ThemedText>{t("Additional Instructions")}</ThemedText>
				<CustomTextInput />
				<ThemedText>{t("Depends On")}</ThemedText>
				<ChipButton label={t("Add Dependency")} />
				<ThemedText>{t("Type")}</ThemedText>
				<QuestionTypeSelector />
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					onPress={() => {}}
					forceDarkText={false}
					icon={"save"}
					// backgroundColor={edited ? colors.success : colors.accent}
					// disabled={!edited}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default EditQuestionScreen;
