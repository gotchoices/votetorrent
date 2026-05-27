import React from "react";
import { View, StyleSheet, ScrollView } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { ChipButton } from "../../components/ChipButton";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { CustomButton } from "../../components/CustomButton";

/**
 * EditBallotScreen — polish for BALUI-02 (Figma frame 57:490).
 *
 * Read-only view of a published ballot template. Strings via t(); theme
 * tokens for all colors. The hardcoded "Election Title"/"Election Date"
 * placeholders are replaced by t() label rows pending the engine wiring
 * that surfaces real values (deferred per D-18 / 09-04 plan boundary).
 */
const EditBallotScreen = () => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const questions: Array<{
		id: string;
		questionTitle: string;
		code: string;
		type: string;
	}> = [];

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={styles.section}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("election")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							{t("electionTitle")}
						</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="tail">
							{t("date")}
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
				{questions.map((question) => (
					<InfoCard
						key={question.id}
						title={question.questionTitle}
						additionalInfo={[
							{ label: t("code"), value: question.code },
							{ label: t("type"), value: question.type },
						]}
					/>
				))}
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
	row: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default EditBallotScreen;
