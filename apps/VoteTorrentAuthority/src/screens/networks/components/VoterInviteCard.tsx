/**
 * VoterInviteCard.tsx — "Invite voters" for one network (spike 100).
 *
 * Produces a JOIN CODE (`engines/voter-invite.ts`): an untargeted, multi-use cadre invitation plus
 * the network's founding anchor. The officer shows the code as a QR (inline thumbnail, then a
 * full-screen view), copies it or shares it, and publishes the network fingerprint shown here through
 * an official channel; a voter's phone shows the same fingerprint before it joins (Voter app,
 * Settings → Join a network). Paste, Share and both QR panels carry exactly the same text (D-01).
 *
 * The full-screen view is a Modal OWNED BY THIS CARD, never a route, so the code cannot enter
 * navigation params or persisted navigation state. The code text itself is no longer rendered on the
 * card (D-06). The Share QR image PNG is built and deleted by `VoterInviteQrView` / `engines/qr-share`;
 * the card deletes any leftover on unmount.
 *
 * A phone that founded its cadre without an owner key must first become the cadre's owner. That
 * changes who can admit machines to this network, so it waits for an explicit confirm. A phone that
 * joined a cadre someone else owns cannot invite voters at all, and says so.
 *
 * A failed code says why when the reason is known (`inviteFailureReason`): no relay configured in
 * the app, no relay reservation yet, a network this phone did not found, or a network that did not
 * open in time. The log carries the same closed reason token.
 *
 * Translated copy only; logs carry closed tokens, never the code (it holds the invitation's private
 * key).
 */
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Image, PixelRatio, Pressable, Share, View, useWindowDimensions, type HostInstance } from "react-native";
import type { NetworkReference } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { useApp } from "../../../providers/AppProvider";
import { useCadreNode } from "../../../providers/CadreNodeProvider";
import { getDeviceUser } from "../../../engines/device-user";
import { deleteSharedQrImage } from "../../../engines/qr-share";
import { VoterInviteQrView, tryBuildQrPanel } from "./VoterInviteQrView";
import { copyToClipboard } from "../../../utils/copyToClipboard";
import {
	createVoterJoinCode,
	inviteExpiryMs,
	voterInviteCapability,
	VoterInviteError,
	type VoterInviteFailureReason,
	type VoterInviteNode,
	type VoterJoinCodeResult,
} from "../../../engines/voter-invite";

export interface VoterInviteCardProps {
	networkRef: NetworkReference;
	onClose: () => void;
}

/** Delay before accessibility focus returns to the Show QR code button (UI-SPEC: after the Modal's fade). */
export const QR_FOCUS_RETURN_DELAY_MS = 250;

// Mirrors FoundingBundleExportCard's EXPORT_OPEN_TIMEOUT_MS: open() can stall on a first-sync wait.
const INVITE_OPEN_TIMEOUT_MS = 45000;

type CardState =
	| { kind: "checking" }
	| { kind: "confirm-owner" }
	| { kind: "not-owner" }
	| { kind: "generating" }
	| { kind: "ready"; result: VoterJoinCodeResult }
	| { kind: "error"; reason: InviteErrorReason };

/** Every reason the error body can name; `failed` is the generic one. */
export type InviteErrorReason = VoterInviteFailureReason | "no-relay-config" | "failed";

/**
 * The reason for a failed generate. An unreachable phone whose app ships no relay address is
 * reported as the config fault, its root cause; anything unrecognised is `failed`.
 */
export function inviteFailureReason(err: unknown, configFault: unknown): InviteErrorReason {
	if (!(err instanceof VoterInviteError)) return "failed";
	if (err.reason === "not-reachable" && configFault) return "no-relay-config";
	return err.reason;
}

/** The translated sentence for each reason. */
export function inviteFailureKey(reason: InviteErrorReason): string {
	switch (reason) {
		case "no-relay-config":
			return "voterInviteFailedNoRelay";
		case "not-reachable":
			return "voterInviteFailedNotReachable";
		case "not-founding-officer":
			return "voterInviteFailedNotFounder";
		case "open-timeout":
			return "voterInviteFailedOpenTimeout";
		default:
			return "voterInviteFailed";
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new VoterInviteError("open-timeout")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function logInviteFailure(stage: string, reason: InviteErrorReason = "failed"): void {
	// eslint-disable-next-line no-console -- closed tokens only, never a code, key or hash.
	console.info(`[voter-invite] ${stage}: ${reason}`);
}

export function VoterInviteCard({ networkRef, onClose }: VoterInviteCardProps) {
	const { t } = useTranslation();
	const theme = useTheme() as ExtendedTheme;
	const { colors } = theme;
	const { networksEngine } = useApp();
	const { node, configFault } = useCadreNode();
	const [state, setState] = useState<CardState>({ kind: "checking" });
	const [copyNotice, setCopyNotice] = useState<"copied" | "failed" | undefined>(undefined);
	const [qrOpen, setQrOpen] = useState(false);
	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);
	const openButtonRef = useRef<HostInstance>(null);
	const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Re-renders on a density change, so the thumbnail is rebuilt at the new pixel ratio.
	const { scale } = useWindowDimensions();
	const readyCode = state.kind === "ready" ? state.result.code : null;
	const thumb = useMemo(
		() => (readyCode === null ? null : tryBuildQrPanel(readyCode, 160 * PixelRatio.get())),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[readyCode, scale],
	);

	useEffect(() => {
		if (thumb && !thumb.ok) logInviteFailure("qr");
	}, [thumb]);

	useEffect(
		() => () => {
			mountedRef.current = false;
			if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
			void deleteSharedQrImage();
		},
		[],
	);

	const closeQr = useCallback(() => {
		setQrOpen(false);
		if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
		focusTimerRef.current = setTimeout(() => {
			focusTimerRef.current = null;
			if (mountedRef.current && openButtonRef.current) {
				AccessibilityInfo.sendAccessibilityEvent(openButtonRef.current, "focus");
			}
		}, QR_FOCUS_RETURN_DELAY_MS);
	}, []);

	const generate = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setState({ kind: "generating" });
		try {
			const user = await getDeviceUser();
			const signerKey = user?.activeKeys[0]?.key;
			if (!user || !signerKey || !networksEngine || !node) throw new Error("voter-invite: not ready");
			// storeAsRecent=false: inviting never reorders recent networks.
			await withTimeout(networksEngine.open(networkRef, user, false), INVITE_OPEN_TIMEOUT_MS);
			if (!mountedRef.current) return;
			const result = await createVoterJoinCode({
				node: node as unknown as VoterInviteNode,
				networksEngine,
				networkHash: networkRef.hash,
				founder: { userId: user.id, signerKey },
			});
			if (mountedRef.current) setState({ kind: "ready", result });
		} catch (err) {
			const reason = inviteFailureReason(err, configFault);
			logInviteFailure("generate", reason);
			if (mountedRef.current) setState({ kind: "error", reason });
		} finally {
			inFlightRef.current = false;
		}
	}, [networkRef, networksEngine, node, configFault]);

	// Decide what the card can do on this phone, then generate straight away when nothing needs
	// confirming.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const capability = await voterInviteCapability(node as unknown as VoterInviteNode | null);
			if (cancelled || !mountedRef.current) return;
			if (capability === "ready") void generate();
			else if (capability === "needs-owner-setup") setState({ kind: "confirm-owner" });
			else if (capability === "not-owner") setState({ kind: "not-owner" });
			else {
				logInviteFailure("capability");
				setState({ kind: "error", reason: "failed" });
			}
		})();
		return () => {
			cancelled = true;
		};
		// Re-check only when the node changes; `generate` is stable for a given network/node.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [node]);

	const copyCode = useCallback(async (code: string) => {
		const ok = await copyToClipboard(code);
		if (mountedRef.current) setCopyNotice(ok ? "copied" : "failed");
	}, []);

	const shareCode = useCallback(
		async (result: VoterJoinCodeResult) => {
			try {
				await Share.share({
					message: t("voterInviteShareMessage", { name: result.networkName, fingerprint: result.fingerprint, code: result.code }),
				});
			} catch {
				logInviteFailure("share");
			}
		},
		[t],
	);

	switch (state.kind) {
		case "checking":
		case "generating":
			return (
				<View testID="voter-invite-body-generating">
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("voterInviteGenerating")}
					</ThemedText>
				</View>
			);
		case "confirm-owner":
			return (
				<View testID="voter-invite-body-confirm-owner" style={{ gap: 8 }}>
					<ThemedText type="defaultSemiBold">{t("voterInviteOwnerTitle")}</ThemedText>
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("voterInviteOwnerBody")}
					</ThemedText>
					<CustomButton testID="voter-invite-owner-confirm" title={t("voterInviteOwnerConfirm")} onPress={generate} />
					<CustomButton testID="voter-invite-cancel" title={t("voterInviteCancel")} onPress={onClose} />
				</View>
			);
		case "not-owner":
			return (
				<View testID="voter-invite-body-not-owner" style={{ gap: 8 }}>
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("voterInviteNotOwner")}
					</ThemedText>
					<CustomButton testID="voter-invite-done" title={t("voterInviteDone")} onPress={onClose} />
				</View>
			);
		case "error":
			return (
				<View testID="voter-invite-body-error" style={{ gap: 8 }}>
					<ThemedText type="default" style={{ color: colors.error }}>
						{t(inviteFailureKey(state.reason))}
					</ThemedText>
					<CustomButton testID="voter-invite-retry" title={t("voterInviteRetry")} onPress={generate} />
					<CustomButton testID="voter-invite-cancel" title={t("voterInviteCancel")} onPress={onClose} />
				</View>
			);
		case "ready": {
			const { result } = state;
			const expiry = inviteExpiryMs(result.expiresAt);
			const ratio = PixelRatio.get();
			return (
				<View testID="voter-invite-body-ready" style={{ gap: 8 }}>
					<ThemedText type="default" testID="voter-invite-ready-body" style={{ color: colors.textSecondary }}>
						{t("voterInviteReadyBody")}
					</ThemedText>
					{thumb?.ok ? (
						<>
							<Pressable
								testID="voter-invite-qr"
								accessibilityRole="button"
								accessibilityLabel={t("voterInviteQrThumbA11y")}
								onPress={() => setQrOpen(true)}
								style={{ alignSelf: "center" }}
							>
								<View style={{ borderWidth: 1 / ratio, borderColor: theme.dark ? colors.accent : colors.border }}>
									<Image
										testID="voter-invite-qr-image"
										source={{ uri: "data:image/png;base64," + thumb.panel.base64 }}
										style={{ width: thumb.panel.panelPx / ratio, height: thumb.panel.panelPx / ratio }}
										resizeMode="stretch"
										fadeDuration={0}
										accessible={false}
										onError={() => logInviteFailure("qr")}
									/>
								</View>
							</Pressable>
							<ThemedText type="small" style={{ color: colors.text, textAlign: "center" }}>
								{t("voterInviteQrHint")}
							</ThemedText>
						</>
					) : (
						<ThemedText type="small" testID="voter-invite-qr-render-failed" style={{ color: colors.error }}>
							{t("voterInviteQrRenderFailed")}
						</ThemedText>
					)}
					<ThemedText type="defaultSemiBold">{t("networkFoundingExportFingerprintLabel")}</ThemedText>
					<ThemedText type="default" testID="voter-invite-fingerprint" selectable>
						{result.fingerprint}
					</ThemedText>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("voterInviteFingerprintHelp")}
					</ThemedText>
					{expiry !== null && (
						<ThemedText type="small" testID="voter-invite-expiry" style={{ color: colors.textSecondary }}>
							{t("voterInviteExpires", { when: new Date(expiry).toLocaleDateString() })}
						</ThemedText>
					)}
					{thumb?.ok && (
						<CustomButton
							ref={openButtonRef}
							testID="voter-invite-qr-open"
							icon="qrcode"
							backgroundColor={colors.primary}
							title={t("voterInviteQrOpen")}
							onPress={() => setQrOpen(true)}
						/>
					)}
					<CustomButton testID="voter-invite-copy" title={t("voterInviteCopy")} onPress={() => void copyCode(result.code)} />
					<CustomButton testID="voter-invite-share" title={t("voterInviteShare")} onPress={() => void shareCode(result)} />
					{copyNotice !== undefined && (
						<ThemedText
							type="small"
							testID="voter-invite-copy-notice"
							style={{ color: copyNotice === "copied" ? colors.textSecondary : colors.error }}
						>
							{copyNotice === "copied" ? t("voterInviteCopied") : t("voterInviteCopyFailed")}
						</ThemedText>
					)}
					<CustomButton testID="voter-invite-done" title={t("voterInviteDone")} onPress={onClose} />
					{qrOpen ? <VoterInviteQrView code={result.code} fingerprint={result.fingerprint} onClose={closeQr} /> : null}
				</View>
			);
		}
	}
}
