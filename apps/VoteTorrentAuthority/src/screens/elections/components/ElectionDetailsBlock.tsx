import { ElectionDetails, ElectionType } from "@votetorrent/vote-core";
import { StyleSheet, View } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";
import { useTranslation } from "react-i18next";

interface ElectionDetailsBlockProps {
	electionDetails: ElectionDetails;
}

/**
 * Election header + metadata block.
 *
 * Phase 9 plan 09-01: The inline timeline rows that previously lived here have
 * been removed in favor of the local `Timeline` component (D-05/D-06/D-08).
 * `ElectionDetailsScreen` mounts `Timeline` separately as the focal section.
 */
export function ElectionDetailsBlock({ electionDetails }: ElectionDetailsBlockProps) {
	const { t } = useTranslation();
	const { election, current } = electionDetails;

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
});

const styles = { ...globalStyles, ...localStyles };
