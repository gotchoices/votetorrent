import { View, StyleSheet, Image } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import type { NetworkSignatureTask } from "@votetorrent/vote-core";

export function NetworkSignatureTaskDetails({ task }: { task: NetworkSignatureTask }) {
	const { t } = useTranslation();
	const network = task.network;
	const proposed = network.proposed;
	const tsas = proposed?.policies?.timestampAuthorities ?? [];
	const requiredTsas = proposed?.policies?.numberRequiredTSAs;
	const relays = proposed?.relays ?? network.relays ?? [];
	const signers = network.signers ?? [];

	return (
		<View style={[styles.section, styles.detailContainer]}>
			{network.hash && (
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("hash")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="middle">
						{network.hash}
					</ThemedText>
				</View>
			)}
			{tsas.length > 0 && (
				<>
					<ThemedText type="defaultSemiBold">{t("timestampAuthorities")}:</ThemedText>
					<View style={styles.bullets}>
						{tsas.map((tsa) => (
							<View key={tsa.url} style={styles.bulletRow}>
								<ThemedText>{"• "}</ThemedText>
								<ThemedText>{tsa.url}</ThemedText>
							</View>
						))}
					</View>
				</>
			)}
			{requiredTsas !== undefined && (
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("requiredTimestampAuthorities")}: </ThemedText>
					<ThemedText>{requiredTsas}</ThemedText>
				</View>
			)}
			{proposed?.imageUrl && (
				<>
					<View style={styles.detail}>
						<ThemedText type="defaultSemiBold">{t("imageUrl")}: </ThemedText>
						<ThemedText style={styles.imageUrlText}>{proposed.imageUrl}</ThemedText>
					</View>
					<Image
						source={{ uri: proposed.imageUrl }}
						style={styles.networkImage}
						resizeMode="contain"
					/>
				</>
			)}
			{relays.length > 0 && (
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("relays")}: </ThemedText>
					<ThemedText style={styles.relaysText}>{relays.join(" ; ")}</ThemedText>
				</View>
			)}
			{signers.length > 0 && (
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("signature")}: </ThemedText>
					<ThemedText numberOfLines={1} ellipsizeMode="middle">
						{signers[0]}
					</ThemedText>
				</View>
			)}
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
		gap: 4,
	},
	bullets: {
		marginLeft: 8,
	},
	bulletRow: {
		flexDirection: "row",
	},
	italic: {
		fontStyle: "italic",
	},
	imageUrlText: {
		flex: 1,
		flexWrap: "wrap",
	},
	relaysText: {
		flex: 1,
		flexWrap: "wrap",
	},
	networkImage: {
		width: "60%",
		alignSelf: "center",
		height: 160,
		marginTop: 12,
		marginBottom: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
