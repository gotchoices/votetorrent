import { useLayoutEffect, useState } from "react";
import { ExtendedTheme, useNavigation, useTheme } from "@react-navigation/native";
import { useRoute } from "@react-navigation/native";
import { ScrollView, StyleSheet, View } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import { globalStyles } from "../../theme/styles";
import { useTranslation } from "react-i18next";
import { formatDate } from "../../utils/displayUtils";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { IKeysTasksEngine, ReleaseKeyTask } from "@votetorrent/vote-core";
import { useApp } from "../../providers/AppProvider";

export default function KeyTaskScreen() {
	const { task } = useRoute().params as { task: ReleaseKeyTask };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation();
	const { getEngine } = useApp();

	const [errorMessage, setErrorMessage] = useState<string>("");

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("keyholderRelease") });
	}, [navigation, t]);

	const { election: core, current } = task.election;
	const timeline = current.timeline;
	const keyholderCount = current.keyholders?.length ?? 0;
	// Figma shows "1 of 2"; we render "1/2" to avoid embedding an English literal
	// in this file (D-13). The "of"-style copy is reachable via an i18n key
	// added in a future plan if a closer match to Figma is required.
	const policyText = keyholderCount
		? `${current.keyholderThreshold}/${keyholderCount}`
		: String(current.keyholderThreshold);

	const revisionTimestamp = current.revisionTimestamp?.[0];
	const revisionText = revisionTimestamp
		? `#${current.revision} - ${formatDate(revisionTimestamp)}`
		: `#${current.revision}`;

	// Mock release-key tasks do not currently populate the revision signature
	// (see vote-engine mock-keys-tasks-engine.ts). Surface it when present.
	const revisionSignature = (current as any).signature?.signature as string | undefined;

	// D-13 — real countdown from task.election.election.revisionDeadline (ms epoch on ElectionCore).
	// core IS task.election.election (destructured above as `const { election: core, current } = task.election`).
	// Never return a fabricated constant; surface an honest empty state when deadline is absent/past.
	const timeRemaining = (): string => {
		const deadline = core.revisionDeadline;
		// No deadline: show honest empty state (no i18n 'expired' key exists — use empty string per D-15)
		if (!deadline) return "";
		const msLeft = deadline - Date.now();
		// Deadline passed: same honest empty state
		if (msLeft <= 0) return "";
		const hoursLeft = Math.floor(msLeft / 3_600_000);
		const minutesLeft = Math.floor((msLeft % 3_600_000) / 60_000);
		return `${hoursLeft}h ${minutesLeft}m`;
	};

	// SIGN-03 — wire to real completeKeyRelease pipeline (plan 21-06)
	const releaseKey = async () => {
		setErrorMessage("");
		try {
			const engine = await getEngine<IKeysTasksEngine>("keysTasksEngine");
			await engine.completeKeyRelease(task);
			navigation.goBack();
		} catch (err) {
			console.error("releaseKey error:", err);
			setErrorMessage(err instanceof Error ? err.message : String(err));
			return;
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
						<ThemedText>{task.network.name}</ThemedText>
					</View>
					<View style={styles.electionTitleRow}>
						<ThemedText type="cardTitle">{core.title}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
						<ThemedText>{formatDate(core.date)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revisionDeadline")}: </ThemedText>
						<ThemedText>{formatDate(core.revisionDeadline)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
						<ThemedText>{core.authorityId}</ThemedText>
					</View>
				</View>

				<View style={[styles.section, styles.detailContainer]}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
						<ThemedText>{revisionText}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
						<ThemedText>{current.tags.join(", ")}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("timeline")}: </ThemedText>
					</View>
					<View style={styles.subDetails}>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("registrationEnds")}: </ThemedText>
							<ThemedText>{formatDate(timeline.registrationEnds)}</ThemedText>
						</View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("ballotsFinal")}: </ThemedText>
							<ThemedText>{formatDate(timeline.ballotsFinal)}</ThemedText>
						</View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("votingStarts")}: </ThemedText>
							<ThemedText>{formatDate(timeline.votingStarts)}</ThemedText>
						</View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("tallyingStarts")}: </ThemedText>
							<ThemedText>{formatDate(timeline.tallyingStarts)}</ThemedText>
						</View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("validation")}: </ThemedText>
							<ThemedText>{formatDate(timeline.validation)}</ThemedText>
						</View>
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("closed")}: </ThemedText>
							<ThemedText>{formatDate(timeline.closed)}</ThemedText>
						</View>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
						<ThemedText>{policyText}</ThemedText>
					</View>
					{revisionSignature ? (
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
							<ThemedText numberOfLines={1} ellipsizeMode="middle">
								{revisionSignature}
							</ThemedText>
						</View>
					) : null}
				</View>

				<View style={styles.ready}>
					<ThemedText type="small">{t("ready") + " - "}</ThemedText>
					{timeRemaining() ? (
						<ThemedText type="small" style={{ color: colors.error }}>
							{timeRemaining() + " " + t("remaining")}
						</ThemedText>
					) : null}
				</View>
			</ScrollView>
			{errorMessage ? (
				<ThemedText style={{ color: colors.error, marginHorizontal: 16, marginBottom: 8 }}>
					{errorMessage}
				</ThemedText>
			) : null}
			<Footer>
				<CustomButton
					title={t("release")}
					icon="save"
					backgroundColor={colors.success}
					size="thin"
					onPress={() => {
						releaseKey();
					}}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		width: "100%",
	},
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
	},
	subDetails: {
		marginLeft: 8,
	},
	electionTitleRow: {
		marginVertical: 4,
	},
	ready: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginBottom: 20,
	},
});

const styles = { ...globalStyles, ...localStyles };
