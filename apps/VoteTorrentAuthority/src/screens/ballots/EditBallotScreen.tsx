import React from "react";
import { View, StyleSheet, FlatList, ScrollView } from "react-native";
import { useTheme } from "@react-navigation/native";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { ChipButton } from "../../components/ChipButton";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { CustomButton } from "../../components/CustomButton";

const EditBallotScreen = () => {
	const { colors } = useTheme();
	const { t } = useTranslation();

	const questions: Array<{ id: string; questionTitle: string; code: string; type: string }> = [];

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={styles.section}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("election")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							Election Title
						</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							Election Date
						</ThemedText>
					</View>
				</View>
				<View style={styles.section}>
					<ThemedText>{t("authority")}</ThemedText>
					<CustomTextInput />
				</View>
				<View style={styles.section}>
					<ThemedText>{t("description")}</ThemedText>
					<CustomTextInput />
				</View>
				{questions.map(
					(question: { id: string; questionTitle: string; code: string; type: string }) => (
						<InfoCard
							key={question.id}
							title={question.questionTitle}
							additionalInfo={[
								{ label: t("code"), value: question.code },
								{ label: t("type"), value: question.type },
							]}
						/>
					)
				)}
				<ChipButton label={t("addQuestion")} />
				<View style={styles.section}>
					<View style={styles.row}>
						<ThemedText>{t("districtsGroups")}</ThemedText>
						<ChipButton label={t("import")} />
					</View>
					<CustomTextInput />
					<View style={styles.row}>
						<ChipButton label={t("clearAll")} />
						<ChipButton label={t("addRange")} />
					</View>
				</View>
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
};

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
	},
	title: {
		marginBottom: 16,
	},
	section: {
		marginBottom: 20,
	},
	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default EditBallotScreen;
