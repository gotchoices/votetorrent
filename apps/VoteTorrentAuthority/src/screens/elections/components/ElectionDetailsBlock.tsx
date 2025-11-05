import { ElectionDetails } from "@votetorrent/vote-core";
import { StyleSheet, View } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";
import { useTranslation } from "react-i18next";

interface ElectionDetailsBlockProps {
	electionDetails: ElectionDetails;
}

export function ElectionDetailsBlock({ electionDetails }: ElectionDetailsBlockProps) {
	const { t } = useTranslation();

	return (
		<View>
			<View style={styles.section}>
				<ThemedText type="subtitle">{electionDetails.election.title}</ThemedText>
			</View>

			<View style={[styles.section, styles.detailContainer]}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("date")}: </ThemedText>
					<ThemedText>{formatDate(electionDetails.election.date)}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revisionDeadline")}: </ThemedText>
					<ThemedText>{formatDate(electionDetails.election.revisionDeadline)}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
					<ThemedText>{electionDetails.election.authorityId}</ThemedText>
				</View>
			</View>

			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
					<ThemedText>{electionDetails.current.revision}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("tags")}: </ThemedText>
					<ThemedText>{electionDetails.current.tags.join(", ")}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("timeline")}: </ThemedText>
				</View>
				<View style={styles.subDetails}>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("registrationEnds")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.registrationEnds)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("ballotsFinal")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.ballotsFinal)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("votingStarts")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.votingStarts)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("tallyingStarts")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.tallyingStarts)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("validation")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.validation)}</ThemedText>
					</View>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("closed")}: </ThemedText>
						<ThemedText>{formatDate(electionDetails.current.timeline.closed)}</ThemedText>
					</View>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderThreshold")}: </ThemedText>
					<ThemedText>{electionDetails.current.keyholderThreshold}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
					<ThemedText>{electionDetails.current.signature.signature}</ThemedText>
				</View>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detailContainer: {
		width: "100%",
	},
	detail: {
		flexDirection: "row",
	},
	subDetails: {
		marginLeft: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
