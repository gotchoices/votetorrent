import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { RegistrantListRow } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { globalStyles } from "../../../theme/styles";
import { REGISTRANT_STATUS_META, registrantDisplayName, formatExpirationDate } from "../registrant-display";
import { tintPill, pillStyles } from "./pill";

export interface RegistrantRowProps {
	row: RegistrantListRow;
	onPress: () => void;
}

/**
 * RegistrantRow — the roster list row (D-04/D-08). Renders a display name (or
 * truncated `Registrant.Id`), a tinted `registrantStatus*` pill, expiration,
 * an optional district line, and a trailing chevron. Owns no state, makes no
 * engine call of its own, and takes no `canWrite` prop — opening a registrant
 * is a read, not a write (T-47-05).
 *
 * Renders NOTHING sourced from `RegistrantPrivate` or `RegistrantSelective` —
 * `RegistrantListRow` (47-05) already omits `SignorKey`/`Signature` and joins
 * no private/selective table, and this component reads only the public-tier
 * fields off it.
 *
 * The status pill reuses `pill.ts`'s `tintPill`/`pillStyles.pill` — the same
 * shared geometry/tint helper 47-10's `VerdictBadge` uses — so the two status
 * pill treatments in this app (attestation verdict, registrant status) cannot
 * visually drift apart from a locally-declared alpha constant.
 */
export function RegistrantRow({ row, onPress }: RegistrantRowProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const meta = REGISTRANT_STATUS_META[row.status];

	return (
		<TouchableOpacity
			testID={"registrant-row-" + row.registrantId}
			onPress={onPress}
			style={[styles.cardSurface, { backgroundColor: colors.card }]}
		>
			<View style={localStyles.row}>
				<View style={localStyles.leftColumn}>
					<View style={localStyles.headerLine}>
						<ThemedText type="defaultSemiBold" numberOfLines={1}>
							{registrantDisplayName(row)}
						</ThemedText>
						{meta ? (
							<View
								testID={"registrant-row-status-" + row.registrantId}
								style={[pillStyles.pill, { backgroundColor: tintPill(colors[meta.colorKey]) }]}
							>
								<ThemedText type="smallBold" style={{ color: colors[meta.colorKey] }}>
									{t(meta.labelKey)}
								</ThemedText>
							</View>
						) : (
							// An unknown status code (a future schema revision) must never
							// crash the roster — render the raw code with no pill instead
							// of throwing on the REGISTRANT_STATUS_META lookup miss.
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{row.status}
							</ThemedText>
						)}
					</View>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrantDetailExpirationLabel") + ": " + formatExpirationDate(row.expiration)}
					</ThemedText>
					{row.district ? (
						<ThemedText
							testID={"registrant-row-district-" + row.registrantId}
							type="small"
							style={{ color: colors.textSecondary }}
						>
							{t("registrantListFilterDistrictLabel") + ": " + row.district}
						</ThemedText>
					) : null}
				</View>
				<FontAwesome6 name="chevron-right" size={16} color={colors.accent} />
			</View>
		</TouchableOpacity>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	leftColumn: {
		flex: 1,
		gap: 4,
	},
	headerLine: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
