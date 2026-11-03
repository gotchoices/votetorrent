/**
 * PairBrowserScreen — pairs THIS officer's own browser with the network they follow (the
 * officer's phone asks an owner for a single-use invitation and hands the browser a short-lived
 * pairing code). It works on every officer's phone: an owner phone mints locally, any other
 * officer's phone asks an online owner.
 *
 * ONE CONFIRM STEP, ONE BIOMETRIC SIGNATURE, ONE REQUEST PER ATTEMPT. Requesting a code raises an
 * in-screen confirmation gated behind a typed "I confirm" (the `iConfirm`/`typeIConfirm` idiom).
 * Confirming makes exactly one call to the pairing engine with the device signer; the ENGINE builds
 * the signed statement and calls the signer once. This screen never builds signed bytes. Retry is a
 * new request (fresh nonce, fresh signature) without the typed gate.
 *
 * THE CODE IS A BEARER CREDENTIAL. Anyone holding it can pair a browser as this officer until it
 * expires (about 15 minutes, single use). It leaves the screen only through Copy, Share and the QR
 * code, and it is NEVER rendered as text, never put in an accessibility label, hint, testID or
 * nativeID, never logged and never put in navigation state. There is no code text to clip or to
 * read over a shoulder. The clipboard is cleared on expiry, on use, on Finish and on leaving, but
 * only when this screen is the one that wrote the code there.
 *
 * The join anchor comes from the networks engine's revision-tolerant join-anchor reader, so pairing
 * keeps working after the administration is revised (a second officer promoted).
 *
 * THE OWNER MUST BE ONLINE WITH THE APP OPEN. While the request is out the screen says so; when no
 * owner answers it offers "Retry request". Leaving the screen while waiting cancels the request.
 *
 * The full-screen QR view is a screen-owned Modal (never a route), mirroring the voter invite's
 * full-screen view: portrait, kept awake while open, white surface, integer-module panel. It shows
 * the officer's name and the network name; "Share QR image" carries only the code and the network
 * fingerprint (the only text the image band can draw).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ActivityIndicator,
	Image,
	Modal,
	PixelRatio,
	Pressable,
	ScrollView,
	Share,
	StatusBar,
	StyleSheet,
	View,
	useWindowDimensions,
} from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useTheme } from "@react-navigation/native";
import Clipboard from "@react-native-clipboard/clipboard";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeepAwake } from "@sayem314/react-native-keep-awake";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { INetworksEngine } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { globalStyles } from "../../theme/styles";
import { copyToClipboard } from "../../utils/copyToClipboard";
import { errorClassName } from "../../utils/errorClassName";
import { buildQrMatrix } from "../../utils/qr/qr-matrix";
import { qrLayout } from "../../utils/qr/qr-layout";
import { useApp } from "../../providers/AppProvider";
import { useCadreNode, usePairMintLocal } from "../../providers/CadreNodeProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { getDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import {
	loadPairingCapabilityState,
	pairingCapability,
	requestPairingCode,
	type PairingAnchorResult,
	type PairingCapability,
	type PairingNode,
	type PairingRequestFailureReason,
	type ReadPairingAnchor,
} from "../../engines/dashboard-pairing";
import { readActiveNetworkHash } from "../../engines/pair-mint-host";
import { readPairedBrowsers } from "../../engines/paired-browsers-store";
import { deleteSharedQrImage, shareJoinCodeQrImage } from "../../engines/qr-share";
import { QR_VIEW_CHROME_DP, qrViewTargetPx, tryBuildQrPanel } from "../networks/components/VoterInviteQrView";

/** How often a ready code checks whether the browser has redeemed its invitation. */
export const PAIRING_USAGE_POLL_MS = 5_000;
/** The largest QR symbol (version 40). */
export const PAIRING_QR_MAX_MODULES = 177;
/** The smallest module size, in device pixels on a 1080 px wide panel, that still scans. */
export const PAIRING_QR_MIN_MODULE_PX = 5;
/** The reference panel width for the module-size floor. */
const PAIRING_QR_REFERENCE_PX = 1080;
/** The inline tile's target side, in dp. */
const INLINE_QR_DP = 160;

/**
 * True iff the code encodes into one QR symbol of at most `PAIRING_QR_MAX_MODULES` modules whose
 * modules are at least `PAIRING_QR_MIN_MODULE_PX` pixels on a 1080 px panel. Never throws, never logs.
 */
export function pairingQrFits(code: string): boolean {
	try {
		const { n } = buildQrMatrix(code);
		if (n > PAIRING_QR_MAX_MODULES) return false;
		return qrLayout(n, PAIRING_QR_REFERENCE_PX).m >= PAIRING_QR_MIN_MODULE_PX;
	} catch {
		return false;
	}
}

export type PairFailureState = "owner-unreachable" | "refused-off" | "refused-not-allowed" | "build-failed" | "ready";

const FAILURE_STATE: Readonly<Record<PairingRequestFailureReason, PairFailureState>> = Object.freeze({
	"owner-unreachable": "owner-unreachable",
	"not-reachable": "owner-unreachable",
	"switched-off": "refused-off",
	"not-allowed": "refused-not-allowed",
	"build-failed": "build-failed",
	cancelled: "ready",
});

/** The screen state for a failed request. A cancelled request returns to ready with no message. */
export function pairingFailureState(reason: PairingRequestFailureReason): PairFailureState {
	return Object.prototype.hasOwnProperty.call(FAILURE_STATE, reason) ? FAILURE_STATE[reason] : "build-failed";
}

/**
 * The engine's anchor port, bound to the networks engine's revision-tolerant join-anchor reader.
 * One read per call. Success reports `{ name, fingerprint }` to `onAnchor` (for the full-screen view)
 * and returns the anchor WITHOUT its fingerprint. A rejection is classified by its `.code` only,
 * never by its message.
 */
export function makeReadAnchor(args: {
	networksEngine: Pick<INetworksEngine, "getJoinAnchor"> | null | undefined;
	networkHash: string;
	onAnchor?: (a: { name: string; fingerprint: string }) => void;
}): ReadPairingAnchor {
	const { networksEngine, networkHash, onAnchor } = args;
	return async (): Promise<PairingAnchorResult> => {
		if (!networksEngine) return { ok: false, anchor: "not-open" };
		try {
			const a = await networksEngine.getJoinAnchor(networkHash);
			onAnchor?.({ name: a.name, fingerprint: a.fingerprint });
			return { ok: true, anchor: { networkHash: a.networkHash, name: a.name, genesis: a.genesis, digest: a.digest } };
		} catch (err) {
			const code = (err as { code?: unknown } | null)?.code;
			return { ok: false, anchor: code === "network-not-open" ? "not-open" : "unreadable" };
		}
	};
}

type ScreenState =
	| "checking"
	| "unavailable"
	| "ready"
	| "waiting"
	| "code-ready"
	| "used"
	| "expired"
	| "owner-unreachable"
	| "refused-off"
	| "refused-not-allowed"
	| "build-failed";

type UnavailableReason = "no-network" | "not-officer" | "no-signing-key";

interface PairingContext {
	networkHash: string | null;
	db: unknown | null;
	userId: string | null;
	userName: string;
	keyPub: string | null;
	capability: PairingCapability;
}

interface ReadyCode {
	serial: number;
	expiresAtMs: number;
	minutes: number;
}

/** The slice of the cadre node this screen reads directly. */
interface ScreenNode {
	getStrand?(strandId: string): { database?: { getDatabase?(): unknown } } | undefined;
	getControlDatabase?(): { queryCadreInviteUsages?(retry?: boolean): Promise<ReadonlyArray<{ inviteKey: string }>> } | null;
}

/** The network's quereus database, or null when the strand is not open. Never throws. */
function resolveStrandDb(node: unknown, networkHash: string | null): unknown | null {
	if (!node || !networkHash) return null;
	try {
		return (node as ScreenNode).getStrand?.(networkHash)?.database?.getDatabase?.() ?? null;
	} catch {
		return null;
	}
}

const UNAVAILABLE_KEY: Readonly<Record<UnavailableReason, string>> = Object.freeze({
	"no-network": "dashboardPairingUnavailableNoNetwork",
	"not-officer": "dashboardPairingUnavailableNotOfficer",
	"no-signing-key": "dashboardPairingUnavailableNoKey",
});

const INK = "#000000";
const SURFACE = "#FFFFFF";

export default function PairBrowserScreen() {
	const theme = useTheme() as ExtendedTheme;
	const { colors } = theme;
	const { t } = useTranslation();
	const navigation = useNavigation();
	const { networksEngine } = useApp();
	const { node } = useCadreNode();
	const getPairMintLocal = usePairMintLocal();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [screen, setScreenState] = useState<ScreenState>("checking");
	const screenRef = useRef<ScreenState>("checking");
	const setScreen = useCallback((next: ScreenState) => {
		screenRef.current = next;
		setScreenState(next);
	}, []);
	const [unavailableReason, setUnavailableReason] = useState<UnavailableReason>("no-network");
	const [errorMessage, setErrorMessage] = useState("");
	const [confirming, setConfirming] = useState(false);
	// Reset whenever the confirm step is entered or left, so a confirmation typed for an earlier
	// attempt never carries over.
	const [confirmText, setConfirmText] = useState("");
	const readyToConfirm = confirmText === t("iConfirm");
	// The ref is the CORRECTNESS guard against a double request (two presses in one tick read the same
	// closure); `busy` is only the feedback.
	const generatingRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const mountedRef = useRef(true);
	const ctxRef = useRef<PairingContext | null>(null);
	const anchorRef = useRef<{ name: string; fingerprint: string } | null>(null);

	// The code itself lives only in this ref; renders key off `ready.serial`.
	const codeRef = useRef<string | null>(null);
	const nonceRef = useRef<string | null>(null);
	const inviteKeyRef = useRef<string | null>(null);
	const serialRef = useRef(0);
	const [ready, setReady] = useState<ReadyCode | null>(null);
	const [nowTick, setNowTick] = useState(() => Date.now());
	const [copyNotice, setCopyNotice] = useState<"copied" | "failed" | undefined>(undefined);
	const [shareFailed, setShareFailed] = useState(false);
	const [qrOpen, setQrOpen] = useState(false);
	const pollingRef = useRef(false);

	// Set before the clipboard write: a clear that finds nothing is harmless, a credential left on
	// the clipboard is not. Cleared only when THIS screen wrote the code there.
	const copiedRef = useRef(false);
	const clearCopiedCode = useCallback(() => {
		if (!copiedRef.current) return;
		copiedRef.current = false;
		Clipboard.setString("");
	}, []);

	const dropCode = useCallback(() => {
		clearCopiedCode();
		codeRef.current = null;
		nonceRef.current = null;
		inviteKeyRef.current = null;
		setQrOpen(false);
		setCopyNotice(undefined);
		setShareFailed(false);
	}, [clearCopiedCode]);

	useEffect(
		() => () => {
			mountedRef.current = false;
			abortRef.current?.abort();
			abortRef.current = null;
			if (copiedRef.current) {
				copiedRef.current = false;
				Clipboard.setString("");
			}
			codeRef.current = null;
			nonceRef.current = null;
			inviteKeyRef.current = null;
		},
		[],
	);

	// --- capability ---------------------------------------------------------------------------

	const refreshCapability = useCallback(async () => {
		let networkHash: string | null = null;
		let userId: string | null = null;
		let userName = "";
		try {
			networkHash = await readActiveNetworkHash();
		} catch {
			networkHash = null;
		}
		try {
			const user = await getDeviceUser();
			userId = typeof user?.id === "string" && user.id.length > 0 ? user.id : null;
			userName = typeof user?.name === "string" ? user.name : "";
		} catch {
			userId = null;
		}
		const db = resolveStrandDb(node, networkHash);
		const state = await loadPairingCapabilityState({ node, db, networkHash: db ? networkHash : null, userId });
		const capability = pairingCapability(state);
		ctxRef.current = { networkHash, db, userId, userName, keyPub: state.signingKey?.key ?? null, capability };
		if (!mountedRef.current) return;
		// Only a resting screen follows the capability; a result on screen stays until acted on.
		const current = screenRef.current;
		if (current !== "checking" && current !== "ready" && current !== "unavailable") return;
		if (capability === "ready-owner" || capability === "ready-officer") {
			setScreen("ready");
		} else {
			setUnavailableReason(capability);
			setConfirming(false);
			setConfirmText("");
			setScreen("unavailable");
		}
	}, [node, setScreen]);

	useFocusEffect(
		useCallback(() => {
			const current = screenRef.current;
			if (current === "waiting" || current === "code-ready") return undefined;
			void refreshCapability();
			return undefined;
		}, [refreshCapability]),
	);

	// --- request ------------------------------------------------------------------------------

	const runRequest = useCallback(async () => {
		if (generatingRef.current) return;
		const ctx = ctxRef.current;
		if (
			!ctx ||
			(ctx.capability !== "ready-owner" && ctx.capability !== "ready-officer") ||
			!node ||
			!ctx.networkHash ||
			!ctx.db ||
			!ctx.userId ||
			!ctx.keyPub
		) {
			return;
		}
		generatingRef.current = true;
		setBusy(true);
		setErrorMessage("");
		setConfirming(false);
		setConfirmText("");
		dropCode();
		setReady(null);
		setScreen("waiting");
		const controller = new AbortController();
		abortRef.current = controller;
		const { networkHash, db, userId, keyPub, capability } = ctx;
		try {
			const signer = await createDeviceSigner("Device User");
			if (!mountedRef.current || controller.signal.aborted) return;
			const localMint = capability === "ready-owner" ? (getPairMintLocal() ?? undefined) : undefined;
			const readAnchor = makeReadAnchor({
				networksEngine,
				networkHash,
				onAnchor: (a) => {
					anchorRef.current = a;
				},
			});
			const result = await requestPairingCode({
				node: node as unknown as PairingNode,
				db: db as Parameters<typeof requestPairingCode>[0]["db"],
				signer,
				networkHash,
				userId,
				keyPub,
				readAnchor,
				localMint,
				label: null,
				signal: controller.signal,
			});
			if (!mountedRef.current || controller.signal.aborted) return;
			if (result.ok) {
				const expiresAtMs = Date.parse(`${result.expiresAt}Z`);
				const now = Date.now();
				codeRef.current = result.code;
				nonceRef.current = result.nonce;
				inviteKeyRef.current = null;
				serialRef.current += 1;
				setNowTick(now);
				setReady({
					serial: serialRef.current,
					expiresAtMs,
					minutes: Math.max(1, Math.ceil((expiresAtMs - now) / 60_000)),
				});
				setScreen("code-ready");
			} else {
				setScreen(pairingFailureState(result.reason));
			}
		} catch (err) {
			if (!mountedRef.current) return;
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) {
				setScreen("ready");
				return;
			}
			// eslint-disable-next-line no-console -- closed tag and the error class name only.
			console.warn("[pair-browser] request failed:", errorClassName(err));
			const hasCode = typeof (err as { code?: unknown } | null)?.code === "string";
			if (hasCode && outcome.message) {
				setErrorMessage(outcome.message);
				setScreen("ready");
			} else {
				setScreen("build-failed");
			}
		} finally {
			generatingRef.current = false;
			if (abortRef.current === controller) abortRef.current = null;
			if (mountedRef.current) setBusy(false);
		}
	}, [dropCode, getPairMintLocal, handleDeviceSigningError, networksEngine, node, setScreen]);

	const handleOpenConfirm = useCallback(() => {
		setErrorMessage("");
		setConfirmText("");
		setConfirming(true);
	}, []);

	const handleCloseConfirm = useCallback(() => {
		setConfirming(false);
		setConfirmText("");
	}, []);

	const handleCancelRequest = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setScreen("ready");
	}, [setScreen]);

	const handlePairAnother = useCallback(() => {
		dropCode();
		setReady(null);
		setScreen("ready");
		handleOpenConfirm();
	}, [dropCode, handleOpenConfirm, setScreen]);

	const handleFinish = useCallback(() => {
		dropCode();
		setReady(null);
		setScreen("ready");
		if (navigation.canGoBack()) navigation.goBack();
	}, [dropCode, navigation, setScreen]);

	const handleCopy = useCallback(async () => {
		const code = codeRef.current;
		if (!code) return;
		copiedRef.current = true;
		const ok = await copyToClipboard(code);
		if (mountedRef.current) setCopyNotice(ok ? "copied" : "failed");
	}, []);

	const handleShare = useCallback(async () => {
		const code = codeRef.current;
		if (!code) return;
		try {
			// The code text alone, so a paste of the shared text decodes.
			await Share.share({ message: code });
			if (mountedRef.current) setShareFailed(false);
		} catch {
			if (mountedRef.current) setShareFailed(true);
		}
	}, []);

	// --- code-ready timers ---------------------------------------------------------------------

	const codeReady = screen === "code-ready";
	const readySerial = ready?.serial ?? 0;

	useEffect(() => {
		if (!codeReady) return undefined;
		const interval = setInterval(() => setNowTick(Date.now()), 1_000);
		return () => clearInterval(interval);
	}, [codeReady, readySerial]);

	useEffect(() => {
		if (codeReady && ready && nowTick >= ready.expiresAtMs) {
			dropCode();
			setScreen("expired");
		}
	}, [codeReady, ready, nowTick, dropCode, setScreen]);

	const pollUsage = useCallback(async (serial: number) => {
		if (pollingRef.current) return;
		pollingRef.current = true;
		try {
			const ctx = ctxRef.current;
			if (!ctx?.networkHash || !ctx.userId || !nonceRef.current) return;
			if (!inviteKeyRef.current) {
				const entries = await readPairedBrowsers({ networkHash: ctx.networkHash, userId: ctx.userId });
				const entry = entries.find((e) => e.nonce === nonceRef.current);
				if (entry) inviteKeyRef.current = entry.inviteKey;
			}
			const inviteKey = inviteKeyRef.current;
			if (!inviteKey) return;
			const control = (node as unknown as ScreenNode | null)?.getControlDatabase?.();
			if (!control?.queryCadreInviteUsages) return;
			const rows = await control.queryCadreInviteUsages(false);
			if (!rows.some((r) => r.inviteKey === inviteKey)) return;
			if (!mountedRef.current || screenRef.current !== "code-ready" || serialRef.current !== serial) return;
			dropCode();
			setScreen("used");
		} catch {
			// A failed read is retried on the next tick.
		} finally {
			pollingRef.current = false;
		}
	}, [dropCode, node, setScreen]);

	useEffect(() => {
		if (!codeReady || readySerial === 0) return undefined;
		const serial = readySerial;
		const interval = setInterval(() => void pollUsage(serial), PAIRING_USAGE_POLL_MS);
		return () => clearInterval(interval);
	}, [codeReady, readySerial, pollUsage]);

	// --- inline QR ----------------------------------------------------------------------------

	const { scale } = useWindowDimensions();
	const thumb = useMemo(() => {
		const code = codeReady ? codeRef.current : null;
		if (!code) return null;
		if (!pairingQrFits(code)) return { fits: false as const };
		return { fits: true as const, attempt: tryBuildQrPanel(code, INLINE_QR_DP * PixelRatio.get()) };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [codeReady, readySerial, scale]);

	// --- render -------------------------------------------------------------------------------

	const ratio = PixelRatio.get();
	const remainingSeconds = ready ? Math.max(0, Math.round((ready.expiresAtMs - nowTick) / 1_000)) : 0;
	const remainingLabel = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
	const qrUsable = thumb?.fits === true && thumb.attempt.ok;
	const showRequest =
		!confirming && (screen === "ready" || screen === "expired" || screen === "refused-off" || screen === "refused-not-allowed");
	const showRetry = !confirming && (screen === "owner-unreachable" || screen === "build-failed");

	return (
		<KeyboardAvoidingScreen testID="pair-browser-screen">
			<ScrollView style={styles.container}>
				<View style={[styles.card, { backgroundColor: colors.background }]}>
					{screen === "checking" ? (
						<ThemedText type="default" testID="pair-browser-checking" style={{ color: colors.textSecondary }}>
							{t("dashboardPairingChecking")}
						</ThemedText>
					) : null}

					{screen === "unavailable" ? (
						<View testID="pair-browser-unavailable" style={styles.block}>
							<ThemedText type="defaultSemiBold">{t("dashboardPairingUnavailable")}</ThemedText>
							<ThemedText type="default">{t(UNAVAILABLE_KEY[unavailableReason])}</ThemedText>
						</View>
					) : null}

					{screen === "ready" ? (
						<View testID="pair-browser-ready" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingIdleBody")}</ThemedText>
						</View>
					) : null}

					{screen === "waiting" ? (
						<View testID="pair-browser-waiting" style={styles.block}>
							<ThemedText type="defaultSemiBold">{t("dashboardPairingWaitingHeading")}</ThemedText>
							<ThemedText type="default">{t("dashboardPairingWaitingBody")}</ThemedText>
							<ActivityIndicator accessibilityLabel={t("dashboardPairingWaitingHeading")} color={colors.text} />
						</View>
					) : null}

					{codeReady && ready ? (
						<View testID="pair-browser-code-ready" style={styles.block}>
							<ThemedText type="defaultSemiBold">{t("dashboardPairingReadyHeading")}</ThemedText>
							<ThemedText type="default">{t("dashboardPairingReadyBody", { minutes: ready.minutes })}</ThemedText>
							{thumb?.fits === false ? (
								<ThemedText type="small" testID="pair-browser-qr-too-large" style={{ color: colors.text }}>
									{t("dashboardPairingQrTooLarge")}
								</ThemedText>
							) : null}
							{thumb?.fits === true && thumb.attempt.ok ? (
								<>
									<Pressable
										testID="pair-browser-qr"
										accessibilityRole="button"
										accessibilityLabel={t("dashboardPairingQrTileLabel")}
										onPress={() => setQrOpen(true)}
										style={{ alignSelf: "center" }}
									>
										<View style={{ borderWidth: 1 / ratio, borderColor: theme.dark ? colors.accent : colors.border }}>
											<Image
												testID="pair-browser-qr-image"
												source={{ uri: "data:image/png;base64," + thumb.attempt.panel.base64 }}
												style={{
													width: thumb.attempt.panel.panelPx / ratio,
													height: thumb.attempt.panel.panelPx / ratio,
												}}
												resizeMode="stretch"
												fadeDuration={0}
												accessible={false}
											/>
										</View>
									</Pressable>
									<ThemedText type="small" style={{ color: colors.text, textAlign: "center" }}>
										{t("dashboardPairingQrHint")}
									</ThemedText>
								</>
							) : null}
							{thumb?.fits === true && !thumb.attempt.ok ? (
								<ThemedText type="small" testID="pair-browser-qr-render-failed" style={{ color: colors.error }}>
									{t("dashboardPairingQrRenderFailed")}
								</ThemedText>
							) : null}
							<ThemedText type="small" testID="pair-browser-countdown" style={{ color: colors.textSecondary }}>
								{t("dashboardPairingCountdown", { remaining: remainingLabel })}
							</ThemedText>
							{qrUsable ? (
								<CustomButton
									testID="pair-browser-qr-open"
									icon="qrcode"
									backgroundColor={colors.primary}
									title={t("dashboardPairingShowQrButton")}
									onPress={() => setQrOpen(true)}
								/>
							) : null}
							<CustomButton
								testID="pair-browser-copy"
								icon="copy"
								title={t("dashboardPairingCopyButton")}
								onPress={() => void handleCopy()}
							/>
							<CustomButton
								testID="pair-browser-share"
								icon="share-nodes"
								title={t("dashboardPairingShareButton")}
								onPress={() => void handleShare()}
							/>
							{copyNotice !== undefined ? (
								<ThemedText
									type="small"
									testID="pair-browser-copy-notice"
									style={{ color: copyNotice === "copied" ? colors.textSecondary : colors.error }}
								>
									{copyNotice === "copied" ? t("dashboardPairingCopied") : t("dashboardPairingCopyFailed")}
								</ThemedText>
							) : null}
							{shareFailed ? (
								<ThemedText type="small" testID="pair-browser-share-notice" style={{ color: colors.error }}>
									{t("dashboardPairingShareFailed")}
								</ThemedText>
							) : null}
							<CustomButton
								testID="pair-browser-finish"
								title={t("dashboardPairingFinishButton")}
								onPress={handleFinish}
							/>
							<ThemedText type="small" testID="pair-browser-warning" style={{ color: colors.text }}>
								{t("dashboardPairingQrWarning")}
							</ThemedText>
						</View>
					) : null}

					{screen === "used" ? (
						<View testID="pair-browser-used" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingUsed")}</ThemedText>
						</View>
					) : null}

					{screen === "expired" ? (
						<View testID="pair-browser-expired" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingExpired")}</ThemedText>
						</View>
					) : null}

					{screen === "owner-unreachable" ? (
						<View testID="pair-browser-owner-unreachable" style={styles.block}>
							<ThemedText type="defaultSemiBold">{t("dashboardPairingOwnerUnreachableHeading")}</ThemedText>
							<ThemedText type="default">{t("dashboardPairingOwnerUnreachableBody")}</ThemedText>
						</View>
					) : null}

					{screen === "refused-off" ? (
						<View testID="pair-browser-refused-off" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingSwitchedOff")}</ThemedText>
						</View>
					) : null}

					{screen === "refused-not-allowed" ? (
						<View testID="pair-browser-refused-not-allowed" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingNotAllowed")}</ThemedText>
						</View>
					) : null}

					{screen === "build-failed" ? (
						<View testID="pair-browser-build-failed" style={styles.block}>
							<ThemedText type="default">{t("dashboardPairingBuildFailed")}</ThemedText>
						</View>
					) : null}
				</View>
			</ScrollView>
			<InlineError message={errorMessage} />
			{confirming ? (
				<View style={styles.section} testID="pair-browser-confirm">
					<ThemedText type="defaultSemiBold" style={styles.body}>
						{t("dashboardPairingConfirmHeading")}
					</ThemedText>
					<ThemedText type="default" style={styles.body}>
						{t("dashboardPairingConfirmBody")}
					</ThemedText>
					<CustomTextInput
						title={t("typeIConfirm")}
						placeholder={t("confirmIfSure")}
						value={confirmText}
						onChangeText={setConfirmText}
					/>
				</View>
			) : null}
			<Footer>
				{confirming ? (
					<>
						<CustomButton
							testID="pair-browser-confirm-submit"
							title={t("dashboardPairingRequestButton")}
							icon="key"
							disabled={busy || !readyToConfirm}
							backgroundColor={colors.primary}
							onPress={() => void runRequest()}
						/>
						<CustomButton
							testID="pair-browser-confirm-cancel"
							title={t("cancel")}
							size="thin"
							onPress={handleCloseConfirm}
						/>
					</>
				) : null}
				{showRequest ? (
					<CustomButton
						testID="pair-browser-request"
						title={t("dashboardPairingRequestButton")}
						icon="key"
						disabled={busy}
						backgroundColor={colors.primary}
						onPress={handleOpenConfirm}
					/>
				) : null}
				{screen === "waiting" ? (
					<CustomButton
						testID="pair-browser-cancel-request"
						title={t("dashboardPairingCancelButton")}
						size="thin"
						onPress={handleCancelRequest}
					/>
				) : null}
				{showRetry ? (
					<CustomButton
						testID="pair-browser-retry"
						title={t("dashboardPairingRetryButton")}
						disabled={busy}
						onPress={() => void runRequest()}
					/>
				) : null}
				{screen === "used" && !confirming ? (
					<CustomButton
						testID="pair-browser-pair-another"
						title={t("dashboardPairingPairAnotherButton")}
						onPress={handlePairAnother}
					/>
				) : null}
			</Footer>
			{qrOpen && codeReady && qrUsable && codeRef.current ? (
				<PairingQrView
					code={codeRef.current}
					officerName={ctxRef.current?.userName ?? ""}
					networkName={anchorRef.current?.name ?? ""}
					fingerprint={anchorRef.current?.fingerprint ?? ""}
					onClose={() => setQrOpen(false)}
				/>
			) : null}
		</KeyboardAvoidingScreen>
	);
}

// --- full-screen QR view ------------------------------------------------------------------------

interface PairingQrViewProps {
	code: string;
	officerName: string;
	networkName: string;
	fingerprint: string;
	onClose: () => void;
}

function PairingQrBody({ code, officerName, networkName, fingerprint, onClose }: PairingQrViewProps) {
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
		if (inFlightRef.current || fingerprint.length === 0) return;
		inFlightRef.current = true;
		setSharing(true);
		try {
			await shareJoinCodeQrImage({ code, fingerprint });
			if (mountedRef.current) setShareFailed(false);
		} catch {
			if (mountedRef.current) setShareFailed(true);
		} finally {
			inFlightRef.current = false;
			if (mountedRef.current) setSharing(false);
		}
	}, [code, fingerprint]);

	const leadPx = attempt.ok ? Math.floor((windowWidthPx - attempt.panel.panelPx) / 2) : 0;

	return (
		<View
			testID="pair-browser-qr-view"
			style={{ flex: 1, backgroundColor: SURFACE, paddingTop: insets.top, paddingBottom: insets.bottom }}
		>
			<StatusBar barStyle="dark-content" />
			<View style={{ height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 8 }}>
				<Pressable
					testID="pair-browser-qr-close"
					accessibilityRole="button"
					accessibilityLabel={t("dashboardPairingQrClose")}
					onPress={handleClose}
					style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}
				>
					<FontAwesome6 name="xmark" size={24} color={INK} />
				</Pressable>
			</View>
			<View style={{ width: "100%", flexDirection: "row" }}>
				{attempt.ok ? (
					<Image
						testID="pair-browser-qr-full"
						source={{ uri: "data:image/png;base64," + attempt.panel.base64 }}
						style={{
							width: attempt.panel.panelPx / ratio,
							height: attempt.panel.panelPx / ratio,
							marginLeft: leadPx / ratio,
						}}
						resizeMode="stretch"
						fadeDuration={0}
						accessible={false}
					/>
				) : (
					<ThemedText type="small" style={{ color: INK, paddingHorizontal: 16 }}>
						{t("dashboardPairingQrRenderFailed")}
					</ThemedText>
				)}
			</View>
			<View style={{ height: 24 }} />
			<View style={{ paddingHorizontal: 16, alignItems: "center", gap: 4 }}>
				{officerName.length > 0 ? (
					<ThemedText
						testID="pair-browser-qr-officer"
						style={{ fontSize: 16, fontWeight: "600", lineHeight: 24, color: INK, textAlign: "center" }}
					>
						{officerName}
					</ThemedText>
				) : null}
				{networkName.length > 0 ? (
					<ThemedText
						testID="pair-browser-qr-network"
						style={{ fontSize: 14, lineHeight: 20, color: INK, textAlign: "center" }}
					>
						{networkName}
					</ThemedText>
				) : null}
			</View>
			<View style={{ flex: 1 }} />
			<ThemedText type="small" style={{ color: INK, textAlign: "center", paddingHorizontal: 16 }}>
				{t("dashboardPairingQrWarning")}
			</ThemedText>
			{fingerprint.length > 0 ? (
				<CustomButton
					testID="pair-browser-qr-share-image"
					title={t("dashboardPairingQrShareImage")}
					icon="share-nodes"
					backgroundColor="#d9d9d9"
					forceDarkText
					disabled={sharing}
					onPress={() => void share()}
				/>
			) : null}
			{shareFailed ? (
				<ThemedText
					type="small"
					testID="pair-browser-qr-share-notice"
					style={{ color: INK, textAlign: "center", paddingHorizontal: 16 }}
				>
					{t("dashboardPairingQrShareFailed")}
				</ThemedText>
			) : null}
		</View>
	);
}

function PairingQrView(props: PairingQrViewProps) {
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
				<PairingQrBody {...props} />
			</SafeAreaProvider>
		</Modal>
	);
}

const localStyles = StyleSheet.create({
	card: {
		padding: 16,
		gap: 8,
	},
	block: {
		gap: 8,
	},
	body: {
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
