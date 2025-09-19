import { Image, StyleSheet, View } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { InfoCard } from "../../../components/InfoCard";
import { ThemedText } from "../../../components/ThemedText";
import type { AuthorityDetails, NetworkDetails } from "@votetorrent/vote-core";
import { useTranslation } from "react-i18next";

interface NetworkDetailsProps {
	details: NetworkDetails;
	primaryAuthorityDetails: AuthorityDetails;
	isProposed: boolean;
}

export function NetworkDetailsComponent({
	details,
	primaryAuthorityDetails,
	isProposed,
}: NetworkDetailsProps) {
	const { t } = useTranslation();

	return (
		<View style={[styles.section, styles.detailContainer]}>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("sid")}:</ThemedText>
				<ThemedText>{details.network.sid}</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("hash")}:</ThemedText>
				<ThemedText>{details.network.hash}</ThemedText>
			</View>
			<View>
				<ThemedText type="defaultSemiBold">{t("timestampAuthorities")}:</ThemedText>
				{isProposed
					? details.proposed?.proposed.policies.timestampAuthorities.map((authority) => (
							<ThemedText key={authority.url}>• {authority.url}</ThemedText>
					  ))
					: details.network.policies.timestampAuthorities.map((authority) => (
							<ThemedText key={authority.url}>• {authority.url}</ThemedText>
					  ))}
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("requiredTimestampAuthorities")}:</ThemedText>
				<ThemedText>
					{isProposed
						? details.proposed?.proposed.policies.numberRequiredTSAs
						: details.network.policies.numberRequiredTSAs}
				</ThemedText>
			</View>
			<View style={styles.detail}>
				<ThemedText type="defaultSemiBold">{t("imageUrl")}:</ThemedText>
				<ThemedText style={styles.imageUrl} numberOfLines={1} ellipsizeMode="tail">
					{isProposed ? details.proposed?.proposed.imageRef?.url : details.network.imageRef?.url}
				</ThemedText>
			</View>
			<View style={styles.imageContainer}>
				<Image
					source={{
						uri: isProposed
							? details.proposed?.proposed.imageRef?.url
							: details.network.imageRef?.url,
					}}
					style={styles.image}
				/>
			</View>
			<View>
				{/* TODO: relays only visible to primary authority admins */}
				<ThemedText type="defaultSemiBold">{t("relays")}:</ThemedText>
				{isProposed
					? details.proposed?.proposed.relays.map((relay) => (
							<ThemedText key={relay}>• {relay}</ThemedText>
					  ))
					: details.network.relays.map((relay) => <ThemedText key={relay}>• {relay}</ThemedText>)}
			</View>
			<ThemedText type="defaultSemiBold">{t("primaryAuthority")}:</ThemedText>
			<InfoCard
				title={primaryAuthorityDetails?.authority.name}
				subtitle={primaryAuthorityDetails?.authority.domainName}
				icon="chevron-right"
				image={{ uri: primaryAuthorityDetails?.authority.imageRef?.url }}
			/>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		gap: 4,
	},
	imageUrl: {
		flex: 1,
	},
	detailContainer: {
		width: "100%",
	},
	image: {
		width: 120,
		height: 120,
	},
	imageContainer: {
		alignItems: "center",
		marginVertical: 20,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default NetworkDetailsComponent;
