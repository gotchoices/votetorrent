import { ExtendedTheme, useTheme, useRoute, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import { BallotTemplateForm } from "./components/BallotTemplateForm";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { useApp } from "../../providers/AppProvider";
import type { Authority, Ballot, INetworkEngine, Question } from "@votetorrent/vote-core";

/**
 * CreateBallotScreen — Ballot Template frame (Figma 57:490) in create/empty mode.
 *
 * Reached from ElectionDetailsScreen's empty-state action per D-09.
 * Draft state lives in BallotDraftProvider (D-11) — scoped to this flow only.
 * Shares BallotTemplateForm with EditBallotScreen (Decision 3).
 *
 * UAT Test 4 wiring preserved:
 *   - electionId persistence useEffect (also seeds a stable ballot id, G12 WARNING 8)
 *   - incomingQuestion carry-back useEffect
 *   - useBallotDraft wiring (D-11)
 *
 * 09-10 G12: reads electionEngine from route.params; handlePropose calls
 * engine.proposeBallot(ballot) then goBack so the template appears in
 * ElectionDetails on focus.
 */
export default function CreateBallotScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "CreateBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const insets = useSafeAreaInsets();
	const { electionId, electionTitle, electionDate } = route.params ?? {
		electionId: "",
		electionTitle: undefined,
		electionDate: undefined,
	};
	const electionEngine = (route.params as any)?.electionEngine;
	const { getEngine } = useApp();
	const [errorMessage, setErrorMessage] = useState("");
	const [proposing, setProposing] = useState(false);
	const [authorities, setAuthorities] = useState<Authority[]>([]);
	const { ballotDraft, setBallotDraft, addQuestion, updateQuestion, removeQuestion } = useBallotDraft();

	// Fresh-create reset: the BallotDraftProvider is now hoisted above the
	// navigator (shared across the ballot flow), so a previously created/edited
	// ballot would leak into a new one without an explicit reset. Runs once on
	// mount — popTo carry-backs re-render but do NOT remount, so accumulated
	// questions are preserved. Seeds a STABLE id once (no duplicate cards on
	// re-PROPOSE).
	useEffect(() => {
		setBallotDraft({
			electionId,
			id: `ballot-${electionId}-${Date.now()}`,
			questions: [],
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Load the real authorities from the network engine so the dropdown stores a
	// valid Authority.Id (the ProposedBallot.AuthorityIdValid CHECK requires the id
	// to exist in the Authority table). getAuthoritiesByName(undefined) returns all
	// authorities, which includes the primary/network-creator authority.
	const [primaryAuthorityId, setPrimaryAuthorityId] = useState("");
	useEffect(() => {
		async function loadAuthorities() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				if (!engine) return;
				const cursor = await engine.getAuthoritiesByName(undefined);
				setAuthorities(cursor.buffer);
				const details = await engine.getDetails();
				if (details?.network?.primaryAuthorityId) {
					setPrimaryAuthorityId(details.network.primaryAuthorityId);
				}
			} catch (error) {
				console.warn("Error loading authorities for ballot:", error);
			}
		}
		loadAuthorities();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [getEngine]);

	// Default the draft to the primary authority once it resolves and nothing is
	// selected yet. setBallotDraft is a plain setter, so spread the current draft
	// to preserve questions/electionId. Keyed on the selected authority so it
	// fires once and never clobbers a user choice.
	useEffect(() => {
		if (primaryAuthorityId && !(ballotDraft as any).authority) {
			setBallotDraft({ ...ballotDraft, authority: primaryAuthorityId } as any);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [primaryAuthorityId, (ballotDraft as any).authority]);

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

	const handlePropose = async () => {
		// G12: persist template via engine then goBack so ElectionDetails' useFocusEffect
		// re-fetches getBallots() and shows the new card.
		if (!electionEngine) {
			// Guard: no engine in test/standalone contexts — still navigate back.
			navigation.goBack();
			return;
		}
		setErrorMessage("");
		setProposing(true);
		const ballot: Ballot = {
			id: (ballotDraft as any).id ?? `ballot-${electionId}-${Date.now()}`,
			electionId: ballotDraft.electionId ?? electionId,
			authorityId: (ballotDraft as any).authority ?? "",
			description: ballotDraft.description ?? "",
			districts: ballotDraft.districts ?? [],
			questions: ballotDraft.questions ?? [],
		};
		try {
			await electionEngine.proposeBallot(ballot);
			navigation.goBack();
		} catch (error) {
			console.warn("proposeBallot error", error);
			setErrorMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setProposing(false);
		}
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
		// Pass the existing question so EditQuestion can pre-populate — its own
		// draft provider instance is separate/empty (screenLayout per-screen).
		const editQuestion = (ballotDraft.questions ?? []).find((q) => q.code === questionCode);
		navigation.navigate("EditQuestion", {
			questionCode,
			editQuestion,
			electionTitle,
			electionDate,
		} as any);
	};

	return (
		<View style={globalStyles.content}>
			<BallotTemplateForm
				electionTitle={electionTitle}
				electionDate={electionDate}
				authority={(ballotDraft as any).authority ?? ""}
				onAuthorityChange={handleAuthorityChange}
				authorityOptions={authorities.map((a) => ({ id: a.id, name: a.name }))}
				description={ballotDraft.description ?? ""}
				onDescriptionChange={handleDescriptionChange}
				districts={ballotDraft.districts ?? []}
				onDistrictsChange={handleDistrictsChange}
				questions={ballotDraft.questions ?? []}
				onAddQuestion={handleAddQuestion}
				onEditQuestion={handleEditQuestion}
			/>
			<InlineError message={errorMessage} />
			{/* Footer: PROPOSE — owned by screen so create vs edit can wire own handlers */}
			<View style={[globalStyles.footer, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
					disabled={proposing}
				/>
			</View>
		</View>
	);
}
