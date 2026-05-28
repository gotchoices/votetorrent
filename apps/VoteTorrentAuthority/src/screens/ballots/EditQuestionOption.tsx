import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import {
	ExtendedTheme,
	useTheme,
	useRoute,
	useNavigation,
} from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useTranslation } from "react-i18next";
import { Image } from "react-native";
import { useState } from "react";
import { CustomButton } from "../../components/CustomButton";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import type { Option } from "@votetorrent/vote-core";

/**
 * EditQuestionOption — polish for BALUI-04 (Figma frame 57:740).
 *
 * Leaf screen of the Ballot screen-stack: assembles an Option and on SAVE
 * popTos back to EditQuestion carrying the new option via route param (D-10).
 * Reads ballot draft to seed initial values when editing an existing option.
 */
export function EditQuestionOption() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditQuestionOption">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { ballotDraft, addOption, updateOption } = useBallotDraft();

	const { questionCode, optionCode, electionTitle, electionDate } = route.params ?? { questionCode: "" };
	const existingOption = optionCode
		? (ballotDraft.questions ?? [])
				.find((q) => q.code === questionCode)
				?.options?.find((o) => o.code === optionCode)
		: undefined;

	const [code, setCode] = useState(existingOption?.code ?? "");
	const [title, setTitle] = useState(existingOption?.title ?? "");
	const [details, setDetails] = useState(existingOption?.details ?? "");
	const [infoUrl, setInfoUrl] = useState(existingOption?.infoURL ?? "");
	const [imageUrl, setImageUrl] = useState(existingOption?.image?.url ?? "");
	const [videoUrl, setVideoUrl] = useState(existingOption?.video?.url ?? "");

	const handleMakePermanent = () => {
		// Stub — make-permanent is a v1.x backlog item, not in BALUI-04 scope.
		console.log("editQuestionOption-makePermanent stub");
	};

	const handleSave = () => {
		const newOption: Option = {
			code: code || `o-${Date.now()}`,
			title,
			details: details || undefined,
			infoURL: infoUrl || undefined,
			image: imageUrl ? ({ url: imageUrl } as Option["image"]) : undefined,
			video: videoUrl ? ({ url: videoUrl } as Option["video"]) : undefined,
		};
		// Branch on optionCode presence: edit path uses updateOption (locates
		// the existing option by its ORIGINAL code from route.params, even if
		// the user renamed it in the form); add path uses addOption.
		if (questionCode) {
			if (optionCode) {
				updateOption(questionCode, optionCode, newOption);
			} else {
				addOption(questionCode, newOption);
			}
		}
		// Pass originalOptionCode through so EditQuestion's local options state
		// can findIndex against the ORIGINAL code even if the user renamed it.
		navigation.popTo("EditQuestion", {
			questionCode,
			newOption,
			originalOptionCode: optionCode,
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
					title={t("additionalDetails")}
					value={details}
					onChangeText={setDetails}
				/>
				<CustomTextInput
					title={t("informationUrl")}
					value={infoUrl}
					onChangeText={setInfoUrl}
				/>
				<CustomTextInput
					title={t("imageUrl")}
					value={imageUrl}
					placeholder={t("optionalImageAddress")}
					onChangeText={setImageUrl}
					isImageUrlField={true}
					makePermanentPressed={handleMakePermanent}
				/>
				{imageUrl ? (
					<Image
						source={{ uri: imageUrl }}
						style={styles.previewImage}
						resizeMode="cover"
					/>
				) : null}
				<CustomTextInput
					title={t("videoUrl")}
					value={videoUrl}
					placeholder={t("optionalVideoAddress")}
					onChangeText={setVideoUrl}
					isImageUrlField={true}
					makePermanentPressed={handleMakePermanent}
				/>
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
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default EditQuestionOption;
