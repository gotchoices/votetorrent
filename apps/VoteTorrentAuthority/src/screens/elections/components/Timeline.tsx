import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import { formatDate } from "../../../utils/displayUtils";
import { useTranslation } from "react-i18next";
import {
	ElectionEvent,
	type ElectionDetails,
} from "@votetorrent/vote-core";

interface TimelineProps {
	electionDetails: ElectionDetails;
}

type MilestoneStatus = "past" | "current" | "future";

interface Milestone {
	key: string;
	labelKey: string;
	date: number;
}

/**
 * Vertical timeline with status dots — per Phase 9 D-05/D-06/D-08.
 *
 * Renders 5 chronological milestones for an election:
 *   registrationOpens → registrationCloses → votingOpens → votingCloses → revisionDeadline
 *
 * Each milestone row is a vertical stack with a status dot (past/current/future)
 * and a vertical connector line between consecutive dots. Colors come from theme
 * tokens (no hardcoded hex per Phase 7 D-13).
 *
 * D-08: Local to screens/elections/components/ — NOT a global primitive yet.
 * Promote to src/components/ only on second-consumer discovery.
 */
export function Timeline({ electionDetails }: TimelineProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { election, current } = electionDetails;
	const timeline = current.timeline;

	// Source data:
	//   registrationOpens  → revisionTimestamp[0] (revision was created when registration opened)
	//   registrationCloses → ElectionEvent.registrationEnds
	//   votingOpens        → ElectionEvent.votingStarts
	//   votingCloses       → ElectionEvent.tallyingStarts (voting ends == tallying begins)
	//   revisionDeadline   → election.revisionDeadline
	const registrationOpensTs =
		Array.isArray(current.revisionTimestamp) && current.revisionTimestamp.length > 0
			? (current.revisionTimestamp[0] as unknown as number)
			: election.date;

	const milestones: Milestone[] = [
		{
			key: "registrationOpens",
			labelKey: "registrationOpens",
			date: registrationOpensTs,
		},
		{
			key: "registrationCloses",
			labelKey: "registrationCloses",
			date: timeline[ElectionEvent.registrationEnds],
		},
		{
			key: "votingOpens",
			labelKey: "votingOpens",
			date: timeline[ElectionEvent.votingStarts],
		},
		{
			key: "votingCloses",
			labelKey: "votingCloses",
			date: timeline[ElectionEvent.tallyingStarts],
		},
		{
			key: "revisionDeadline",
			labelKey: "revisionDeadline",
			date: election.revisionDeadline,
		},
	];

	const now = Date.now();
	// "current" milestone = the first future milestone (the next thing happening).
	// Anything before that is past; anything after it is future.
	const currentIdx = milestones.findIndex((m) => m.date >= now);

	const statusOf = (idx: number): MilestoneStatus => {
		if (currentIdx === -1) return "past"; // all in the past
		if (idx < currentIdx) return "past";
		if (idx === currentIdx) return "current";
		return "future";
	};

	const colorFor = (status: MilestoneStatus): string => {
		if (status === "past") return colors.success;
		if (status === "current") return colors.primary;
		return colors.muted;
	};

	return (
		<View style={styles.timelineContainer}>
			{milestones.map((m, idx) => {
				const status = statusOf(idx);
				const dotColor = colorFor(status);
				const isLast = idx === milestones.length - 1;
				return (
					<View key={m.key} style={styles.row}>
						<View style={styles.dotColumn}>
							<View
								style={[
									styles.dot,
									{ backgroundColor: dotColor, borderColor: dotColor },
								]}
							/>
							{!isLast && (
								<View
									style={[styles.connector, { backgroundColor: colors.border }]}
								/>
							)}
						</View>
						<View style={styles.contentColumn}>
							<ThemedText type="defaultSemiBold">{t(m.labelKey)}</ThemedText>
							<ThemedText>{formatDate(m.date)}</ThemedText>
						</View>
					</View>
				);
			})}
		</View>
	);
}

const localStyles = StyleSheet.create({
	timelineContainer: {
		paddingVertical: 8,
	},
	row: {
		flexDirection: "row",
		alignItems: "flex-start",
	},
	dotColumn: {
		alignItems: "center",
		width: 24,
		marginRight: 12,
	},
	dot: {
		width: 14,
		height: 14,
		borderRadius: 7,
		borderWidth: 2,
		marginTop: 4,
	},
	// Vertical connector line between consecutive dots — per D-05.
	// Style key name `connector` is referenced by the plan's verify grep.
	connector: {
		width: 2,
		flexGrow: 1,
		minHeight: 24,
		marginTop: 2,
	},
	contentColumn: {
		flex: 1,
		paddingBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
