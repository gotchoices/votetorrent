/**
 * PairedBrowsersScreen — the browsers THIS phone paired for THIS phone's officer on the active
 * network (D-08). Each card shows the browser's name, when it was paired, when its machine last
 * published its self record, and a state word: waiting to pair, paired, removal pending, removed.
 * A paired browser stays paired until it is removed here or by an owner on the network (D-07).
 *
 * Names and pairing times live on this phone only (D-25); "last seen" is the browser machine's own
 * self-record stamp, which a running browser re-publishes about every 8 minutes.
 *
 * REMOVE = ONE INLINE CONFIRM + ONE BIOMETRIC PROMPT. Confirming calls the paired-browsers engine
 * once with the device signer; the ENGINE builds the revocation digest and inserts the
 * officer-signed revocation row (this screen never builds signed bytes and sends nothing over the
 * wire). The row itself stores only the officer and the pairing id: every peer checks the officer's
 * signature when it applies the row, but the signature is not kept in it. The minting owner's
 * phone watches those rows and finishes the network removal when it is next online with the app
 * open, so a removed browser reads "Removal pending" until then and "Removed" after; there is no
 * retry control because nothing on this phone needs retrying (a re-read is enough).
 *
 * Removing a browser takes away its way into the network; it cannot take back data the browser
 * already received, and nothing on this screen says otherwise.
 *
 * The confirm is bound to ONE pairing: opening another card's confirm, or a re-read in which the
 * selected pairing is gone or no longer removable, discards the open confirm and any error, so
 * nobody removes a browser under a confirm they did not review.
 *
 * The biometric prompt shows the generic device-signing title: the device signer takes no
 * per-action title.
 *
 * Hygiene: no pairing id, invitation key, peer id or user id is ever rendered, put in a testID or
 * accessibility prop, or logged. Logs carry a fixed tag and at most an error class name.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { LifecycleConfirmCard } from "../registration/components/LifecycleConfirmCard";
import { useCadreNode } from "../../providers/CadreNodeProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { getDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { loadPairingCapabilityState } from "../../engines/dashboard-pairing";
import { readActiveNetworkHash } from "../../engines/pair-mint-host";
import {
	listPairedBrowsers,
	removePairedBrowser,
	type PairedBrowserRow,
	type PairedBrowsersNode,
	type PairedBrowserState,
} from "../../engines/paired-browsers";
import { errorClassName } from "../../utils/errorClassName";
import type { NavigationProp } from "../../navigation/types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The coarse last-seen bucket for a machine stamp (pure). Under 15 min reads "a few minutes ago",
 * then whole minutes, whole hours up to 47, then whole days (always 2 or more). A stamp in the
 * future (clock skew) reads "a few minutes ago"; no stamp yet reads "Not seen yet".
 */
export function lastSeenCopy(lastSeenAt: number | null, nowMs: number): { key: string; n?: number } {
	if (lastSeenAt === null || !Number.isFinite(lastSeenAt)) return { key: "pairedBrowsersNotSeenYet" };
	const age = Math.max(0, nowMs - lastSeenAt);
	if (age < 15 * MINUTE_MS) return { key: "pairedBrowsersLastSeenFewMinutes" };
	if (age < HOUR_MS) return { key: "pairedBrowsersLastSeenMinutes", n: Math.floor(age / MINUTE_MS) };
	if (age < 48 * HOUR_MS) return { key: "pairedBrowsersLastSeenHours", n: Math.floor(age / HOUR_MS) };
	return { key: "pairedBrowsersLastSeenDays", n: Math.floor(age / DAY_MS) };
}

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

/** Local `YYYY-MM-DD` (plain Date getters, so the text never depends on the engine's Intl data). */
export function formatPairedDate(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local `YYYY-MM-DD HH:MM`. */
export function formatPairedDateTime(ms: number): string {
	const d = new Date(ms);
	return `${formatPairedDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The copy key for a failed Remove (pure). Signer errors are routed through the signing hook first. */
export function removeFailureKey(err: unknown): "pairedBrowsersRemoveKeyNotCurrent" | "pairedBrowsersRemoveFailed" {
	const e = err as { name?: unknown; reason?: unknown } | null;
	if (e && typeof e === "object" && e.name === "PairedBrowserRemoveError" && e.reason === "key-not-current") {
		return "pairedBrowsersRemoveKeyNotCurrent";
	}
	return "pairedBrowsersRemoveFailed";
}

const STATE_KEY: Readonly<Record<PairedBrowserState, string>> = Object.freeze({
	waiting: "pairedBrowsersStateWaiting",
	paired: "pairedBrowsersStatePaired",
	"removal-pending": "pairedBrowsersStateRemovalPending",
	removed: "pairedBrowsersStateRemoved",
});

function isRemovable(state: PairedBrowserState): boolean {
	return state === "waiting" || state === "paired";
}

/** The slice of the cadre node this screen reads directly. */
interface ScreenNode {
	getStrand?(strandId: string): { database?: { getDatabase?(): unknown } } | undefined;
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

/** The screen lacks the node, network, officer or database it needs; any copy is already on screen. */
class ScreenNotReadyError extends Error {
	constructor() {
		super("paired-browsers: not ready");
		this.name = "ScreenNotReadyError";
	}
}

export default function PairedBrowsersScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const navigation = useNavigation<NavigationProp>();
	const { node } = useCadreNode();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// null = never loaded successfully.
	const [rows, setRows] = useState<PairedBrowserRow[] | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadedAtMs, setLoadedAtMs] = useState(0);
	const [pendingRemoveNonce, setPendingRemoveNonce] = useState<string | undefined>(undefined);
	const [removeErrorText, setRemoveErrorText] = useState("");

	const removingRef = useRef(false);
	const unmountedRef = useRef(false);
	const loadSeqRef = useRef(0);
	// Mirrors the selection so a re-read can apply the reset rule without a stale closure.
	const pendingRemoveRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const selectForRemove = useCallback((nonce: string | undefined) => {
		pendingRemoveRef.current = nonce;
		if (!unmountedRef.current) setPendingRemoveNonce(nonce);
	}, []);

	const loadList = useCallback(async () => {
		const seq = ++loadSeqRef.current;
		let result: PairedBrowserRow[] | null = null;
		let failure: unknown = null;
		try {
			let networkHash: string | null = null;
			try {
				networkHash = await readActiveNetworkHash();
			} catch {
				networkHash = null;
			}
			const user = await getDeviceUser();
			if (!node || !networkHash || !user || typeof user.id !== "string" || user.id.length === 0) {
				throw new ScreenNotReadyError();
			}
			result = await listPairedBrowsers(node as unknown as PairedBrowsersNode, undefined, {
				userId: user.id,
				networkHash,
			});
		} catch (err) {
			failure = err ?? new Error("unknown");
		}
		if (unmountedRef.current || seq !== loadSeqRef.current) return;
		setRefreshing(false);
		if (failure !== null || result === null) {
			console.warn("[paired-browsers] list failed:", errorClassName(failure));
			setLoadFailed(true);
			return;
		}
		const fresh = result;
		setRows(fresh);
		setLoadedAtMs(Date.now());
		setLoadFailed(false);
		const selected = pendingRemoveRef.current;
		if (selected !== undefined && !fresh.some((r) => r.nonce === selected && isRemovable(r.state))) {
			selectForRemove(undefined);
			setRemoveErrorText("");
		}
	}, [node, selectForRemove]);

	useFocusEffect(
		useCallback(() => {
			void loadList();
		}, [loadList])
	);

	const handleRefresh = useCallback(() => {
		setRefreshing(true);
		void loadList();
	}, [loadList]);

	const openPairBrowser = useCallback(() => {
		navigation.navigate("PairBrowser");
	}, [navigation]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<Pressable
					testID="paired-browsers-add"
					onPress={openPairBrowser}
					style={localStyles.headerButton}
					hitSlop={8}
					accessibilityRole="button"
					accessibilityLabel={t("pairedBrowsersPairButton")}
				>
					<FontAwesome6 name="plus" size={18} color={colors.text} />
				</Pressable>
			),
		});
	}, [navigation, openPairBrowser, t, colors.text]);

	// A new selection discards the old confirm and any error (it was about another browser).
	const handleRequestRemove = useCallback(
		(nonce: string) => {
			if (removingRef.current) return;
			selectForRemove(nonce);
			setRemoveErrorText("");
		},
		[selectForRemove]
	);

	const handleDismissRemove = useCallback(() => {
		selectForRemove(undefined);
	}, [selectForRemove]);

	const handleConfirmRemove = useCallback(
		async (nonce: string) => {
			if (removingRef.current) return;
			removingRef.current = true;
			if (!unmountedRef.current) setRemoveErrorText("");
			const showError = (text: string) => {
				if (!unmountedRef.current) setRemoveErrorText(text);
			};
			try {
				let networkHash: string | null = null;
				try {
					networkHash = await readActiveNetworkHash();
				} catch {
					networkHash = null;
				}
				let userId: string | null = null;
				try {
					const user = await getDeviceUser();
					userId = typeof user?.id === "string" && user.id.length > 0 ? user.id : null;
				} catch {
					userId = null;
				}
				const db = resolveStrandDb(node, networkHash);
				if (!node || !networkHash || !userId || !db) {
					showError(t("pairedBrowsersRemoveFailed"));
					throw new ScreenNotReadyError();
				}
				const state = await loadPairingCapabilityState({ node, db, networkHash, userId });
				if (!state.signingKey) {
					showError(t("pairedBrowsersRemoveKeyNotCurrent"));
					throw new ScreenNotReadyError();
				}
				const sign = await createDeviceSigner("Device User");
				const signer = {
					userId,
					signingPublicKey: state.signingKey.key,
					sign: (digest: Uint8Array) => sign(digest),
				};
				await removePairedBrowser({
					node: node as unknown as PairedBrowsersNode,
					db,
					signer,
					entry: { nonce },
					networkHash,
				});
			} catch (err) {
				console.warn("[paired-browsers] remove failed:", errorClassName(err));
				if (!(err instanceof ScreenNotReadyError)) {
					const coded = err !== null && typeof err === "object" && typeof (err as { code?: unknown }).code === "string";
					if (coded) {
						const outcome = handleDeviceSigningError(err);
						showError(outcome.handled ? "" : outcome.message ?? t(removeFailureKey(err)));
					} else {
						showError(t(removeFailureKey(err)));
					}
				}
				// Rethrown so the confirm card returns to idle and can be pressed again.
				throw err;
			} finally {
				removingRef.current = false;
			}
			selectForRemove(undefined);
			await loadList();
		},
		[node, t, handleDeviceSigningError, selectForRemove, loadList]
	);

	const renderItem = useCallback(
		({ item, index }: { item: PairedBrowserRow; index: number }) => {
			const title = item.label ?? t("pairedBrowsersDefaultLabel", { date: formatPairedDate(item.mintedAt) });
			const seen = lastSeenCopy(item.lastSeenAt, loadedAtMs);
			const seenText = seen.n === undefined ? t(seen.key) : t(seen.key, { n: seen.n });
			const selected = pendingRemoveNonce === item.nonce && isRemovable(item.state);
			return (
				<View>
					<View testID={`paired-browser-row-${index}`} style={[localStyles.card, { backgroundColor: colors.card }]}>
						<View style={localStyles.titleRow}>
							<ThemedText
								type="defaultSemiBold"
								testID={`paired-browser-title-${index}`}
								numberOfLines={2}
								style={localStyles.title}
							>
								{title}
							</ThemedText>
							<ThemedText type="small" testID={`paired-browser-state-${index}`} style={localStyles.stateWord}>
								{t(STATE_KEY[item.state])}
							</ThemedText>
						</View>
						<ThemedText type="small" testID={`paired-browser-paired-at-${index}`}>
							{t("pairedBrowsersPairedAt", { date: formatPairedDateTime(item.mintedAt) })}
						</ThemedText>
						{item.state !== "removed" ? (
							<ThemedText type="small" testID={`paired-browser-last-seen-${index}`}>
								{seenText}
							</ThemedText>
						) : null}
						{isRemovable(item.state) ? (
							<Pressable
								testID={`paired-browser-remove-${index}`}
								onPress={() => handleRequestRemove(item.nonce)}
								style={localStyles.removeButton}
								hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
								accessibilityRole="button"
								accessibilityLabel={t("pairedBrowsersRemoveButton")}
							>
								<ThemedText type="defaultSemiBold" style={{ color: colors.error }}>
									{t("pairedBrowsersRemoveButton")}
								</ThemedText>
							</Pressable>
						) : null}
						{item.state === "removal-pending" ? (
							<ThemedText type="small" testID={`paired-browser-pending-${index}`}>
								{t("pairedBrowsersRemovalPendingLine")}
							</ThemedText>
						) : null}
					</View>
					{selected ? (
						<LifecycleConfirmCard
							key={item.nonce}
							variant="ordinary"
							tone="destructive"
							title={t("pairedBrowsersRemoveConfirmHeading")}
							body={t("pairedBrowsersRemoveConfirmBody")}
							confirmLabel={t("pairedBrowsersRemoveConfirmButton")}
							dismissLabel={t("pairedBrowsersKeepButton")}
							testIDPrefix="paired-browsers-confirm"
							onDismiss={handleDismissRemove}
							onConfirm={() => handleConfirmRemove(item.nonce)}
						/>
					) : null}
				</View>
			);
		},
		[t, colors.card, colors.error, loadedAtMs, pendingRemoveNonce, handleRequestRemove, handleDismissRemove, handleConfirmRemove]
	);

	if (rows === null && !loadFailed) {
		return (
			<View style={localStyles.loading}>
				<ActivityIndicator testID="paired-browsers-loading" color={colors.text} />
			</View>
		);
	}

	const header = (
		<View style={localStyles.header}>
			<ThemedText type="default">{t("pairedBrowsersIntro")}</ThemedText>
			{loadFailed ? (
				<View testID="paired-browsers-load-error">
					<InlineError message={t("pairedBrowsersLoadError")} />
				</View>
			) : null}
			{removeErrorText ? (
				<View testID="paired-browsers-remove-error">
					<InlineError message={removeErrorText} />
				</View>
			) : null}
		</View>
	);

	const empty =
		rows !== null ? (
			<View testID="paired-browsers-empty" style={localStyles.empty}>
				<ThemedText type="defaultSemiBold">{t("pairedBrowsersEmptyHeading")}</ThemedText>
				<ThemedText type="small">{t("pairedBrowsersEmptyBody")}</ThemedText>
				<CustomButton
					testID="paired-browsers-empty-pair"
					title={t("pairedBrowsersPairButton")}
					size="thin"
					onPress={openPairBrowser}
				/>
			</View>
		) : null;

	const footer =
		rows !== null && rows.length > 0 ? (
			<View style={localStyles.footer}>
				<ThemedText type="small" testID="paired-browsers-last-seen-footnote">
					{t("pairedBrowsersLastSeenFootnote")}
				</ThemedText>
				<ThemedText type="small" testID="paired-browsers-local-labels-note">
					{t("pairedBrowsersLocalLabelsNote")}
				</ThemedText>
			</View>
		) : null;

	return (
		<FlatList
			testID="paired-browsers-list"
			data={rows ?? []}
			keyExtractor={(item, index) => `${index}-${item.mintedAt}`}
			renderItem={renderItem}
			extraData={{ pendingRemoveNonce, loadedAtMs }}
			refreshing={refreshing}
			onRefresh={handleRefresh}
			ListHeaderComponent={header}
			ListEmptyComponent={empty}
			ListFooterComponent={footer}
			contentContainerStyle={[localStyles.content, { paddingBottom: insets.bottom + 24 }]}
		/>
	);
}

const localStyles = StyleSheet.create({
	headerButton: {
		minWidth: 44,
		minHeight: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	loading: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		padding: 16,
	},
	content: {
		padding: 16,
		gap: 8,
	},
	header: {
		gap: 8,
		marginBottom: 8,
	},
	card: {
		borderRadius: 16,
		padding: 16,
		gap: 8,
	},
	titleRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 8,
	},
	// flexShrink lets a long label wrap so the state word always stays on the title line.
	title: {
		flexShrink: 1,
	},
	stateWord: {
		marginLeft: "auto",
		flexShrink: 0,
	},
	removeButton: {
		minHeight: 36,
		justifyContent: "center",
		alignSelf: "flex-start",
	},
	empty: {
		gap: 8,
		paddingVertical: 16,
	},
	footer: {
		gap: 4,
		marginTop: 8,
	},
});
