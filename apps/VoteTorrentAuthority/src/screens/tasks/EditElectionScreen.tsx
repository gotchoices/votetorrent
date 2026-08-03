import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";

export default function EditElectionScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("editElectionTitle") });
	}, [navigation, t]);

	const onResend = undefined;

	const onBackToTasks = undefined;

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("editElectionBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("editElectionBodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<Footer row>
				<CustomButton
					title={t("editElectionResend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={true}
					onPress={onResend}
				/>
				<CustomButton
					title={t("editElectionBackToTasks")}
					backgroundColor={colors.success}
					size="thin"
					flex={true}
					disabled={true}
					onPress={onBackToTasks}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
