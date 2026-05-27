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

	// Persist electionId from initial route param into the shared draft so
	// it survives popTo carry-backs that drop the param. Read from draft on
	// SAVE, not from route.params. Closes UAT Test 4 electionId-empty gap.
	useEffect(() => {
		if (electionId && ballotDraft.electionId !== electionId) {
			setBallotDraft({ ...ballotDraft, electionId });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [electionId]);

	// Carry-back from EditQuestionScreen: child screen passes a `question` route
	// param when SAVE is pressed; we merge it into the draft and clear the param.
	const incomingQuestion = (route.params as { question?: Question } | undefined)?.question;

	useEffect(() => {
		if (!incomingQuestion) return;
		// Prefer the ORIGINAL questionCode from route.params so a user-rename
		// of the code field still resolves to the existing question — closes
		// UAT Test 4 question-update broken path.
		const originalQuestionCode = (
			route.params as { originalQuestionCode?: string } | undefined
		)?.originalQuestionCode;
		const lookupCode = originalQuestionCode ?? incomingQuestion.code;
		const existing = (ballotDraft.questions ?? []).some((q) => q.code === lookupCode);
		if (existing) {
			updateQuestion(lookupCode, incomingQuestion);
		} else {
			addQuestion(incomingQuestion);
		}
		// Clear the params so subsequent renders don't re-apply.
		navigation.setParams({
			question: undefined,
			originalQuestionCode: undefined,
		} as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingQuestion?.code]);

	const handleSave = () => {
		// D-12 stub — no engine persistence in v1.1. electionId now lives
		// inside ballotDraft (persisted by the useEffect above) so the payload
		// is just ballotDraft itself.
		console.log("createBallot-save stub", ballotDraft);
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
