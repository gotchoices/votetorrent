import { useCallback, useRef, useState } from "react";
import { ExtendedTheme, useFocusEffect, useRoute, useTheme } from "@react-navigation/native";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ElectionResults, ElectionResultsEngine, QuestionResult } from "@votetorrent/vote-engine/rn";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";

/**
 * ElectionResultsScreen — decrypts, validates and tallies the election after the keyholders release their key
 * shares, on this device, from the replicated election data (vote-engine ElectionResultsEngine). Read-only: the
 * rebuilt election key lives only inside the engine call and is wiped there. Recomputed on every focus and on
 * Refresh, so it picks up late blocks and late key releases.
 */

type Load = { kind: "loading" } | { kind: "done"; results: ElectionResults } | { kind: "failed" };

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
	const { electionId, electionTitle } = useRoute().params as { electionId: string; electionTitle?: string };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const inFlight = useRef(false);
	const active = useRef(true);

	const compute = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setLoad({ kind: "loading" });
		try {
			const engine = await getEngine<ElectionResultsEngine>("electionResults");
			const results = await engine.getElectionResults(electionId);
			if (active.current) setLoad({ kind: "done", results });
		} catch {
			if (active.current) setLoad({ kind: "failed" });
		} finally {
			inFlight.current = false;
		}
	}, [electionId, getEngine]);

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
