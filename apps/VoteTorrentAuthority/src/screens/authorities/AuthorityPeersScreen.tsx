import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { createDeviceSigner } from "../../engines/device-signer";
import type { SignCallback } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
// LifecycleConfirmCard is owned by 47-10 and lives in the registration tree
// because that is where its other seven call sites are; this screen is one
// authorities-tree consumer among two (47-17 is the other) and imports it
// rather than forking a second confirmation card.
import { LifecycleConfirmCard } from "../registration/components/LifecycleConfirmCard";
import { scopeLabel } from "../../utils/scopeLabel";
import type { AuthorityPeer, IAuthorityConfigEngine } from "@votetorrent/vote-core";
import type { RootStackParamList } from "../../navigation/types";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { errorCopy } from "../../utils/errorCopy";

// A stable no-op for the (non-optional) CustomButton.onPress prop when a gate
// is unmet — belt-and-suspenders alongside `disabled`, mirroring
// AttestationPolicySection's NOOP idiom, so a direct programmatic invocation
// of the handler (bypassing a real touch event) still cannot fire a write.
const NOOP = () => {};

/**
 * AuthorityPeersScreen — the `'cap'`-scoped `AuthorityPeer` CRUD surface
 * (47-18, D-08 authorities tree, D-13 default visible-but-disabled gating
 * pattern).
 *
 * `AuthorityConfigEngine` deliberately splits its ceremonies by scope:
 * `'cap'` (Configure Authority Peers) for `AuthorityPeer`, `'vrg'` (Validate
 * Registrations) for the whitelisted-device model the sibling authorities-
 * tree screen manages (47-17). This screen's gate is `'cap'` ONLY. As with
 * every other Phase 46/47
 * scope gate, this is a UI legibility affordance, NOT the enforcement
 * boundary — the real and only control is `AuthorityPeer`'s
 * `InsertValid`/`DeleteValid` CHECKs (`votetorrent.qsql:1586-1606`), which
 * require an `AdminSignature` joined through `AdminSigning` with
 * `A.Scope = 'cap'` and a matching `Digest`. A caller that bypasses this
 * screen entirely still cannot write, because `AuthorityConfigEngine`'s
 * `addAuthorityPeer`/`removeAuthorityPeer` pass `'cap'` to
 * `seedSignedMutation` unconditionally (T-46-03 precedent, T-47-04).
 *
 * `AuthorityPeers` IS a key of `RootStackParamList` (47-21 added
 * `{ authorityId: string }` and registered the `Stack.Screen`), so this screen
 * reads its param through `RouteProp<RootStackParamList, "AuthorityPeers">`
 * rather than the local `as { authorityId: string }` cast it used before that
 * landed. This screen has no detail screen and navigates nowhere, so no
 * navigation-prop hook or type is imported.
 */

/**
 * Truncates a `peerId` for display in a row title. Exact convention carried
 * from `HistoryEvent.tsx`'s signer-key truncation (47-PATTERNS §15) — do not
 * invent a middle-ellipsis variant.
 */
export function truncatePeerId(peerId: string): string {
	return peerId.length > 8 ? peerId.slice(0, 5) + "..." : peerId;
}

/**
 * Exact-match duplicate check (trim only, no case-folding). A libp2p PeerId
 * is case-sensitive base58/base36 — lower-casing either side would let two
 * distinct peers collide into one "duplicate".
 */
export function isDuplicatePeerId(peers: AuthorityPeer[], candidate: string): boolean {
	const trimmed = candidate.trim();
	return peers.some((p) => p.peerId === trimmed);
}

export default function AuthorityPeersScreen() {
	const { t } = useTranslation();
	const keyboardInset = useKeyboardInset();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	// Typed, not cast: 47-21 registered "AuthorityPeers" on RootStackParamList,
	// so RouteProp gives the param checking the earlier cast could not.
	const { authorityId } = useRoute<RouteProp<RootStackParamList, "AuthorityPeers">>().params;

	const [peers, setPeers] = useState<AuthorityPeer[]>([]);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState("");
	const [addFormOpen, setAddFormOpen] = useState(false);
	const [peerIdInput, setPeerIdInput] = useState("");
	const [pendingRemovePeerId, setPendingRemovePeerId] = useState<string | undefined>(undefined);
	const [submitting, setSubmitting] = useState(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("cap") === true;

	// CR-02-style guard against a stale setState: loadPeers is invoked both
	// from the mount effect below AND (Task 2) from both write handlers, so a
	// single effect-scoped `cancelled` closure would only cover the mount
	// call. A ref shared across every caller generalizes the same
	// never-setState-after-unmount guarantee (RegistrationPolicyScreen.tsx
	// precedent).
	const unmountedRef = useRef(false);
	useEffect(() => {
		// WR-08: reset on entry so a cleanup that runs while the component
		// stays mounted (StrictMode double-invoke, Fast Refresh, remount-in-
		// place) does not permanently latch every setState in loadPeers off.
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const loadPeers = useCallback(async () => {
		try {
			const authorityConfigEngine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
			const fetched = await authorityConfigEngine.getAuthorityPeers(authorityId);
			if (!unmountedRef.current) {
				setPeers(fetched);
				setErrorMessage("");
			}
		} catch (err) {
			if (!unmountedRef.current) setErrorMessage(errorCopy(err, t, "read"));
		} finally {
			if (!unmountedRef.current) setLoading(false);
		}
	}, [getEngine, authorityId]);

	// Plain effect, deliberately NOT useFocusEffect: nothing else in the app
	// mutates AuthorityPeer rows during a session, and this screen re-reads
	// via loadPeers() at the end of every write it fires itself.
	useEffect(() => {
		loadPeers();
	}, [loadPeers]);

	// Shared write runner for both 'cap' ceremonies. Sets submitting, clears
	// errorMessage, resolves the device signer and the authorityConfig
	// engine, awaits the caller's op(sign, engine), then re-reads the list so
	// the screen reflects the committed row rather than an optimistic local
	// edit. On failure, sets errorMessage and RE-THROWS so the caller (and,
	// for the remove path, LifecycleConfirmCard's own handleConfirm) can
	// distinguish success from failure.
	const runSignedWrite = useCallback(
		async (op: (sign: SignCallback, engine: IAuthorityConfigEngine) => Promise<void>) => {
			setSubmitting(true);
			setErrorMessage("");
			try {
				// Same literal bootstrap name AppProvider.tsx and
				// useCurrentOfficerScopes use, so a first-run identity cannot
				// diverge.
				const sign = await createDeviceSigner("Device User");
				const engine = await getEngine<IAuthorityConfigEngine>("authorityConfig");
				await op(sign, engine);
				await loadPeers();
			} catch (err) {
				// Preserve the existing re-throw contract (handleAddPeer's catch and
				// LifecycleConfirmCard's handleConfirm both depend on it) — only the
				// message-setting decision routes through the shared handler. When
				// `outcome.handled` is true (navigation fired), the throw is still
				// propagated so callers unwind cleanly, but no errorMessage is set.
				const outcome = handleDeviceSigningError(err);
				if (!unmountedRef.current && !outcome.handled) {
					setErrorMessage(outcome.message ?? errorCopy(err, t, "write"));
				}
				throw err;
			} finally {
				if (!unmountedRef.current) setSubmitting(false);
			}
		},
		[getEngine, loadPeers, handleDeviceSigningError]
	);

	const canAddSubmit = canWrite && !submitting && peerIdInput.trim().length > 0;

	// The raw peerId is submitted verbatim (47-UI-SPEC.md:568) — trim only, no
	// format validation, no multiaddr/PeerId parsing. Deliberate scope
	// boundary carried by threat T-47-18-02, not an oversight.
	const handleAddPeer = async () => {
		if (!canAddSubmit) return;
		const candidate = peerIdInput.trim();
		// Guard FIRST, before any engine call. See the module-level
		// declared-blind-spot note: MockAuthorityConfigEngine.addAuthorityPeer
		// silently no-ops on a duplicate peerId while the real engine's PK
		// insert throws — this guard is the only thing that keeps the
		// mock-green path and the real-engine path in agreement.
		if (isDuplicatePeerId(peers, candidate)) {
			// 47-REVIEW IN-06: this was the one untranslated user-visible string
			// in the file, and it interpolated `candidate` — operator-supplied
			// text — straight into a rendered message. Now a translated key with
			// no interpolation: the rejected value is still on screen in the add
			// form's input, which the failed submit deliberately leaves intact.
			setErrorMessage(t("authorityPeerDuplicateError"));
			return;
		}
		try {
			await runSignedWrite((sign, engine) => engine.addAuthorityPeer(authorityId, candidate, sign));
			if (!unmountedRef.current) {
				setAddFormOpen(false);
				setPeerIdInput("");
			}
		} catch {
			// Leave the form open with the draft intact so the officer can
			// retry — errorMessage already carries the reason.
		}
	};

	// State only, zero engine calls — the confirmation card is what actually
	// fires the write.
	function handleRequestRemove(peerId: string) {
		if (!canWrite || submitting) return;
		setPendingRemovePeerId(peerId);
	}

	// A dismissed confirmation fires ZERO engine calls (D-10).
	function handleDismissRemove() {
		setPendingRemovePeerId(undefined);
	}

	async function handleConfirmRemove(peerId: string) {
		await runSignedWrite((sign, engine) => engine.removeAuthorityPeer(authorityId, peerId, sign));
		// Per 47-10's downstream contract, the card latches after a RESOLVED
		// onConfirm and re-enables after a REJECTED one — clear the pending
		// slot only on resolve (a throw here propagates to
		// LifecycleConfirmCard's handleConfirm, which resets its own
		// submitState to idle without this screen touching
		// pendingRemovePeerId).
		if (!unmountedRef.current) setPendingRemovePeerId(undefined);
	}

	return (
		<ScrollView
			testID="authority-peers-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 + keyboardInset }}
		>
			<View style={styles.section}>
				<InlineError message={errorMessage} />
			</View>

			{/* D-13 scope-gate banner — persistent, non-collapsible, rendered
			    only once the hook has resolved. The two branches are
			    DELIBERATELY not collapsed: scopes === undefined (no matching
			    Officer row) vs. a real scopes array missing 'cap' are two
			    distinct facts and bind to two distinct copies. This gate is a
			    UI affordance for legibility, NOT a security boundary. */}
			{!scopesLoading &&
				!canWrite &&
				(scopes === undefined ? (
					<View testID="authority-peers-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="authority-peers-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("authorityPeerScopeReadOnlyBanner", { scope: scopeLabel("cap", t) })}
						</ThemedText>
					</View>
				))}

			<View
				testID="authority-peers-add-toggle"
				pointerEvents={canWrite ? "auto" : "none"}
				style={canWrite ? undefined : localStyles.disabledControl}
			>
				<ChipButton
					label={t("authorityPeerAddButton")}
					icon="circle-plus"
					onPress={
						canWrite
							? () => {
									setAddFormOpen((o) => !o);
									setPeerIdInput("");
							  }
							: undefined
					}
				/>
			</View>

			{addFormOpen && (
				<View
					testID="authority-peers-add-form"
					style={[styles.section, globalStyles.cardSurface, { backgroundColor: colors.card }]}
				>
					<CustomTextInput
						testID="authority-peers-add-input"
						title={t("authorityPeerIdLabel")}
						placeholder={t("authorityPeerIdPlaceholder")}
						value={peerIdInput}
						onChangeText={setPeerIdInput}
						// Load-bearing, not cosmetic: a PeerId is case-sensitive
						// base58 and an autocapitalised first character produces a
						// silently different peer.
						autoCapitalize="none"
						autoCorrect={false}
					/>
					<View
						testID="authority-peers-add-submit"
						pointerEvents={canWrite ? "auto" : "none"}
						style={canWrite ? undefined : localStyles.disabledControl}
					>
						<CustomButton
							size="thin"
							title={submitting ? `${t("authorityPeerAddButton")}…` : t("authorityPeerAddButton")}
							disabled={!canAddSubmit}
							onPress={canAddSubmit ? handleAddPeer : NOOP}
						/>
					</View>
				</View>
			)}

			{loading && (
				<ThemedText
					type="small"
					testID="authority-peers-loading"
					style={{ color: colors.textSecondary }}
				>
					{t("loading")}
				</ThemedText>
			)}

			{!loading && peers.length === 0 && (
				<View testID="authority-peers-empty" style={styles.section}>
					<ThemedText type="defaultSemiBold">{t("authorityPeerEmptyHeading")}</ThemedText>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("authorityPeerEmptyBody")}
					</ThemedText>
				</View>
			)}

			{!loading &&
				peers.length > 0 &&
				peers.map((peer) => (
					<React.Fragment key={peer.peerId}>
						<View testID={"authority-peers-row-" + peer.peerId} style={localStyles.row}>
							{/* InfoCard renders no children and exposes no trailing slot
							    (InfoCard.tsx:9-17), so the Remove chip is a sibling in a
							    flex row, not nested inside the card. Do not modify
							    InfoCard. */}
							<View style={localStyles.rowCard}>
								<InfoCard
									title={truncatePeerId(peer.peerId)}
									additionalInfo={[{ label: t("authorityPeerIdLabel"), value: peer.peerId }]}
								/>
							</View>
							<View
								testID={"authority-peers-remove-" + peer.peerId}
								pointerEvents={canWrite ? "auto" : "none"}
								style={[localStyles.rowAction, canWrite ? null : localStyles.disabledControl]}
							>
								<ChipButton
									label={submitting ? `${t("authorityPeerRemoveButton")}…` : t("authorityPeerRemoveButton")}
									disabled={submitting}
									onPress={
										canWrite && !submitting ? () => handleRequestRemove(peer.peerId) : undefined
									}
								/>
							</View>
						</View>
						{pendingRemovePeerId === peer.peerId && (
							// Ordinary variant only: removing a peer is reversible
							// ("It can be added back at any time" —
							// authorityPeerRemoveBody) and touches no registrant
							// record, so it does not meet D-10's typed-gate bar —
							// but it is still a delete and never a silent
							// single-tap action.
							<LifecycleConfirmCard
								variant="ordinary"
								tone="destructive"
								title={t("authorityPeerRemoveTitle")}
								body={t("authorityPeerRemoveBody")}
								confirmLabel={t("authorityPeerRemoveConfirm")}
								dismissLabel={t("authorityPeerKeepPeer")}
								testIDPrefix={"authority-peers-confirm-" + peer.peerId}
								onDismiss={handleDismissRemove}
								onConfirm={() => handleConfirmRemove(peer.peerId)}
							/>
						)}
					</React.Fragment>
				))}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	disabledControl: {
		opacity: 0.5,
	},
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	rowCard: {
		flex: 1,
		minWidth: 0,
	},
	// flexShrink: 0 guarantees the REMOVE chip claims its intrinsic width
	// first and the card absorbs all remaining pressure, so REMOVE can never
	// be squeezed past the screen edge even if a future card grows.
	rowAction: {
		flexShrink: 0,
	},
});

const styles = { ...globalStyles, ...localStyles };
