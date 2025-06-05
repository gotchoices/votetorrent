import React, { useState } from "react";
import { View, StyleSheet, Image, ScrollView } from "react-native";
import { useTheme, ExtendedTheme, useRoute, useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomTextInput } from "../../components/CustomTextInput";
import { CustomButton } from "../../components/CustomButton";
import { globalStyles } from "../../theme/styles";
import type { DefaultUser } from "@votetorrent/vote-core";
import { IDefaultUserEngine } from "@votetorrent/vote-core";

export function DefaultUserScreen() {
	const { defaultUser, defaultUserEngine } = useRoute().params as {
		defaultUser: DefaultUser;
		defaultUserEngine: IDefaultUserEngine;
	};
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation();

	const [defaultUserState, setDefaultUserState] = useState<DefaultUser>(defaultUser);
	const [edited, setEdited] = useState(false);

	const handleSave = async () => {
		try {
			await defaultUserEngine.set(defaultUserState);
			navigation.goBack();
		} catch (error) {
			console.error("Error saving default user:", error);
			//TODO: Show an alert to the user
		}
	};

	const handleImageUrlChange = (text: string) => {
		setDefaultUserState({ ...defaultUserState, image: { url: text } });
		if (text.startsWith("http")) {
			setDefaultUserState({ ...defaultUserState, image: { url: text } });
		}
		setEdited(true);
	};

	const handleNameChange = (text: string) => {
		setDefaultUserState({ ...defaultUserState, name: text });
		setEdited(true);
	};

	return (
		<View style={styles.content}>
			<ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
				<CustomTextInput
					title={t("name")}
					value={defaultUserState.name}
					onChangeText={handleNameChange}
					placeholder={t("enterName")}
				/>
				<CustomTextInput
					title={t("imageUrl")}
					value={defaultUserState.image?.url}
					onChangeText={handleImageUrlChange}
					isImageUrlField={true}
					makePermanentPressed={() => {}}
					placeholder={t("enterImageUrl")}
					keyboardType="url"
					autoCapitalize="none"
				/>

				{defaultUserState.image?.url && (
					<Image
						source={{ uri: defaultUserState.image.url }}
						style={styles.image}
						resizeMode="contain"
					/>
				)}
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("save")}
					onPress={handleSave}
					forceDarkText={false}
					icon={"save"}
					backgroundColor={edited ? colors.success : colors.accent}
					disabled={!edited}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	image: {
		width: "100%",
		height: "100%",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default DefaultUserScreen;
