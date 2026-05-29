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
 * Immutable-core-only election header block.
 *
 * Phase 9 plan 09-14 (Checker fix B3): pared down to the immutable core:
 *   title + Authority + Type + Date-time + Core Signature.
 * The revision/tags/keyholder-policy/revision-signature rows have been
 * removed from here — they live in ElectionDetailsScreen's current-revision
 * section to avoid duplication.
 */
export function ElectionDetailsBlock({ electionDetails }: ElectionDetailsBlockProps) {
	const { t } = useTranslation();
	const { election } = electionDetails;

	const typeLabel =
		election.type === ElectionType.official
			? t("official")
			: election.type === ElectionType.adhoc
			? t("adhoc")
			: String(election.type);

	const coreSignature = (election as any).signature?.signature as string | undefined;

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
