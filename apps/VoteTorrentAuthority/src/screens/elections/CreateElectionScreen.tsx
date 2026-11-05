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
import type { IElectionsEngine, INetworkEngine, ElectionInit } from "@votetorrent/vote-core";
import { ElectionsCreateElectionBuilder } from "@votetorrent/vote-engine";
import { createDeviceSigner } from "../../engines/device-signer";
import { mapElectionError } from "./election-error-messages";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { findAuthorityName } from "../../utils/findAuthorityName";
import { KEYHOLDER_POLICY_ERROR_KEY, validateKeyholderPolicy } from "./keyholder-policy";
import {
	resolveElectionTimeline,
	findTimelineOrderViolation,
	CREATE_FALLBACK_DAYS,
} from "./resolve-election-timeline";

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

	// Phase 16 Plan 03 — PROPOSE wires the real engine-signing seam + createElection (FLOW-03).
	// Phase 20 plan 20-06 — EUI-03: validates title + visible date fields before engine call.
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

		// WR-02 + WR-03: enforce the "at least one keyholder" model invariant
		// (ElectionRevisionInit.keyholders) and strip blank rows so empty names
		// never inflate keyholders.length / keyholderThreshold.
		const cleanKeyholders = revision.keyholders
			.map((name) => name.trim())
			.filter(Boolean);
		if (cleanKeyholders.length === 0) {
			setErrorMessage(t("atLeastOneKeyholderRequired"));
			return;
		}

		const policy = validateKeyholderPolicy(cleanKeyholders, Math.trunc(revision.threshold));
		if (!policy.ok) {
			setErrorMessage(t(KEYHOLDER_POLICY_ERROR_KEY[policy.reason]));
			return;
		}

		setIsCreating(true);
		try {
			const electionsEngine = await getEngine<IElectionsEngine>("elections");
			if (!electionsEngine) {
				navigation.goBack();
				return;
			}

			// Build the device signer once — the callback closes over the device private key
			// app-side (D-01). The key never crosses into vote-engine.
			const signer = await createDeviceSigner("Device User");

			const now = Date.now();

			// Resolve the full 10-event timeline ONCE so the builder payload and the
			// revision-signing seam below sign an IDENTICAL timeline (the digests must match).
			// resolveElectionTimeline is the single shared construction site both this screen
			// and EditElectionScreen build through (D-16) — see resolve-election-timeline.ts
			// for the "relative to votingStarts, not now" rationale.
			const resolvedTimeline = resolveElectionTimeline(revision, now, CREATE_FALLBACK_DAYS);

			// WR-05: the two required core date fields must actually PARSE — do not let an
			// unparseable string silently fall back to a fabricated now+N-days timeline in
			// the signed, immutable election. Surface a field error instead.
			const parsedCoreDate = new Date(coreDate).getTime();
			if (Number.isNaN(parsedCoreDate)) {
				setDateError(t("errElectionDateInvalid"));
				return;
			}
			const parsedRevisionDeadline = new Date(coreRevisionDeadline).getTime();
			if (Number.isNaN(parsedRevisionDeadline)) {
				setRevisionDeadlineError(t("errRevisionDeadlineInvalid"));
				return;
			}

			// Generate the election id once and use it for both the seam call and the builder
			// payload — the AdminSigning.Digest and Election.InsertValid Digest must use the
			// IDENTICAL id (field contract: screen generates id, passes to both paths).
			const electionId = `election-${now}`;
			const electionDate = parsedCoreDate;
			const electionRevisionDeadline = parsedRevisionDeadline;
			const electionBallotDeadline = now + 10 * 24 * 60 * 60 * 1000;
			// EUI-03 (D-06): validated non-empty above — trim() only, no silent default
			const electionTitle = coreTitle.trim();

			// Deadline coherence — catch these BEFORE the engine so the user gets a
			// friendly, field-level message instead of a raw SQL CHECK
			// (RevisionDeadline ≤ Date / BallotDeadlineValid) or a builder TIMELINE_ORDER error.
			if (electionRevisionDeadline > electionDate) {
				setRevisionDeadlineError(t("errRevisionDeadlineAfterDate"));
				return;
			}
			if (electionBallotDeadline > electionDate) {
				setDateError(
					t("errElectionDateTooSoon", {
						date: new Date(electionBallotDeadline).toLocaleDateString(),
					})
				);
				return;
			}
			if (findTimelineOrderViolation(resolvedTimeline) !== null) {
				setErrorMessage(t("errTimelineOrder"));
				return;
			}

			// Assemble the full payload via the v1.1 builder (D-03 / FACT-02)
			const builder = new ElectionsCreateElectionBuilder(electionsEngine)
				.setElection({
					id: electionId,
					authorityId,
					title: electionTitle,
					date: electionDate,
					revisionDeadline: electionRevisionDeadline,
					ballotDeadline: electionBallotDeadline,
					type: electionType,
				})
				.setRevision({
					electionId,
					revision: 0,
					revisionTimestamp: now - 1000,
					tags: revision.tags,
					instructions: revision.instructions,
					keyholders: cleanKeyholders.map((name) => ({
						name,
						type: "k",
						expiration: "0",
						inviteKey: "",
						invitePrivate: "",
						inviteSignature: "",
						digest: "",
					})),
					timeline: resolvedTimeline,
					keyholderThreshold: Math.max(0, Math.trunc(revision.threshold)),
				});

			// Drive the engine signing seam — seam owns tid + Digest computation (D-03);
			// the signer callback closes over the device private key app-side (D-01).
			// Pass the SAME election fields (id, authorityId, title, date, ...) so the seam's
			// internal AdminSigning.Digest matches what createElection's Election.InsertValid computes.
			const signingNonce = await electionsEngine.seedElectionSigning(
				{
					id: electionId,
					authorityId,
					title: electionTitle,
					date: electionDate,
					revisionDeadline: electionRevisionDeadline,
					ballotDeadline: electionBallotDeadline,
					type: electionType,
				},
				signer
			);

			// Sign the ElectionRevision row (Revision=0) via the companion seam.
			// revTid = (await electionsEngine.peekNextTid()) + 1 (Election consumes T, revision
			// consumes T+1). pastRevTs = now - 1000 — must be PAST and identical to what
			// builder.setRevision received.
			// 999.1 D-15 fix: peekNextTid() is an IElectionsEngine interface method (delegates
			// to the namespace-allocator-backed peekNextElectionTid(db) internally) — the screen
			// never holds a raw Database handle, so it cannot call the standalone
			// peekNextElectionTid(db) function directly.
			const pastRevTs = now - 1000;
			const revTid = (await electionsEngine.peekNextTid()) + 1;
			// Same object the builder payload signs — must be identical (digest parity).
			const revisionTimeline = resolvedTimeline;
			const revisionSigningNonce = await electionsEngine.seedElectionRevisionSigning(
				electionId,
				authorityId,
				{
					revision: 0,
					revisionTimestamp: pastRevTs,
					tags: revision.tags,
					instructions: revision.instructions,
					timeline: revisionTimeline,
					keyholderThreshold: Math.max(0, Math.trunc(revision.threshold)),
				},
				revTid,
				signer,
			);

			// Call createElection directly (not via builder.commit()) so both nonces are forwarded —
			// ElectionsCreateElectionBuilder.commit() does NOT forward signingNonce (RESEARCH FQ3 option a).
			const payload = builder.build();
			// D-27: no local scaffold persistence — createElection already persists
			// ElectionRevision.Keyholders, and the engine is the single source.
			await electionsEngine.createElection(payload, { signingNonce, revisionSigningNonce });
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
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* ── Read-only Authority row + EUI-02 Election Type radio control ── */}
				<View style={styles.section}>
					<View style={localStyles.contextRow}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText type="default" testID="create-election-authority" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>{authorityName || "Loading..."}</ThemedText>
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
