import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import {
	ExtendedTheme,
	useTheme,
	useRoute,
	useNavigation,
	StackActions,
} from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useTranslation } from "react-i18next";
import { Image } from "react-native";
import { useEffect, useState } from "react";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import type { Option } from "@votetorrent/vote-core";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { useMediaPin } from "../../hooks/useMediaPin";

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
	// This screen's BallotDraftProvider instance is separate/empty (screenLayout
	// mounts one per screen), so the parent passes the option to edit as a route
	// param. Fall back to a draft lookup.
	const existingOption: Option | undefined =
		(route.params?.editOption as Option | undefined) ??
		(optionCode
			? (ballotDraft.questions ?? [])
					.find((q) => q.code === questionCode)
					?.options?.find((o) => o.code === optionCode)
			: undefined);

	const [code, setCode] = useState(existingOption?.code ?? "");
	const [title, setTitle] = useState(existingOption?.title ?? "");
	const [details, setDetails] = useState(existingOption?.details ?? "");
	const [infoUrl, setInfoUrl] = useState(existingOption?.infoURL ?? "");
	const [imageUrl, setImageUrl] = useState(existingOption?.image?.url ?? "");
	const [videoUrl, setVideoUrl] = useState(existingOption?.video?.url ?? "");
	// "Make Permanent": each media field records the content id of its bytes (useMediaPin).
	const imagePin = useMediaPin(existingOption?.image);
	const videoPin = useMediaPin(existingOption?.video);

	// G11: Re-seed local state when the existing option resolves (draft may load
	// after mount). Keyed on optionCode only to avoid clobbering user edits.
	useEffect(() => {
		if (!optionCode || !existingOption) return;
		setCode(existingOption.code ?? "");
		setTitle(existingOption.title ?? "");
		setDetails(existingOption.details ?? "");
		setInfoUrl(existingOption.infoURL ?? "");
		setImageUrl(existingOption.image?.url ?? "");
		setVideoUrl(existingOption.video?.url ?? "");
		imagePin.reset(existingOption.image);
		videoPin.reset(existingOption.video);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [optionCode]);

	// SAVE is disabled until the option has a code or title — prevents the
	// junk "Code: o-<timestamp>" card from an all-empty save.
	const canSave = code.trim().length > 0 || title.trim().length > 0;

	const handleSave = () => {
		const newOption: Option = {
			code: code || `o-${Date.now()}`,
			title,
			details: details || undefined,
			infoURL: infoUrl || undefined,
			image: imageUrl ? mediaRef(imageUrl, imagePin.cidFor(imageUrl)) : undefined,
			video: videoUrl
				? (mediaRef(videoUrl, videoPin.cidFor(videoUrl)) as Option["video"])
				: undefined,
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
		// merge=true preserves EditQuestion's existing params (electionTitle/Date,
		// editQuestion) instead of replacing them.
		navigation.dispatch(
			StackActions.popTo(
				"EditQuestion",
				{ questionCode, newOption, originalOptionCode: optionCode },
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
					makePermanentPressed={() => imagePin.pin(imageUrl)}
					makePermanentDisabled={!imageUrl.trim() || imagePin.isPinning}
					permanentStatus={imagePin.statusFor(imageUrl)}
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
					makePermanentPressed={() => videoPin.pin(videoUrl)}
					makePermanentDisabled={!videoUrl.trim() || videoPin.isPinning}
					permanentStatus={videoPin.statusFor(videoUrl)}
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

/** `{ url, cid? }` — the cid only when the field's current URL is the one that was made permanent. */
function mediaRef(url: string, cid: string | undefined): { url: string; cid?: string } {
	return cid ? { url, cid } : { url };
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
