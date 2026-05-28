import { ExtendedTheme, useTheme, useRoute, useNavigation } from "@react-navigation/native";
import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import { BallotTemplateForm } from "./components/BallotTemplateForm";
import { CustomButton } from "../../components/CustomButton";
import type { Question } from "@votetorrent/vote-core";

/**
 * CreateBallotScreen — Ballot Template frame (Figma 57:490) in create/empty mode.
 *
 * Reached from ElectionDetailsScreen's empty-state action per D-09.
 * Draft state lives in BallotDraftProvider (D-11) — scoped to this flow only.
 * Shares BallotTemplateForm with EditBallotScreen (Decision 3).
 *
 * UAT Test 4 wiring preserved:
 *   - electionId persistence useEffect
 *   - incomingQuestion carry-back useEffect
 *   - useBallotDraft wiring (D-11)
 */
export default function CreateBallotScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "CreateBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { electionId, electionTitle, electionDate } = route.params ?? {
		electionId: "",
		electionTitle: undefined,
		electionDate: undefined,
	};
	const { ballotDraft, setBallotDraft, addQuestion, updateQuestion, removeQuestion } = useBallotDraft();

	// Persist electionId from initial route param into the shared draft so
	// it survives popTo carry-backs that drop the param. Read from draft on
	// PROPOSE, not from route.params. Closes UAT Test 4 electionId-empty gap.
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

	// Carry-back from EditQuestionScreen REMOVE: child passes removeQuestionCode via popTo.
	// We remove the question then clear the param to prevent re-fire (WARNING 7).
	const removeQuestionCode = (route.params as { removeQuestionCode?: string } | undefined)?.removeQuestionCode;
	useEffect(() => {
		if (!removeQuestionCode) return;
		removeQuestion(removeQuestionCode);
		navigation.setParams({ removeQuestionCode: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [removeQuestionCode]);

	const handlePropose = () => {
		// D-12 stub — no engine persistence in v1.1. Footer label: t("propose").
		// electionId lives inside ballotDraft (persisted by the useEffect above).
		console.log("createBallot-propose stub", ballotDraft);
		navigation.goBack();
	};

	const handleDescriptionChange = (description: string) => {
		setBallotDraft({ ...ballotDraft, description });
	};

	const handleAuthorityChange = (authority: string) => {
		setBallotDraft({ ...ballotDraft, authority } as any);
	};

	const handleDistrictsChange = (districts: string[]) => {
		setBallotDraft({ ...ballotDraft, districts });
	};

	const handleAddQuestion = () => {
		navigation.navigate("EditQuestion", { electionTitle, electionDate });
	};

	const handleEditQuestion = (questionCode: string) => {
		navigation.navigate("EditQuestion", { questionCode, electionTitle, electionDate });
	};

	return (
		<View style={globalStyles.content}>
			<BallotTemplateForm
				electionTitle={electionTitle}
				electionDate={electionDate}
				authority={(ballotDraft as any).authority ?? ""}
				onAuthorityChange={handleAuthorityChange}
				authorityOptions={[t("mockAuthorityA"), t("mockAuthorityB")]}
				description={ballotDraft.description ?? ""}
				onDescriptionChange={handleDescriptionChange}
				districts={ballotDraft.districts ?? []}
				onDistrictsChange={handleDistrictsChange}
				questions={ballotDraft.questions ?? []}
				onAddQuestion={handleAddQuestion}
				onEditQuestion={handleEditQuestion}
			/>
			{/* Footer: PROPOSE — owned by screen so create vs edit can wire own handlers */}
			<View style={[globalStyles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</View>
		</View>
	);
}
