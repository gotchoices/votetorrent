import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";

export default function EditRevisionFormScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("editRevisionFormTitle") });
	}, [navigation, t]);

	const onResend = () => {
		console.log("editRevisionForm-resend");
		navigation.goBack();
	};

	const onDismissRequest = () => {
		console.log("editRevisionForm-dismissRequest");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("editRevisionFormBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("editRevisionFormBodySecondary")}</ThemedText>
				</View>
			</ScrollView>
			<Footer row>
				<CustomButton
					title={t("editRevisionFormResend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onResend}
				/>
				<CustomButton
					title={t("editRevisionFormDismissRequest")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					onPress={onDismissRequest}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
