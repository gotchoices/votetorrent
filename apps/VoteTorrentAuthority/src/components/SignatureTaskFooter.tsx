import { StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomButton } from "./CustomButton";
import { Footer } from "./Footer";

export interface SignatureTaskFooterProps {
	onAccept: () => void;
	onReject: () => void;
	acceptLabel?: string;
	rejectLabel?: string;
	// 49-11: optional in-flight-signing disable, applied to BOTH buttons —
	// backward-compatible (defaults false), so every pre-existing caller of
	// this shared footer (KeyholderInvitationScreen, AuthorityInvitationScreen,
	// AdministratorInvitationScreen) is unaffected unless it opts in.
	disabled?: boolean;
}

export function SignatureTaskFooter({
	onAccept,
	onReject,
	acceptLabel,
	rejectLabel,
	disabled,
}: SignatureTaskFooterProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	return (
		<Footer row>
			{/* Each button sits in a ROW slot (CustomButton's `flex` is built for a row parent) with a
			    height floor, so `alignSelf: stretch` lifts the one-line thin button from 36dp to the
			    48dp touch target. Same recipe as RejectReasonCard's buttonSlot. */}
			<View testID="signature-task-footer-accept-slot" style={styles.buttonSlot}>
				<CustomButton
					title={acceptLabel ?? t("accept")}
					icon="check"
					backgroundColor={colors.success}
					size="thin"
					flex={true}
					onPress={onAccept}
					disabled={disabled}
				/>
			</View>
			<View testID="signature-task-footer-reject-slot" style={styles.buttonSlot}>
				<CustomButton
					title={rejectLabel ?? t("reject")}
					icon="xmark"
					backgroundColor={colors.error}
					size="thin"
					flex={true}
					onPress={onReject}
					disabled={disabled}
				/>
			</View>
		</Footer>
	);
}

/** Minimum clickable height of a footer button, dp (Android 48dp touch target). */
const BUTTON_MIN_HEIGHT = 48;
/** CustomButton styles.button.marginVertical, dp, each side. */
const BUTTON_MARGIN_VERTICAL = 8;

/**
 * Floor on the SLOT, not the button: `flex` stretches the button to the slot height MINUS
 * CustomButton's own marginVertical, so the slot floor is 48dp of button plus both margins (64dp).
 * Without it a one-line thin button stayed at its natural 36dp (72px at 2x, bounds
 * [48,1304][336,1376]) on a Redmi 8 accept/decline footer. If CustomButton's marginVertical
 * changes, update BUTTON_MARGIN_VERTICAL (the jest pin reads the real margin and fails on drift).
 */
export const SIGNATURE_TASK_FOOTER_SLOT_MIN_HEIGHT = BUTTON_MIN_HEIGHT + 2 * BUTTON_MARGIN_VERTICAL;

const styles = StyleSheet.create({
	buttonSlot: {
		// Row direction on purpose: CustomButton's `flex` (flex:1 + alignSelf:stretch) assumes a row
		// parent. The slot still splits the footer row 50/50 via flex:1 + minWidth:0.
		flexDirection: "row",
		flex: 1,
		minWidth: 0,
		minHeight: SIGNATURE_TASK_FOOTER_SLOT_MIN_HEIGHT,
	},
});
