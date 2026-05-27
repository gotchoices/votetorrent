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
	const { ballotDraft, addOption } = useBallotDraft();

	const questionCode = route.params?.questionCode;
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

	// Carry-back from EditQuestionOption: child screen passes a `newOption`
	// route param when SAVE is pressed. Merge it and clear the param.
	const incomingOption = route.params?.newOption as Option | undefined;
	useEffect(() => {
		if (!incomingOption) return;
		setOptions((current) => {
			const existsAt = current.findIndex((o) => o.code === incomingOption.code);
			if (existsAt >= 0) {
				const next = [...current];
				next[existsAt] = incomingOption;
				return next;
			}
			return [...current, incomingOption];
		});
		// Also push into the shared draft so other consumers see the option.
		if (code) {
			addOption(code, incomingOption);
		}
		navigation.setParams({ newOption: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingOption?.code]);

	const handleAddOption = () => {
		navigation.navigate("EditQuestionOption", { questionCode: code || `q-${Date.now()}` });
	};

	const handleSave = () => {
		const assembled: Question = {
			code: code || `q-${Date.now()}`,
			title,
			instructions,
			options,
			type,
		};
		navigation.popTo("CreateBallot", { electionId: "", question: assembled } as any);
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
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
				<CustomTextInput title={t("code")} value={code} onChangeText={setCode} />
				<CustomTextInput title={t("title")} value={title} onChangeText={setTitle} />
				<CustomTextInput
					title={t("additionalInstructions")}
					value={instructions}
					onChangeText={setInstructions}
				/>
				<ThemedText>{t("dependsOn")}</ThemedText>
				<ChipButton label={t("addDependency")} />
				<ThemedText>{t("type")}</ThemedText>
				<QuestionTypeSelector value={type} onChange={setType} />

				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("option")}
					</ThemedText>
					{options.map((o) => (
						<InfoCard
							key={o.code}
							title={o.title}
							additionalInfo={[{ label: t("code"), value: o.code }]}
							icon="pen"
							onPress={handleAddOption}
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
