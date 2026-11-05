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
	SigningStatus,
} from "@votetorrent/vote-core";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ThresholdProgressNote } from "./ThresholdProgressNote";

interface TaskCardProps {
	task: ReleaseKeyTask | SignatureTask;
	onPress?: () => void;
	showIndicator?: boolean;
	// Phase 7 additions (07-01 D-02): task-type chip rendered above title
	chipLabel?: string;
	chipColor?: string;
	// 62-12 (Surface 5, D-09/D-10/D-11): the task's own co-signing status, rendered as a caption
	// directly under the title. Undefined/null/threshold<=1/unreachable all render nothing —
	// release-key cards never receive this prop.
	thresholdStatus?: SigningStatus | null;
}

/**
 * A date renders only for a finite timestamp; never "Invalid Date" (UAT 62 gap 4 item 3).
 * Do not invent a ballot timestamp: the engine does not carry one.
 */
function formatTaskDate(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const time = new Date(value as number | string).getTime();
	return Number.isFinite(time) ? new Date(time).toLocaleDateString() : undefined;
}

export function TaskCard({
	task,
	onPress,
	showIndicator = true,
	chipLabel,
	chipColor,
	thresholdStatus,
}: TaskCardProps) {
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
				setDate(formatTaskDate(task.election.election.date));
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
						setSubtitle(t("adminRevision"));
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
						setDate(formatTaskDate(tempTask.election.proposed.election.date));
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
					case "election-revision":
						tempTask = task as ElectionRevisionSignatureTask;
						setTitle(tempTask.election.proposed.election.title);
						setDate(formatTaskDate(tempTask.election.proposed.election.date));
						setSubtitle(t("electionRevision"));
						setImageUrl(tempTask.network.imageUrl);
						setNetworkName(tempTask.network.name);
						break;
					case "ballot":
						tempTask = task as BallotSignatureTask;
						setTitle(tempTask.ballot.proposed.description);
						setDate(formatTaskDate((tempTask.ballot as { timestamp?: number }).timestamp));
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
			<View style={styles.content} testID="task-card-content">
				{chipLabel && (
					<View style={[styles.chip, { backgroundColor: chipColor ?? colors.accent }]}>
						<ThemedText type="small">{chipLabel.toUpperCase()}</ThemedText>
					</View>
				)}
				<ThemedText type="cardTitle" numberOfLines={1}>
					{title}
				</ThemedText>
				<ThresholdProgressNote status={thresholdStatus} />
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
	chip: {
		height: 24,
		paddingHorizontal: 8,
		borderRadius: 12,
		alignSelf: "flex-start",
		justifyContent: "center",
		marginBottom: 4,
	},
});

export default TaskCard;
