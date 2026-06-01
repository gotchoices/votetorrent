import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { CustomTextInput } from "../../components/CustomTextInput";
import { DateField } from "../../components/DateField";
import { globalStyles } from "../../theme/styles";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { ElectionRevisionForm, ElectionRevisionFormValue } from "./components/ElectionRevisionForm";
import { useApp } from "../../providers/AppProvider";
import { ElectionType } from "@votetorrent/vote-core";
import type { IElectionsEngine, ElectionInit } from "@votetorrent/vote-core";

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
	const { getEngine } = useApp();

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

	// Phase 9 plan 09-15 — PROPOSE calls electionsEngine.createElection, then goBack.
	const handlePropose = async () => {
		try {
			const electionsEngine = await getEngine<IElectionsEngine>("elections");
			if (!electionsEngine) {
				navigation.goBack();
				return;
			}
			const now = Date.now();
			const parseDateOrFallback = (s: string, fallbackMs: number): number =>
				s.trim() ? new Date(s).getTime() || fallbackMs : fallbackMs;
			const init: ElectionInit = {
				election: {
					id: `election-${now}`,
					authorityId: "authority-mock",
					title: coreTitle || "Untitled Election",
					date: parseDateOrFallback(coreDate, now + 14 * 24 * 60 * 60 * 1000),
					revisionDeadline: parseDateOrFallback(
						coreRevisionDeadline,
						now + 7 * 24 * 60 * 60 * 1000
					),
					ballotDeadline: now + 10 * 24 * 60 * 60 * 1000,
					type: ElectionType.official,
				},
				revision: {
					electionId: `election-${now}`,
					revision: 1,
					revisionTimestamp: now,
					tags: revision.tags,
					instructions: revision.instructions,
					keyholders: revision.keyholders.map((name) => ({
						name,
						type: "k",
						expiration: "0",
						inviteKey: "",
						invitePrivate: "",
						inviteSignature: "",
						digest: "",
					})),
					timeline: {
						registrationEnds: parseDateOrFallback(
							revision.registrationEnds,
							now + 2 * 24 * 60 * 60 * 1000
						),
						ballotsFinal: parseDateOrFallback(
							revision.ballotsFinal,
							now + 5 * 24 * 60 * 60 * 1000
						),
						votingStarts: parseDateOrFallback(
							revision.votingStarts,
							now + 10 * 24 * 60 * 60 * 1000
						),
						tallyingStarts: now + 14 * 24 * 60 * 60 * 1000,
						validation: now + 15 * 24 * 60 * 60 * 1000,
						certificationStarts: now + 16 * 24 * 60 * 60 * 1000,
						closed: now + 17 * 24 * 60 * 60 * 1000,
					},
					keyholderThreshold: revision.threshold,
				},
			};
			await electionsEngine.createElection(init);
		} catch (err) {
			console.error("createElection error:", err);
		}
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

					<DateField
						title={t("date")}
						placeholder={t("selectDate")}
						value={coreDate}
						onChange={setCoreDate}
					/>
					<ThemedText type="small" style={localStyles.helperText}>
						{t("coreDateHelp")}
					</ThemedText>

					<DateField
						title={t("revisionDeadline")}
						value={coreRevisionDeadline}
						onChange={setCoreRevisionDeadline}
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
			<Footer>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</Footer>
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
