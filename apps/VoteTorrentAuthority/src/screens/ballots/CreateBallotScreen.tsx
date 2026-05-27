import { ExtendedTheme, useTheme, useRoute, useNavigation } from "@react-navigation/native";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import type { Question } from "@votetorrent/vote-core";

/**
 * CreateBallotScreen — top-level ballot form (BALUI-01).
 *
 * Reached from ElectionDetailsScreen's "no ballot" empty-state action per D-09.
 * Holds a Questions list (initially empty), an ADD QUESTION chip that pushes
 * EditQuestionScreen, and a footer SAVE that stubs per D-12.
 *
 * Draft state lives in BallotDraftProvider (D-11) — scoped to this flow only.
 */
export default function CreateBallotScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "CreateBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { electionId } = route.params ?? { electionId: "" };
	const { ballotDraft, setBallotDraft, addQuestion, updateQuestion } = useBallotDraft();

	// Carry-back from EditQuestionScreen: child screen passes a `question` route
	// param when SAVE is pressed; we merge it into the draft and clear the param.
	const incomingQuestion = (route.params as { question?: Question } | undefined)?.question;

	useEffect(() => {
		if (!incomingQuestion) return;
		const existing = (ballotDraft.questions ?? []).some(
			(q) => q.code === incomingQuestion.code
		);
		if (existing) {
			updateQuestion(incomingQuestion.code, incomingQuestion);
		} else {
			addQuestion(incomingQuestion);
		}
		// Clear the param so subsequent renders don't re-apply.
		navigation.setParams({ question: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingQuestion?.code]);

	const handleSave = () => {
		// D-12 stub — no engine persistence in v1.1.
		console.log("createBallot-save stub", { electionId, ...ballotDraft });
		navigation.goBack();
	};

	const handleDescriptionChange = (description: string) => {
		setBallotDraft({ ...ballotDraft, description });
	};

	const handleAddQuestion = () => {
		navigation.navigate("EditQuestion", {});
	};

	const handleEditQuestion = (questionCode: string) => {
		navigation.navigate("EditQuestion", { questionCode });
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold">{t("description")}</ThemedText>
					<CustomTextInput
						value={ballotDraft.description ?? ""}
						onChangeText={handleDescriptionChange}
					/>
				</View>

				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("question")}
					</ThemedText>
					{(ballotDraft.questions ?? []).map((q) => (
						<InfoCard
							key={q.code}
							title={q.title}
							additionalInfo={[
								{ label: t("code"), value: q.code },
								{ label: t("type"), value: q.type },
							]}
							icon="pen"
							onPress={() => handleEditQuestion(q.code)}
						/>
					))}
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addQuestion")}
							icon="circle-plus"
							onPress={handleAddQuestion}
						/>
					</View>
				</View>
			</ScrollView>

			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("save")}
					icon="floppy-disk"
					onPress={handleSave}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
});

const styles = { ...globalStyles, ...localStyles };
