import { View, StyleSheet, Image } from "react-native";
import { globalStyles } from "../../../theme/styles";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import type { NetworkSignatureTask } from "@votetorrent/vote-core";
import { SignatureTaskBody } from "./SignatureTaskBody";

export function NetworkSignatureTaskDetails({ task }: { task: NetworkSignatureTask }) {
	const { t } = useTranslation();
	const network = task.network;
	const proposed = network.proposed;
	const tsas = proposed?.policies?.timestampAuthorities ?? [];
	const requiredTsas = proposed?.policies?.numberRequiredTSAs;
	const relays = proposed?.relays ?? network.relays ?? [];
	const signers = network.signers ?? [];
	const proposalTimestamp = (network as { timestamp?: number }).timestamp;
	const timestampDisplay =
		proposalTimestamp !== undefined ? new Date(proposalTimestamp).toLocaleString() : "";

	const tsaBullets = (
		<View style={styles.bullets}>
			{tsas.map((tsa) => (
				<View key={tsa.url} style={styles.bulletRow}>
					<ThemedText>{"• "}</ThemedText>
					<ThemedText>{tsa.url}</ThemedText>
				</View>
			))}
		</View>
	);

	const relayBullets = (
		<View style={styles.bullets}>
			{relays.map((relay) => (
				<View key={relay} style={styles.bulletRow}>
					<ThemedText>{"• "}</ThemedText>
					<ThemedText>{relay}</ThemedText>
				</View>
			))}
		</View>
	);

	const imageSlot = proposed?.imageUrl ? (
		<Image
			source={{ uri: proposed.imageUrl }}
			style={styles.networkImage}
			resizeMode="contain"
		/>
	) : null;

	return (
		<SignatureTaskBody
			sections={[
				{
					title: t("proposal"),
					rows: [
						{ label: t("proposalTimestamp"), value: timestampDisplay },
						{ label: t("hash"), value: network.hash ?? "" },
					],
				},
				{
					title: t("policies"),
					rows: [
						{ label: t("timestampAuthorities"), slot: tsaBullets },
						{
							label: t("requiredTimestampAuthorities"),
							value: requiredTsas !== undefined ? String(requiredTsas) : "",
						},
					],
				},
				{
					title: t("network"),
					rows: [
						{ label: t("imageUrl"), value: proposed?.imageUrl ?? "" },
						{ label: t("image"), slot: imageSlot },
						{ label: t("relays"), slot: relayBullets },
						{ label: t("signature"), value: signers[0] ?? "" },
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
	networkImage: {
		width: "60%",
		alignSelf: "center",
		height: 160,
		marginTop: 12,
		marginBottom: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
