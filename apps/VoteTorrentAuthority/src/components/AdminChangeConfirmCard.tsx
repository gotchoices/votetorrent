import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { globalStyles } from "../theme/styles";
import { formatLocalTime } from "../utils/displayUtils";

/**
 * The inline confirm step of an administration change: the local time the change takes effect,
 * then Confirm and sign / Go back.
 *
 * Shown == signed: the screen computes `effectiveAt` once, on the first Save or Propose tap, renders
 * this card with it and passes the SAME string to `proposeAdmin` in `onConfirm`. The card holds no
 * state and never computes or judges a time. When the screen's confirm-age rule says the stored
 * time is stale, the screen signs nothing, stores a fresh time and renders the card again with it
 * and a translated `notice`. The handlers are called with no arguments (never the press event).
 */
export interface AdminChangeConfirmCardProps {
	effectiveAt: string;
	onConfirm: () => void;
	onBack: () => void;
	busy?: boolean;
	notice?: string;
}

export function AdminChangeConfirmCard({ effectiveAt, onConfirm, onBack, busy = false, notice }: AdminChangeConfirmCardProps): React.JSX.Element {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<View
			testID="admin-change-confirm-card"
			accessibilityLiveRegion="polite"
			style={[globalStyles.cardSurface, { backgroundColor: colors.card }]}
		>
			{typeof notice === "string" && notice.length > 0 ? (
				<ThemedText type="small" testID="admin-change-confirm-notice" style={[styles.notice, { color: colors.warningText }]}>
					{notice}
				</ThemedText>
			) : null}
			<ThemedText type="default">{t("adminChangeConfirm", { time: formatLocalTime(effectiveAt) })}</ThemedText>
			<View style={styles.actions}>
				<CustomButton
					testID="admin-change-confirm"
					title={t("adminChangeConfirmButton")}
					backgroundColor={colors.success}
					disabled={busy}
					flex
					onPress={() => onConfirm()}
				/>
				<CustomButton
					testID="admin-change-confirm-back"
					title={t("adminChangeConfirmBack")}
					disabled={busy}
					flex
					onPress={() => onBack()}
				/>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	notice: {
		marginBottom: 8,
	},
	actions: {
		flexDirection: "row",
		marginTop: 8,
	},
});
