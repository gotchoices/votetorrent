import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function AuthorityDetailScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("authorityDetailTitle") });
	}, [navigation, t]);

	const onResend = () => {
		console.log("authorityDetail-resend");
		navigation.goBack();
	};

	const onCancelInvitation = () => {
		console.log("authorityDetail-cancelInvitation");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<View
				style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
			>
				<CustomButton
					title={t("authorityDetailResend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onResend}
				/>
				<CustomButton
					title={t("authorityDetailCancelInvitation")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onCancelInvitation}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
