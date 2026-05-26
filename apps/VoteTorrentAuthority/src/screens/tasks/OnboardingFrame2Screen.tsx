import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function OnboardingFrame2Screen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("onboardingFrame2Title") });
	}, [navigation, t]);

	const onResend = () => {
		console.log("frame2-resend");
		navigation.goBack();
	};

	const onBackToTasks = () => {
		console.log("frame2-backToTasks");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("onboardingFrame2BodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("onboardingFrame2BodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<View
				style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
			>
				<CustomButton
					title={t("onboardingFrame2Resend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onResend}
				/>
				<CustomButton
					title={t("onboardingFrame2BackToTasks")}
					backgroundColor={colors.success}
					size="thin"
					flex={true}
					onPress={onBackToTasks}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
