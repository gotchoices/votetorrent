import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { globalStyles } from "../../theme/styles";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { ElectionRevisionForm, ElectionRevisionFormValue } from "./components/ElectionRevisionForm";

// Phase 9 plan 09-12 (ELECUI-03) — Single-scroll New Election form.
// Replaces the 4-step wizard (D-01..D-04) per Binding Decision 1 (09-PARITY-GAPS-R3).
// D-01..D-04 removed: wizard step state, step constant array, step indicator,
//   NEXT/BACK footer, and Review-edit-chips are all gone.
// PROPOSE stub: console.log + goBack. Persistence deferred to 09-15.
// D-17: en-only i18n; Spanish deferred to Phase 11.
// D-18: authority/type rows display hardcoded mock strings (no engine import).

export function CreateElectionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const insets = useSafeAreaInsets();

	// Core section state (cannot change once approved)
	const [coreTitle, setCoreTitle] = useState("");
	const [coreDate, setCoreDate] = useState("");
	const [coreRevisionDeadline, setCoreRevisionDeadline] = useState("");

	// Initial Revision state (can change) — controlled via ElectionRevisionForm
	const [revision, setRevision] = useState<ElectionRevisionFormValue>({
		registrationEnds: "",
		ballotsFinal: "",
		releasingKeys: "",
		votingStarts: "",
		keyholders: [],
		threshold: 1,
		tags: [],
		instructions: "",
	});

	// PROPOSE stub per D-03 / 09-15 deferred persistence
	const handlePropose = () => {
		console.log("createElection-propose stub", {
			coreTitle,
			coreDate,
			coreRevisionDeadline,
			revision,
		});
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* ── Read-only Authority / Type context rows ─────────────── */}
				<View style={styles.section}>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText type="default">{"Mock Authority B"}</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
						<ThemedText type="default">{t("official")}</ThemedText>
					</View>
				</View>

				{/* ── Core section ─────────────────────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("coreSectionHeader")}
					</ThemedText>

					<CustomTextInput
						title={t("title")}
						value={coreTitle}
						onChangeText={setCoreTitle}
					/>

					<CustomTextInput
						title={t("date")}
						icon="calendar"
						placeholder={t("selectDate")}
						value={coreDate}
						onChangeText={setCoreDate}
					/>
					<ThemedText type="small" style={localStyles.helperText}>
						{t("coreDateHelp")}
					</ThemedText>

					<CustomTextInput
						title={t("revisionDeadline")}
						icon="calendar"
						value={coreRevisionDeadline}
						onChangeText={setCoreRevisionDeadline}
					/>
					<ThemedText type="small" style={localStyles.helperText}>
						{t("revisionDeadlineHelp")}
					</ThemedText>
				</View>

				{/* ── Initial Revision section ─────────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("initialRevisionHeader")}
					</ThemedText>
					<ElectionRevisionForm
						value={revision}
						onChange={setRevision}
						tagOptions={["Primary", "Utah", "General", "Local"]}
					/>
				</View>
			</ScrollView>

			{/* ── PROPOSE footer ───────────────────────────────────────────── */}
			<View
				style={[
					styles.footer,
					{ backgroundColor: colors.card, paddingBottom: insets.bottom + 16 },
				]}
			>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</View>
		</View>
	);
}

export default CreateElectionScreen;

const localStyles = StyleSheet.create({
	contextRow: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 4,
	},
	helperText: {
		marginTop: 4,
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
