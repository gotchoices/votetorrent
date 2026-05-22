import { ElectionDetails, ElectionType } from "@votetorrent/vote-core";
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
	const { election, current } = electionDetails;
	const timeline = current.timeline;

	const typeLabel =
		election.type === ElectionType.official
			? t("official")
			: election.type === ElectionType.adhoc
			? t("adhoc")
			: String(election.type);

	const keyholderCount = current.keyholders?.length ?? 0;
	const policyText = keyholderCount
		? `${current.keyholderThreshold} of ${keyholderCount}`
		: String(current.keyholderThreshold);

	const coreSignature = (election as any).signature?.signature as string | undefined;
	const revisionSignature = (current as any).signature?.signature as string | undefined;

	return (
		<View>
			<View style={styles.section}>
				<ThemedText type="subtitle">{election.title}</ThemedText>
			</View>

			<View style={[styles.section, styles.detailContainer]}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("authority")}: </ThemedText>
					<ThemedText>{election.authorityId}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("type")}: </ThemedText>
					<ThemedText>{typeLabel}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("dateTime")}: </ThemedText>
					<ThemedText>{formatDate(election.date)}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revisionDeadline")}: </ThemedText>
					<ThemedText>{formatDate(election.revisionDeadline)}</ThemedText>
				</View>
				{coreSignature ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("coreSignature")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle">{coreSignature}</ThemedText>
					</View>
				) : null}
			</View>

			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("revision")}: </ThemedText>
					<ThemedText>{current.revision}</ThemedText>
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
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderPolicy")}: </ThemedText>
					<ThemedText>{policyText}</ThemedText>
				</View>
				{revisionSignature ? (
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("revisionSignature")}: </ThemedText>
						<ThemedText numberOfLines={1} ellipsizeMode="middle">{revisionSignature}</ThemedText>
					</View>
				) : null}
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
