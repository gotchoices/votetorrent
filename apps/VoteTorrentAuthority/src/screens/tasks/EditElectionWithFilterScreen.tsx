import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function EditElectionWithFilterScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("editElectionWithFilterTitle") });
	}, [navigation, t]);

	const onGotIt = () => {
		console.log("editElectionWithFilter-gotIt");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("editElectionWithFilterBodyPrimary")}</ThemedText>
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("editElectionWithFilterGotIt")}
					backgroundColor={colors.success}
					size="thin"
					onPress={onGotIt}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
