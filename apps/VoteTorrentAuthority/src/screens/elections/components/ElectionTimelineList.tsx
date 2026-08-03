import React from "react";
import { View, StyleSheet } from "react-native";
import { ThemedText } from "../../../components/ThemedText";
import { useTranslation } from "react-i18next";
import { ElectionEvent } from "@votetorrent/vote-core";
import { formatDate } from "../../../utils/displayUtils";

interface ElectionTimelineListProps {
	timeline: Record<ElectionEvent, number>;
}

const EVENT_ORDER: ElectionEvent[] = [
	ElectionEvent.registrationEnds,
	ElectionEvent.ballotsFinal,
	ElectionEvent.votingStarts,
	ElectionEvent.tallyingStarts,
	ElectionEvent.validation,
	ElectionEvent.closed,
];

/**
 * Bold-label text list timeline — Phase 9 Decision 2 (Binding).
 *
 * Replaces the vertical-dot Timeline component on the Election Detail screen
 * per 09-PARITY-GAPS-R3 Decision 2. Renders one row per event in a fixed
 * display order: registrationEnds → ballotsFinal → votingStarts →
 * tallyingStarts → validation → closed. Rows whose timestamp is falsy/zero
 * are skipped. No dots, no lines between rows — plain bold-label + date.
 */
export function ElectionTimelineList({ timeline }: ElectionTimelineListProps) {
	const { t } = useTranslation();

	return (
		<View style={styles.listContainer}>
			{EVENT_ORDER.map((event) => {
				const ts = timeline[event];
				if (!ts) return null;
				return (
					<View key={event} style={styles.row}>
						<ThemedText type="defaultSemiBold">{t(event)}: </ThemedText>
						<ThemedText>{formatDate(ts)}</ThemedText>
					</View>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	listContainer: {
		paddingVertical: 4,
	},
	row: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginVertical: 2,
	},
});
