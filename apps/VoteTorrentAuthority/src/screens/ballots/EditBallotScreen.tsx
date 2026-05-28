import React, { useEffect } from "react";
import { View } from "react-native";
import { ExtendedTheme, useTheme, useNavigation, useRoute } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import { BallotTemplateForm } from "./components/BallotTemplateForm";
import { CustomButton } from "../../components/CustomButton";

/**
 * EditBallotScreen — Ballot Template frame (Figma 57:490) in edit/populated mode.
 *
 * Reached from ElectionDetailsScreen's ballot template chevron list card (09-08).
 * Shares BallotTemplateForm with CreateBallotScreen (Decision 3).
 * Seeded from route.params for v1.1 (no real engine); draft serves as the
 * editable copy. PROPOSE logs a real payload then goBack().
 */
const EditBallotScreen = () => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { electionId, electionTitle, electionDate } = route.params ?? {};
	const { ballotDraft, setBallotDraft, removeQuestion } = useBallotDraft();

	// Seed the draft with electionId from route params (edit mode entry point)
	useEffect(() => {
		if (electionId && ballotDraft.electionId !== electionId) {
			setBallotDraft({ ...ballotDraft, electionId });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [electionId]);

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
		// v1.1 stub — logs a real payload then navigates back.
		console.log("editBallot-propose stub", {
			electionId: ballotDraft.electionId ?? electionId,
			authority: (ballotDraft as any).authority,
			description: ballotDraft.description,
			districts: ballotDraft.districts,
			questions: ballotDraft.questions,
		});
		navigation.goBack();
	};

	const handleAuthorityChange = (authority: string) => {
		setBallotDraft({ ...ballotDraft, authority } as any);
	};

	const handleDescriptionChange = (description: string) => {
		setBallotDraft({ ...ballotDraft, description });
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
			{/* Footer: PROPOSE — owned by screen per plan; matches CreateBallotScreen footer */}
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
};

export default EditBallotScreen;
