import { ExtendedTheme, useTheme, useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
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
import type { IElectionEngine, IElectionsEngine, ElectionInit, ElectionDetails } from "@votetorrent/vote-core";

// Phase 9 plan 09-13 (ELECUI-04) — Election Revision form (Screen C, Figma #16/#17).
// Phase 20 plan 20-06 (EUI-01, EUI-02) — wire real adjustElection from single cached load.
// EUI-01 (D-01): election details fetched ONCE in useEffect; handlePropose reads from cache.
// adjustElection is non-signing (IsUserValid=true, no seedElectionSigning seam needed — D-01).
// D-05 (EUI-02): election-type radio control (adhoc/official) seeded from loaded election.
// D-19 (SC6): adjustElection errors surface inline; goBack only on success inside try.
export default function EditElectionScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const route = useRoute<RouteProp<RootStackParamList, "EditElectionRevision">>();
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();

	// electionEngine from route params (IElectionEngine — per-election engine for getElectionDetails)
	const electionEngine = route.params?.electionEngine as IElectionEngine | undefined;

	// Single cached load: fetched once in useEffect below.
	// handlePropose reads ids/dates/revision from this cached state — never re-fetches.
	const [details, setDetails] = useState<ElectionDetails | null>(null);

	// EUI-02: election type state (seeded from loaded election.type, user-editable via radio)
	const [electionType, setElectionType] = useState<ElectionType>(ElectionType.official);

	// SC6 / D-19: inline error state
	const [errorMessage, setErrorMessage] = useState<string>("");

	// Loading guard
	const [proposing, setProposing] = useState<boolean>(false);

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

	// SINGLE data-loading useEffect — loads once on mount, caches full ElectionDetails.
	// handlePropose reads from cached `details` state and never re-fetches (no double-fetch race).
	useEffect(() => {
		async function loadElection() {
			if (!electionEngine) return;
			try {
				const loaded = await electionEngine.getElectionDetails();
				setDetails(loaded);
				// Seed electionType from the loaded election (user can then change it via radio)
				setElectionType(loaded.election.type);
			} catch (error) {
				console.error("Error loading election for edit:", error);
				setErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}
		loadElection();
	}, [electionEngine]);

	// handlePropose builds a REAL ElectionInit from cached `details` + live form state.
	// Reads from cached `details` state — does NOT re-fetch (no double-fetch race with form edits).
	// IN-24 guard: revision.electionId MUST equal election.id — both sourced from details.election.id.
	const handlePropose = async () => {
		setErrorMessage("");
		if (!details) {
			return;
		}
		setProposing(true);
		try {
			// Pitfall 4: adjustElection is on IElectionsEngine (not the route's IElectionEngine)
			const electionsEngine = await getEngine<IElectionsEngine>("elections");
			if (!electionsEngine) {
				setProposing(false);
				return;
			}
			const now = Date.now();
			const parseDateOrFallback = (s: string, fallbackMs: number): number =>
				s.trim() ? new Date(s).getTime() || fallbackMs : fallbackMs;

			const init: ElectionInit = {
				election: {
					// EUI-01 (D-01): real ids from cached details — no hardcoded fixture strings
					id: details.election.id,
					authorityId: details.election.authorityId,
					title: details.election.title,
					date: details.election.date,
					revisionDeadline: details.election.revisionDeadline,
					ballotDeadline: details.election.ballotDeadline,
					// EUI-02 (D-05): from radio state (seeded from loaded election.type)
					type: electionType,
				},
				revision: {
					// IN-24: revision.electionId MUST equal election.id — use the SAME expression
					electionId: details.election.id,
					revision: (details.current.revision ?? 0) + 1,
					// revisionTimestamp must be in the past
					revisionTimestamp: now - 1000,
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
					keyholderThreshold: Math.max(0, Math.trunc(revision.threshold)),
				},
			};
			// No seedElectionSigning — adjustElection is non-signing (D-01, RESEARCH Pattern 1)
			await electionsEngine.adjustElection(init);
			// goBack only on success (D-19 — NOT after the catch)
			navigation.goBack();
		} catch (err) {
			console.error("adjustElection error:", err);
			// D-19 (SC6): surface error inline instead of silently failing
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			setProposing(false);
		}
		// NOTE: no unconditional navigation.goBack() here (goBack is inside try on success)
	};

	return (
		<View style={styles.content}>
			<ScrollView
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* ── Read-only election context block (real data from cached details) ── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={localStyles.electionTitle}>
						{details ? details.election.title : t("loading")}
					</ThemedText>

					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText type="default">{details ? details.election.authorityId : "..."}</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("dateTime")}: </ThemedText>
						<ThemedText type="default">
							{details ? new Date(details.election.date).toLocaleDateString() : "..."}
						</ThemedText>
					</View>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("revisionDeadline")}: </ThemedText>
						<ThemedText type="default">
							{details ? new Date(details.election.revisionDeadline).toLocaleDateString() : "..."}
						</ThemedText>
					</View>
				</View>

				{/* ── Proposed Revision header ──────────────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("proposedRevisionHeader")}
					</ThemedText>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
						<ThemedText type="default">
							{details ? `#${(details.current.revision ?? 0) + 1}` : "..."}
						</ThemedText>
					</View>
				</View>

				{/* ── EUI-02 Election Type radio control ───────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={localStyles.fieldLabel}>
						{t("electionType")}
					</ThemedText>
					<View style={localStyles.radioRow}>
						<TouchableOpacity
							style={localStyles.radioOption}
							onPress={() => setElectionType(ElectionType.adhoc)}
						>
							<View style={[localStyles.radioOuter, { borderColor: electionType === ElectionType.adhoc ? colors.primary : colors.textSecondary }]}>
								{electionType === ElectionType.adhoc && (
									<View style={[localStyles.radioInner, { backgroundColor: colors.primary }]} />
								)}
							</View>
							<ThemedText style={localStyles.radioLabel}>{t("adhoc")}</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							style={localStyles.radioOption}
							onPress={() => setElectionType(ElectionType.official)}
						>
							<View style={[localStyles.radioOuter, { borderColor: electionType === ElectionType.official ? colors.primary : colors.textSecondary }]}>
								{electionType === ElectionType.official && (
									<View style={[localStyles.radioInner, { backgroundColor: colors.primary }]} />
								)}
							</View>
							<ThemedText style={localStyles.radioLabel}>{t("official")}</ThemedText>
						</TouchableOpacity>
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

			{/* ── SC6 / D-19: inline error above footer ────────────────────────── */}
			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}

			{/* ── PROPOSE footer ────────────────────────────────────────────────── */}
			<Footer>
				<CustomButton
					title={t("propose")}
					icon="floppy-disk"
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
					disabled={proposing || !details}
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
	fieldLabel: {
		marginBottom: 8,
	},
	radioRow: {
		flexDirection: "row",
		gap: 24,
	},
	radioOption: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 4,
	},
	radioOuter: {
		width: 20,
		height: 20,
		borderRadius: 10,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
	},
	radioInner: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	radioLabel: {
		fontSize: 15,
	},
});

const styles = { ...globalStyles, ...localStyles };
