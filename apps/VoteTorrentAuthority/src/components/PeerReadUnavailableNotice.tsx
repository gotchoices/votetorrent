import React from "react";
import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";

/**
 * Shown when a read could not reach the other devices (see engines/peer-read-unavailable.ts).
 * 'unavailable': nothing has been read yet, so the screen has nothing to show and says so instead
 * of rendering the absence as "N/A" or an empty list. 'stale': the screen keeps what this device
 * last read and labels it as such. Translated copy only: the engine message (which carries block
 * ids) is never rendered.
 */
export interface PeerReadUnavailableNoticeProps {
	variant: "unavailable" | "stale";
	onRetry: () => void;
}

export function PeerReadUnavailableNotice({ variant, onRetry }: PeerReadUnavailableNoticeProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	return (
		<View
			testID="peer-read-unavailable-notice"
			accessibilityRole="alert"
			style={[styles.container, { borderColor: colors.warning, backgroundColor: colors.card }]}
		>
			{variant === "unavailable" ? (
				<>
					<ThemedText type="defaultSemiBold">{t("peerReadUnavailableTitle")}</ThemedText>
					<ThemedText type="small" style={styles.body}>
						{t("peerReadUnavailableBody")}
					</ThemedText>
				</>
			) : (
				<ThemedText type="small" style={styles.body}>
					{t("peerReadUnavailableStaleBody")}
				</ThemedText>
			)}
			{/* "tall" is 56pt, above the 44pt touch floor. */}
			<CustomButton
				title={t("peerReadUnavailableRetry")}
				icon="rotate-right"
				size="tall"
				testID="peer-read-unavailable-retry"
				onPress={onRetry}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
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
