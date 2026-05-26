import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function OnboardingFrame21Screen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("onboardingFrame21Title") });
	}, [navigation, t]);

	const onResendRequest = () => {
		console.log("frame21-resendRequest");
		navigation.goBack();
	};

	const onCancelRequest = () => {
		console.log("frame21-cancelRequest");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("onboardingFrame21BodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("onboardingFrame21BodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<View
				style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
			>
				<CustomButton
					title={t("onboardingFrame21ResendRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onResendRequest}
				/>
				<CustomButton
					title={t("onboardingFrame21CancelRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onCancelRequest}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
