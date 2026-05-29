import { View, StyleSheet } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import type { ElectionSignatureTask } from "@votetorrent/vote-core";
import { formatDate } from "../../../utils/displayUtils";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function ElectionSignatureTaskDetails({ task }: { task: ElectionSignatureTask }) {
	const { t } = useTranslation();
	const proposed = task.election.proposed;
	const election = proposed.election;
	const revision = proposed.revision;

	const tagsSlot = (
		<View style={styles.bullets}>
			{revision.tags.map((tag) => (
				<View key={tag} style={styles.bulletRow}>
					<ThemedText>{"• "}</ThemedText>
					<ThemedText>{tag}</ThemedText>
				</View>
			))}
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
						{ label: t("date"), value: formatDate(election.date) },
					],
				},
				{
					title: t("details"),
					rows: [
						{ label: t("revision"), value: String(revision.revision) },
						{ label: t("tags"), slot: tagsSlot },
					],
				},
			]}
		/>
	);
}

const localStyles = StyleSheet.create({
	bullets: {
		marginLeft: 8,
	},
	bulletRow: {
		flexDirection: "row",
	},
});

const styles = { ...globalStyles, ...localStyles };
