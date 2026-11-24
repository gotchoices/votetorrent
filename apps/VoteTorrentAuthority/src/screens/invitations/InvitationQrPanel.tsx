/**
 * InvitationQrPanel - the keyholder invitation as a QR code, shown inline under Share and Copy.
 *
 * Why inline and not a Modal: the panel draws the invitation's private key, and while it shows the
 * window is FLAG_SECURE on Android (no screenshots, screen recording or Recents thumbnail) through
 * the same ref-counted lease the paste field uses. A React Native Modal is a separate Android window
 * that the activity's flag does not cover, so the QR stays in the screen's own window. Another
 * phone's camera still reads it; the way to send it as a picture is "Share QR image".
 *
 * The QR carries exactly the text Share and Copy send (the invitation is ASCII-only JSON, see
 * `serializeInviteShare`), at error correction M (`utils/qr/invite-qr.ts`). The screen is kept awake
 * only while the panel is mounted, and the shared PNG is deleted once the sheet settles, on Hide and
 * on unmount.
 *
 * The invitation is a secret meant for one person, so the warning says that anyone who scans the
 * code or gets the image can accept it in the invitee's place. Nothing here logs the text; the only
 * log lines are the closed tokens `[invite] qr: failed` and `[invite] qr-share: failed`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Image, PixelRatio, StyleSheet, View, useWindowDimensions } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useKeepAwake } from "@sayem314/react-native-keep-awake";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { deleteSharedInvitationQrImage, shareInvitationQrImage } from "../../engines/qr-share";
import { tryBuildInvitationQr } from "../../utils/qr/invite-qr";
import { acquireSecureLease, releaseSecureLease } from "./InviteSharePasteField";

/** Horizontal room the panel leaves on screen, in dp (the screen container's 16 dp padding on each side). */
export const INVITATION_QR_GUTTER_DP = 32;
/** The panel never grows past this, in dp, so it stays a comfortable size on a tablet. */
export const INVITATION_QR_MAX_DP = 360;

function logFailure(stage: "qr" | "qr-share"): void {
	// eslint-disable-next-line no-console -- closed token only, never the invitation, image or native text.
	console.info(`[invite] ${stage}: failed`);
}

const SURFACE = "#FFFFFF";

export interface InvitationQrPanelProps {
	shareText: string;
	testIDPrefix: string;
	onHide: () => void;
	/** Fired when the QR image share sheet reports that the image was sent. */
	onShared?: () => void;
}

export function InvitationQrPanel({ shareText, testIDPrefix, onHide, onShared }: InvitationQrPanelProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	useKeepAwake();
	const { width } = useWindowDimensions();
	const ratio = PixelRatio.get();
	const sideDp = Math.max(1, Math.min(width - INVITATION_QR_GUTTER_DP, INVITATION_QR_MAX_DP));
	const attempt = useMemo(() => tryBuildInvitationQr(shareText, Math.floor(sideDp * ratio)), [shareText, sideDp, ratio]);
	const [sharing, setSharing] = useState(false);
	const [shareFailed, setShareFailed] = useState(false);
	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);

	useEffect(() => {
		if (!attempt.ok) logFailure("qr");
	}, [attempt]);

	useEffect(() => {
		mountedRef.current = true;
		acquireSecureLease();
		return () => {
			mountedRef.current = false;
			releaseSecureLease();
			void deleteSharedInvitationQrImage();
		};
	}, []);

	const share = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setSharing(true);
		setShareFailed(false);
		try {
			const outcome = await shareInvitationQrImage(shareText);
			if (outcome === "shared" && mountedRef.current) onShared?.();
		} catch {
			logFailure("qr-share");
			if (mountedRef.current) setShareFailed(true);
		} finally {
			inFlightRef.current = false;
			if (mountedRef.current) setSharing(false);
		}
	}, [shareText, onShared]);

	const hide = useCallback(() => {
		void deleteSharedInvitationQrImage();
		onHide();
	}, [onHide]);

	return (
		<View testID={`${testIDPrefix}-qr-panel`} style={styles.panel}>
			{attempt.ok ? (
				<View style={[styles.surface, { borderColor: colors.border }]}>
					<Image
						testID={`${testIDPrefix}-qr-image`}
						source={{ uri: "data:image/png;base64," + attempt.base64 }}
						style={{ width: attempt.panelPx / ratio, height: attempt.panelPx / ratio }}
						resizeMode="stretch"
						fadeDuration={0}
						accessible
						accessibilityRole="image"
						accessibilityLabel={t("invitationQrA11y")}
						onError={() => logFailure("qr")}
					/>
				</View>
			) : (
				<ThemedText type="small" testID={`${testIDPrefix}-qr-render-failed`} style={{ color: colors.error }}>
					{t("invitationQrRenderFailed")}
				</ThemedText>
			)}
			<ThemedText type="small" testID={`${testIDPrefix}-qr-warning`} style={[styles.warning, { color: colors.text }]}>
				{t("invitationQrWarning")}
			</ThemedText>
			{attempt.ok ? (
				<CustomButton
					testID={`${testIDPrefix}-qr-share`}
					title={t("invitationQrShareImage")}
					icon="share-nodes"
					disabled={sharing}
					onPress={() => void share()}
				/>
			) : null}
			{shareFailed ? (
				<ThemedText
					type="small"
					testID={`${testIDPrefix}-qr-share-failed`}
					accessibilityLiveRegion="polite"
					style={{ color: colors.error }}
				>
					{t("invitationQrShareFailed")}
				</ThemedText>
			) : null}
			<CustomButton
				testID={`${testIDPrefix}-qr-hide`}
				title={t("invitationQrHide")}
				icon="eye-slash"
				backgroundColor={colors.card}
				onPress={hide}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	panel: {
		marginTop: 8,
		gap: 8,
	},
	surface: {
		alignSelf: "center",
		backgroundColor: SURFACE,
		borderWidth: StyleSheet.hairlineWidth,
	},
	warning: {
		marginTop: 4,
	},
});

export default InvitationQrPanel;
