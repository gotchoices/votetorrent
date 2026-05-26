import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";

/**
 * A single proposed-change row. `field` is the already-translated label
 * (callers do the `t(...)` wrap); `oldValue` and `newValue` are display-ready
 * strings (formatting decisions live with the caller).
 */
export interface ProposedChange {
	field: string;
	oldValue: string;
	newValue: string;
}

export interface ProposedChangesCardProps {
	changes: ProposedChange[];
}

/**
 * Flat InfoCard-style diff display for proposed network changes (D-14).
 *
 * Renders one row per changed field as: `<label>\n<old> → <new>`. When
 * `changes` is empty, the component renders `null` — callers should not
 * wrap it in a section title because the empty case yields nothing at all.
 *
 * Visual: reuses `globalStyles.cardSurface` so it nests visually with the
 * other `InfoCard` callers on `NetworkDetailsScreen`. No hardcoded hex
 * (D-13 strict): old-value text uses `colors.textSecondary`; arrow icon
 * uses `colors.text`.
 */
export function ProposedChangesCard({ changes }: ProposedChangesCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (changes.length === 0) {
		return null;
	}

	return (
		<View style={[styles.cardSurface, { backgroundColor: colors.card }]}>
			<ThemedText type="cardTitle">{t("proposedChanges")}</ThemedText>
			{changes.map((c) => (
				<View key={c.field} style={styles.row}>
					<ThemedText type="smallBold">{c.field}</ThemedText>
					<View style={styles.diffRow}>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{c.oldValue}
						</ThemedText>
						<FontAwesome6 name="arrow-right" size={12} color={colors.text} />
						<ThemedText type="small">{c.newValue}</ThemedText>
					</View>
				</View>
			))}
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		paddingVertical: 8,
		gap: 4,
	},
	diffRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
});

const styles = { ...globalStyles, ...localStyles };

export default ProposedChangesCard;
