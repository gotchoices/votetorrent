import { useCallback, useRef, useState } from "react";
import { ExtendedTheme, useFocusEffect, useRoute, useTheme } from "@react-navigation/native";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type {
	BlockCoverage,
	ElectionResults,
	ElectionResultsEngine,
	PublishedTally,
	QuestionResult,
	TallyPublicationEngine,
} from "@votetorrent/vote-engine/rn";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { getDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { useStrandChanges } from "../../hooks/useStrandChanges";

/**
 * ElectionResultsScreen — decrypts, validates and tallies the election after the keyholders release their key
 * shares, on this device, from the replicated election data (vote-engine ElectionResultsEngine). Read-only: the
 * rebuilt election key lives only inside the engine call and is wiped there. Recomputed on every focus and on
 * Refresh, so it picks up late blocks and late key releases.
 *
 * Publishing (user decision 2026-11-02: the officer's device writes ONE signed ElectionTally row). An officer of
 * the election's authority sees Publish once the tally covers every block this device holds (BlockCoverage) and
 * at least one block. It is a button, not a background write: the officer's key signs behind a biometric
 * prompt, and a published tally can never be changed (the schema refuses updates), so the officer confirms the
 * block and vote counts first. The schema itself refuses a publisher who is not a current officer and a tally
 * before the keys are released; the officer gate here only decides what is shown.
 *
 * Live: a key release, a vote block or a published tally reaching this device counts again in the background
 * (useStrandChanges), keeping the current results on screen until the new ones are ready.
 */

/** 'unknown': nothing to read yet (not tallied) or the published tally could not be read. */
type Publication =
	| { kind: "unknown" }
	| { kind: "published"; published: PublishedTally }
	| { kind: "unpublished"; coverage: BlockCoverage };

type Load = { kind: "loading" } | { kind: "done"; results: ElectionResults; publication: Publication } | { kind: "failed" };

/** The tables a recount depends on (qualified, as the strand reports them). */
const RESULTS_TABLES = ["App.KeyholderShareRelease", "App.ElectionKey", "App.VoteBlock", "App.VoteBlockVoter", "App.ElectionTally"];

async function readPublication(getEngine: <T>(name: string) => Promise<T>, results: ElectionResults): Promise<Publication> {
	if (results.status !== "tallied") return { kind: "unknown" };
	try {
		const engine = await getEngine<TallyPublicationEngine>("tallyPublication");
		const published = await engine.readPublishedTally(results.electionId, results.revision, results.tally);
		if (published !== null) return { kind: "published", published };
		return { kind: "unpublished", coverage: await engine.blockCoverage(results.electionId, results.revision) };
	} catch {
		return { kind: "unknown" };
	}
}

const percent = (count: number, of: number): number => (of > 0 ? Math.round((count / of) * 100) : 0);

function QuestionCard({ question, t, colors }: { question: QuestionResult; t: (k: string, o?: any) => string; colors: ExtendedTheme["colors"] }) {
	const total = question.options.reduce((n, o) => n + o.count, 0);
	return (
		<View testID={`results-question-${question.code}`} style={localStyles.question}>
			<ThemedText type="defaultSemiBold">{question.title}</ThemedText>
			{question.counted ? (
				<>
					{question.options.map((o) => (
						<View key={o.code} testID={`results-option-${question.code}-${o.code}`} style={localStyles.optionRow}>
							<View style={localStyles.optionLabel}>
								<ThemedText style={localStyles.shrink}>{o.title}</ThemedText>
								<ThemedText type="defaultSemiBold" testID={`results-count-${question.code}-${o.code}`}>
									{t("resultsOptionCount", { count: o.count, percent: percent(o.count, total) })}
								</ThemedText>
							</View>
							<View style={[localStyles.barTrack, { backgroundColor: colors.border }]}>
								<View style={[localStyles.barFill, { backgroundColor: colors.primary, width: `${percent(o.count, total)}%` }]} />
							</View>
						</View>
					))}
					{question.blank > 0 ? (
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("resultsBlank", { count: question.blank })}
						</ThemedText>
					) : null}
				</>
			) : (
				<ThemedText type="small" style={{ color: colors.textSecondary }}>
					{t("resultsNotCounted", { count: question.answered })}
				</ThemedText>
			)}
		</View>
	);
}

export default function ElectionResultsScreen() {
	const { electionId, electionTitle, authorityId } = useRoute().params as {
		electionId: string;
		electionTitle?: string;
		authorityId?: string;
	};
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const inFlight = useRef(false);
	// A background recount asked for while one is running runs once more after it.
	const recountPending = useRef(false);
	const active = useRef(true);
	const [publishing, setPublishing] = useState(false);
	const publishingRef = useRef(false);
	const [publishError, setPublishError] = useState<string | undefined>(undefined);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId ?? "");
	const officer: "loading" | "yes" | "no" =
		authorityId === undefined ? "no" : scopesLoading ? "loading" : scopes !== undefined ? "yes" : "no";

	const compute = useCallback(
		async (quiet = false) => {
			if (inFlight.current) {
				if (quiet) recountPending.current = true;
				return;
			}
			inFlight.current = true;
			if (!quiet) setLoad({ kind: "loading" });
			try {
				const engine = await getEngine<ElectionResultsEngine>("electionResults");
				const results = await engine.getElectionResults(electionId);
				const publication = await readPublication(getEngine, results);
				if (active.current) setLoad({ kind: "done", results, publication });
			} catch {
				if (active.current && !quiet) setLoad({ kind: "failed" });
			} finally {
				inFlight.current = false;
			}
			if (recountPending.current && active.current) {
				recountPending.current = false;
				void compute(true);
			}
		},
		[electionId, getEngine],
	);

	useStrandChanges(
		RESULTS_TABLES,
		() => {
			if (!publishingRef.current) void compute(true);
		},
		"authority-election-results",
	);

	const publish = useCallback(
		async (tally: Extract<ElectionResults, { status: "tallied" }>["tally"]) => {
			if (publishingRef.current) return;
			publishingRef.current = true;
			setPublishing(true);
			setPublishError(undefined);
			try {
				const sign = await createDeviceSigner("Device User");
				const user = await getDeviceUser();
				const signingPublicKey = user?.activeKeys[0]?.key;
				if (user === undefined || signingPublicKey === undefined) {
					if (active.current) setPublishError(t("resultsPublishNoKey"));
					return;
				}
				const engine = await getEngine<TallyPublicationEngine>("tallyPublication");
				const outcome = await engine.publishElectionTally(tally, { userId: user.id, signingPublicKey, sign });
				if (!active.current) return;
				if (outcome.outcome === "conflict") setPublishError(t("resultsPublishConflict"));
				else if (outcome.outcome === "signer-key-mismatch") setPublishError(t("resultsPublishKeyMismatch"));
				else if (outcome.outcome === "invalid-tally") setPublishError(t("resultsPublishInvalid"));
				else if (outcome.outcome === "not-officer") setPublishError(t("resultsPublishNotOfficer"));
				else if (outcome.outcome === "keys-not-released") setPublishError(t("resultsPublishKeysNotReleased"));
			} catch (err) {
				const outcome = handleDeviceSigningError(err);
				if (outcome.handled || !active.current) return;
				setPublishError(outcome.message ?? t("resultsPublishFailed"));
			} finally {
				publishingRef.current = false;
				if (active.current) setPublishing(false);
			}
			void compute(true);
		},
		[compute, getEngine, handleDeviceSigningError, t],
	);

	useFocusEffect(
		useCallback(() => {
			active.current = true;
			compute();
			return () => {
				active.current = false;
			};
		}, [compute]),
	);

	const results = load.kind === "done" ? load.results : null;
	const publication: Publication = load.kind === "done" ? load.publication : { kind: "unknown" };
	const tallied = results?.status === "tallied" ? results : null;
	// The tally covers exactly the blocks this device holds, and every one of them has all its voter rows.
	const coverageReady =
		tallied !== null &&
		publication.kind === "unpublished" &&
		publication.coverage.complete &&
		publication.coverage.blocks === tallied.blockCount;
	const canPublish = officer === "yes" && tallied !== null && tallied.blockCount > 0 && coverageReady && !publishing;

	const confirmPublish = () => {
		if (tallied === null) return;
		Alert.alert(
			t("resultsPublishConfirmTitle"),
			t("resultsPublishConfirmBody", { blocks: tallied.blockCount, votes: tallied.totals.valid }),
			[
				{ text: t("resultsPublishCancel"), style: "cancel" },
				{
					text: t("resultsPublishConfirm"),
					onPress: () => {
						void publish(tallied.tally);
					},
				},
			],
		);
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container} contentContainerStyle={localStyles.scroll}>
				{electionTitle ? (
					<ThemedText type="cardTitle" testID="results-election-title">
						{electionTitle}
					</ThemedText>
				) : null}

				{load.kind === "loading" ? (
					<ThemedText testID="results-loading" style={{ color: colors.textSecondary }}>
						{t("resultsComputing")}
					</ThemedText>
				) : null}

				{load.kind === "failed" ? (
					<ThemedText testID="results-failed" style={{ color: colors.error }}>
						{t("resultsLoadFailed")}
					</ThemedText>
				) : null}

				{results?.status === "no-election" ? (
					<ThemedText testID="results-no-election">{t("resultsNoElection")}</ThemedText>
				) : null}

				{results?.status === "awaiting-keys" ? (
					<View testID="results-awaiting-keys" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
						<ThemedText type="defaultSemiBold">{t("resultsLockedTitle")}</ThemedText>
						<ThemedText>{t("resultsLockedBody")}</ThemedText>
						{results.threshold !== null ? (
							<ThemedText testID="results-released-count" type="defaultSemiBold">
								{t("resultsReleasedCount", { released: results.releasedCount, needed: results.threshold })}
							</ThemedText>
						) : (
							<ThemedText testID="results-no-key">{t("resultsNoElectionKey")}</ThemedText>
						)}
						{results.releasingKeysAt !== null ? (
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("resultsReleaseFrom", { date: new Date(results.releasingKeysAt).toLocaleString() })}
							</ThemedText>
						) : null}
					</View>
				) : null}

				{results?.status === "unavailable" ? (
					<View testID="results-unavailable" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
						<ThemedText type="defaultSemiBold" style={{ color: colors.error }}>
							{t("resultsUnavailableTitle")}
						</ThemedText>
						<ThemedText type="small" testID="results-unavailable-reason">
							{t("resultsUnavailableReason", { reason: results.reason })}
						</ThemedText>
					</View>
				) : null}

				{results?.status === "tallied" && results.blockCount === 0 ? (
					<View testID="results-no-blocks" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
						<ThemedText type="defaultSemiBold" style={{ color: colors.warning }}>
							{t("resultsNoBlocksYet")}
						</ThemedText>
					</View>
				) : null}

				{results?.status === "tallied" && results.blockCount > 0 ? (
					<>
						<View testID="results-summary" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
							<ThemedText type="defaultSemiBold" testID="results-valid-total">
								{t("resultsValidVotes", { count: results.totals.valid })}
							</ThemedText>
							<ThemedText type="small">{t("resultsBlocks", { count: results.blockCount })}</ThemedText>
							{results.totals.invalid > 0 ? (
								<ThemedText type="small" testID="results-invalid-total" style={{ color: colors.warning }}>
									{t("resultsInvalidVotes", { count: results.totals.invalid })}
								</ThemedText>
							) : null}
							{results.totals.excluded > 0 ? (
								<ThemedText type="small" testID="results-excluded-total" style={{ color: colors.warning }}>
									{t("resultsExcludedVotes", { count: results.totals.excluded })}
								</ThemedText>
							) : null}
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("resultsKeyholdersUsed", { count: results.keyholdersUsed })}
							</ThemedText>
							<ThemedText type="small" testID="results-received-so-far" style={{ color: colors.textSecondary }}>
								{t("resultsReceivedSoFar")}
							</ThemedText>
						</View>
						{results.ballots.length === 0 ? (
							<ThemedText testID="results-no-ballots">{t("resultsNoBallots")}</ThemedText>
						) : null}
						{results.ballots.map((b) => (
							<View key={b.ballotId} testID={`results-ballot-${b.ballotId}`} style={[styles.cardSurface, { backgroundColor: colors.card }]}>
								{b.description ? <ThemedText type="cardTitle">{b.description}</ThemedText> : null}
								<ThemedText type="small" style={{ color: colors.textSecondary }}>
									{t("resultsBallotVotes", { count: b.valid })}
								</ThemedText>
								{b.questions.map((q) => (
									<QuestionCard key={q.code} question={q} t={t} colors={colors} />
								))}
							</View>
						))}
						<ThemedText type="tiny" testID="results-tally-root" style={{ color: colors.textSecondary }}>
							{t("resultsTallyRoot", { root: results.tallyRoot.slice(0, 16) })}
						</ThemedText>
					</>
				) : null}

				{tallied !== null && publication.kind === "published" ? (
					<View testID="results-published" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
						<ThemedText type="defaultSemiBold">{t("resultsPublishedTitle")}</ThemedText>
						{!(publication.published.signatureValid && publication.published.treeCheck.ok) ? (
							<ThemedText testID="results-published-invalid" style={{ color: colors.error }}>
								{t("resultsPublishedInvalid")}
							</ThemedText>
						) : publication.published.matchesRecomputed === true ? (
							<ThemedText testID="results-published-matches">
								{t("resultsPublishedMatches", { date: new Date(publication.published.publishedAt).toLocaleString() })}
							</ThemedText>
						) : (
							<ThemedText testID="results-published-differs" style={{ color: colors.warning }}>
								{t("resultsPublishedDiffers", { published: publication.published.blockCount, local: tallied.blockCount })}
							</ThemedText>
						)}
					</View>
				) : null}

				{tallied !== null && tallied.blockCount > 0 && publication.kind === "unpublished" ? (
					<View testID="results-publish-card" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
						<ThemedText type="defaultSemiBold">{t("resultsNotPublishedTitle")}</ThemedText>
						{officer === "no" ? (
							<ThemedText type="small" testID="results-publish-officer-only" style={{ color: colors.textSecondary }}>
								{t("resultsPublishOfficerOnly")}
							</ThemedText>
						) : null}
						{officer === "yes" && !coverageReady ? (
							<ThemedText type="small" testID="results-publish-waiting" style={{ color: colors.warning }}>
								{t("resultsPublishWaitingForBlocks")}
							</ThemedText>
						) : null}
						{officer === "yes" && coverageReady ? (
							<ThemedText type="small" testID="results-publish-explain" style={{ color: colors.textSecondary }}>
								{t("resultsPublishExplain")}
							</ThemedText>
						) : null}
						{publishError !== undefined ? (
							<ThemedText type="small" testID="results-publish-error" style={{ color: colors.error }}>
								{publishError}
							</ThemedText>
						) : null}
						{officer === "yes" ? (
							<CustomButton
								testID="results-publish"
								title={publishing ? t("resultsPublishing") : t("resultsPublish")}
								disabled={!canPublish}
								onPress={confirmPublish}
							/>
						) : null}
					</View>
				) : null}
			</ScrollView>
			<Footer>
				<CustomButton
					testID="results-refresh"
					title={t("resultsRefresh")}
					disabled={load.kind === "loading"}
					onPress={() => {
						compute();
					}}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	scroll: {
		gap: 12,
		paddingBottom: 24,
	},
	shrink: {
		flexShrink: 1,
	},
	question: {
		marginTop: 12,
		gap: 6,
	},
	optionRow: {
		gap: 4,
	},
	optionLabel: {
		flexDirection: "row",
		justifyContent: "space-between",
		gap: 8,
	},
	barTrack: {
		height: 8,
		borderRadius: 4,
		overflow: "hidden",
	},
	barFill: {
		height: 8,
		borderRadius: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
