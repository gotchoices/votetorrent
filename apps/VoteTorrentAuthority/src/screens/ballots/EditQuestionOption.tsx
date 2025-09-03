import { ScrollView, StyleSheet, View } from "react-native";
import { globalStyles } from "../../theme/styles";
import { useTheme } from "@react-navigation/native";
import { ThemedText } from "../../components/ThemedText";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useTranslation } from "react-i18next";
import { Image } from "react-native";
import { useState } from "react";
import { CustomButton } from "../../components/CustomButton";

export function EditQuestionOption() {
	const { colors } = useTheme();
	const { t } = useTranslation();
	const [imageUrl, setImageUrl] = useState("");
	const [videoUrl, setVideoUrl] = useState("");

	const handleMakePermanent = () => {
		//TODO: Implement make permanent
		console.log("Make permanent");
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<ThemedText type="defaultSemiBold">Election Title</ThemedText>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="tail">
						Election Date
					</ThemedText>
				</View>
				<CustomTextInput title={t("code")} />
				<CustomTextInput title={t("title")} />
				<CustomTextInput title={t("additionalDetails")} />
				<CustomTextInput title={t("informationUrl")} />
				<CustomTextInput
					title={t("imageUrl")}
					value={imageUrl}
					placeholder={t("optionalImageAddress")}
					onChangeText={setImageUrl}
					isImageUrlField={true}
					makePermanentPressed={handleMakePermanent}
				/>
				{imageUrl ? (
					<Image source={{ uri: imageUrl }} style={styles.previewImage} resizeMode="cover" />
				) : null}
				<CustomTextInput
					title={t("videoUrl")}
					value={videoUrl}
					placeholder={t("optionalImageAddress")}
					onChangeText={setVideoUrl}
					isImageUrlField={true}
					makePermanentPressed={handleMakePermanent}
				/>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("propose")}
					onPress={() => {}}
					forceDarkText={false}
					icon={"save"}
					// backgroundColor={edited ? colors.success : colors.accent}
					// disabled={!edited}
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
