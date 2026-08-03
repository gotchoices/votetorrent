import { View, StyleSheet } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import type { ElectionRevisionSignatureTask } from "@votetorrent/vote-core";
import { formatDate } from "../../../utils/displayUtils";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function ElectionRevisionSignatureTaskDetails({
	task,
}: {
	task: ElectionRevisionSignatureTask;
}) {
	const { t } = useTranslation();
	const proposed = task.election.proposed;
	const election = proposed.election;
	const revision = proposed.revision;
	const timeline = revision.timeline;

	const timelineSlot = (
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
			{timeline.certificationStarts ? (
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("certificationStarts")}: </ThemedText>
					<ThemedText>{formatDate(timeline.certificationStarts)}</ThemedText>
				</View>
			) : null}
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("closed")}: </ThemedText>
				<ThemedText>{formatDate(timeline.closed)}</ThemedText>
			</View>
		</View>
	);

	return (
		<SignatureTaskBody
			sections={[
				{
					title: t("proposal"),
					rows: [
						{ label: t("network"), value: task.network.name },
						{ label: t("election"), value: election.title },
						{
							label: t("revisionDeadline"),
							value: formatDate(election.revisionDeadline),
						},
					],
				},
				{
					rows: [{ label: t("timeline"), slot: timelineSlot }],
				},
			]}
		/>
	);
}

const localStyles = StyleSheet.create({
	subDetails: {
		marginLeft: 8,
	},
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
