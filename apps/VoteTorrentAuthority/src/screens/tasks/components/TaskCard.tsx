import { ExtendedTheme } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";
import { Image, TouchableOpacity } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { globalStyles } from "../../../theme/styles";
import {
	AdminSignatureTask,
	AuthoritySignatureTask,
	BallotSignatureTask,
	ElectionRevisionSignatureTask,
	ElectionSignatureTask,
	NetworkSignatureTask,
	ReleaseKeyTask,
	SignatureTask,
} from "@votetorrent/vote-core";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface TaskCardProps {
	task: ReleaseKeyTask | SignatureTask;
	onPress?: () => void;
	showIndicator?: boolean;
}

export function TaskCard({ task, onPress, showIndicator = true }: TaskCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [title, setTitle] = useState<string>();
	const [date, setDate] = useState<string>();
	const [subtitle, setSubtitle] = useState<string>();
	const [imageUrl, setImageUrl] = useState<string>();
	const [networkName, setNetworkName] = useState<string>();

	useEffect(() => {
		const determineInfo = () => {
			if (task.type === "release-key") {
				setTitle(task.election.election.title);
				setDate(new Date(task.election.election.date).toLocaleDateString());
				setSubtitle(t("ready") + " - " + t("remaining"));
				setImageUrl(task.network.imageUrl);
				setNetworkName(task.network.name);
			}
			if (task.type === "signature") {
				let tempTask;
				switch (task.signatureType) {
					case "admin":
						tempTask = task as AdminSignatureTask;
						setTitle(tempTask.authority.name);
						setSubtitle(t("administrationRevision"));
						setImageUrl(tempTask.authority.imageRef?.url);
						setNetworkName(tempTask.network.name);
						break;
					case "authority":
						tempTask = task as AuthoritySignatureTask;
						setTitle(tempTask.authority.proposed.name);
						setSubtitle(t("authorityRevision"));
						setImageUrl(tempTask.authority.proposed.imageRef?.url);
						setNetworkName(tempTask.network.name);
						break;
					case "network":
						tempTask = task as NetworkSignatureTask;
						setTitle(tempTask.network.name);
						setSubtitle(t("networkRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
					case "election":
						tempTask = task as ElectionSignatureTask;
						setTitle(tempTask.election.proposed.election.title);
						setDate(new Date(tempTask.election.proposed.election.date).toLocaleDateString());
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
					case "election-revision":
						tempTask = task as ElectionRevisionSignatureTask;
						setTitle(tempTask.election.proposed.election.title);
						setDate(new Date(tempTask.election.proposed.election.date).toLocaleDateString());
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
					case "ballot":
						tempTask = task as BallotSignatureTask;
						setTitle(tempTask.ballot.proposed.description);
						setDate(new Date(tempTask.ballot.proposed.timestamp).toLocaleDateString());
						setSubtitle(t("ballotRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
				}
			}
		};
		determineInfo();
	}, [task, t]);

	return (
		<TouchableOpacity onPress={onPress} style={[styles.card, { backgroundColor: colors.card }]}>
			{imageUrl && <Image source={{ uri: imageUrl }} style={styles.image} />}
			<View style={styles.content}>
				<ThemedText type="cardTitle" numberOfLines={1}>
					{title}
				</ThemedText>
				{date && (
					<ThemedText type="defaultSemiBold" numberOfLines={1}>
						{date}
					</ThemedText>
				)}
				{subtitle && (
					<ThemedText type="default" numberOfLines={1}>
						{subtitle}
					</ThemedText>
				)}
				{networkName && (
					<ThemedText type="small" style={styles.networkLabel} numberOfLines={1}>
						{networkName}
					</ThemedText>
				)}
			</View>
			<FontAwesome6 name={"chevron-right"} size={20} color={colors.text} style={styles.icon} />
			{showIndicator && (
				<View style={[styles.indicator, { backgroundColor: colors.notification }]} />
			)}
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	card: {
		...globalStyles.cardSurface,
		flexDirection: "row",
		alignItems: "center",
	},
	image: {
		width: 56,
		height: 56,
		borderRadius: 4,
	},
	content: {
		flex: 1,
		marginLeft: 16,
		marginRight: 8,
		paddingRight: 8,
	},
	icon: {
		marginLeft: 8,
	},
	networkLabel: {
		opacity: 0.6,
		marginTop: 4,
	},
	indicator: {
		position: "absolute",
		top: -4,
		right: -4,
		width: 14,
		height: 14,
		borderRadius: 7,
	},
});

export default TaskCard;
