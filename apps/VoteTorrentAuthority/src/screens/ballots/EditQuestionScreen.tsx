import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTheme, useRoute, useNavigation } from "@react-navigation/native";
import type { ExtendedTheme, RouteProp } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { ChipButton } from "../../components/ChipButton";
import { InfoCard } from "../../components/InfoCard";
import QuestionTypeSelector from "./components/QuestionTypeSelector";
import { Stepper } from "../../components/Stepper";
import { ToggleRow } from "../../components/ToggleRow";
import { CustomButton } from "../../components/CustomButton";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import type { Option, Question } from "@votetorrent/vote-core";
import React, { useEffect, useState } from "react";

type QuestionType = Question["type"];

/**
 * EditQuestionScreen — polish for BALUI-03 (Figma frame 57:574).
 *
 * Mid-screen of the Ballot screen-stack: consumes useBallotDraft to read the
 * current question (if questionCode route param present), pushes
 * EditQuestionOption for option creation, and on SAVE popTos back to
 * CreateBallot carrying the assembled Question via route param (D-10).
 */
export function EditQuestionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditQuestion">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { ballotDraft } = useBallotDraft();

	const questionCode = route.params?.questionCode;
	const electionTitle = route.params?.electionTitle;
	const electionDate = route.params?.electionDate;

	const existingQuestion = questionCode
		? (ballotDraft.questions ?? []).find((q) => q.code === questionCode)
		: undefined;

	const [code, setCode] = useState<string>(existingQuestion?.code ?? "");
	const [title, setTitle] = useState<string>(existingQuestion?.title ?? "");
	const [instructions, setInstructions] = useState<string>(
		existingQuestion?.instructions ?? ""
	);
	const [type, setType] = useState<QuestionType>(existingQuestion?.type ?? "select");
	const [options, setOptions] = useState<Option[]>(existingQuestion?.options ?? []);

	// Selection Limits + additional Question fields (09-07: BALUI-03 parity)
	const [optionMin, setOptionMin] = useState<number>(existingQuestion?.optionRange?.min ?? 1);
	const [optionMax, setOptionMax] = useState<number>(existingQuestion?.optionRange?.max ?? 1);
	const [optionsOrdered, setOptionsOrdered] = useState<boolean>(
		existingQuestion?.optionsOrdered ?? false
	);
	const [required, setRequired] = useState<boolean>(existingQuestion?.required ?? true);
	const [group, setGroup] = useState<string>(existingQuestion?.group ?? "");
	const [sequence, setSequence] = useState<number>(existingQuestion?.sequence ?? 0);

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

	const handleAddOption = () => {
		navigation.navigate("EditQuestionOption", {
			questionCode: code || `q-${Date.now()}`,
			electionTitle,
			electionDate,
		});
	};

	const handleEditOption = (optionCode: string) => {
		navigation.navigate("EditQuestionOption", {
			questionCode: code || `q-${Date.now()}`,
			optionCode,
			electionTitle,
			electionDate,
		});
	};

	const handleSave = () => {
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
		// Pass the ORIGINAL questionCode from route.params so CreateBallot
		// can branch add-vs-update on it even if the user renamed the code.
		navigation.popTo("CreateBallot", {
			question: assembled,
			originalQuestionCode: questionCode,
		} as any);
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
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

				{/* Selection Limits — Figma 57:574 scrolled section */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("selectionLimits")}
					</ThemedText>
					<Stepper
						label={t("min")}
						value={optionMin}
						onChange={setOptionMin}
						min={0}
					/>
					<Stepper
						label={t("max")}
						value={optionMax}
						onChange={setOptionMax}
						min={0}
					/>
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
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("save")}
					onPress={handleSave}
					forceDarkText={true}
					icon={"floppy-disk"}
					backgroundColor={colors.success}
				/>
			</View>
		</View>
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
});

const styles = { ...globalStyles, ...localStyles };

export default EditQuestionScreen;
