import { ExtendedTheme, useTheme, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useEffect, useState } from "react";
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
import type { IElectionsEngine, INetworkEngine, ElectionInit } from "@votetorrent/vote-core";
import { ElectionsCreateElectionBuilder, peekNextElectionTid } from "@votetorrent/vote-engine";
import { getOrCreateDeviceUser, getDevicePrivKeyHex } from "../../engines/device-user";

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

	// Phase 16 Plan 03 — authorityId/name resolved from the real network chain (D-04).
	// Replaces the D-18 hardcoded placeholder strings that were in the original stub.
	const [authorityId, setAuthorityId] = useState<string>("");
	const [authorityName, setAuthorityName] = useState<string>("");
	// 16-08 item 4: surface the ACTUAL propose failure inline (not just console.error).
	const [errorMessage, setErrorMessage] = useState<string>("");

	useEffect(() => {
		async function loadAuthority() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine?.getDetails();
				if (details?.network?.primaryAuthorityId) {
					setAuthorityId(details.network.primaryAuthorityId);
				}
				if (details?.network?.name) {
					setAuthorityName(details.network.name);
				}
			} catch (error) {
				console.error("Error loading authority for election:", error);
			}
		}
		loadAuthority();
	}, [getEngine]);

	// Phase 16 Plan 03 — PROPOSE wires the real engine-signing seam + createElection (FLOW-03).
	// Tier split (B2): signing pipeline lives entirely in ElectionsEngine.seedElectionSigning.
	// The screen passes privKeyHex + election fields; the seam owns tid/Digest/secp256k1.
	const handlePropose = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		try {
			const electionsEngine = await getEngine<IElectionsEngine>("elections");
			if (!electionsEngine) {
				navigation.goBack();
				return;
			}

			// Source the device user and private key (generate on first run via device-user helper)
			const user = await getOrCreateDeviceUser("Device User");
			const privKeyHex = await getDevicePrivKeyHex();
			if (!privKeyHex) {
				console.error("handlePropose: device private key not available");
				setErrorMessage("Device private key not available — cannot sign the election.");
				return;
			}

			const now = Date.now();
			const parseDateOrFallback = (s: string, fallbackMs: number): number =>
				s.trim() ? new Date(s).getTime() || fallbackMs : fallbackMs;

			// Generate the election id once and use it for both the seam call and the builder
			// payload — the AdminSigning.Digest and Election.InsertValid Digest must use the
			// IDENTICAL id (field contract: screen generates id, passes to both paths).
			const electionId = `election-${now}`;
			const electionDate = parseDateOrFallback(coreDate, now + 14 * 24 * 60 * 60 * 1000);
			const electionRevisionDeadline = parseDateOrFallback(
				coreRevisionDeadline,
				now + 7 * 24 * 60 * 60 * 1000
			);
			const electionBallotDeadline = now + 10 * 24 * 60 * 60 * 1000;
			const electionTitle = coreTitle || "Untitled Election";
			const electionType = ElectionType.official;

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
					keyholderThreshold: Math.max(0, Math.trunc(revision.threshold)),
				});

			// Drive the engine signing seam — seam owns tid + Digest + real secp256k1 sign (D-01).
			// Pass the SAME election fields (id, authorityId, title, date, ...) so the seam's
			// internal AdminSigning.Digest matches what createElection's Election.InsertValid computes.
			const signingNonce = await (electionsEngine as unknown as {
				seedElectionSigning(
					fields: {
						id: string; authorityId: string; title: string;
						date: number; revisionDeadline: number; ballotDeadline: number; type: string;
					},
					privKeyHex: string,
					signerUserId: string,
					signerKey: string
				): Promise<string>;
			}).seedElectionSigning(
				{
					id: electionId,
					authorityId,
					title: electionTitle,
					date: electionDate,
					revisionDeadline: electionRevisionDeadline,
					ballotDeadline: electionBallotDeadline,
					type: electionType,
				},
				privKeyHex,
				user.id,
				user.activeKeys[0].key
			);

			// Sign the ElectionRevision row (Revision=0) via the companion seam.
			// revTid = peekNextElectionTid() + 1 (Election consumes T, revision consumes T+1).
			// pastRevTs = now - 1000 — must be PAST and identical to what builder.setRevision received.
			// peekNextElectionTid is imported statically from @votetorrent/vote-engine at top of file.
			const pastRevTs = now - 1000;
			const revTid = peekNextElectionTid() + 1;
			const revisionTimeline = {
				registrationEnds: parseDateOrFallback(revision.registrationEnds, now + 2 * 24 * 60 * 60 * 1000),
				ballotsFinal: parseDateOrFallback(revision.ballotsFinal, now + 5 * 24 * 60 * 60 * 1000),
				votingStarts: parseDateOrFallback(revision.votingStarts, now + 10 * 24 * 60 * 60 * 1000),
				tallyingStarts: now + 14 * 24 * 60 * 60 * 1000,
				validation: now + 15 * 24 * 60 * 60 * 1000,
				certificationStarts: now + 16 * 24 * 60 * 60 * 1000,
				closed: now + 17 * 24 * 60 * 60 * 1000,
			};
			const revisionSigningNonce = await (electionsEngine as unknown as {
				seedElectionRevisionSigning(
					electionId: string,
					authorityId: string,
					revision: {
						revision: number;
						revisionTimestamp: number;
						tags: string[];
						instructions: string;
						timeline: Record<string, number>;
						keyholderThreshold: number;
					},
					tid: number,
					privKeyHex: string,
					signerUserId: string,
					signerKey: string,
				): Promise<string>;
			}).seedElectionRevisionSigning(
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
				privKeyHex,
				user.id,
				user.activeKeys[0].key,
			);

			// Call createElection directly (not via builder.commit()) so both nonces are forwarded —
			// ElectionsCreateElectionBuilder.commit() does NOT forward signingNonce (RESEARCH FQ3 option a).
			const payload = builder.build();
			await electionsEngine.createElection(payload, { signingNonce, revisionSigningNonce });
		} catch (err) {
			console.error("createElection error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
			return;
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
						<ThemedText type="default">{authorityName || "Loading..."}</ThemedText>
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
			{errorMessage ? (
				<ThemedText type="small" style={{ color: colors.error }}>
					{errorMessage}
				</ThemedText>
			) : null}
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
