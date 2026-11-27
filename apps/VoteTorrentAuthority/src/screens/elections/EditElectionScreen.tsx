import { ExtendedTheme, useTheme, useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorCopy } from "../../utils/errorCopy";
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
import type { IElectionEngine, IElectionsEngine, ElectionDetails } from "@votetorrent/vote-core";
import { checkElectionKeyholders, proposeElectionRevision } from "@votetorrent/workflows/authority";
import type { ElectionSetupRefusal } from "@votetorrent/workflows/authority";
import { mapElectionError } from "./election-error-messages";
import { InlineError } from "../../components/InlineError";
import { KEYHOLDER_POLICY_ERROR_KEY } from "./keyholder-policy";
import { resolveElectionTimeline, EDIT_FALLBACK_DAYS } from "./resolve-election-timeline";

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
		votingStarts: "",
		accruingVotes: "",
		hashingVotes: "",
		releasingKeys: "",
		tallyingStarts: "",
		validation: "",
		certificationStarts: "",
		closed: "",
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
				// Seed revision form from the current revision so all fields are pre-populated.
				// Keyholder names live at kh.invite.name (InviteStatus<SentKeyholderInvite>).
				// Timeline numbers are Unix ms → convert to ISO strings for DateField.
				const cur = loaded.current;
				const toISO = (ms: number | undefined): string =>
					ms != null && ms > 0 ? new Date(ms).toISOString() : "";
				setRevision({
					registrationEnds: toISO(cur.timeline.registrationEnds),
					ballotsFinal: toISO(cur.timeline.ballotsFinal),
					votingStarts: toISO(cur.timeline.votingStarts),
					accruingVotes: toISO(cur.timeline.accruingVotes),
					hashingVotes: toISO(cur.timeline.hashingVotes),
					releasingKeys: toISO(cur.timeline.releasingKeys),
					tallyingStarts: toISO(cur.timeline.tallyingStarts),
					validation: toISO(cur.timeline.validation),
					certificationStarts: toISO(cur.timeline.certificationStarts),
					closed: toISO(cur.timeline.closed),
					// D-27: keyholders come from the engine only.
					keyholders: cur.keyholders.map((kh) => kh.invite.name),
					threshold: cur.keyholderThreshold,
					tags: cur.tags ?? [],
					instructions: cur.instructions ?? "",
				});
			} catch (error) {
				console.warn("Error loading election for edit:", error);
				setErrorMessage(errorCopy(error, t, "read"));
			}
		}
		loadElection();
	}, [electionEngine]);

	// Presentation only: map a shared proposeElectionRevision refusal code to its message.
	const applyRevisionRefusal = (refusal: ElectionSetupRefusal) => {
		if (refusal.code === "no-keyholders") {
			setErrorMessage(t("atLeastOneKeyholderRequired"));
		} else if (refusal.code === "timeline-order") {
			setErrorMessage(t("errTimelineOrder"));
		} else if (refusal.code in KEYHOLDER_POLICY_ERROR_KEY) {
			setErrorMessage(t(KEYHOLDER_POLICY_ERROR_KEY[refusal.code as keyof typeof KEYHOLDER_POLICY_ERROR_KEY]));
		} else {
			setErrorMessage(t("errTimelineOrder"));
		}
	};

	// handlePropose hands cached `details` + live form state to the shared proposeElectionRevision,
	// which builds the REAL ElectionInit (IN-24: revision.electionId equals election.id, both from
	// details.election.id) and calls the non-signing adjustElection.
	// Reads from cached `details` state — does NOT re-fetch (no double-fetch race with form edits).
	// Phase 67 plan 10 — the workflow body lives in @votetorrent/workflows; this screen keeps state,
	// messages and navigation.
	const handlePropose = async () => {
		setErrorMessage("");
		if (!details) {
			return;
		}

		// WR-02 + WR-03: the shared keyholder check strips blank rows, refuses an empty list and
		// applies the 2-of-N policy, all before any engine call.
		const keyholderCheck = checkElectionKeyholders(revision.keyholders, revision.threshold);
		if (!keyholderCheck.ok) {
			applyRevisionRefusal(keyholderCheck.refusal);
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

			// resolveElectionTimeline is the single shared construction site both this
			// screen and CreateElectionScreen build through (D-16) — see
			// resolve-election-timeline.ts for the "relative to votingStarts, not now"
			// rationale.
			const resolvedTimeline = resolveElectionTimeline(revision, now, EDIT_FALLBACK_DAYS);

			// The shared body applies the eight-event strict-chain guard BEFORE adjustElection and
			// returns a refusal instead of writing (CR-02: one guard, no hand-typed copies).
			const result = await proposeElectionRevision({
				electionsEngine,
				current: details,
				input: {
					// EUI-02 (D-05): from radio state (seeded from loaded election.type)
					type: electionType,
					keyholders: revision.keyholders,
					threshold: revision.threshold,
					tags: revision.tags,
					instructions: revision.instructions,
					timeline: resolvedTimeline,
				},
				now,
			});
			if (!result.ok) {
				applyRevisionRefusal(result.refusal);
				setProposing(false);
				return;
			}
			// D-27: no local scaffold persistence — adjustElection already persists
			// ProposedElectionRevision.Keyholders, and the engine is the single source.
			// goBack only on success (D-19 — NOT after the catch)
			navigation.goBack();
		} catch (err) {
			console.warn("adjustElection error:", err);
			// D-19 (SC6): surface a friendly error inline instead of a raw engine/SQL message
			setErrorMessage(mapElectionError(err, t));
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
			<InlineError message={errorMessage} />

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
