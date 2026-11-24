import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { CustomTextInput } from "../../components/CustomTextInput";
import { DateField } from "../../components/DateField";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { ElectionRevisionForm, ElectionRevisionFormValue } from "./components/ElectionRevisionForm";
import { useApp } from "../../providers/AppProvider";
import { ElectionType } from "@votetorrent/vote-core";
import type { IElectionsEngine, INetworkEngine } from "@votetorrent/vote-core";
import { checkElectionKeyholders, createElection } from "@votetorrent/workflows/authority";
import type { ElectionSetupRefusal } from "@votetorrent/workflows/authority";
import { createDeviceSigner } from "../../engines/device-signer";
import { mapElectionError } from "./election-error-messages";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { findAuthorityName } from "../../utils/findAuthorityName";
import { KEYHOLDER_POLICY_ERROR_KEY } from "./keyholder-policy";
import { resolveElectionTimeline, CREATE_FALLBACK_DAYS } from "./resolve-election-timeline";

// Phase 9 plan 09-12 (ELECUI-03) — Single-scroll New Election form.
// Phase 20 plan 20-06 (EUI-02, EUI-03) — type radio + per-field inline validation.
// EUI-02 (D-05): electionType is now useState-backed; radio control replaces read-only row.
// EUI-03 (D-06/D-07): per-field InlineError under title, date, revisionDeadline fields.
// D-06: electionTitle = coreTitle.trim() — validated non-empty above (EUI-03), no silent default.

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

	// Phase 16 Plan 03 — authorityId/name resolved from the real network chain (D-04).
	const [authorityId, setAuthorityId] = useState<string>("");
	const [authorityName, setAuthorityName] = useState<string>("");

	// EUI-02 (D-05): election type state — was hardcoded const, now useState-backed
	const [electionType, setElectionType] = useState<ElectionType>(ElectionType.official);

	// EUI-03 (D-06/D-07): per-field inline validation error state
	const [titleError, setTitleError] = useState<string>("");
	const [dateError, setDateError] = useState<string>("");
	const [revisionDeadlineError, setRevisionDeadlineError] = useState<string>("");

	// 16-08 item 4: surface the ACTUAL propose failure inline (not just console.error).
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isCreating, setIsCreating] = useState(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	useEffect(() => {
		async function loadAuthority() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine?.getDetails();
				const primaryAuthorityId = details?.network?.primaryAuthorityId;
				if (primaryAuthorityId) {
					setAuthorityId(primaryAuthorityId);
					// The AUTHORITY's name, not the network's (it used to show network.name). Falls back
					// to the id when the authority row can't be read yet.
					let name: string | undefined;
					try {
						name = engine ? await findAuthorityName(engine, primaryAuthorityId) : undefined;
					} catch (lookupError) {
						console.warn("Error looking up authority name:", lookupError instanceof Error ? lookupError.name : typeof lookupError);
					}
					setAuthorityName(name ?? primaryAuthorityId);
				}
			} catch (error) {
				console.warn("Error loading authority for election:", error);
			}
		}
		loadAuthority();
	}, [getEngine]);

	// Presentation only: map a shared createElection refusal code to the field it belongs to.
	const applyElectionRefusal = (refusal: ElectionSetupRefusal) => {
		switch (refusal.code) {
			case "title-required":
				setTitleError(t("errTitleRequired"));
				return;
			case "no-keyholders":
				setErrorMessage(t("atLeastOneKeyholderRequired"));
				return;
			case "election-date-invalid":
				setDateError(t("errElectionDateInvalid"));
				return;
			case "revision-deadline-invalid":
				setRevisionDeadlineError(t("errRevisionDeadlineInvalid"));
				return;
			case "revision-deadline-after-date":
				setRevisionDeadlineError(t("errRevisionDeadlineAfterDate"));
				return;
			case "election-date-too-soon":
				setDateError(
					t("errElectionDateTooSoon", {
						date: new Date(refusal.ballotDeadline ?? 0).toLocaleDateString(),
					})
				);
				return;
			case "timeline-order":
				setErrorMessage(t("errTimelineOrder"));
				return;
			default:
				setErrorMessage(t(KEYHOLDER_POLICY_ERROR_KEY[refusal.code]));
				return;
		}
	};

	// Phase 16 Plan 03 — PROPOSE wires the real engine-signing seam + createElection (FLOW-03).
	// Phase 20 plan 20-06 — EUI-03: validates title + visible date fields before engine call.
	// Phase 67 plan 10 — the workflow body lives in @votetorrent/workflows (createElection); this
	// screen keeps state, field errors and navigation.
	const handlePropose = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");

		// EUI-03 (D-06/D-07): validate required fields before proceeding to engine call.
		// Validate ONLY title + the two visible date fields (RESEARCH OQ2 — ballotDeadline stays auto-computed).
		if (!coreTitle.trim()) {
			setTitleError(t("errTitleRequired"));
			return;
		}
		if (!coreDate.trim()) {
			setDateError(t("errElectionDateRequired"));
			return;
		}
		if (!coreRevisionDeadline.trim()) {
			setRevisionDeadlineError(t("errRevisionDeadlineRequired"));
			return;
		}

		// WR-02 + WR-03: the shared keyholder check strips blank rows, refuses an empty list and
		// applies the 2-of-N policy, all before any engine call or device-signer resolution.
		const keyholderCheck = checkElectionKeyholders(revision.keyholders, revision.threshold);
		if (!keyholderCheck.ok) {
			applyElectionRefusal(keyholderCheck.refusal);
			return;
		}

		setIsCreating(true);
		try {
			const electionsEngine = await getEngine<IElectionsEngine>("elections");
			if (!electionsEngine) {
				navigation.goBack();
				return;
			}

			const now = Date.now();

			// resolveElectionTimeline is the single shared construction site both this screen
			// and EditElectionScreen build through (D-16) — see resolve-election-timeline.ts
			// for the "relative to votingStarts, not now" rationale.
			const resolvedTimeline = resolveElectionTimeline(revision, now, CREATE_FALLBACK_DAYS);

			// The workflow body (date parsing refusals, deadline coherence, the v1.1 builder, the two
			// signing seams and createElection) is the shared createElection. The device signer is
			// built once, inside createSigner — the callback closes over the device private key
			// app-side (D-01); the key never crosses into vote-engine. The app passes no
			// ballotDeadline, so the shared 10-day rule applies.
			const result = await createElection({
				electionsEngine,
				input: {
					authorityId,
					title: coreTitle,
					date: new Date(coreDate).getTime(),
					revisionDeadline: new Date(coreRevisionDeadline).getTime(),
					type: electionType,
					keyholders: revision.keyholders,
					threshold: revision.threshold,
					tags: revision.tags,
					instructions: revision.instructions,
					timeline: resolvedTimeline,
				},
				createSigner: () => createDeviceSigner("Device User"),
				now,
			});
			if (!result.ok) {
				// A refusal is a field-level message, never a write; the finally resets isCreating.
				applyElectionRefusal(result.refusal);
				return;
			}
		} catch (err) {
			console.warn("createElection error:", err);
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? mapElectionError(err, t));
			return;
		} finally {
			setIsCreating(false);
		}
		navigation.goBack();
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView
				keyboardShouldPersistTaps="handled"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* ── Read-only Authority row + EUI-02 Election Type radio control ── */}
				<View style={styles.section}>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText type="default" testID="create-election-authority" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>{authorityName || t("loading")}</ThemedText>
					</View>

					{/* EUI-02 (D-05): radio control replaces read-only "{t("official")}" row */}
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

				{/* ── Core section ─────────────────────────────────────────── */}
				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("coreSectionHeader")}
					</ThemedText>

					{/* EUI-03: title field + InlineError */}
					<CustomTextInput
						title={t("title")}
						value={coreTitle}
						onChangeText={(v) => { setCoreTitle(v); setTitleError(""); }}
					/>
					<InlineError message={titleError} />

					{/* EUI-03: date field + InlineError */}
					<DateField
						title={t("date")}
						placeholder={t("selectDate")}
						value={coreDate}
						onChange={(v) => { setCoreDate(v); setDateError(""); }}
					/>
					<InlineError message={dateError} />
					<ThemedText type="small" style={localStyles.helperText}>
						{t("coreDateHelp")}
					</ThemedText>

					{/* EUI-03: revisionDeadline field + InlineError */}
					<DateField
						title={t("revisionDeadline")}
						value={coreRevisionDeadline}
						onChange={(v) => { setCoreRevisionDeadline(v); setRevisionDeadlineError(""); }}
					/>
					<InlineError message={revisionDeadlineError} />
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
			<InlineError message={errorMessage} />
			<Footer>
				<CustomButton
					title={isCreating ? `${t("propose")}…` : t("propose")}
					icon="floppy-disk"
					disabled={isCreating}
					onPress={handlePropose}
					backgroundColor={colors.success}
					forceDarkText={true}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
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
	fieldLabel: {
		marginBottom: 8,
		marginTop: 8,
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
