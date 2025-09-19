import { ExtendedTheme } from "@react-navigation/native";
import { useTheme } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";
import { Image, TouchableOpacity } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
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
}

export function TaskCard({ task, onPress }: TaskCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const [title, setTitle] = useState<string>();
	const [date, setDate] = useState<string>();
	const [subtitle, setSubtitle] = useState<string>();
	const [imageUrl, setImageUrl] = useState<string>();

	useEffect(() => {
		const determineInfo = () => {
			if (task.type === "release-key") {
				setTitle(task.election.election.title);
				setDate(new Date(task.election.election.date).toLocaleDateString());
				setSubtitle(t("ready") + " - " + t("remaining"));
				setImageUrl(task.network.imageUrl);
			}
			if (task.type === "signature") {
				let tempTask;
				switch (task.signatureType) {
					case "admin":
						tempTask = task as AdminSignatureTask;
						setTitle(tempTask.authority.name);
						setSubtitle(t("administrationRevision"));
						setImageUrl(tempTask.authority.imageRef?.url);
						break;
					case "authority":
						tempTask = task as AuthoritySignatureTask;
						setTitle(tempTask.authority.proposed.name);
						setSubtitle(t("authorityRevision"));
						setImageUrl(tempTask.authority.proposed.imageRef?.url);
						break;
					case "network":
						tempTask = task as NetworkSignatureTask;
						setTitle(tempTask.network.name);
						setSubtitle(t("networkRevision"));
						setImageUrl(tempTask.network.imageUrl);
						break;
					case "election":
						tempTask = task as ElectionSignatureTask;
						setTitle(tempTask.election.proposed.election.title);
						setDate(new Date(tempTask.election.proposed.election.date).toLocaleDateString());
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						break;
					case "election-revision":
						tempTask = task as ElectionRevisionSignatureTask;
						setTitle(tempTask.election.proposed.election.title);
						setDate(new Date(tempTask.election.proposed.election.date).toLocaleDateString());
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						break;
					case "ballot":
						tempTask = task as BallotSignatureTask;
						setTitle(tempTask.ballot.proposed.description);
						setDate(new Date(tempTask.ballot.proposed.timestamp).toLocaleDateString());
						setSubtitle(t("ballotRevision"));
						setImageUrl(tempTask.network.imageUrl);
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
				<ThemedText type="subtitle" numberOfLines={1}>
					{title}
				</ThemedText>
				{date && (
					<ThemedText type="subtitle" numberOfLines={1}>
						{date}
					</ThemedText>
				)}
				{subtitle && (
					<ThemedText type="default" numberOfLines={1}>
						{subtitle}
					</ThemedText>
				)}
			</View>
			<FontAwesome6 name={"chevron-right"} size={16} color={colors.text} style={styles.icon} />
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	card: {
		flexDirection: "row",
		alignItems: "center",
		padding: 12,
		marginVertical: 8,
		marginHorizontal: 4,
		borderRadius: 12,
		shadowColor: "#000",
		shadowOffset: {
			width: 0,
			height: 2,
		},
		shadowOpacity: 0.1,
		shadowRadius: 4,
		elevation: 3,
	},
	image: {
		width: 50,
		height: 50,
	},
	content: {
		flex: 1,
		marginLeft: 16,
		marginRight: 8,
		paddingRight: 16,
	},
	icon: {
		marginLeft: 16,
	},
});

export default TaskCard;
