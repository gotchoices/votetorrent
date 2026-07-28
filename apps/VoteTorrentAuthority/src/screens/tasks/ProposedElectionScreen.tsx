import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";

export default function ProposedElectionScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedElectionTitle") });
	}, [navigation, t]);

	const onBackToTasks = undefined;

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedElectionBodyPrimary")}</ThemedText>
				</View>
			</ScrollView>
			<Footer>
				<CustomButton
					title={t("proposedElectionBackToTasks")}
					backgroundColor={colors.success}
					size="thin"
					disabled={true}
					onPress={onBackToTasks}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
