import React, { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NavigationProp } from "../../navigation/types";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { IDefaultUserEngine, INetworkEngine, IUserEngine, Signature } from "@votetorrent/vote-core";
import { UserKeyType } from "@votetorrent/vote-core";
import type { Spec as NativeAttestationSpec } from "@votetorrent/attestation-native/src/specs/NativeAttestation";
import { nativeSignInputBase64 } from "@votetorrent/attestation-native/src/native-sign-input";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { renewOfficerIntakeKeyAfterKeyReplacement } from "../registration/officer-intake-key";
import { useApp } from "../../providers/AppProvider";
import {
	clearRecoveryInProgress,
	getDeviceProvisioningRecord,
	getDeviceUser,
	markRecoveryInProgress,
	persistDeviceProvisioningRecord,
	persistProvisionedDeviceUser,
} from "../../engines/device-user";
import { SIGNING_KEY_ALIAS, RECOVERY_KEY_ALIAS } from "../../engines/device-signer";
import { mapDeviceSigningError, DEVICE_SIGNING_ERROR_COPY_KEY } from "../../utils/deviceSigningError";
import type { DeviceSigningErrorClass } from "../../utils/deviceSigningError";

/**
 * ProvisionSigningKeyScreen — D-14's dedicated first-run and recovery signing-key surface.
 *
 * signingKeyProvisioning — this file's own D-14/D-16/D-18 marker (see 49-UI-SPEC.md's
 * "Screen Composition Reference" and "ProvisionSigningKeyScreen" contract, exact).
 *
 * D-14 boot invariant (explicit, load-bearing): this screen is reached ONLY by an explicit
 * Settings press (`reason: 'first-run'`) or an explicit catch-and-navigate from one of the 22
 * `createDeviceSigner` call sites (`reason: 'invalidated'`, 49-11/49-12). It is NEVER
 * auto-navigated-to during provider construction or cold start, and no signer is ever resolved
 * here as a side effect of merely rendering. `AppProvider.tsx`'s lazy factory (its own
 * comment block, ~line 199) is the reason: resolving a signer — or, by the same logic,
 * redirecting to a signer-setup screen — during boot can turn a successful re-attach into a
 * spurious "Failed to load network". This file must never be imported by `AppProvider.tsx`.
 *
 * D-15 two-stage registration (Gap A closure, 49-17): first-run onboarding is
 * network-independent by construction (49-16), so the first `UserKey` cannot always be
 * registered through the schema's first-key bootstrap branch FROM THIS SCREEN — a `pm clear`
 * device has no network `User` row to attach it to yet. That bootstrap branch
 * (`count(*) = 1 and context.UserKey is null`, `packages/vote-core/schema/votetorrent.qsql`
 * `UserKey.InsertValid`) is exercised by `networks-engine.create()` on the network-creation
 * path instead; this screen's stage 2 exercises it only when it finds a network `User` with no
 * keys yet (the join-network path). The recovery key always registers through the signed
 * subsequent-key path, authorized by the signing key.
 *
 * D-08: the provision-time attestation cert chain is captured (via `produceAttestation`) and
 * persisted (49-16's `persistDeviceProvisioningRecord`) — it is the only mechanism that ever
 * makes user presence verifiable in-schema, and capturing it now avoids re-provisioning keys
 * later. The X.509 chain proves hardware and key continuity, never user identity; same-user
 * continuity across provisioning events is the deferred master-password item, not this screen's
 * job. Unlike the Voter app's device-association flow (45-05), there is no server-issued
 * challenge nonce in this ceremony, so the bound digest is self-issued over a locally generated
 * nonce plus the new key's own public value.
 *
 * DEVICE-PROOF HONESTY: jest cannot exercise the real Android Keystore or `BiometricPrompt`. This
 * screen's own test suite proves the JS-side wiring and rendering against a faked native module
 * ONLY — not that provisioning works on real hardware. That proof is D-24 leg 1 (49-13/49-18) and
 * leg 3 (49-14).
 */

type ProvisionReason = "first-run" | "invalidated";

/** Ten years in milliseconds — expiration epoch for every key this screen registers. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** WR-R3-06: how long the background intake-key renewal may run before the success screen says it failed. */
const INTAKE_RENEWAL_NOTICE_TIMEOUT_MS = 30_000;

/**
 * Base64 of the UTF-8 bytes of a string — mirrors `real-attestation-producer.ts`'s identical
 * `base64FromUtf8` contract. Used ONLY for `produceAttestation`'s `boundDigestUtf8Base64`
 * argument (the Keystore `setAttestationChallenge` payload) — never for `digestBase64` above,
 * which is a deliberately different encoding of a deliberately different input (D-08's own
 * asymmetry, documented in `ATTESTATION-CONTRACT.md` §3).
 */
function base64FromUtf8(value: string): string {
	const { TextEncoder: TextEncoderCtor, btoa: btoaFn } = globalThis as unknown as {
		TextEncoder: new () => { encode(input: string): Uint8Array };
		btoa: (data: string) => string;
	};
	const bytes = new TextEncoderCtor().encode(value);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
	return btoaFn(binary);
}

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — never a top-level
 * import. `TurboModuleRegistry.getEnforcing(...)` throws under Node/jest whenever the native
 * module isn't registered (documented in `device-signer.ts` and `real-attestation-producer.ts`);
 * this screen, like those files, is reachable from real jest suites without a native-bridge mock,
 * so an eager top-level touch here would break them.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require("@votetorrent/attestation-native/src/specs/NativeAttestation").default as NativeAttestationSpec;
}

// "network-user-unresolved" (49-14 follow-up): a network resolved, but this device's User row
// did not — a DISTINCT condition from "no network context at all" (`awaiting-network`). See
// `tryResolveNetworkUserEngine`'s doc comment.
//
// "recovery-unsupported-os" (49-19/49-21, D-26a rescope): the recovery ceremony rejected because
// on-device recovery is supported on Android 11 and newer and explicitly unsupported below it — a
// DISTINCT terminal phase from "no-recovery", not a reuse of it, because the cause and therefore
// the copy differ: "no-recovery" means this device's screen lock was removed (a device
// configuration fact), while this phase means the OS version itself cannot authorize the recovery
// key regardless of screen-lock state. Reusing "no-recovery"'s copy here would tell an officer
// with a perfectly good screen lock to go re-add one they never removed.
type ScreenPhase =
	| "idle"
	| "pending"
	| "success"
	| "awaiting-network"
	| "no-recovery"
	| "network-user-unresolved"
	| "recovery-unsupported-os";

export default function ProvisionSigningKeyScreen() {
	const insets = useSafeAreaInsets();
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const { getEngine, resolveDeviceSigner } = useApp();
	const { reason } = useRoute().params as { reason: ProvisionReason };

	const [phase, setPhase] = useState<ScreenPhase>("idle");
	const [errorClass, setErrorClass] = useState<DeviceSigningErrorClass | undefined>(undefined);
	const [intakeRenewalFailed, setIntakeRenewalFailed] = useState(false);
	// WR-R3-06: the intake-key renewal runs after the success screen is shown and may settle after
	// the officer has left it; only a mounted screen records its outcome.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const pending = phase === "pending";
	const isFirstRun = reason === "first-run";

	/**
	 * `EngineFactory.getEngine("user")` is cache-keyed by name alone and returns the SAME
	 * `UserEngine` instance (and therefore the SAME stale `activeKeys` snapshot) on every call.
	 * `addKey`'s signed subsequent-key path binds `context.UserKey` from that snapshot (its own
	 * doc comment, `user-engine.ts`), never from the `Signature` object passed in — so a second
	 * write against a cached engine would bind against the PRE-write key set, not the one just
	 * inserted. Going through the (also cached, but read-fresh-on-call) network engine's
	 * `getCurrentUser()` directly, instead of the app-wide `getEngine("user")` cache entry, gives
	 * a real DB read every time this is called.
	 *
	 * Throwing variant — used by the recovery path, which by definition runs on a device that
	 * already has a network (a recovery ceremony can only be reached once a `UserKey` already
	 * exists to invalidate). First-run stage 2 uses the non-throwing `tryResolveNetworkUserEngine`
	 * sibling below instead, because a genuinely network-less device is an expected, not
	 * exceptional, state there.
	 */
	async function resolveFreshUserEngine(): Promise<IUserEngine> {
		const networkEngine = await getEngine<INetworkEngine>("network");
		const userEngine = await networkEngine.getCurrentUser();
		if (!userEngine) {
			throw new Error(
				"ProvisionSigningKeyScreen: no current user resolved for this network — cannot register a signing key.",
			);
		}
		return userEngine;
	}

	/**
	 * Non-throwing sibling of `resolveFreshUserEngine`, used by first-run stage 2.
	 *
	 * 49-14 follow-up (root-caused this session, confirmed at source): the PRIOR version of this
	 * function collapsed EVERY failure mode into the same `undefined` — a genuinely absent network
	 * ("no network context at all", the expected `pm clear` case) AND a resolved network whose
	 * `getCurrentUser()` rejects or resolves nothing (a real DB-read failure, or this device's
	 * `User` row genuinely missing/not-yet-synced). Both rendered the IDENTICAL
	 * `awaiting-network` UI state with zero diagnostic information — on real hardware (Device B,
	 * D-26a), this dead-ended the officer across THREE distinct networks with no
	 * `BiometricPrompt` ever appearing and no way to tell "not synced yet, wait" from "a genuine
	 * defect".
	 *
	 * This version DISTINGUISHES the two failure modes (per the comment on `getEngine('network')`
	 * below, that first try/catch's narrow scope is deliberate — it is the ONLY thing that may
	 * legitimately resolve to `'no-network'`):
	 *   - `getEngine('network')` itself rejects → `'no-network'` (unchanged: still routes to the
	 *     `awaiting-network` UI — this remains the expected, non-exceptional network-less state).
	 *   - `getEngine('network')` resolves but `getCurrentUser()` rejects, OR resolves to nothing →
	 *     `'user-unresolved'`, carrying the underlying error (if any) for future diagnostics. This
	 *     is a DISTINCT, actionable condition — never silently masqueraded as "no network".
	 */
	async function tryResolveNetworkUserEngine(): Promise<
		{ kind: "no-network" } | { kind: "resolved"; engine: IUserEngine } | { kind: "user-unresolved"; error: unknown }
	> {
		let networkEngine: INetworkEngine;
		try {
			networkEngine = await getEngine<INetworkEngine>("network");
		} catch {
			// Narrow catch, deliberately: only `getEngine('network')` itself failing means "no
			// network context exists at all" — the genuinely network-less `pm clear` case.
			return { kind: "no-network" };
		}
		try {
			const userEngine = await networkEngine.getCurrentUser();
			if (!userEngine) return { kind: "user-unresolved", error: undefined };
			return { kind: "resolved", engine: userEngine };
		} catch (err) {
			// A network context resolved, but this device's `User` row did not — e.g.
			// `network-engine.ts`'s `getUser` throwing `Error('User not found')`, a real DB-query
			// fault, or a commit-visibility race. NEVER collapsed into `'no-network'`.
			return { kind: "user-unresolved", error: err };
		}
	}

	/**
	 * Stage 1 (network-independent, D-14/D-08): generate the signing key, generate the recovery
	 * key, capture the D-08 attestation cert chain, and persist the provisioning record + the
	 * local device `User`. NO engine call anywhere on this path — the `defaultUser` engine used
	 * for the display name is LocalStorage-only (`engine-factory.ts`), never network-scoped.
	 */
	async function runLocalCeremony(
		native: NativeAttestationSpec,
	): Promise<{ attestedKeyHex: string; recoveryKeyHex: string }> {
		// Step 1 — the biometric-gated primary signing key.
		const deviceKey = (await native.provisionDeviceKey(SIGNING_KEY_ALIAS)) as {
			publicKeyCompressedHex: string;
		};
		// Step 2 (D-16) — the device-credential recovery key.
		const recoveryKey = (await native.provisionRecoveryKey(RECOVERY_KEY_ALIAS)) as {
			publicKeyCompressedHex: string;
		};

		// Step 3 (D-08) — capture the provision-time attestation cert chain. There is no
		// server-issued challenge nonce to bind against in this ceremony (unlike the Voter app's
		// device-association flow, which uses `computeBoundDigest(nonce, deviceKey)` against an
		// authority-issued nonce — 45-05); a self-issued, locally generated string stands in as
		// `boundDigest` since nothing verifies this binding this phase (T-49-PLAIN: only the
		// public cert chain itself is persisted, never key material).
		const boundDigest = `signing-key-provisioning-${Date.now()}-${deviceKey.publicKeyCompressedHex}`;
		// Dev-only: emit the digest so the on-device ceremony harness can verify that the
		// challenge baked into the attestation leaf is the one THIS run generated. It cannot be
		// recovered any other way — `produceAttestation` immediately deletes and regenerates the
		// alias (see the comment below), so the `deviceKey.publicKeyCompressedHex` this string
		// embeds belongs to a key that no longer exists and is never persisted. Without this line
		// `run-authority-signing-ceremony.sh`'s challengeBound check compares the real challenge
		// against the literal string `unavailable-not-logged` and can never pass, on any device.
		// Safe to log: the digest is self-issued, non-secret, and contains only a timestamp and a
		// PUBLIC key — never key material. __DEV__-gated so release builds stay silent.
		if (__DEV__) {
			console.log("[ceremony-bound-digest]", boundDigest);
		}
		const attestation = (await native.produceAttestation(
			SIGNING_KEY_ALIAS,
			boundDigest,
			base64FromUtf8(boundDigest),
			false,
		)) as { certificateChainBase64: string[]; publicKeyCompressedHex: string };

		// The ONLY compressed public key this screen may ever register or persist as the signing
		// key. `produceAttestation` deletes and regenerates the `SIGNING_KEY_ALIAS` entry
		// (`regenerateAttested`, `KeyAttestationHelper.kt`), so `deviceKey.publicKeyCompressedHex`
		// above refers to a key the Keystore no longer holds. Registering the discarded value
		// would attribute every later signature to a `signerKey` that never produced it, and
		// `verify()` swallows exceptions and fails closed — silently (T-49-KEY). Nothing else in
		// this function consumes `deviceKey.publicKeyCompressedHex` beyond the self-issued
		// `boundDigest` string above (49-10's key decision — a self-issued placeholder is correct
		// while nothing verifies the binding).
		const attestedKeyHex = attestation.publicKeyCompressedHex;

		// Persist the attestation record FIRST, then the local device user — reversed from
		// 49-10's original "persist the device user last, only once both UserKey rows are real"
		// rule (deviation, see 49-17-SUMMARY.md). Under this plan's two-stage onboarding order the
		// network UserKey rows are written later, by design (stage 2 below, possibly on a return
		// visit) — so "last" here means last within stage 1: the device-user entry is what every
		// other call site (`device-signer.ts`, `useDeviceSigningErrorHandler`) treats as "this
		// device is provisioned", so it must be written only once it points at a key that
		// genuinely exists (the post-attestation key, never the discarded pre-attestation one).
		await persistDeviceProvisioningRecord({
			recoveryPublicKeyCompressedHex: recoveryKey.publicKeyCompressedHex,
			attestedPublicKeyCompressedHex: attestedKeyHex,
			signingKeyAlias: SIGNING_KEY_ALIAS,
			certificateChainBase64: attestation.certificateChainBase64,
			capturedAt: Date.now(),
		});

		// Resolve the display name from the network-independent `defaultUser` engine — the same
		// source `AddNetworkScreen` and `AppProvider` already use — NEVER from a network `User`
		// summary; that dependency is exactly what this plan exists to break.
		const defaultUserEngine = await getEngine<IDefaultUserEngine>("defaultUser");
		const defaultUser = await defaultUserEngine.get();
		const displayName = defaultUser?.name ?? "Device User";
		await persistProvisionedDeviceUser(displayName, attestedKeyHex);

		return { attestedKeyHex, recoveryKeyHex: recoveryKey.publicKeyCompressedHex };
	}

	async function handleFirstRun(): Promise<void> {
		setErrorClass(undefined);
		setPhase("pending");
		try {
			const native = getNative();

			// Stage 1 — local, guarded, idempotent. Run the native ceremony ONLY when this device
			// has never been locally provisioned. This guard is load-bearing in two directions:
			// `provisionDeviceKey`/`produceAttestation` unconditionally regenerate the Keystore
			// alias, so a second run would mint a DIFFERENT key and orphan whatever is already
			// registered in the network; and `persistProvisionedDeviceUser` mints a fresh
			// `crypto.randomUUID()` for `user.id`, which `networks-engine.create()` writes as
			// `User.Id` — re-running it after a network exists would fork the device's identity.
			let attestedKeyHex: string;
			let recoveryKeyHex: string;
			const existingDeviceUser = await getDeviceUser();
			if (existingDeviceUser === undefined) {
				({ attestedKeyHex, recoveryKeyHex } = await runLocalCeremony(native));
			} else {
				const existingRecord = await getDeviceProvisioningRecord();
				if (existingRecord === undefined) {
					// Defensive: a legacy pre-49-16 install can carry a `deviceUser` entry with no
					// sibling provisioning record. Treat that as unprovisioned for
					// network-registration purposes and run stage 1 to backfill both, rather than
					// proceeding with a partial (recovery-key-less) set.
					({ attestedKeyHex, recoveryKeyHex } = await runLocalCeremony(native));
				} else {
					attestedKeyHex = existingDeviceUser.activeKeys[0]!.key;
					recoveryKeyHex = existingRecord.recoveryPublicKeyCompressedHex;
				}
			}

			// Stage 2 (network-scoped): register whichever keys the network `User` is still
			// missing. Skipped entirely — landing on the awaiting-network state — when no network
			// `User` resolves yet (the officer provisioned before creating or joining a network).
			// 49-14 follow-up: a resolved network whose `User` row didn't resolve is a DISTINCT,
			// actionable condition — see `tryResolveNetworkUserEngine`'s doc comment — never
			// silently rendered as the same `awaiting-network` dead end.
			const resolution = await tryResolveNetworkUserEngine();
			if (resolution.kind === "no-network") {
				setPhase("awaiting-network");
				return;
			}
			if (resolution.kind === "user-unresolved") {
				setPhase("network-user-unresolved");
				return;
			}
			const networkUserEngine = resolution.engine;

			// Reconcile, do not re-insert: read the network User's CURRENT key set and register
			// only what is missing. `networks-engine.create()`'s own bootstrap branch already
			// writes the founding UserKey from `activeKeys[0]` on the create-network path, so a
			// blind unconditional insert here would violate UserKey.InsertValid's bootstrap
			// uniqueness guard on that path — this check is what makes a return visit to this
			// screen safe on either the create-network or join-network path.
			const summary = await networkUserEngine.getSummary();
			const existingKeys = new Set((summary?.activeKeys ?? []).map((k) => k.key));
			const expiration = Date.now() + TEN_YEARS_MS;

			if (!existingKeys.has(attestedKeyHex)) {
				// The first-key bootstrap branch: no signature required, ONLY legal when this is
				// genuinely the user's first key (the join-network path, where no bootstrap write
				// has happened yet). `networks-engine.create()` already exercises this branch on
				// the create-network path.
				await networkUserEngine.addKey({ key: attestedKeyHex, type: UserKeyType.p256, expiration });
			}

			if (!existingKeys.has(recoveryKeyHex)) {
				// The signed recovery-key insert is the ONLY write in the whole first-run flow
				// that exercises the in-schema P-256 `SignatureValid` CHECK end to end (D-24 leg
				// 1's second sub-claim), and its `BiometricPrompt` is a genuine post-provisioning
				// per-use prompt (D-24 leg 1's third sub-claim). A fresh engine is re-resolved here
				// (never the `networkUserEngine` local above) so `context.UserKey` binds against
				// the key set as it stands right now — including the bootstrap add just above, if
				// one happened — never a stale snapshot (see `resolveFreshUserEngine`'s doc
				// comment). Public values are sourced from local state, never a fresh native call:
				// calling `provisionRecoveryKey` again here would regenerate that alias and
				// invalidate the value the network may already hold.
				const freshEngine = await resolveFreshUserEngine();
				await freshEngine.addKey(
					{ key: recoveryKeyHex, type: UserKeyType.p256, expiration },
					async (digest: Uint8Array): Promise<Signature> => {
						const result = (await native.signWithDeviceKey(
							SIGNING_KEY_ALIAS,
							nativeSignInputBase64(digest, Platform.OS),
							t("deviceSigningPromptTitle"),
							t("signingKeyProvisioningPromptSubtitle"),
							t("deviceSigningPromptNegativeButton"),
						)) as { signatureHex: string };
						return {
							signerUserId: summary?.id ?? "",
							signerKey: attestedKeyHex,
							signature: result.signatureHex,
						};
					},
				);
			}

			setPhase("success");

			// Dev-only read-back: re-resolve the network `User` AFTER the writes above and emit
			// its key set. This is the measurement the recovery-key-registration proof needs and
			// the only place it can be taken -- the registered keys are `UserKey` rows in the
			// strand DB, not AsyncStorage, and the local `deviceUser.activeKeys` blob is
			// single-element by design (see the gate hook's comment). A fresh engine is resolved
			// rather than reusing `networkUserEngine`/`summary` above, both of which hold the
			// PRE-write snapshot this read-back exists to disprove.
			//
			// Wrapped in its own try/catch and placed AFTER `setPhase("success")` so a failed
			// probe can never turn a completed ceremony into a reported failure -- an instrument
			// must not be able to fail the product it measures. Safe to log: compressed PUBLIC
			// keys only. __DEV__-gated so release builds stay silent.
			if (__DEV__) {
				try {
					const afterSummary = await (await resolveFreshUserEngine()).getSummary();
					console.log(
						"[ceremony-registered-keys]",
						JSON.stringify({
							activeKeys: (afterSummary?.activeKeys ?? []).map((k) => k.key),
							attested: attestedKeyHex,
							recovery: recoveryKeyHex,
						}),
					);
				} catch (probeErr) {
					console.log("[ceremony-registered-keys]", JSON.stringify({ readBackFailed: String(probeErr) }));
				}
			}
		} catch (err) {
			// T-49-USER-7 (deviceSigningError.ts:117-118) — the same generic
			// deviceSigningErrorGeneric copy handleRecovery's catch below warns about applies here
			// too, and this screen's own `addKey` call above is one of the three distinct real
			// faults that copy masked in this one real-hardware session (49-14 follow-up ceremony,
			// 2026-08-18): a rejected `SignatureValid` CHECK, alongside the desync-detection
			// `SignatureValid` failure and the `revokeKey` `DeleteValid` rejection seen in
			// handleRecovery below. In every case biometric authentication had already succeeded —
			// the classified copy alone gave no way to tell that apart from a real engine/schema
			// rejection. Logging the raw value first is what made any of them diagnosable.
			console.warn("ProvisionSigningKeyScreen handleFirstRun ceremony failed:", err);
			handleCeremonyError(err);
		}
	}

	async function handleRecovery(): Promise<void> {
		setErrorClass(undefined);
		setPhase("pending");
		try {
			const native = getNative();

			// Step 1 (precondition check, 49-14 follow-up — root-caused on real hardware, Device
			// A): resolve the recovery key's current public value and the network User's current
			// key set BEFORE touching the Keystore at all. `native.provisionRecoveryKey` is now
			// GENUINELY idempotent (KeyAttestationHelper.kt's `generateRecoveryKey` reuse path,
			// 49-14 follow-up) — it returns the ALIAS'S EXISTING key rather than regenerating it,
			// so calling it this early costs nothing and cannot invalidate anything the network
			// already holds. This replaces the prior comment's FALSE claim that the pre-fix native
			// call was "idempotent" — it was not: every call unconditionally deleted and
			// regenerated the Keystore entry, which is what let this ceremony destroy the very key
			// its own `UserKey.DeleteValid` CHECK depends on (see the 49-14-PROOF-LOG.md follow-up
			// session for the traced root cause).
			//
			// `UserKey.DeleteValid` (votetorrent.qsql) requires BOTH clause 1 (`context.UserKey` —
			// here, the recovery key — must be a registered, non-expired `UserKey` row) AND clause
			// 2 (the row being revoked must not be the user's LAST active key). Together these mean
			// this ceremony can only ever succeed if the recovery key is ALREADY registered as a
			// SECOND active key beside the one being revoked — a precondition
			// `ProvisionSigningKeyScreen`'s own first-run stage 2 establishes (49-17-SUMMARY.md),
			// but ONLY once the officer revisits this screen after a network becomes available. A
			// device that ran first-run before any network existed (e.g. via "Start Fresh") and
			// never returned to press "Set Up Secure Signing" again reaches this ceremony with the
			// recovery key legitimately never registered — this is NOT itself a bug in
			// `networks-engine.create()`'s bootstrap write, which only ever registers the founding
			// SIGNING key. Detected and reported HERE, before any Keystore mutation, so a failed
			// check costs nothing to retry and leaves no interrupted-ceremony residue for the
			// officer to clean up.
			const recoveryKey = (await native.provisionRecoveryKey(RECOVERY_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};
			const before = await resolveFreshUserEngine();
			const beforeSummary = await before.getSummary();
			const recoveryKeyRegistered = (beforeSummary?.activeKeys ?? []).some(
				(k) => k.key === recoveryKey.publicKeyCompressedHex,
			);
			if (!recoveryKeyRegistered) {
				throw Object.assign(
					new Error(
						"ProvisionSigningKeyScreen.handleRecovery: recovery key is not a registered, " +
							"active UserKey on this network — UserKey.DeleteValid cannot be satisfied. " +
							"Complete Secure Signing setup (Settings) while connected to the network first.",
					),
					{ code: "RECOVERY_KEY_NOT_REGISTERED" },
				);
			}
			const oldKey = beforeSummary?.activeKeys.find((k) => k.key !== recoveryKey.publicKeyCompressedHex)?.key;

			// Step 2 — a fresh signing key under the SAME alias (the old one is permanently
			// invalidated; the native side regenerates under this alias, `KeyAttestationHelper.kt`).
			const deviceKey = (await native.provisionDeviceKey(SIGNING_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};

			// 49-14 follow-up (interrupted-handleRecovery Keystore/metadata desync): the Keystore
			// alias above is now regenerated, UNPROMPTED, with no user-visible confirmation — but
			// local storage (`deviceUser.activeKeys[0].key`) and the network `UserKey` still name
			// the OLD key. Mark this in-progress IMMEDIATELY, before any further step that could be
			// interrupted (screen timeout, app kill, process death). While this marker is set,
			// `device-signer.ts`'s `createDeviceSigner` fails closed (`KEY_INVALIDATED_REASSOCIATE`)
			// for every routine per-use signing call site, rather than risk silently producing a
			// mismatched signature. Cleared only at the very end of this function, once BOTH
			// `persistProvisionedDeviceUser` and `persistDeviceProvisioningRecord` complete — see
			// `device-user.ts`'s `DEVICE_RECOVERY_IN_PROGRESS_KEY` doc comment.
			await markRecoveryInProgress();

			// Revoke the invalidated key FIRST, authorized by the recovery key's own signature
			// (revokeKey binds context.UserKey from `signature.signerKey` directly — unlike
			// addKey, it does not depend on array order). This collapses the user down to exactly
			// one active key (the recovery key) BEFORE the signed add below, so that add's
			// context.UserKey — bound from the engine snapshot's activeKeys[0] — is unambiguously
			// the recovery key, regardless of how UserKey rows happen to sort when read back.
			// Legal per UserKey.DeleteValid: this is never the user's LAST key while the recovery
			// key remains registered.
			if (oldKey !== undefined) {
				const revokeDigest = await before.getRevokeKeyDigest(oldKey);
				const revokeResult = (await native.signWithRecoveryKey(
					RECOVERY_KEY_ALIAS,
					nativeSignInputBase64(revokeDigest, Platform.OS),
					t("deviceSigningPromptTitle"),
					t("signingKeyRecoveryPromptSubtitle"),
					t("deviceSigningPromptNegativeButton"),
				)) as { signatureHex: string };
				await before.revokeKey(oldKey, {
					signerUserId: beforeSummary?.id ?? "",
					signerKey: recoveryKey.publicKeyCompressedHex,
					signature: revokeResult.signatureHex,
				});
			}

			const expiration = Date.now() + TEN_YEARS_MS;

			// Register the replacement key via the signed subsequent-key path, authorized by the
			// SAME recovery key (D-16/D-26a): `BiometricPrompt` + `DEVICE_CREDENTIAL` on Android 11
			// and newer. Below that version the native layer rejects `RECOVERY_UNSUPPORTED_OS`
			// before any prompt is ever shown (49-19), which this function's catch block routes to
			// the terminal `recovery-unsupported-os` phase (49-21) rather than reaching this call at
			// all. `promptNegativeButton` is now unused on every path — recovery signing is either
			// `BiometricPrompt`-driven (API 30+) or rejected before a prompt exists (below it).
			const userEngineAfterRevoke = await resolveFreshUserEngine();
			await userEngineAfterRevoke.addKey(
				{ key: deviceKey.publicKeyCompressedHex, type: UserKeyType.p256, expiration },
				async (digest: Uint8Array): Promise<Signature> => {
					const result = (await native.signWithRecoveryKey(
						RECOVERY_KEY_ALIAS,
						nativeSignInputBase64(digest, Platform.OS),
						t("deviceSigningPromptTitle"),
						t("signingKeyRecoveryPromptSubtitle"),
						t("deviceSigningPromptNegativeButton"),
					)) as { signatureHex: string };
					return {
						signerUserId: beforeSummary?.id ?? "",
						signerKey: recoveryKey.publicKeyCompressedHex,
						signature: result.signatureHex,
					};
				},
			);

			// Update the persisted local device identity so activeKeys[0] is the replacement key.
			// Keep the NETWORK user's id and name: re-minting an id forks the device from its
			// network User (loses officer standing, fails AdminSigning.UserIdValid).
			if (!beforeSummary) {
				throw new Error("ProvisionSigningKeyScreen.handleRecovery: network user summary unavailable; refusing to mint a new identity.");
			}
			await persistProvisionedDeviceUser(beforeSummary.name, deviceKey.publicKeyCompressedHex, {
				userId: beforeSummary.id,
			});

			// Refresh the 49-16 provisioning record so it never keeps pointing at the previous
			// (now-invalidated) attested key. `certificateChainBase64` is set to an empty array —
			// this ceremony calls no `produceAttestation`, so an empty chain is the truthful record
			// that no chain attests this replacement key; carrying the stale chain forward would be
			// a repudiation hazard (T-49-RECOV).
			await persistDeviceProvisioningRecord({
				recoveryPublicKeyCompressedHex: recoveryKey.publicKeyCompressedHex,
				attestedPublicKeyCompressedHex: deviceKey.publicKeyCompressedHex,
				signingKeyAlias: SIGNING_KEY_ALIAS,
				certificateChainBase64: [],
				capturedAt: Date.now(),
			});

			// Both paired writes above completed — local metadata is back in sync with the
			// Keystore alias. Only NOW is it safe to clear the in-progress marker (49-14
			// follow-up); leaving it set on any earlier failure path is the entire point.
			await clearRecoveryInProgress();

			// The recovery itself is complete: show success now, never behind the renewal below.
			setPhase("success");

			// O-01: the replacement can strand the officer's intake encryption key. Renew it in the
			// background (one extra prompt, only when stranded). It never fails or blocks the recovery
			// (WR-R3-06): a renewal still unsettled after INTAKE_RENEWAL_NOTICE_TIMEOUT_MS (a stalled
			// network write) shows the renewal-failed notice, and the real outcome replaces it if the
			// renewal settles later while the screen is still mounted.
			const noticeTimer = setTimeout(() => {
				if (mountedRef.current) setIntakeRenewalFailed(true);
			}, INTAKE_RENEWAL_NOTICE_TIMEOUT_MS);
			void renewOfficerIntakeKeyAfterKeyReplacement({
				getEngine,
				createSigner: resolveDeviceSigner,
			})
				.catch(() => "failed" as const)
				.then((renewal) => {
					clearTimeout(noticeTimer);
					console.info(`[intake-renewal] outcome=${renewal}`);
					if (mountedRef.current) setIntakeRenewalFailed(renewal === "failed");
				});
		} catch (err) {
			// T-49-USER-7 (deviceSigningError.ts:117-118) — mapDeviceSigningError/handleCeremonyError
			// below classify this into a UI-safe copy string, which necessarily discards the raw
			// error. Logging the raw value first is what actually surfaced this file's own D-16/
			// DeleteValid defect on real hardware (49-14 follow-up) — the generic "Couldn't verify
			// your biometrics" copy alone gave no way to tell a device-signing rejection from an
			// engine/schema failure like a rejected `DeleteValid` CHECK.
			console.warn("ProvisionSigningKeyScreen handleRecovery ceremony failed:", err);
			handleCeremonyError(err);
		}
	}

	/**
	 * Shared catch-path classification (D-13). `cancellation` silently restores the pre-press
	 * state — no `InlineError`, no logged fault. D-18's terminal `no-device-credential` class
	 * replaces the ENTIRE recovery body with the no-recovery message and renders no button at
	 * all — see the render branch below. `recovery-unsupported-os` (49-19/49-21, D-26a rescope)
	 * is the second terminal class: also zero-button, but reached only on a device below Android
	 * 11, where the native layer rejects before any prompt — kept ordered AFTER
	 * `no-device-credential` because a device with no screen lock at all is a more specific truth
	 * than an unsupported OS version, mirroring the native layer's own check ordering
	 * (`isDeviceSecure` before the SDK gate). Every other class renders inline and re-enables the
	 * button.
	 */
	function handleCeremonyError(err: unknown): void {
		const cls = mapDeviceSigningError(err);
		if (cls === "cancellation") {
			setPhase("idle");
			return;
		}
		if (cls === "no-device-credential") {
			setPhase("no-recovery");
			return;
		}
		if (cls === "recovery-unsupported-os") {
			setPhase("recovery-unsupported-os");
			return;
		}
		setErrorClass(cls);
		setPhase("idle");
	}

	if (phase === "success" || phase === "awaiting-network") {
		const headingKey =
			phase === "awaiting-network"
				? "signingKeyProvisioningAwaitingNetworkHeading"
				: "signingKeyProvisioningSuccessHeading";
		const bodyKey =
			phase === "awaiting-network"
				? "signingKeyProvisioningAwaitingNetworkBody"
				: "signingKeyProvisioningSuccessBody";
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<View style={localStyles.iconRow}>
					<FontAwesome6 name="circle-check" size={32} color={colors.success} />
				</View>
				<ThemedText type="defaultSemiBold" style={[localStyles.heading, { color: colors.text }]}>
					{t(headingKey)}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.textSecondary }]}>
					{t(bodyKey)}
				</ThemedText>
				{phase === "success" && intakeRenewalFailed && (
					<View testID="signing-key-intake-renewal-failed">
						<ThemedText type="small" style={[localStyles.body, { color: colors.warning }]}>
							{t("officerIntakeRenewalFailedBody")}
						</ThemedText>
					</View>
				)}
				<View testID="signing-key-provisioning-continue-button">
					<CustomButton
						title={t("signingKeyProvisioningContinueButton")}
						backgroundColor={colors.accent}
						onPress={() => navigation.goBack()}
					/>
				</View>
			</ScrollView>
		);
	}

	// 49-14 follow-up: a network resolved, but this device's User row did not — a DISTINCT,
	// actionable condition from `awaiting-network` (see `tryResolveNetworkUserEngine`'s doc
	// comment). Retry re-invokes stage 2's resolution directly (the local ceremony already ran,
	// per the `existingDeviceUser`/`existingRecord` guard, so this is a cheap network-only retry).
	if (phase === "network-user-unresolved") {
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<View style={localStyles.iconRow}>
					<FontAwesome6 name="triangle-exclamation" size={32} color={colors.warning} />
				</View>
				<ThemedText type="defaultSemiBold" style={[localStyles.heading, { color: colors.text }]}>
					{t("signingKeyProvisioningNetworkUserUnresolvedHeading")}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.textSecondary }]}>
					{t("signingKeyProvisioningNetworkUserUnresolvedBody")}
				</ThemedText>
				<View testID="signing-key-provisioning-retry-button">
					<CustomButton
						title={t("signingKeyProvisioningNetworkUserUnresolvedRetryButton")}
						backgroundColor={colors.accent}
						onPress={() => handleFirstRun()}
					/>
				</View>
				{/* UAT 62 Q: "not synced yet" and "this device has no account on the network" are
				    indistinguishable here (getCurrentUser finds no User row in both), and waiting never
				    fixes the second. Settings > Connect to existing user is not a way out: its
				    connectDevice() is still phase-gated (FeatureNotAvailableError) and an unbound device
				    lands on its noUser state. Accepting an administrator invitation is the working path. */}
				<View testID="signing-key-provisioning-accept-invitation-button">
					<CustomButton
						title={t("signingKeyProvisioningNetworkUserUnresolvedInviteButton")}
						backgroundColor={colors.card}
						size="thin"
						onPress={() => navigation.navigate("AcceptInvitation")}
					/>
				</View>
			</ScrollView>
		);
	}

	// D-18 terminal state: both keys are unrecoverable on this device. No icon, no button — see
	// this file's header comment and 49-UI-SPEC.md's "No-recovery terminal state" for why an
	// accent-colored dead-end button would be a lie here.
	if (phase === "no-recovery") {
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<ThemedText type="defaultSemiBold" style={[localStyles.heading, { color: colors.error }]}>
					{t("signingKeyProvisioningNoRecoveryHeading")}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.text }]}>
					{t("signingKeyProvisioningNoRecoveryBody")}
				</ThemedText>
			</ScrollView>
		);
	}

	// D-26a rescope terminal state (49-19/49-21): recovery is unsupported on this device's Android
	// version. Distinct from `no-recovery` above — same zero-button shape, different cause and
	// therefore different copy (see the `ScreenPhase` union comment). No icon, no button.
	if (phase === "recovery-unsupported-os") {
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<ThemedText type="defaultSemiBold" style={[localStyles.heading, { color: colors.error }]}>
					{t("signingKeyProvisioningRecoveryUnsupportedOsHeading")}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.text }]}>
					{t("signingKeyProvisioningRecoveryUnsupportedOsBody")}
				</ThemedText>
			</ScrollView>
		);
	}

	// The one place this screen reads the "needs attention" token, reserved exclusively for the
	// recovery variant's icon — distinct from InlineError's fixed "already failed" token.
	const recoveryIconColor = colors.warning;
	const icon = isFirstRun ? "fingerprint" : "key";
	const iconColor = isFirstRun ? colors.text : recoveryIconColor;
	const headingKey = isFirstRun ? "signingKeyProvisioningFirstRunHeading" : "signingKeyProvisioningRecoveryHeading";
	const bodyKey = isFirstRun ? "signingKeyProvisioningFirstRunBody" : "signingKeyProvisioningRecoveryBody";
	const buttonTitleKey = isFirstRun ? "signingKeyProvisioningSetupButton" : "signingKeyProvisioningRecoveryButton";
	const buttonTitle = t(buttonTitleKey) + (pending ? "…" : "");
	const errorMessage =
		errorClass !== undefined
			? t(DEVICE_SIGNING_ERROR_COPY_KEY[errorClass] ?? DEVICE_SIGNING_ERROR_COPY_KEY["biometric-error"]!)
			: undefined;

	return (
		<ScrollView
			testID="signing-key-provisioning-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			<View style={localStyles.iconRow}>
				<FontAwesome6 name={icon} size={32} color={iconColor} />
			</View>
			<ThemedText type="defaultSemiBold" style={[localStyles.heading, { color: colors.text }]}>
				{t(headingKey)}
			</ThemedText>
			<ThemedText type="small" style={[localStyles.body, { color: colors.textSecondary }]}>
				{t(bodyKey)}
			</ThemedText>
			<InlineError message={errorMessage} />
			<View testID="signing-key-provisioning-primary-button">
				<CustomButton
					title={buttonTitle}
					disabled={pending}
					backgroundColor={colors.accent}
					onPress={() => {
						if (isFirstRun) {
							handleFirstRun();
						} else {
							handleRecovery();
						}
					}}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	iconRow: {
		alignItems: "center",
		marginTop: 24,
		marginBottom: 12,
	},
	// Headings sit above the grey body copy; at body weight they read as just
	// another paragraph, so give them size and weight.
	heading: {
		fontSize: 20,
		lineHeight: 26,
		fontWeight: "700",
	},
	body: {
		marginTop: 8,
		marginBottom: 16,
		lineHeight: 20,
	},
});

const styles = { ...globalStyles, ...localStyles };
