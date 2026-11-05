import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { PendingAdminChange } from "@votetorrent/vote-core";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { InlineError } from "./InlineError";
import { globalStyles } from "../theme/styles";
import { formatLocalTime } from "../utils/displayUtils";

/**
 * An administration change that has not taken effect yet: "Change pending", the local time it takes
 * effect, an optional error line (translated by the screen) and, when allowed, Cancel change.
 *
 * `canCancel` is advisory UI only: it hides the button from a device user who cannot revise the
 * administration. The schema's CancellerIsRadOfficer check and the engine's pre-prompt refusal are
 * the enforcement. The card reads only `pending.effectiveAt`, so it renders the same whether the
 * change has been promoted or not. No state, no time computation.
 */
export interface PendingAdminChangeCardProps {
	pending: PendingAdminChange;
	canCancel: boolean;
	onCancel: () => void;
	busy?: boolean;
	error?: string;
}

export function PendingAdminChangeCard({ pending, canCancel, onCancel, busy = false, error }: PendingAdminChangeCardProps): React.JSX.Element {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<View
			testID="admin-change-pending-card"
			style={[globalStyles.cardSurface, styles.frame, { backgroundColor: colors.card, borderLeftColor: colors.warning }]}
		>
			<ThemedText type="defaultSemiBold">{t("adminChangePending")}</ThemedText>
			<ThemedText type="default">{t("adminChangeTakesEffectAt", { time: formatLocalTime(pending.effectiveAt) })}</ThemedText>
			<InlineError message={error} />
			{canCancel ? (
				<CustomButton testID="admin-change-cancel" title={t("adminChangeCancel")} disabled={busy} onPress={() => onCancel()} />
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	frame: {
		borderLeftWidth: 4,
	},
});
