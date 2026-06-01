import { ExtendedTheme, useTheme, useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { globalStyles } from "../../theme/styles";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../navigation/types";
import { ElectionRevisionForm, ElectionRevisionFormValue } from "./components/ElectionRevisionForm";
import { useApp } from "../../providers/AppProvider";
import { ElectionType } from "@votetorrent/vote-core";
import type { IElectionsEngine, ElectionInit } from "@votetorrent/vote-core";

// Phase 9 plan 09-13 (ELECUI-04) — Election Revision form (Screen C, Figma #16/#17).
// Replaces thin scaffold (title/description/tags/voting dates) from 09-03.
// Route typed against EditElectionRevision (NOT EditElection — task-flow stub).
// electionEngine read from route.params (not taskId — dropped entirely).
// Context block uses hardcoded mock strings (D-18; no engine import).
// PROPOSE stub: console.log + goBack. Persistence deferred to 09-15.
// D-17: en-only i18n; Spanish deferred to Phase 11.
export default function EditElectionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const route = useRoute<RouteProp<RootStackParamList, "EditElectionRevision">>();
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();

	// electionEngine from route params (optional — not exercised at v1.1 per D-18)
	const electionEngine = route.params?.electionEngine;

	// Proposed Revision form state
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

	// Phase 9 plan 09-15 — PROPOSE calls electionsEngine.adjustElection, then goBack.
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
					id: "election-2",
					authorityId: "auth-b",
					title: "Test Election 2 (Future)",
					date: now + 14 * 24 * 60 * 60 * 1000,
					revisionDeadline: now + 7 * 24 * 60 * 60 * 1000,
					ballotDeadline: now + 5 * 24 * 60 * 60 * 1000,
					type: ElectionType.official,
				},
				revision: {
					electionId: "election-2",
					revision: 2,
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
							now + 3 * 24 * 60 * 60 * 1000
						),
						ballotsFinal: parseDateOrFallback(
							revision.ballotsFinal,
							now + 6 * 24 * 60 * 60 * 1000
						),
						votingStarts: parseDateOrFallback(
							revision.votingStarts,
							now + 11 * 24 * 60 * 60 * 1000
						),
						tallyingStarts: now + 15 * 24 * 60 * 60 * 1000,
						validation: now + 16 * 24 * 60 * 60 * 1000,
						certificationStarts: now + 17 * 24 * 60 * 60 * 1000,
						closed: now + 18 * 24 * 60 * 60 * 1000,
					},
					keyholderThreshold: revision.threshold,
				},
			};
			await electionsEngine.adjustElection(init);
		} catch (err) {
			console.error("adjustElection error:", err);
		}
		navigation.goBack();
	};

	return (
		<View style={styles.content}>
			<ScrollView
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* ── Read-only election context block ─────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={localStyles.electionTitle}>
						{"Republican Primary"}
					</ThemedText>

					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText type="default">{"Mock Authority B"}</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
						<ThemedText type="default">{t("official")}</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("dateTime")}: </ThemedText>
						<ThemedText type="default">{"Nov 5, 2024 7:00 AM"}</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("revisionDeadline")}: </ThemedText>
						<ThemedText type="default">{"Oct 1, 2024 11:59 PM"}</ThemedText>
					</View>
				</View>

				{/* ── Proposed Revision header ──────────────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("proposedRevisionHeader")}
					</ThemedText>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
						<ThemedText type="default">{"#1 - Sep 15, 2024"}</ThemedText>
					</View>
				</View>

				{/* ── Shared ElectionRevisionForm ───────────────────────────────── */}
				<View style={styles.section}>
					<ElectionRevisionForm
						value={revision}
						onChange={setRevision}
						tagOptions={["Primary", "Utah", "General", "Local"]}
					/>
				</View>
			</ScrollView>

			{/* ── PROPOSE footer ────────────────────────────────────────────────── */}
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

const localStyles = StyleSheet.create({
	electionTitle: {
		marginBottom: 8,
		fontSize: 18,
	},
	contextRow: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
