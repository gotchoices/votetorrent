import { useLayoutEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import type { NavigationProp } from "../../navigation/types";

// Phase 7 dev-entry route per D-12. Lists every OnboardingFrame{N} screen so
// reviewers can reach all six before phases 8–10 wire the real callers.
// Temporary by design — remove once callers are wired upstream.
const FRAME_ROUTES = [
	{ key: "frame2", route: "OnboardingFrame2", titleKey: "onboardingFrame2Title" },
	{ key: "frame7", route: "OnboardingFrame7", titleKey: "onboardingFrame7Title" },
	{ key: "frame18", route: "OnboardingFrame18", titleKey: "onboardingFrame18Title" },
	{ key: "frame19", route: "OnboardingFrame19", titleKey: "onboardingFrame19Title" },
	{ key: "frame20", route: "OnboardingFrame20", titleKey: "onboardingFrame20Title" },
	{ key: "frame21", route: "OnboardingFrame21", titleKey: "onboardingFrame21Title" },
] as const;

export default function OnboardingDebugScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("onboardingDebugTitle") });
	}, [navigation, t]);

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("onboardingDebugIntro")}</ThemedText>
				</View>
				{FRAME_ROUTES.map((entry) => (
					<View key={entry.key} style={styles.section}>
						<CustomButton
							title={t(entry.titleKey)}
							backgroundColor={colors.accent}
							size="thin"
							onPress={() => {
								console.log(`onboardingDebug-navigate-${entry.route}`);
								navigation.navigate(entry.route as any);
							}}
						/>
					</View>
				))}
			</ScrollView>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
