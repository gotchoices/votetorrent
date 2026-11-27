/**
 * VoterInviteQrView.tsx - the full-screen join-code QR (Phase 64 plan 17; D-03, D-04, D-06).
 *
 * D-03: a card-owned React Native Modal (never a route, so the code never enters navigation state)
 * that draws the QR as the largest integer-module square that fits, full-bleed, at an integer
 * device-pixel lead offset, with the fingerprint below it. The panel row carries NO horizontal
 * padding or margin: plan 64-24's geometry checker fails `not-largest-fit` and `not-centered`
 * otherwise.
 *
 * D-04: "Share QR image" hands only the code and the fingerprint to `shareJoinCodeQrImage`, so no
 * name, expiry or warning can reach the PNG.
 *
 * D-06: the code is a bearer credential. It is in no label, testID or key. The only log lines are the
 * closed tokens `[voter-invite] qr: failed` and `[voter-invite] qr-share: failed`. The screen is kept
 * awake only while this view is mounted, and the card renders it conditionally, so keep-awake and the
 * cache-file cleanup follow mount and unmount.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PixelRatio, Platform, Pressable, StatusBar, View, Image, Modal, useWindowDimensions } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "@sayem314/react-native-keep-awake";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { deleteSharedQrImage, shareJoinCodeQrImage } from "../../../engines/qr-share";
import { lightTheme } from "../../../theme/themes";
import { buildQrPanelPng } from "../../../utils/qr/qr-panel";

/**
 * Vertical chrome reserved around the panel, in dp: top bar 64 + gap 24 + fingerprint block 72 +
 * warning 48 + share button 72 (56 + 2 x 8 margin) + notice line 24. The safe-area insets are added
 * on top at render time.
 */
export const QR_VIEW_CHROME_DP = 304;

/** The square the panel may occupy: the width, or the height left after the chrome if smaller. */
export function qrViewTargetPx(a: { windowWidthPx: number; windowHeightPx: number; chromePx: number }): number {
	return Math.min(a.windowWidthPx, a.windowHeightPx - a.chromePx);
}

export type QrPanelAttempt =
	| { readonly ok: true; readonly panel: { base64: string; n: number; m: number; panelPx: number } }
	| { readonly ok: false };

/**
 * Build the panel without ever throwing. QrInputError, QrOverflowError and QrLayoutError are the
 * expected failures; anything else also fails closed. Only the PNG and its numbers leave.
 */
export function tryBuildQrPanel(code: string, targetPx: number): QrPanelAttempt {
	try {
		const { base64, n, m, panelPx } = buildQrPanelPng(code, targetPx);
		return { ok: true, panel: { base64, n, m, panelPx } };
	} catch {
		return { ok: false };
	}
}

function logQrFailure(stage: "qr" | "qr-share"): void {
	// eslint-disable-next-line no-console -- closed token only, never a code, image or native text.
	console.info(`[voter-invite] ${stage}: failed`);
}

const INK = "#000000";
const SURFACE = "#FFFFFF";

export interface VoterInviteQrViewProps {
	code: string;
	fingerprint: string;
	onClose: () => void;
}

function QrViewBody({ code, fingerprint, onClose }: VoterInviteQrViewProps) {
	const { t } = useTranslation();
	useKeepAwake();
	const insets = useSafeAreaInsets();
	const { width, height } = useWindowDimensions();
	const ratio = PixelRatio.get();
	const windowWidthPx = PixelRatio.getPixelSizeForLayoutSize(width);
	const windowHeightPx = PixelRatio.getPixelSizeForLayoutSize(height);
	const chromePx = PixelRatio.getPixelSizeForLayoutSize(QR_VIEW_CHROME_DP + insets.top + insets.bottom);
	const attempt = useMemo(
		() => tryBuildQrPanel(code, qrViewTargetPx({ windowWidthPx, windowHeightPx, chromePx })),
		[code, windowWidthPx, windowHeightPx, chromePx],
	);
	const [shareFailed, setShareFailed] = useState(false);
	const [sharing, setSharing] = useState(false);
	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);

	useEffect(() => {
		if (!attempt.ok) logQrFailure("qr");
	}, [attempt]);

	useEffect(
		() => () => {
			mountedRef.current = false;
			void deleteSharedQrImage();
		},
		[],
	);

	const handleClose = useCallback(() => {
		void deleteSharedQrImage();
		onClose();
	}, [onClose]);

	const share = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setSharing(true);
		try {
			await shareJoinCodeQrImage({ code, fingerprint });
			if (mountedRef.current) setShareFailed(false);
		} catch {
			logQrFailure("qr-share");
			if (mountedRef.current) setShareFailed(true);
		} finally {
			inFlightRef.current = false;
			if (mountedRef.current) setSharing(false);
		}
	}, [code, fingerprint]);

	const leadPx = attempt.ok ? Math.floor((windowWidthPx - attempt.panel.panelPx) / 2) : 0;

	return (
		<View
			testID="voter-invite-qr-view"
			style={{ flex: 1, backgroundColor: SURFACE, paddingTop: insets.top, paddingBottom: insets.bottom }}
		>
			<StatusBar barStyle="dark-content" />
			<View style={{ height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 }}>
				<Pressable
					testID="voter-invite-qr-close"
					accessibilityRole="button"
					accessibilityLabel={t("voterInviteQrClose")}
					onPress={handleClose}
					style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
				>
					<FontAwesome6 name="xmark" size={24} color={INK} />
				</Pressable>
			</View>
			<View style={{ width: "100%", flexDirection: "row" }}>
				{attempt.ok ? (
					<Image
						testID="voter-invite-qr-full"
						source={{ uri: "data:image/png;base64," + attempt.panel.base64 }}
						style={{
							width: attempt.panel.panelPx / ratio,
							height: attempt.panel.panelPx / ratio,
							marginLeft: leadPx / ratio,
						}}
						resizeMode="stretch"
						fadeDuration={0}
						accessible={false}
						onError={() => logQrFailure("qr")}
					/>
				) : (
					<ThemedText
						type="small"
						testID="voter-invite-qr-full-render-failed"
						style={{ color: lightTheme.colors.error, paddingHorizontal: 16 }}
					>
						{t("voterInviteQrRenderFailed")}
					</ThemedText>
				)}
			</View>
			<View style={{ height: 24 }} />
			<View style={{ paddingHorizontal: 16, alignItems: "center", gap: 4 }}>
				<ThemedText type="defaultSemiBold" style={{ color: INK }}>
					{t("networkFoundingExportFingerprintLabel")}
				</ThemedText>
				<ThemedText
					testID="voter-invite-qr-fingerprint"
					selectable
					maxFontSizeMultiplier={1.5}
					style={{
						fontSize: 24,
						fontWeight: "600",
						lineHeight: 32,
						fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
						color: INK,
						textAlign: "center",
					}}
				>
					{fingerprint}
				</ThemedText>
			</View>
			<View style={{ flex: 1 }} />
			<ThemedText
				type="small"
				testID="voter-invite-qr-warning"
				style={{ color: INK, textAlign: "center", paddingHorizontal: 16 }}
			>
				{t("voterInviteQrWarning")}
			</ThemedText>
			<CustomButton
				testID="voter-invite-qr-share"
				title={t("voterInviteQrShareImage")}
				icon="share-nodes"
				backgroundColor="#d9d9d9"
				forceDarkText
				disabled={sharing}
				onPress={() => void share()}
			/>
			{shareFailed && (
				<ThemedText
					type="small"
					testID="voter-invite-qr-share-notice"
					style={{ color: lightTheme.colors.error, textAlign: "center", paddingHorizontal: 16 }}
				>
					{t("voterInviteQrShareFailed")}
				</ThemedText>
			)}
		</View>
	);
}

export function VoterInviteQrView(props: VoterInviteQrViewProps) {
	const { onClose } = props;
	const handleRequestClose = useCallback(() => {
		void deleteSharedQrImage();
		onClose();
	}, [onClose]);
	return (
		<Modal
			visible
			presentationStyle="fullScreen"
			statusBarTranslucent
			navigationBarTranslucent
			animationType="fade"
			supportedOrientations={["portrait"]}
			onRequestClose={handleRequestClose}
		>
			<SafeAreaProvider>
				<QrViewBody {...props} />
			</SafeAreaProvider>
		</Modal>
	);
}
