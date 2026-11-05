/**
 * JoinNetworkScreen.tsx - the Authority's "Join a network" paste screen (D-26).
 *
 * D-26: a paste screen. The officer pastes (or types) the join code the election office gave them,
 * sees the network's name and fingerprint, compares the fingerprint with the one the office
 * published, and taps Join. There is no camera. A paste or a typed text only decodes; only the Join
 * tap starts a join.
 *
 * UI-SPEC A1: a root-stack route with no params. The code lives only in this screen's state; it is
 * never passed to `navigate`, `setParams` or `setOptions`, and navigation state is not persisted.
 *
 * D-09: the needs-reinvite notice's action lands here. A join runs the glue (`runAuthorityNetworkJoin`),
 * then `completeAuthorityJoin` with the context's `refreshOwnerTrust`, so the joined state follows the
 * owner-trust refresh; when the refresh could not save trust the screen says so.
 *
 * D-30 (the joining window that keeps a half-joined hash from opening as a founder) is handled inside
 * the glue.
 *
 * D-06: the code is a bearer credential. The only console calls are three closed tokens whose second
 * argument is a typed reason, a literal or `errorClassName(<caught>)`. A result's `detail` and an
 * engine error's text are never read, shown or logged; every sentence is chosen by the typed reason.
 *
 * OQ1, copy branch B: the user approved a guard that refuses a founder joining a foreign network, so
 * the glue can resolve `founder-cannot-join`, and this screen maps it to its own sentence.
 *
 * A signing-key gap (`NO_KEY_PROVISIONED` from the select step) is routed to the provisioning ceremony
 * exactly as `ImportFoundingBundleScreen` does: the completion is retried once when this screen is
 * focused again, and a failed retry is not routed again (no ceremony loop).
 *
 * `done` reuses the Verifying label because no copy exists for it: completion runs under the last
 * label.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import Clipboard from "@react-native-clipboard/clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import type { NetworkJoinCodeDecodeFailure, NetworkJoinFailureReason, NetworkJoinStep } from "@votetorrent/vote-engine/rn";
import type { NetworkReference } from "@votetorrent/vote-core";
import type { AuthorityJoinNode } from "../../engines/authority-network-join";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { useApp } from "../../providers/AppProvider";
import { useCadreNode } from "../../providers/CadreNodeProvider";
import { getDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { mapDeviceSigningError } from "../../utils/deviceSigningError";
import { errorClassName } from "../../utils/errorClassName";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";

/** The translated sentence for each way a join can fail, chosen by the typed reason only. */
export function joinNetworkFailureKey(reason: NetworkJoinFailureReason | "founder-cannot-join"): string {
	switch (reason) {
		case "invitation-malformed":
			return "joinNetworkErrorInvalidCode";
		case "invitation-expired":
			return "joinNetworkErrorExpired";
		case "invitation-used-up":
			return "joinNetworkErrorUsedUp";
		case "invitation-older-version":
			return "joinNetworkErrorOlderCode";
		case "not-admitted":
			return "joinNetworkErrorNotAdmitted";
		case "no-peers":
			return "joinNetworkErrorNoPeers";
		case "not-synced":
			return "joinNetworkErrorNotSynced";
		case "digest-mismatch":
			return "joinNetworkErrorDigestMismatch";
		case "open-failed":
			return "joinNetworkErrorOpenFailed";
		case "founder-cannot-join":
			return "joinNetworkErrorFounderCannotJoin";
		default:
			return "joinNetworkErrorGeneric";
	}
}

/** The translated sentence for each reason a pasted text does not decode. */
export function joinNetworkDecodeErrorKey(reason: NetworkJoinCodeDecodeFailure): string {
	switch (reason) {
		case "unsupported-version":
			return "joinNetworkErrorNewerCode";
		case "invitation-older-version":
			return "joinNetworkErrorOlderCode";
		case "not-join-code":
			return "joinNetworkErrorNotJoinCode";
		default:
			return "joinNetworkErrorInvalidCode";
	}
}

/** The progress label for each join step; `done` has no copy of its own. */
export function joinNetworkStepKey(step: NetworkJoinStep): string {
	switch (step) {
		case "admitting":
			return "joinNetworkStepAdmitting";
		case "syncing":
			return "joinNetworkStepSyncing";
		default:
			return "joinNetworkStepVerifying";
	}
}

type Phase =
	| { kind: "idle" }
	| { kind: "joining"; step: NetworkJoinStep }
	| { kind: "joined"; name: string; trustSaved: boolean }
	| { kind: "failed"; key: string; message?: string };

const resolvedNoop = (): Promise<void> => Promise.resolve();

/**
 * The glue statically imports `@serfab/cadre-core`, which the RN jest suites that load the whole
 * navigation tree cannot load. A RELATIVE lazy require is unaffected by Metro's import-only exports
 * trap. This file must never lazily require `@serfab/cadre-core` itself.
 */
function loadJoinGlue(): typeof import("../../engines/authority-network-join") {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require("../../engines/authority-network-join") as typeof import("../../engines/authority-network-join");
}

export default function JoinNetworkScreen(): React.JSX.Element {
	const { colors, dark } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const insets = useSafeAreaInsets();
	const keyboardInset = useKeyboardInset();
	const { networksEngine, selectNetwork } = useApp();
	const cadre = useCadreNode();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [text, setText] = useState("");
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });

	const mountedRef = useRef(true);
	const inFlightRef = useRef(false);
	const retryOnFocusRef = useRef<{ node: AuthorityJoinNode; networkRef: NetworkReference } | null>(null);
	// Latest-value refs: the focus effect below runs with no dependencies and must not retry behind
	// the officer's back when an identity changes.
	const selectNetworkRef = useRef(selectNetwork);
	selectNetworkRef.current = selectNetwork;
	const refreshRef = useRef(cadre.refreshOwnerTrust);
	refreshRef.current = cadre.refreshOwnerTrust;
	const handleSigningRef = useRef(handleDeviceSigningError);
	handleSigningRef.current = handleDeviceSigningError;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const decoded = useMemo(() => (text.trim().length === 0 ? null : decodeNetworkJoinCode(text)), [text]);

	async function finishJoin(joinNode: AuthorityJoinNode, networkRef: NetworkReference, mayRoute: boolean): Promise<void> {
		const { completeAuthorityJoin } = loadJoinGlue();
		const refreshOwnerTrust = typeof refreshRef.current === "function" ? refreshRef.current : resolvedNoop;
		try {
			const { trustSaved } = await completeAuthorityJoin({
				node: joinNode,
				networkRef,
				selectNetwork: selectNetworkRef.current,
				refreshOwnerTrust,
			});
			if (mountedRef.current) setPhase({ kind: "joined", name: networkRef.name, trustSaved });
		} catch (error) {
			console.error("JoinNetworkScreen: select failed:", errorClassName(error));
			if (!mountedRef.current) return;
			let message: string | undefined;
			if (mayRoute) {
				const outcome = handleSigningRef.current(error);
				if (outcome.handled && mapDeviceSigningError(error) !== "cancellation") {
					// The hook has navigated to the ceremony; its CONTINUE pops back here.
					retryOnFocusRef.current = { node: joinNode, networkRef };
				}
				message = outcome.message;
			}
			setPhase({ kind: "failed", key: "joinNetworkErrorGeneric", message });
		}
	}
	const finishJoinRef = useRef(finishJoin);
	finishJoinRef.current = finishJoin;

	// Back from the routed ceremony, retry the completion ONCE. A failure is not routed again.
	useFocusEffect(
		useCallback(() => {
			const pending = retryOnFocusRef.current;
			retryOnFocusRef.current = null;
			if (!pending || inFlightRef.current) return;
			inFlightRef.current = true;
			setPhase({ kind: "joining", step: "verifying" });
			finishJoinRef
				.current(pending.node, pending.networkRef, false)
				.catch(() => undefined)
				.finally(() => {
					inFlightRef.current = false;
				});
		}, []),
	);

	function onChangeText(value: string): void {
		setText(value);
		setPhase((p) => (p.kind === "failed" ? { kind: "idle" } : p));
		retryOnFocusRef.current = null;
	}

	function onPaste(): void {
		Clipboard.getString()
			.catch(() => "")
			.then((value) => {
				if (!value || !mountedRef.current) return;
				setText(value);
				setPhase({ kind: "idle" });
				retryOnFocusRef.current = null;
			});
	}

	async function onJoin(): Promise<void> {
		if (!decoded || !decoded.ok || inFlightRef.current) return;
		const code = decoded.code;
		inFlightRef.current = true;
		retryOnFocusRef.current = null;
		setPhase({ kind: "joining", step: "admitting" });
		const show = (key: string): void => {
			if (mountedRef.current) setPhase({ kind: "failed", key });
		};
		try {
			const node = cadre.node;
			if (!node) {
				console.warn("JoinNetworkScreen: join refused:", "no-peers");
				show(joinNetworkFailureKey("no-peers"));
				return;
			}
			if (!networksEngine) {
				console.error("JoinNetworkScreen: join failed:", "no-engine");
				show("joinNetworkErrorGeneric");
				return;
			}
			let result;
			let joinNode: AuthorityJoinNode;
			try {
				const user = await getDeviceUser();
				const glue = loadJoinGlue();
				joinNode = node as unknown as AuthorityJoinNode;
				result = await glue.runAuthorityNetworkJoin({
					node: joinNode,
					networksEngine,
					user,
					code,
					onStep: (step) => {
						if (mountedRef.current) setPhase({ kind: "joining", step });
					},
				});
			} catch (error) {
				console.error("JoinNetworkScreen: join failed:", errorClassName(error));
				show("joinNetworkErrorGeneric");
				return;
			}
			if (!result.ok) {
				console.warn("JoinNetworkScreen: join refused:", result.reason);
				show(joinNetworkFailureKey(result.reason));
				return;
			}
			await finishJoin(joinNode, result.networkRef, true);
		} finally {
			inFlightRef.current = false;
		}
	}

	const busy = phase.kind === "joining";
	const decodeError = decoded !== null && !decoded.ok ? decoded : null;

	return (
		<ScrollView
			testID="join-network-screen"
			style={globalStyles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 16 + keyboardInset, gap: 16 }}
			keyboardShouldPersistTaps="handled"
		>
			{phase.kind === "joined" ? (
				<View style={styles.stack}>
					<ThemedText type="defaultSemiBold" accessibilityRole="header" testID="join-network-joined">
						{t("joinNetworkJoinedTitle", { name: phase.name })}
					</ThemedText>
					{!phase.trustSaved ? (
						<ThemedText type="small" accessibilityRole="alert" testID="join-network-trust-warning" style={{ color: colors.error }}>
							{t("joinNetworkTrustNotSaved")}
						</ThemedText>
					) : null}
					<CustomButton testID="join-network-done" title={t("joinNetworkDone")} onPress={() => navigation.goBack()} />
				</View>
			) : (
				<>
					<ThemedText testID="join-network-intro" style={{ color: colors.text }}>
						{t("joinNetworkIntro")}
					</ThemedText>
					<View
						testID="join-network-card"
						style={[
							styles.card,
							{ backgroundColor: colors.card, borderColor: dark ? colors.accent : colors.border },
						]}
					>
						<View style={styles.labelRow}>
							<ThemedText type="defaultSemiBold">{t("joinNetworkCodeLabel")}</ThemedText>
							<Pressable
								testID="join-network-paste"
								accessibilityRole="button"
								accessibilityLabel={t("joinNetworkPaste")}
								disabled={busy}
								onPress={onPaste}
								style={styles.paste}
							>
								<Text style={{ color: colors.primary, fontSize: 16, fontWeight: "400" }}>{t("joinNetworkPaste")}</Text>
							</Pressable>
						</View>
						<TextInput
							testID="join-network-code-input"
							value={text}
							onChangeText={onChangeText}
							multiline
							editable={!busy}
							autoCapitalize="none"
							autoCorrect={false}
							accessibilityLabel={t("joinNetworkCodeLabel")}
							placeholder={t("joinNetworkCodePlaceholder")}
							placeholderTextColor={dark ? colors.text : colors.textSecondary}
							style={[styles.input, { color: colors.text, borderColor: decodeError ? colors.error : colors.primary }]}
						/>
						{decodeError ? (
							<ThemedText type="small" testID="join-network-code-error" style={{ color: colors.error }}>
								{t(joinNetworkDecodeErrorKey(decodeError.reason))}
							</ThemedText>
						) : null}
						{decoded && decoded.ok ? (
							<View testID="join-network-preview" style={styles.stack}>
								<ThemedText type="small" style={{ color: colors.textSecondary }}>
									{t("network")}
								</ThemedText>
								<ThemedText type="defaultSemiBold" testID="join-network-preview-name">
									{decoded.code.name}
								</ThemedText>
								<ThemedText type="small" style={{ color: colors.textSecondary }}>
									{t("networkFoundingExportFingerprintLabel")}
								</ThemedText>
								<Text
									testID="join-network-preview-fingerprint"
									selectable
									maxFontSizeMultiplier={1.5}
									style={{ fontFamily: "monospace", fontSize: 16, fontWeight: "600", color: colors.text }}
								>
									{decoded.fingerprint}
								</Text>
								<ThemedText type="small" style={{ color: colors.text }}>
									{t("joinNetworkPreviewCheck")}
								</ThemedText>
							</View>
						) : null}
						{phase.kind === "failed" ? (
							<ThemedText testID="join-network-error" accessibilityRole="alert" style={{ color: colors.error }}>
								{phase.message ?? t(phase.key)}
							</ThemedText>
						) : null}
						{phase.kind === "joining" ? (
							<View testID="join-network-progress" style={styles.progress}>
								<ActivityIndicator color={colors.primary} />
								<ThemedText testID="join-network-step" style={{ color: colors.text, flexShrink: 1 }}>
									{t(joinNetworkStepKey(phase.step))}
								</ThemedText>
							</View>
						) : (
							<CustomButton
								testID="join-network-submit"
								size="tall"
								title={t("joinNetworkSubmit")}
								backgroundColor={colors.primary}
								disabled={!decoded?.ok}
								onPress={onJoin}
							/>
						)}
					</View>
				</>
			)}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	stack: {
		gap: 8,
	},
	card: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 16,
		gap: 8,
	},
	labelRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	paste: {
		minHeight: 44,
		minWidth: 44,
		justifyContent: "center",
		alignItems: "flex-end",
	},
	input: {
		borderWidth: 1,
		borderRadius: 8,
		padding: 12,
		minHeight: 96,
		textAlignVertical: "top",
		fontSize: 14,
	},
	progress: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
});
