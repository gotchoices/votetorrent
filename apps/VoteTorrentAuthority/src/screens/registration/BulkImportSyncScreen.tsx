import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { type Signature } from "@votetorrent/vote-core";
import { scopeLabel } from "../../utils/scopeLabel";
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";
import { TransportStatusCard } from "../../components/TransportStatusCard";
import { PeerTransportStatusCard } from "../../components/PeerTransportStatusCard";
import { OfficerIntakeKeyCard } from "./components/OfficerIntakeKeyCard";
import { RestBridgeConfigCard } from "./components/RestBridgeConfigCard";
import { globalStyles } from "../../theme/styles";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { useApp } from "../../providers/AppProvider";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import {
	resolveSyncBinding,
	resolveTransportCardState,
	toSyncErrorRefs,
	type PeerSyncCounts,
	type SyncBindingId,
	type TransportCardEntry,
} from "./bulk-import-sync-model";
import {
	enableOfficerEncryptedIntake,
	readOfficerIntakeKeyState,
	type OfficerIntakeKeyState,
} from "./officer-intake-key";
import {
	readRegistrationBridgeConfig,
	saveRegistrationBridgeUrl,
	type RegistrationBridgeConfig,
} from "./registration-bridge-config";

/** The card-facing subset of `RegistrationBridgeSaveOutcome` — 'invalid-url' never reaches here
 * (the card's own draft validation already shows it), and 'not-authorized'/'conflict' both map to
 * the generic 'save-error' notice (S11: both re-read the config rather than carry a distinct
 * screen-level state). */
type BridgeScreenNotice = "saved" | "save-error" | "co-sign-required";

/**
 * BulkImportSyncScreen — the officer-facing surface for the D-01 transport bridges, the D-04/
 * D-28/D-31 peer-staging surface (Phase 62 Plan 21), and the D-28/D-29 REST bridge config surface
 * (Phase 62 Plan 25).
 *
 * Renders, in a FIXED order that is never reordered by any state:
 *   1. `InlineError`
 *   2. the scope-gate banner (only when ungated for `'vrg'`)
 *   3. `RestBridgeConfigCard` — its own section (62-UI-SPEC Surface 1, D-29)
 *   4. Filesystem `TransportStatusCard` — first-listed, most-trusted binding; D-28/D-29: this
 *      transport and its binding are unchanged by this plan, attached by the Node-side host as
 *      before
 *   5. REST `TransportStatusCard`, plus the unset-bridge hint directly below it when no URL is
 *      saved yet
 *   6. `OfficerIntakeKeyCard` — the D-04 "enable encrypted intake" step
 *   7. `PeerTransportStatusCard` — D-31's live-count peer card
 *   8. the sync-errors section, identifier-only
 *
 * D-28: association has NO REST or filesystem app binding of any kind (62-25 deletes the
 * dev-only association REST harness) — association syncs only over the 'peer' binding, attached
 * in EVERY build (`AppProvider.tsx`, no `__DEV__` gate). D-29: the registration REST binding is
 * ALSO attached in every build now, reading its target from the signed, replicated
 * `AuthorityIntakePolicy` at every sync — it is inert (refuses before any network call) until an
 * officer with `'vrg'` saves an https URL here. D-31: `PeerTransportStatusCard` shows REAL numeric
 * counts read via `resolveSyncBinding('peer').readCounts`. The peer leg itself remains
 * **code-complete, unverified** on devices (D-23, proof debt against P2P-11) — attaching it and
 * showing counts does not change that; the card's own hardcoded warning frame and verbatim caveat
 * are what keep that distinction visible to the officer.
 *
 * The errors section renders a transport heading and an item IDENTIFIER only — never a payload
 * value, a requester name, or a transport's error text (T-48-20-02).
 *
 * The `'vrg'` scope gate DISABLES write controls, it does not hide them, and it is a legibility
 * control only — `useCurrentOfficerScopes()`'s own file header says so verbatim. No claim anywhere
 * in this file that this gate is enforcement (Phase 999.1's pre-existing, out-of-scope gap). D-04:
 * encrypted intake registration is open to EVERY current officer of this authority (any scope) —
 * `canEnableIntake` therefore does not require `'vrg'`, unlike `canSync`/`canConfigureBridge`.
 *
 * 62-25: this screen now resolves the device signer directly (the bridge-URL save is a
 * user-initiated signing action), so it DOES invoke the injected signer factory — the
 * `deviceSigningRollout` coverage inventory gains this file as an invoker, routed through
 * `useDeviceSigningErrorHandler` below (see `handleSaveBridgeUrl`). The bundling gate this
 * screen was already held to is unchanged: no vote-engine package import, no Node built-in
 * module specifier, and no dynamic module loader of any kind.
 */

interface BulkImportSyncRouteParams {
	authorityId: string;
}

export function BulkImportSyncScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { authorityId } = useRoute().params as BulkImportSyncRouteParams;
	const { getEngine, resolveDeviceSigner } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const { scopes, loading } = useCurrentOfficerScopes(authorityId);
	// Legibility/convenience control only — NOT a security boundary. The real control is the
	// signed ceremony downstream (see `useCurrentOfficerScopes.ts`'s own file header).
	const canSync = !loading && scopes?.includes("vrg") === true;
	// D-04: every current officer (any scope) is an intake recipient — no 'vrg' requirement.
	const canEnableIntake = !loading && scopes !== undefined;

	const [errorMessage, setErrorMessage] = useState("");
	const [filesystemEntry, setFilesystemEntry] = useState<TransportCardEntry>({});
	const [restEntry, setRestEntry] = useState<TransportCardEntry>({});
	const [peerEntry, setPeerEntry] = useState<TransportCardEntry>({});
	const [peerCounts, setPeerCounts] = useState<PeerSyncCounts | undefined>(undefined);

	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const inFlightRef = useRef<Set<SyncBindingId>>(new Set());
	const [inFlight, setInFlight] = useState<ReadonlySet<SyncBindingId>>(new Set());

	// 62-21 (D-31): refresh the live peer counts. Guarded by unmountedRef; a rejection clears the
	// counts rather than leaving a stale value on screen. Never sets any error message.
	const refreshPeerCounts = useCallback(async () => {
		try {
			const counts = await resolveSyncBinding("peer")?.readCounts?.({ authorityId });
			if (!unmountedRef.current) setPeerCounts(counts);
		} catch {
			if (!unmountedRef.current) setPeerCounts(undefined);
		}
	}, [authorityId]);

	useEffect(() => {
		void refreshPeerCounts();
	}, [refreshPeerCounts]);

	const runSync = useCallback(
		(id: SyncBindingId) => {
			// Synchronous, same-tick guard. Checked and set before any await/promise boundary.
			if (inFlightRef.current.has(id)) return;

			const setEntry =
				id === "filesystem" ? setFilesystemEntry : id === "rest" ? setRestEntry : setPeerEntry;
			const binding = resolveSyncBinding(id);
			if (!binding) {
				if (!unmountedRef.current) setEntry({ failed: true });
				return;
			}

			if (!unmountedRef.current) setErrorMessage("");

			inFlightRef.current.add(id);
			if (!unmountedRef.current) setInFlight(new Set(inFlightRef.current));
			const settle = () => {
				inFlightRef.current.delete(id);
				if (!unmountedRef.current) setInFlight(new Set(inFlightRef.current));
				if (id === "peer") void refreshPeerCounts();
			};

			binding
				.syncNow({ authorityId })
				.then((report) => {
					if (!unmountedRef.current) setEntry({ report });
				})
				.catch(() => {
					// The caught error's `message` is NEVER put into state, into `InlineError`, into a
					// `testID`, or into any log — a transport error message can echo an adversarial or
					// misconfigured endpoint's response body (T-48-20-02).
					if (!unmountedRef.current) {
						setEntry((prev) => ({ failed: true, report: prev.report }));
					}
				})
				.finally(settle);
		},
		[authorityId, refreshPeerCounts],
	);

	// --- D-04: officer encrypted-intake enable step ---
	const [intakeKeyState, setIntakeKeyState] = useState<"loading" | OfficerIntakeKeyState>("loading");
	const [intakeShowError, setIntakeShowError] = useState(false);
	const [intakeErrorMessage, setIntakeErrorMessage] = useState<string | undefined>(undefined);
	const [intakeSubmitting, setIntakeSubmitting] = useState(false);
	const intakeSubmittingRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		void readOfficerIntakeKeyState({ getEngine, createSigner: resolveDeviceSigner }, authorityId).then((state) => {
			if (!cancelled && !unmountedRef.current) setIntakeKeyState(state);
		});
		return () => {
			cancelled = true;
		};
	}, [getEngine, resolveDeviceSigner, authorityId]);

	const handleEnableIntake = useCallback(() => {
		if (intakeSubmittingRef.current) return;
		intakeSubmittingRef.current = true;
		if (!unmountedRef.current) {
			setIntakeSubmitting(true);
			setIntakeShowError(false);
			setIntakeErrorMessage(undefined);
		}

		enableOfficerEncryptedIntake({ getEngine, createSigner: resolveDeviceSigner }, authorityId)
			.then((state) => {
				if (!unmountedRef.current) setIntakeKeyState(state);
				void refreshPeerCounts();
			})
			.catch((err) => {
				// The officer's key was superseded by their other device: a specific message, not the
				// signing-error hook (the code literal mirrors officer-intake-key.ts).
				if ((err as { code?: unknown } | null)?.code === "intake-key-superseded") {
					if (!unmountedRef.current) {
						setIntakeShowError(true);
						setIntakeErrorMessage(t("officerIntakeKeySupersededBody"));
					}
					return;
				}
				const outcome = handleDeviceSigningError(err);
				if (outcome.handled) return;
				if (!unmountedRef.current) {
					setIntakeShowError(true);
					setIntakeErrorMessage(outcome.message);
				}
			})
			.finally(() => {
				intakeSubmittingRef.current = false;
				if (!unmountedRef.current) setIntakeSubmitting(false);
			});
	}, [getEngine, resolveDeviceSigner, authorityId, handleDeviceSigningError, refreshPeerCounts, t]);

	// --- D-29: registration REST bridge URL config (62-25) ---
	// `undefined` = loading (never read yet). A re-read also runs after 'conflict'/'failed' (S11),
	// so a stale revision never gets re-submitted blind.
	const [bridgeConfig, setBridgeConfig] = useState<RegistrationBridgeConfig | undefined>(undefined);
	const [bridgeNotice, setBridgeNotice] = useState<BridgeScreenNotice | undefined>(undefined);
	const [bridgeSubmitting, setBridgeSubmitting] = useState(false);
	const bridgeSubmittingRef = useRef(false);

	const readBridgeConfig = useCallback(() => {
		void readRegistrationBridgeConfig({ getEngine }, authorityId).then((config) => {
			if (!unmountedRef.current) setBridgeConfig(config);
		});
	}, [getEngine, authorityId]);

	useEffect(() => {
		readBridgeConfig();
	}, [readBridgeConfig]);

	const handleSaveBridgeUrl = useCallback(
		(url: string) => {
			// The ref guard (WR-16): a second press in the same tick is a no-op.
			if (bridgeSubmittingRef.current) return;
			// A latched co-sign-required notice is terminal for this mount — nothing to retry.
			if (bridgeNotice === "co-sign-required") return;
			bridgeSubmittingRef.current = true;
			if (!unmountedRef.current) setBridgeSubmitting(true);

			(async () => {
				let sign: (digest: Uint8Array) => Promise<Signature>;
				try {
					const user = await getOrCreateDeviceUser("Device User");
					sign = await createDeviceSigner(user.name);
				} catch (err) {
					const outcome = handleDeviceSigningError(err);
					if (outcome.handled) return;
					if (unmountedRef.current) return;
					if (outcome.message) {
						setErrorMessage(outcome.message);
					} else {
						// No mapped copy to show in the screen's own InlineError: fall back to the
						// card's own SaveError notice rather than a silent no-op.
						setBridgeNotice("save-error");
					}
					return;
				}

				const result = await saveRegistrationBridgeUrl(
					{ getEngine },
					authorityId,
					url,
					sign,
					bridgeConfig?.revision,
				);

				if (unmountedRef.current) return;
				switch (result.outcome) {
					case "saved":
						if (result.config) setBridgeConfig(result.config);
						setBridgeNotice("saved");
						break;
					case "co-sign-required":
						setBridgeNotice("co-sign-required");
						break;
					case "invalid-url":
						// The card's own validation already shows this — no screen-level notice.
						break;
					case "not-authorized":
					case "conflict":
					case "failed":
						setBridgeNotice("save-error");
						readBridgeConfig();
						break;
				}
			})()
				.finally(() => {
					bridgeSubmittingRef.current = false;
					if (!unmountedRef.current) setBridgeSubmitting(false);
				});
		},
		[getEngine, authorityId, bridgeConfig, bridgeNotice, handleDeviceSigningError, readBridgeConfig],
	);

	const canConfigureBridge = canSync;
	const bridgeReady = bridgeConfig?.savedUrl != null;

	const errorRefs = toSyncErrorRefs({
		filesystem: filesystemEntry.report,
		rest: restEntry.report,
		peer: peerEntry.report,
	});

	return (
		<ScrollView style={styles.container} testID="bulk-import-sync-screen">
			<View style={styles.section} testID="bulk-import-sync-error">
				<InlineError message={errorMessage} />
			</View>

			{/* Two-branch scope-gate banner — a UI legibility affordance ONLY, never a security
			    boundary. Callers must NOT collapse the two branches: "not an officer here"
			    (scopes === undefined) and "an officer but lacking this permission" (a real,
			    'vrg'-less scope array) are different facts with different remedies. */}
			{!loading &&
				!canSync &&
				(scopes === undefined ? (
					<View testID="bulk-import-sync-scope-banner" style={styles.banner}>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="bulk-import-sync-scope-banner" style={styles.banner}>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyBanner", { scope: scopeLabel("vrg", t) })}
						</ThemedText>
					</View>
				))}

			{/* 62-UI-SPEC Surface 1, D-29: the registration REST bridge config card, its own
			    section, placed before the filesystem/REST cards per the composition reference. */}
			<View style={styles.section}>
				<RestBridgeConfigCard
					loading={bridgeConfig === undefined}
					savedUrl={bridgeConfig?.savedUrl ?? null}
					notice={bridgeNotice}
					disabled={!canConfigureBridge}
					submitting={bridgeSubmitting}
					onSave={handleSaveBridgeUrl}
				/>
			</View>

			<View style={styles.section}>
				<TransportStatusCard
					kind="filesystem"
					{...resolveTransportCardState(filesystemEntry)}
					disabled={!canSync || inFlight.has("filesystem")}
					onSyncNow={() => runSync("filesystem")}
				/>
			</View>

			<View style={styles.section}>
				<TransportStatusCard
					kind="rest"
					{...resolveTransportCardState(restEntry)}
					disabled={!canSync || inFlight.has("rest") || !bridgeReady}
					onSyncNow={() => runSync("rest")}
				/>
				{/* D-29: the REST card stays disabled, with plain guidance, until a bridge URL is
				    saved above -- never a silent dead control. */}
				{bridgeConfig !== undefined && !bridgeReady && (
					<ThemedText
						type="small"
						style={{ color: colors.textSecondary }}
						testID="registration-bridge-config-unset-hint"
					>
						{t("registrationBridgeConfigUnsetHint")}
					</ThemedText>
				)}
			</View>

			<View style={styles.section}>
				<OfficerIntakeKeyCard
					state={intakeKeyState}
					disabled={!canEnableIntake}
					submitting={intakeSubmitting}
					showError={intakeShowError}
					errorMessage={intakeErrorMessage}
					onEnable={handleEnableIntake}
				/>
			</View>

			{/* D-28: the peer leg ships code-complete, unverified (D-23, proof debt against P2P-11).
			    No conditional of any kind wraps this card: it renders every time this screen renders,
			    in this position, always — never reordered above the two proven bindings above it. */}
			<View style={styles.section}>
				<PeerTransportStatusCard
					counts={peerCounts}
					disabled={!canSync || inFlight.has("peer")}
					onTrySync={() => runSync("peer")}
				/>
			</View>

			{errorRefs.length > 0 && (
				<View style={styles.section} testID="bulk-import-sync-errors-section">
					<ThemedText type="defaultSemiBold">{t("bulkImportSyncErrorsSectionTitle")}</ThemedText>
					{errorRefs.map((ref, index) => (
						<ThemedText
							key={ref.transport + ":" + ref.itemId}
							type="small"
							style={[styles.errorRow, { color: colors.error }]}
							testID={"bulk-import-sync-error-row-" + index}
						>
							{/* An IDENTIFIER only, never a payload value — a failing item is a
							    registration payload carrying real registrant PII, and the
							    never-log-values discipline Phase 47 established for
							    `RegistrantPrivate` applies here unchanged. */}
							{t(
								ref.transport === "filesystem"
									? "bulkImportSyncFilesystemHeading"
									: ref.transport === "rest"
										? "bulkImportSyncRestHeading"
										: "peerSyncCardHeading",
							)}
							{": "}
							{ref.itemId}
						</ThemedText>
					))}
				</View>
			)}
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
	errorRow: {
		marginTop: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
