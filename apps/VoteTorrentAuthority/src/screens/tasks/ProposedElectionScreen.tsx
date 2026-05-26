import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export default function ProposedElectionScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("proposedElectionTitle") });
	}, [navigation, t]);

	const onBackToTasks = () => {
		console.log("proposedElection-backToTasks");
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("proposedElectionBodyPrimary")}</ThemedText>
				</View>
			</ScrollView>
			<View style={[styles.footer, { backgroundColor: colors.card }]}>
				<CustomButton
					title={t("proposedElectionBackToTasks")}
					backgroundColor={colors.success}
					size="thin"
					onPress={onBackToTasks}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
