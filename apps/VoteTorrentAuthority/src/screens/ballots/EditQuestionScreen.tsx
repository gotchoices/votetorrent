import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTheme, useRoute, useNavigation, StackActions } from "@react-navigation/native";
import type { ExtendedTheme, RouteProp } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import QuestionTypeSelector from "./components/QuestionTypeSelector";
import { Stepper } from "../../components/Stepper";
import { ToggleRow } from "../../components/ToggleRow";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import type { Option, Question } from "@votetorrent/vote-core";
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";

type QuestionType = Question["type"];

// Question types that select/rank/score among discrete options — require ≥2 options to be valid.
// Text questions are exempt (free-response, legitimately 0 options).
const CHOICE_BASED_TYPES: QuestionType[] = ["select", "rank", "score"];

/**
 * EditQuestionScreen — polish for BALUI-03 (Figma frame 57:574).
 *
 * Mid-screen of the Ballot screen-stack: consumes useBallotDraft to read the
 * current question (if questionCode route param present), pushes
 * EditQuestionOption for option creation, and on SAVE popTos back to
 * CreateBallot carrying the assembled Question via route param (D-10).
 *
 * 09-10 gap closures:
 *   G7: Options section moved to sit directly below Type (above Selection Limits)
 *   G8: Min + Max Steppers wrapped in a single row (side-by-side)
 *   G9: useEffect keyed on questionCode resets all fields when existingQuestion resolves
 *   G11: removeOptionCode carry-back removes option from local state + draft
 */
export function EditQuestionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditQuestion">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { ballotDraft, removeOption } = useBallotDraft();

	const questionCode = route.params?.questionCode;
	const electionTitle = route.params?.electionTitle;
	const electionDate = route.params?.electionDate;

	// The shared draft is NOT shared across screens (each ballot screen has its
	// own BallotDraftProvider instance via screenLayout), so the parent passes
	// the question to edit as a route param. Fall back to a draft lookup.
	const existingQuestion: Question | undefined =
		(route.params?.editQuestion as Question | undefined) ??
		(questionCode
			? (ballotDraft.questions ?? []).find((q) => q.code === questionCode)
			: undefined);

	const [code, setCode] = useState<string>(existingQuestion?.code ?? "");
	const [title, setTitle] = useState<string>(existingQuestion?.title ?? "");
	const [instructions, setInstructions] = useState<string>(
		existingQuestion?.instructions ?? ""
	);
	const [type, setType] = useState<QuestionType>(existingQuestion?.type ?? "select");
	const [options, setOptions] = useState<Option[]>(existingQuestion?.options ?? []);
	const [errorMessage, setErrorMessage] = useState("");

	// Selection Limits + additional Question fields (09-07: BALUI-03 parity)
	const [optionMin, setOptionMin] = useState<number>(existingQuestion?.optionRange?.min ?? 1);
	const [optionMax, setOptionMax] = useState<number>(existingQuestion?.optionRange?.max ?? 1);
	const [optionsOrdered, setOptionsOrdered] = useState<boolean>(
		existingQuestion?.optionsOrdered ?? false
	);
	const [required, setRequired] = useState<boolean>(existingQuestion?.required ?? true);
	const [group, setGroup] = useState<string>(existingQuestion?.group ?? "");
	const [sequence, setSequence] = useState<number>(existingQuestion?.sequence ?? 0);

	// G9: Re-seed local state when the existing question resolves (draft may load
	// after mount). Keyed on questionCode only — does not clobber user edits on
	// every render. Guards: only fires when questionCode is set and question is found.
	useEffect(() => {
		if (!questionCode || !existingQuestion) return;
		setCode(existingQuestion.code ?? "");
		setTitle(existingQuestion.title ?? "");
		setInstructions(existingQuestion.instructions ?? "");
		setType(existingQuestion.type ?? "select");
		setOptions(existingQuestion.options ?? []);
		setOptionMin(existingQuestion.optionRange?.min ?? 1);
		setOptionMax(existingQuestion.optionRange?.max ?? 1);
		setOptionsOrdered(existingQuestion.optionsOrdered ?? false);
		setRequired(existingQuestion.required ?? true);
		setGroup(existingQuestion.group ?? "");
		setSequence(existingQuestion.sequence ?? 0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [questionCode]);

	// Carry-back from EditQuestionOption: child screen passes a `newOption`
	// route param when SAVE is pressed. Merge it into local form state and
	// clear the params. Per Plan 09-05: the shared BallotDraftProvider is
	// the single source of truth for option mutations — EditQuestionOption
	// itself writes addOption/updateOption, so we no longer need to also
	// call addOption here on carry-back (that produced the stub duplicates).
	const incomingOption = route.params?.newOption as Option | undefined;
	useEffect(() => {
		if (!incomingOption) return;
		const originalOptionCode = (route.params as any)?.originalOptionCode as
			| string
			| undefined;
		setOptions((current) => {
			const lookup = originalOptionCode ?? incomingOption.code;
			const existsAt = current.findIndex((o) => o.code === lookup);
			if (existsAt >= 0) {
				const next = [...current];
				next[existsAt] = incomingOption;
				return next;
			}
			return [...current, incomingOption];
		});
		navigation.setParams({
			newOption: undefined,
			originalOptionCode: undefined,
		} as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingOption?.code]);

	// G11: Carry-back from EditQuestionOption REMOVE: child passes removeOptionCode
	// via popTo. Remove from local state + draft, then clear param (WARNING 7).
	const removeOptionCode = route.params?.removeOptionCode;
	useEffect(() => {
		if (!removeOptionCode || !questionCode) return;
		setOptions((current) => current.filter((o) => o.code !== removeOptionCode));
		removeOption(questionCode, removeOptionCode);
		navigation.setParams({ removeOptionCode: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [removeOptionCode]);

	// Clear the "needs ≥2 options" error reactively: once the question is no
	// longer in the invalid state (enough options added, or type switched to a
	// non-choice type), the error must disappear without a second SAVE press.
	// Only ever clears — the error is set exclusively by handleSave's attempt.
	useEffect(() => {
		if (!(CHOICE_BASED_TYPES.includes(type) && options.length < 2)) {
			setErrorMessage("");
		}
	}, [type, options.length]);

	const handleAddOption = () => {
		navigation.navigate("EditQuestionOption", {
			questionCode: code || `q-${Date.now()}`,
			electionTitle,
			electionDate,
		});
	};

	const handleEditOption = (optionCode: string) => {
		// Pass the existing option object so the leaf screen can pre-populate
		// (its own draft instance is empty — see existingQuestion note above).
		const editOption = options.find((o) => o.code === optionCode);
		navigation.navigate("EditQuestionOption", {
			questionCode: code || `q-${Date.now()}`,
			optionCode,
			editOption,
			electionTitle,
			electionDate,
		} as any);
	};

	// SAVE is disabled until the question has a code or title.
	const canSave = code.trim().length > 0 || title.trim().length > 0;

	const handleSave = () => {
		setErrorMessage("");
		if (CHOICE_BASED_TYPES.includes(type) && options.length < 2) {
			setErrorMessage(t("questionNeedsTwoOptions"));
			return;
		}
		const assembled: Question = {
			code: code || `q-${Date.now()}`,
			title,
			instructions,
			options,
			type,
			optionRange: { min: optionMin, max: optionMax },
			optionsOrdered,
			required,
			group: group || undefined,
			sequence,
		};
		// Pass the ORIGINAL questionCode so the ballot root can branch
		// add-vs-update even if the user renamed the code. popTo whichever
		// ballot-root is actually in the stack (EditBallot when editing an
		// existing template, else CreateBallot) — mirrors the header REMOVE.
		const state = navigation.getState();
		const hasEditBallot = state.routes.some((r: { name: string }) => r.name === "EditBallot");
		// merge=true so the target keeps its existing params (electionEngine,
		// electionTitle/Date, ballotId) — a plain popTo replaces them, which
		// dropped the engine (PROPOSE couldn't persist) and the context labels.
		navigation.dispatch(
			StackActions.popTo(
				hasEditBallot ? "EditBallot" : "CreateBallot",
				{ question: assembled, originalQuestionCode: questionCode },
				{ merge: true }
			)
		);
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView
				style={[styles.container, { backgroundColor: colors.background }]}
				contentContainerStyle={{ paddingBottom: 24 }}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("election")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{electionTitle ?? t("election")}
					</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						{electionDate ?? t("date")}
					</ThemedText>
				</View>
				<CustomTextInput title={t("code")} value={code} onChangeText={setCode} />
				<CustomTextInput title={t("title")} value={title} onChangeText={setTitle} />
				<CustomTextInput
					title={t("additionalInstructions")}
					value={instructions}
					onChangeText={setInstructions}
				/>
				<ThemedText>{t("type")}</ThemedText>
				<QuestionTypeSelector value={type} onChange={setType} />

				{/* G7: Options section directly below Type (above Selection Limits) */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("option")}
					</ThemedText>
					{options.map((o) => (
						<InfoCard
							key={o.code}
							image={o.image?.url ? { uri: o.image.url } : undefined}
							title={o.title}
							additionalInfo={[{ label: t("code"), value: o.code }]}
							icon="chevron-right"
							onPress={() => handleEditOption(o.code)}
						/>
					))}
					<View style={styles.addButtonContainer}>
						<ChipButton
							label={t("addOption")}
							icon="circle-plus"
							onPress={handleAddOption}
						/>
					</View>
					<InlineError message={errorMessage} />
				</View>

				{/* G8: Selection Limits — Min + Max side-by-side in one row */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("selectionLimits")}
					</ThemedText>
					<View style={styles.selectionLimitsRow}>
						<View style={styles.stepperFlex}>
							<Stepper
								label={t("min")}
								value={optionMin}
								onChange={setOptionMin}
								min={0}
							/>
						</View>
						<View style={styles.stepperFlex}>
							<Stepper
								label={t("max")}
								value={optionMax}
								onChange={setOptionMax}
								min={0}
							/>
						</View>
					</View>
				</View>

				<ToggleRow
					label={t("forceOrder")}
					value={optionsOrdered}
					onValueChange={setOptionsOrdered}
				/>
				<ToggleRow
					label={t("required")}
					value={required}
					onValueChange={setRequired}
				/>

				<CustomTextInput
					title={t("group")}
					value={group}
					placeholder={t("groupPlaceholder")}
					onChangeText={setGroup}
				/>

				<Stepper
					label={t("sequence")}
					value={sequence}
					onChange={setSequence}
					min={0}
				/>
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("save")}
					onPress={handleSave}
					forceDarkText={true}
					icon={"floppy-disk"}
					backgroundColor={colors.success}
					disabled={!canSave}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
	},
	addButtonContainer: {
		flexDirection: "row",
		justifyContent: "flex-end",
	},
	// G8: side-by-side Min/Max row
	selectionLimitsRow: {
		flexDirection: "row",
		gap: 12,
	},
	stepperFlex: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default EditQuestionScreen;
