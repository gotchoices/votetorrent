/**
 * FoundingBundleExportCard.tsx — Surface 2 export card (D-35, D-36, D-37 — Authority only).
 *
 * A founding officer on the network's founding device shares the network's signed founding
 * bundle as a FILE (62-75 `writeShareFile`, then the Android file share or the iOS url share, or
 * a local save through the document picker), so a second Authority device can import it
 * (`ImportFoundingBundleScreen.tsx`) and become the same network. The export digest is signed by
 * the device's own hardware-backed key (`createDeviceSigner` — D-01: the private key NEVER
 * enters JS, signing happens inside the Android Keystore behind the biometric prompt). This file
 * never parses, edits or writes bundle rows — `INetworksEngine.exportFoundingBundle` (62-16)
 * does all of that; this card only collects the signer and the text the engine returns.
 */

import { ExtendedTheme, useTheme } from "@react-navigation/native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Share, View } from "react-native";
import { FileShareError, shareFileAndroid, writeShareFile } from "@votetorrent/attestation-native";
import { ThemedText } from "../../../components/ThemedText";
import { CustomButton } from "../../../components/CustomButton";
import { LifecycleConfirmCard } from "../../registration/components/LifecycleConfirmCard";
import { useApp } from "../../../providers/AppProvider";
import { createDeviceSigner } from "../../../engines/device-signer";
import { getDeviceUser } from "../../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../../hooks/useDeviceSigningErrorHandler";
import type { FoundingExportState } from "../foundingBundleState";
import type { NetworkReference } from "@votetorrent/vote-core";

export interface FoundingBundleExportCardProps {
	networkRef: NetworkReference;
	onClose: () => void;
}

// Mirrors AddNetworkScreen.tsx's CREATE_TIMEOUT_MS: `open()` can stall indefinitely on a
// non-active network's first-sync wait. There is NO timeout around the subsequent
// `exportFoundingBundle` call — that call is where the biometric prompt fires, and a device
// waiting on a human should never be raced against a clock.
const EXPORT_OPEN_TIMEOUT_MS = 45000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("founding-bundle: open() timed out"));
		}, ms);
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

const BUNDLE_MIME_TYPE = "application/json";

function isUserCancel(err: unknown): boolean {
	// Lazy require: the picker package's module scope touches a TurboModule that is absent under jest
	// (same reasoning as engines/pick-founding-bundle-file.ts).
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const picker = require("@react-native-documents/picker") as typeof import("@react-native-documents/picker");
	return picker.isErrorWithCode(err) && err.code === picker.errorCodes.OPERATION_CANCELED;
}

/**
 * `isUserCancel` for a catch block: if the picker module itself cannot load (the very failure that
 * may have landed us in the catch), the check must not throw again out of the catch (IN-07). A
 * failed check is "not a cancel", so the caller reports the error.
 */
function isUserCancelSafe(err: unknown): boolean {
	try {
		return isUserCancel(err);
	} catch {
		return false;
	}
}

function logExportFailure(err: unknown): void {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	const token = typeof code === "string" ? code : "failed";
	// eslint-disable-next-line no-console -- closed token only, never a hash/key/file name/text (T-62-23-04).
	console.info(`[founding-bundle] export: ${token}`);
}

export function FoundingBundleExportCard({ networkRef, onClose }: FoundingBundleExportCardProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { networksEngine } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [state, setState] = useState<FoundingExportState>("confirming");
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
	const [fileName, setFileName] = useState<string | undefined>(undefined);
	const [usedTextFallback, setUsedTextFallback] = useState(false);
	const [savedNotice, setSavedNotice] = useState(false);
	// The network fingerprint the exporter reads out to the importing officer (D-36).
	const [fingerprint, setFingerprint] = useState<string | undefined>(undefined);
	// A share or save failure AFTER the file was written: the card stays ready and the same file is retried.
	const [fileActionError, setFileActionError] = useState<"share" | "save" | undefined>(undefined);
	const fileRef = useRef<{ uri: string; fileName: string } | undefined>(undefined);
	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);

	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);

	const runExport = useCallback(async () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		if (mountedRef.current) {
			setErrorMessage(undefined);
			setFileActionError(undefined);
			setState("generating");
		}
		try {
			const sign = await createDeviceSigner("Device User");
			const user = await getDeviceUser();
			if (!user) {
				const err = new Error("founding-bundle export: no device signing key provisioned") as Error & {
					code: string;
				};
				err.code = "NO_KEY_PROVISIONED";
				throw err;
			}
			const signerKey = user.activeKeys[0]?.key;
			if (!signerKey) {
				const err = new Error("founding-bundle export: device user has no active key") as Error & {
					code: string;
				};
				err.code = "NO_KEY_PROVISIONED";
				throw err;
			}
			if (!networksEngine) {
				throw new Error("founding-bundle export: no networks engine");
			}

			// storeAsRecent=false: export never reorders recent networks. A cache-first open is a
			// no-op for the already-active network; the timeout guards a first-sync wait on a
			// non-active one.
			await withTimeout(networksEngine.open(networkRef, user, false), EXPORT_OPEN_TIMEOUT_MS);
			// A card that unmounted while its network was opening must not prompt, export or share.
			if (!mountedRef.current) return;

			const exported = await networksEngine.exportFoundingBundle(networkRef.hash, {
				userId: user.id,
				signerKey,
				sign,
			});

			if (!mountedRef.current) return;
			setFingerprint(exported.fingerprint);
			setState("sharing");
			let uri: string;
			try {
				uri = await writeShareFile(exported.fileName, exported.text);
			} catch (writeErr) {
				if (writeErr instanceof FileShareError && writeErr.code === "unavailable") {
					// An older binary without the native file seam: share the text, with a visible notice.
					if (!mountedRef.current) return;
					await Share.share(
						{ message: exported.text, title: exported.fileName },
						{ subject: exported.fileName, dialogTitle: t("networkFoundingExportShareButton") },
					);
					if (mountedRef.current) {
						setUsedTextFallback(true);
						setState("ready");
					}
					return;
				}
				throw writeErr;
			}
			fileRef.current = { uri, fileName: exported.fileName };
			if (mountedRef.current) {
				setFileName(exported.fileName);
				setUsedTextFallback(false);
				setSavedNotice(false);
				setState("ready");
			}
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) {
				if (mountedRef.current) onClose();
				return;
			}
			logExportFailure(err);
			if (mountedRef.current) {
				setErrorMessage(outcome.message);
				setState("error");
			}
		} finally {
			inFlightRef.current = false;
		}
	}, [networkRef, networksEngine, onClose, handleDeviceSigningError, t]);

	const shareFile = useCallback(async () => {
		const file = fileRef.current;
		if (!file) return;
		setSavedNotice(false);
		setFileActionError(undefined);
		try {
			if (Platform.OS === "android") {
				await shareFileAndroid(file.uri, {
					mimeType: BUNDLE_MIME_TYPE,
					subject: file.fileName,
					dialogTitle: t("networkFoundingExportShareButton"),
				});
			} else {
				await Share.share({ url: file.uri, title: file.fileName });
			}
		} catch (err) {
			// RN's Share.share resolves on dismissal ({ action: "dismissedAction" }) and never rejects
			// for it, and the Android file share resolves once the chooser launches, so every
			// rejection here is a real failure (a FileShareError or not) and must reach the error
			// inline failure (WR-05). The written file is kept: the card stays ready and a retry
			// shares the same file without a new signature (IN-09).
			logExportFailure(err);
			if (mountedRef.current) setFileActionError("share");
		}
	}, [t]);

	const saveFile = useCallback(async () => {
		const file = fileRef.current;
		if (!file) return;
		setFileActionError(undefined);
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const picker = require("@react-native-documents/picker") as typeof import("@react-native-documents/picker");
			const results = await picker.saveDocuments({
				sourceUris: [file.uri],
				fileName: file.fileName,
				mimeType: BUNDLE_MIME_TYPE,
			});
			if (!mountedRef.current) return;
			if (results[0]?.error) {
				logExportFailure(undefined);
				setSavedNotice(false);
				setFileActionError("save");
				return;
			}
			setSavedNotice(true);
		} catch (err) {
			if (isUserCancelSafe(err)) return;
			logExportFailure(err);
			if (mountedRef.current) setFileActionError("save");
		}
	}, []);

	switch (state) {
		case "ready":
			return (
				<View testID="founding-export-body-ready" style={{ gap: 8 }}>
					{usedTextFallback ? (
						<ThemedText type="default" style={{ color: colors.textSecondary }}>
							{t("networkFoundingExportTextFallback")}
						</ThemedText>
					) : (
						<>
							<ThemedText type="default" style={{ color: colors.textSecondary }}>
								{t("networkFoundingExportReadyBody")}
							</ThemedText>
							{fileName !== undefined && (
								<ThemedText type="small" style={{ color: colors.textSecondary }}>
									{fileName}
								</ThemedText>
							)}
							<CustomButton
								testID="founding-export-share-file"
								title={t("networkFoundingExportShareButton")}
								onPress={shareFile}
							/>
							{Platform.OS === "android" && (
								<CustomButton
									testID="founding-export-save-file"
									title={t("networkFoundingExportSaveButton")}
									onPress={saveFile}
								/>
							)}
							{fileActionError !== undefined && (
								<ThemedText type="small" testID="founding-export-file-error" style={{ color: colors.error }}>
									{fileActionError === "share"
										? t("networkFoundingExportShareFailed")
										: t("networkFoundingExportSaveFailed")}
								</ThemedText>
							)}
							{savedNotice && (
								<ThemedText type="small" testID="founding-export-saved" style={{ color: colors.textSecondary }}>
									{t("networkFoundingExportSaved")}
								</ThemedText>
							)}
						</>
					)}
					{fingerprint !== undefined && (
						<>
							<ThemedText type="defaultSemiBold">{t("networkFoundingExportFingerprintLabel")}</ThemedText>
							<ThemedText type="default" testID="founding-export-fingerprint" selectable>
								{fingerprint}
							</ThemedText>
							<ThemedText type="small" style={{ color: colors.textSecondary }}>
								{t("networkFoundingExportFingerprintHelp")}
							</ThemedText>
						</>
					)}
					<CustomButton
						testID="founding-export-done"
						title={t("networkFoundingExportDoneButton")}
						onPress={onClose}
					/>
				</View>
			);
		case "generating":
			return (
				<View testID="founding-export-body-generating">
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("networkFoundingExportGenerating")}
					</ThemedText>
				</View>
			);
		case "sharing":
			return (
				<View testID="founding-export-body-sharing">
					<ThemedText type="default" style={{ color: colors.textSecondary }}>
						{t("networkFoundingExportGenerating")}
					</ThemedText>
				</View>
			);
		case "error":
			return (
				<View testID="founding-export-body-error">
					<ThemedText type="default" style={{ color: colors.error }}>
						{t("networkFoundingExportError")}
					</ThemedText>
					{errorMessage !== undefined && (
						<ThemedText type="small" style={{ color: colors.error }}>
							{errorMessage}
						</ThemedText>
					)}
					<CustomButton title={t("networkFoundingExportShareButton")} onPress={runExport} />
					<CustomButton title={t("networkFoundingExportCancelButton")} onPress={onClose} />
				</View>
			);
		case "confirming":
		default:
			return (
				<LifecycleConfirmCard
					variant="ordinary"
					tone="neutral"
					testIDPrefix="founding-export"
					title={t("networkFoundingExportConfirmHeading")}
					body={t("networkFoundingExportConfirmBody")}
					confirmLabel={t("networkFoundingExportShareButton")}
					dismissLabel={t("networkFoundingExportCancelButton")}
					onConfirm={runExport}
					onDismiss={onClose}
				/>
			);
	}
}
