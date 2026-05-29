import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function ProposedRevisionScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedRevisionTitle") });
	}, [navigation, t]);

	const onResendRequest = () => {
		console.log("proposedRevision-resendRequest");
		navigation.goBack();
	};

	const onCancelRequest = () => {
		console.log("proposedRevision-cancelRequest");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedRevisionBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedRevisionBodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<View
				style={[styles.footer, styles.footerButtonsContainer, { backgroundColor: colors.card }]}
			>
				<CustomButton
					title={t("proposedRevisionResendRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onResendRequest}
				/>
				<CustomButton
					title={t("proposedRevisionCancelRequest")}
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
