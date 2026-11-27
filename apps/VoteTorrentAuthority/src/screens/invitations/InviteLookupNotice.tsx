import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

/**
 * What an accept screen shows while the pasted invitation is looked up on the network (see
 * useInviteLookup): a spinner while looking; after the timeout, who must be online and a Try Again;
 * on a failure, the failure's own copy and, when trying again can help, a Try Again.
 * Translated copy only: an engine message is never rendered.
 */
export interface InviteLookupNoticeProps {
	phase: "looking" | "timed-out" | "failed";
	/** The translated failure copy (phase 'failed'). */
	failureMessage?: string;
	/** Offer Try Again on a failure (always offered after a timeout). */
	canRetry?: boolean;
	onRetry: () => void;
}

export function InviteLookupNotice({ phase, failureMessage, canRetry, onRetry }: InviteLookupNoticeProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (phase === "looking") {
		return (
			<View testID="invite-lookup-looking" accessibilityLiveRegion="polite" style={styles.lookingRow}>
				<ActivityIndicator testID="invite-lookup-spinner" color={colors.text} />
				<ThemedText style={styles.lookingText}>{t("invitationLookingUp")}</ThemedText>
			</View>
		);
	}

	const showRetry = phase === "timed-out" || canRetry === true;
	return (
		<View
			testID={phase === "timed-out" ? "invite-lookup-timed-out" : "invite-lookup-failed"}
			accessibilityRole="alert"
			style={[styles.box, { borderColor: colors.warning, backgroundColor: colors.card }]}
		>
			{phase === "timed-out" ? (
				<>
					<ThemedText type="defaultSemiBold">{t("invitationLookupSlowTitle")}</ThemedText>
					<ThemedText type="small" style={styles.body}>
						{t("invitationLookupSlowBody")}
					</ThemedText>
				</>
			) : (
				<ThemedText type="small" style={styles.body}>
					{failureMessage}
				</ThemedText>
			)}
			{showRetry ? (
				// "tall" is 56pt, above the 44pt touch floor.
				<CustomButton title={t("invitationLookupRetry")} icon="rotate-right" size="tall" testID="invite-lookup-retry" onPress={onRetry} />
			) : null}
		</View>
	);
}

/** Load-failure copy keys for which looking again can help (the network, or a slot not yet here). */
export const RETRYABLE_LOOKUP_FAILURE_KEYS: ReadonlySet<string> = new Set([
	"invitationNetworkNoAnswer",
	"invitationLoadFailed",
	"invitationAcceptNotFound",
]);

const styles = StyleSheet.create({
	lookingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		marginTop: 8,
		marginBottom: 8,
	},
	lookingText: {
		flexShrink: 1,
	},
	box: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 12,
		marginTop: 8,
		marginBottom: 8,
		gap: 4,
	},
	body: {
		marginTop: 4,
	},
});
