import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "../../../components/ThemedText";

/**
 * KeyholderDkgOverdueNotice: officers are told which keyholders have not responded within the per-round key
 * generation deadline (ruling: the deadline FLAGS the silent keyholder; officers decide; no automatic action).
 *
 * Informational only, deliberately no button. The one action the app supports is asking that keyholder to open
 * this election's keyholder screen on their own device (the driver is pull-only, so that advances their round).
 * There is NO in-app way to replace a keyholder (revoke is engine-only and unchecked; no product path bumps
 * ElectionRevision), which is an open decision for the user. This copy never names "editing the election" as a
 * remedy because that remedy does not exist.
 */

interface KeyholderDkgOverdueNoticeProps {
	labels: string[];
	hours: number;
}

export function KeyholderDkgOverdueNotice({ labels, hours }: KeyholderDkgOverdueNoticeProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	if (labels.length === 0) return null;

	return (
		<View testID="keyholder-dkg-overdue-notice" style={localStyles.row}>
			<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} />
			<View style={localStyles.column}>
				<ThemedText testID="keyholder-dkg-overdue-names" type="small" style={{ color: colors.warning }}>
					{t("dkgOverdueNotice", { hours, names: labels.join(", ") })}
				</ThemedText>
				<ThemedText testID="keyholder-dkg-overdue-help" type="small" style={{ color: colors.textSecondary }}>
					{t("dkgOverdueHelp")}
				</ThemedText>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	row: {
		flexDirection: "row",
		alignItems: "flex-start",
		marginTop: 8,
	},
	column: {
		marginLeft: 8,
		flexShrink: 1,
	},
});
