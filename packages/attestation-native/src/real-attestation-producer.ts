/**
 * real-attestation-producer.ts — JS orchestration for the D-11 two-step attestation producer
 * (Phase 45-05). This is the JS half of the device-side attestation producer; all platform-API
 * calls (StrongBox/TEE/BiometricPrompt/Play Integrity) live in the 45-01/45-02 Kotlin
 * TurboModule (`./specs/NativeAttestation`) — this module owns the crypto-decision +
 * orchestration layer that must emit exactly the bytes Phase 43's shipped
 * `PlayIntegrityVerifier` consumes (`packages/vote-engine/ATTESTATION-CONTRACT.md`).
 *
 * IMPORTANT (testability): this file's TOP-LEVEL evaluation is kept pure — it does NOT import
 * the native TurboModule spec's default export at module scope, because
 * `TurboModuleRegistry.getEnforcing(...)` throws in any environment where the native module
 * isn't registered (Node/jest). The native module is accessed LAZILY (see
 * `createRealAttestationProducer` below) so that merely importing this module — and running
 * `computeBoundDigest` + the D-16b probe — works under Node/jest without the native module
 * present.
 */

import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { ANDROID_DEVICE_KEY_ATTESTATION_TAG, cborDecode, type CborValue } from '@votetorrent/vote-core'
import type { AttestationChallenge, DeviceAttestation, IOSAttestationDetails, Signature } from '@votetorrent/vote-core'
// Type-only import — erased at compile time (isolatedModules requires this to be explicit), so
// it produces NO runtime require of './specs/NativeAttestation' and therefore does not trigger
// that module's top-level `TurboModuleRegistry.getEnforcing(...)` call. The runtime value is
// obtained lazily via `require(...)` inside `getNative()` below.
import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'
// Type-only: no runtime import edge, so module purity is preserved.
import type { SecretWrapPrompt } from './secret-wrap'
import { nativeSignInputBase64 } from './native-sign-input'

// Resolved ONCE at module scope — must match packages/vote-engine/ATTESTATION-CONTRACT.md §1 and
// database/initialize.ts's registered SQL Digest() config exactly, or the producer's digest
// silently diverges from the SQL/verifier path (SIGN-05, D-06).
const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/**
 * Compute the canonical injective digest binding a challenge nonce to a device's voting public
 * key: `Digest(nonce, deviceKey)`, sha256/base64url. Field ORDER is `[nonce, deviceKey]`, never
 * reversed; never hand-roll `sha256(nonce + deviceKey)` (the encoding is length-prefixed and
 * type-tagged, not concatenation) — mirrors
 * `packages/vote-engine/src/association/verifiers/digest-binding.ts`'s `recomputeChallengeDigest`
 * byte-for-byte.
 */
export function computeBoundDigest(nonce: string, deviceKey: string): string {
	return digestFields([nonce, deviceKey], hasher, encode) as string
}

/**
 * D-16b module-load probe: assert this runtime's `digestFields` binding matches a known-good,
 * Node-computed vector BEFORE any real use. Runs at MODULE-EVALUATION time (not per-call) so a
 * multi-copy `@noble/hashes` binding anomaly (spike finding 013's class of bug) is caught loudly
 * here — fail-closed — rather than silently producing a corrupt digest that only fails
 * cryptically at the authority verifier. Real enforcement is on Hermes on-device (45-09); a
 * Node/jest pass proves the contract shape only, not the Hermes binding.
 */
const PROBE_VECTOR = { nonce: 'probe-nonce-v1', deviceKey: 'probe-devicekey-v1' }
const PROBE_EXPECTED = 'epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI' // Node-computed literal; do NOT recompute dynamically

const probeResult = digestFields([PROBE_VECTOR.nonce, PROBE_VECTOR.deviceKey], hasher, encode)
if (probeResult !== PROBE_EXPECTED) {
	throw new Error(
		`real-attestation-producer: Digest() module-load probe FAILED on this runtime ` +
			`(got ${String(probeResult)}, expected ${PROBE_EXPECTED}) — likely a multi-copy ` +
			`@noble/hashes binding anomaly (spike finding 013's class of bug). Refusing to produce ` +
			`attestations with an unverified digest implementation.`,
	)
}

/**
 * Stable module-level Keystore alias.
 *
 * CORRECTED 2026-08-24 — the previous rationale here ("D-13 requires a STABLE alias so
 * enrollment-change invalidation is detectable") was a non-sequitur and is removed.
 *
 * UPDATED (spike 104, R1d): on Android the key under this alias is now stable for a whole
 * ceremony. `provisionDeviceKey()` regenerates it (attested under `ANDROID_DEVICE_KEY_ATTESTATION_TAG`)
 * once at the ceremony's start; `produce()` answers the nonce with a THROWAWAY key
 * (`produceFreshAttestation`) and never touches this one. It used to call `produceAttestation`,
 * which deleted the key that had signed the association request and attested a new one, so the
 * challenge named a key the phone no longer held and the honest Android ceremony could never pass
 * the verifier's leaf binding. KEY NON-REUSE across ceremonies still holds: every ceremony
 * provisions a fresh voting key. Full analysis: `.planning/spikes/104-android-ceremony-key-rotation/`.
 *
 * (`setInvalidatedByBiometricEnrollment(true)` remains load-bearing for the AUTHORITY app's
 * persistent signing key, reached via `signWithDeviceKey`, which does NOT regenerate first — that
 * is D-24 leg 3, hardware-proven 2026-08-18.)
 */
const KEY_ALIAS = 'VOTETORRENT_DEVICE_KEY_V1'

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — NOT a top-level
 * `import` and NOT `import()` (bundler-dependent: a single-file bundler without code-splitting
 * can hoist a dynamic `import()` of a local relative module into a top-level static import,
 * defeating the deferral). `require()` inside a function body is unambiguously lazy under both
 * Metro's CommonJS-based module runtime and Jest/Babel's CommonJS transform — the module factory
 * only executes when this function is actually called. NEVER call this at module scope —
 * `getEnforcing(...)` throws in any environment where `AttestationNative` isn't registered
 * (Node/jest), which would break importing this module (and therefore `computeBoundDigest` + the
 * D-16b probe above) under test.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

/**
 * `TextEncoder`/`btoa` ARE globals on Hermes/RN and Node (used as bare globals elsewhere in the
 * codebase — e.g. `packages/vote-engine/src/utils.ts`'s `bytesToBase64url` — proven available
 * on-device; RN/Hermes has no `Buffer`, but these two are proven present). This package ships
 * SOURCE directly (no build step) and is type-checked as part of MULTIPLE consuming programs with
 * different `compilerOptions.types` (this package's own `tsconfig.json` includes `"node"`; the
 * app's `@react-native/typescript-config`-based program does not) — a bare, undeclared-ambient
 * reference to `TextEncoder`/`btoa` fails to compile under the latter. Accessing them via a
 * `globalThis` cast (rather than declaring ambient globals, which would collide with `@types/node`
 * wherever it IS present) compiles identically under both.
 */
type Base64GlobalEnv = {
	TextEncoder: new () => { encode(input: string): Uint8Array }
	btoa: (data: string) => string
	atob: (data: string) => string
}
const { TextEncoder: TextEncoderCtor, btoa: btoaFn, atob: atobFn } = globalThis as unknown as Base64GlobalEnv

/**
 * Base64-encode the UTF-8 bytes of a string (STANDARD alphabet, no URL-safe substitution) — the
 * native side decodes this with `Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)`
 * (`AttestationNativeModule.kt`), which expects the standard `+`/`/` alphabet, not base64url.
 * Mirrors `packages/vote-engine/src/utils.ts`'s `bytesToBase64url` pattern (minus the URL-safe
 * substitution).
 */
function base64FromUtf8(value: string): string {
	const bytes = new TextEncoderCtor().encode(value)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

/** Standard-alphabet base64 of raw bytes (NOT base64url) — `signWithDeviceKey`'s digest contract. */
function base64FromBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

/** Decode standard-alphabet base64 to bytes. */
function bytesFromBase64(value: string): Uint8Array {
	const binary = atobFn(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

// ---- iOS domain-separation tags (ATTESTATION-CONTRACT-IOS.md §3.1 / §4) ----
// These strings are part of the wire contract. The authority RECOMPUTES both digests from its own
// held values; changing a tag here without changing the verifier silently breaks every iOS
// association with an opaque signature failure.
const IOS_ASSERTION_TAG = 'votetorrent/ios-assertion/v1'
const IOS_POP_TAG = 'votetorrent/ios-pop/v1'

/**
 * §3.1 ASSERTION_DIGEST — the value `generateAssertion` cross-signs, binding `K_vote` to the
 * attested identity. Field 3 restates the vote key even though BOUND_DIGEST already commits to it,
 * so the binding is self-evident to a verifier holding the submitted key rather than transitive.
 *
 * Computed HERE, in JS, and passed to Swift finished — `digestFields`' length-prefixed, type-tagged
 * encoding must never be re-derived in a second language (SIGN-05). Mirrors
 * `verifyAssertion`'s recomputation in vote-engine.
 */
export function computeAssertionDigest(boundDigest: string, voteKeyCompressedHex: string): string {
	return digestFields([IOS_ASSERTION_TAG, boundDigest, voteKeyCompressedHex], hasher, encode) as string
}

/**
 * §4 POP_DIGEST — proof that the device holds `K_vote`'s PRIVATE key. Neither the attestation nor
 * the assertion proves this: both are signed by `K_att`. Without it a device could attest and
 * assert over a `K_vote` it does not control. No Android counterpart (§6).
 */
export function computePopDigest(boundDigest: string): string {
	return digestFields([IOS_POP_TAG, boundDigest], hasher, encode) as string
}

/**
 * Read the replay counter out of an App Attest assertion.
 *
 * The assertion is CBOR `{ signature, authenticatorData }`; `authenticatorData` is
 * `rpIdHash(32) || flags(1) || counter(4 big-endian)`. The byte offsets below are the SAME ones
 * `verifyAssertion` uses (`app-attest-assertion.ts` §8.10) — they must stay in step.
 *
 * The authority does NOT trust this value: it reads its own counter from the assertion. Carrying it
 * lets `AssociationAssociateBuilder` reject a malformed submission early and legibly.
 */
function readAssertionCounter(assertionBase64: string): number {
	const decoded = cborDecode(bytesFromBase64(assertionBase64))
	if (!(decoded instanceof Map)) throw new Error('iOS assertion is not a CBOR map')
	const authenticatorData = (decoded as Map<CborValue, CborValue>).get('authenticatorData')
	if (!(authenticatorData instanceof Uint8Array) || authenticatorData.length < 37) {
		throw new Error('iOS assertion authenticatorData is missing or too short')
	}
	return ((authenticatorData[33]! << 24) >>> 0) + (authenticatorData[34]! << 16) +
		(authenticatorData[35]! << 8) + authenticatorData[36]!
}

/**
 * `Platform.OS`, read through a scoped require for the SAME reason `getNative()` uses one: this
 * module's top-level evaluation is kept pure so importing it under Node/jest (for
 * `computeBoundDigest` and the D-16b probe) never touches the React Native runtime.
 */
function getPlatformOS(): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see above.
	return (require('react-native') as { Platform: { OS: string } }).Platform.OS
}

/** Optional arguments to `signDeviceKeyDigest`. */
export interface SignDeviceKeyDigestOptions {
	/** Biometric prompt copy. Used whole or rejected; never merged with the defaults. */
	prompt?: SecretWrapPrompt
	/**
	 * Abandons the sign before it reaches native (review WR-01). Checked once, right before the
	 * native `signWithDeviceKey` call and after every await this method makes (the device-key
	 * lookup), so an abort that lands while the lookup is pending never raises a prompt. An aborted
	 * signal rejects with an `AbortError` whose `code` is `ABORTED`, and native is never called.
	 * Once native has been called, cancel the sign with `cancelPendingSign` instead.
	 */
	signal?: AbortSignal
}

/** The rejection of a sign whose `signal` aborted before the native call. */
function abortedBeforeNativeSign(): Error {
	const err = new Error('signDeviceKeyDigest: abandoned before the native sign') as Error & { code: string }
	err.name = 'AbortError'
	err.code = 'ABORTED'
	return err
}

/**
 * The prompt copy of the registration and continuity ceremonies. Changing these strings changes
 * those ceremonies' biometric prompts.
 */
export const DEFAULT_DEVICE_KEY_SIGN_PROMPT: Readonly<SecretWrapPrompt> = Object.freeze({
	title: 'Confirm this request',
	subtitle: 'Sign this request with your device key',
	negativeButton: 'Cancel',
})

function resolveSignPrompt(options: SignDeviceKeyDigestOptions | undefined): SecretWrapPrompt {
	const prompt = options?.prompt
	if (prompt === undefined) return DEFAULT_DEVICE_KEY_SIGN_PROMPT
	const ok = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0
	if (!ok(prompt.title) || !ok(prompt.subtitle) || !ok(prompt.negativeButton)) {
		throw new Error('signDeviceKeyDigest: prompt.title, prompt.subtitle and prompt.negativeButton must be non-empty strings')
	}
	return prompt
}

/**
 * Package-local three-method producer shape (D-08 — structurally, not nominally, typed).
 *
 * `signDeviceKeyDigest` (plan 51-14, closing the Known Gap flagged by 51-11/51-13): signs an
 * arbitrary caller-supplied digest under whichever key currently sits under `KEY_ALIAS`, via the
 * existing `native.signWithDeviceKey` (Phase 49, D-06/D-04) — the SAME primitive `produceIos`
 * already calls for its §4 proof-of-possession step. This is wiring, not new native work. It is
 * the seam `apps/VoteTorrentVoter/src/engines/attestation-producer.ts`'s `AttestationProducer`
 * interface declares (optionally, for structural flexibility) so the voter's self-signed
 * association-request/attestation-answer submissions (D-02/D-18) can sign directly under the
 * hardware-backed P-256 device key instead of throwing "Device attestation signer is not
 * available yet" (`ConfirmationScreen.tsx`'s guard).
 */
interface RealAttestationProducer {
	/**
	 * `reprovisioned` is TRUE when the native side found the stored vote key DESTROYED (a biometric
	 * re-enrolment) and minted a replacement. The device key has therefore CHANGED: any challenge
	 * already issued against the old one is void, and any existing Association no longer describes
	 * this device. `voteKeyProbe` carries the raw liveness verdict for diagnostics.
	 */
	provisionDeviceKey(): Promise<{ publicKey: string; reprovisioned?: boolean; voteKeyProbe?: string }>
	/**
	 * READ-ONLY lookup of the CURRENT device key (63-18 fix). Normalized exactly like
	 * `provisionDeviceKey`'s `publicKey`, but never generates, rotates, deletes or prompts. Rejects
	 * with `code` `DEVICE_KEY_ABSENT` / `DEVICE_KEY_INVALIDATED` (see `attestation-failure.ts`).
	 * Use this for every LOOKUP (association queries, status); `provisionDeviceKey` is for CREATION.
	 */
	getCurrentDeviceKey(): Promise<{ publicKey: string }>
	produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
	/**
	 * Signs `digest` under the device key. `options.prompt` optionally supplies the biometric prompt
	 * copy (D-09 vote copy is supplied by the caller); omitted, the legacy ceremony copy is used.
	 */
	signDeviceKeyDigest(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature>
}

/**
 * iOS production path (ATTESTATION-CONTRACT-IOS.md §3.4). Deliberately a separate function rather
 * than inline branches: almost nothing about the iOS ceremony resembles Android's. Android's
 * Keystore key both carries the attestation AND signs votes; Apple's App Attest key can ONLY
 * produce assertions, so iOS manages TWO keys and must cross-sign them together (§0).
 *
 * Call order is REQUIRED and encoded here:
 *   1. BOUND_DIGEST, then ASSERTION_DIGEST (both in JS, both passed down finished).
 *   2. produceAttestation — native does attestKey (§2) then generateAssertion (§3.2).
 *   3. signWithDeviceKey over POP_DIGEST (§4) — a SEPARATE call, because it needs the biometric
 *      prompt the App Attest path never raises.
 */
async function produceIos(
	native: NativeAttestationSpec,
	challenge: AttestationChallenge,
	boundDigest: string,
	enableDeviceCheck: boolean,
): Promise<DeviceAttestation> {
	// challenge.deviceKey IS K_vote in compressed SEC1 hex — the same form provisionDeviceKey
	// returned and the authority issued the challenge against.
	const assertionDigest = computeAssertionDigest(boundDigest, challenge.deviceKey)

	const result = (await native.produceAttestation(KEY_ALIAS, boundDigest, assertionDigest, enableDeviceCheck)) as {
		attestationObjectBase64: string
		assertionBase64: string
		appAttestKeyId: string
		publicKeyCompressedHex: string
		attestationTimeMillis: number
		deviceCheckToken: string
	}

	// §3.4 CALLER OBLIGATION. Native reads whatever key currently sits under the vote alias; if that
	// is not the key we hashed into assertionDigest, the assertion binds the WRONG key and the
	// authority rejects with an opaque "K_vote is not bound to this attestation". Catch it here,
	// where the message can say what actually happened. This is reachable in practice: a biometric
	// re-enrolment invalidates the vote key, and a re-provision mints a different one.
	if (result.publicKeyCompressedHex !== challenge.deviceKey) {
		throw new Error(
			'iOS attestation aborted: the vote key under the alias no longer matches the key this ' +
				'challenge was issued against (the device key was likely re-provisioned after a ' +
				'biometric change). Request a fresh challenge for the current key.',
		)
	}

	// §4 proof of possession — signWithDeviceKey takes PLAIN base64 of the RAW 32 digest bytes,
	// never base64url and never UTF-8-of-a-string. The base64 ENCODING is identical on both platforms,
	// but the signing DOMAIN is not: this PoP deliberately pre-hashes utf8(POP_DIGEST) for a
	// prehash:false verifier (ATTESTATION-CONTRACT-IOS.md §4) and is NOT routed through nativeSignInput*.
	const popDigest = computePopDigest(boundDigest)
	const popInput = base64FromBytes(hasher(new TextEncoderCtor().encode(popDigest)))
	const pop = (await native.signWithDeviceKey(
		KEY_ALIAS,
		popInput,
		'Confirm your device',
		'Prove this device holds your voting key',
		'Cancel',
	)) as { signatureHex: string }

	const { certificateChain, environment } = readAttestationObject(result.attestationObjectBase64)

	const platformDetails: IOSAttestationDetails = {
		type: 'iOS',
		secureEnclavePublicKey: challenge.deviceKey,
		appAttestKeyId: result.appAttestKeyId,
		assertion: result.assertionBase64,
		assertionCounter: readAssertionCounter(result.assertionBase64),
		popSignature: pop.signatureHex,
		boundDigest,
		environment,
	}
	// Bar A excludes DeviceCheck (it would need an authority->Apple round trip, breaking the offline
	// verifier posture). Native returns '' when the leg is off; omit the field rather than submit an
	// empty string that reads as "a token was produced".
	if (result.deviceCheckToken !== '') platformDetails.deviceCheckToken = result.deviceCheckToken

	return {
		publicKey: challenge.deviceKey,
		// iOS has no stable device id by design; the App Attest key id IS the app-install identity,
		// which is exactly what DeviceAttestation.deviceId documents for this platform.
		//
		// WR-02 (51-REVIEW): app-install identity is NOT device identity, and the difference is
		// load-bearing downstream. `provisionDeviceKey` regenerates this id on every run and
		// `attestKey` is once-per-key, so the same phone presents a different value each ceremony.
		// `AssociationEngine.associate`'s D-06 device-uniqueness guard keys on exactly this field
		// and is therefore INERT on iOS — see ATTESTATION-CONTRACT-IOS.md §5.1. Do not treat this
		// value as a Sybil control.
		deviceId: result.appAttestKeyId,
		attestationTime: result.attestationTimeMillis,
		attestationStatement: result.attestationObjectBase64,
		certificateChain,
		platformDetails,
	}
}

/**
 * Pull the two things the model needs out of the CBOR attestation object: `x5c` (so
 * `DeviceAttestation.certificateChain` carries the chain, §7) and the environment implied by the
 * authData `aaguid`.
 *
 * The environment is DERIVED, never assumed. Measured 2026-08-25 (spike 085): a build with no
 * entitlements file still received a `development` attestation — the provisioning profile decides,
 * not the plist and not a documented default. The aaguid is the only thing that distinguishes the
 * two, and a development attestation must NEVER be accepted by a production authority.
 */
function readAttestationObject(attestationObjectBase64: string): {
	certificateChain: string[]
	environment: 'development' | 'production'
} {
	const decoded = cborDecode(bytesFromBase64(attestationObjectBase64))
	if (!(decoded instanceof Map)) throw new Error('iOS attestation object is not a CBOR map')
	const map = decoded as Map<CborValue, CborValue>

	const attStmt = map.get('attStmt')
	if (!(attStmt instanceof Map)) throw new Error('iOS attestation object has no attStmt map')
	const x5c = (attStmt as Map<CborValue, CborValue>).get('x5c')
	if (!Array.isArray(x5c) || x5c.length === 0) throw new Error('iOS attestation attStmt.x5c is missing or empty')
	const certificateChain = (x5c as CborValue[]).map(c => {
		if (!(c instanceof Uint8Array)) throw new Error('iOS attestation x5c entry is not a byte string')
		return base64FromBytes(c)
	})

	const authData = map.get('authData')
	if (!(authData instanceof Uint8Array) || authData.length < 53) {
		throw new Error('iOS attestation authData is missing or too short to carry an aaguid')
	}
	// authData: rpIdHash(32) | flags(1) | counter(4) | aaguid(16) | credIdLen(2) | credId...
	let aaguid = ''
	for (let i = 37; i < 53; i++) aaguid += String.fromCharCode(authData[i]!)
	const environment = aaguid.startsWith('appattestdevelop') ? 'development' : 'production'

	return { certificateChain, environment }
}

/**
 * Injectable factory driving the D-11 two-step TurboModule seam. Takes a plain
 * `{ enablePlayIntegrity: boolean }` and passes it STRAIGHT into native `produceFreshAttestation` —
 * this package holds NO app-level flag constant; the boolean is the ONLY injection point (D-12),
 * wired by the app call site (45-08's `resolvePlayIntegrityEnabled()`).
 */
export function createRealAttestationProducer(opts: {
	enablePlayIntegrity: boolean
	/**
	 * iOS DeviceCheck leg, the analogue of `enablePlayIntegrity` (D-12). Defaults to FALSE: integrity
	 * bar A (the settled decision, spike 082) excludes DeviceCheck because it requires an
	 * authority->Apple round trip that would break D-04's offline verifier posture. Present so a
	 * future move to bar B is a flag, not a code change.
	 */
	enableDeviceCheck?: boolean
}): RealAttestationProducer {
	// Cache of the CURRENT device public key, set by `provisionDeviceKey()`/`getCurrentDeviceKey()`.
	// `signDeviceKeyDigest` (plan 51-14) reads it to report an honest `Signature.signerKey` without
	// an extra native round trip on its hot path. Scoped to ONE producer instance/ceremony.
	//
	// `produce()` no longer changes it on either platform (spike 104, R1d): Android answers the nonce
	// with a throwaway key, so the key that signed the association request also signs the
	// attestation answer — the `requesterKey` the authority checks both against. Before R1d,
	// Android's `produce()` replaced the key under `KEY_ALIAS` and the answer was signed by a key the
	// request never named, which failed closed at the authority.
	let currentDeviceKey: string | undefined

	async function doProvisionDeviceKey(): Promise<{ publicKey: string; reprovisioned?: boolean; voteKeyProbe?: string }> {
		const native = getNative()
		// Android: the voting key carries its own attestation chain (spike 104, R1d) — generated
		// under a fixed tag, because the nonce it will answer does not exist yet. iOS attests a
		// separate App Attest key and is unchanged.
		const provisioned = getPlatformOS() === 'ios'
			? native.provisionDeviceKey(KEY_ALIAS)
			: native.provisionAttestedDeviceKey(KEY_ALIAS, base64FromUtf8(ANDROID_DEVICE_KEY_ATTESTATION_TAG))
		const result = (await provisioned) as {
			publicKeyBase64?: string
			publicKeyCompressedHex?: string
			keyAlias: string
			reprovisioned?: boolean
			voteKeyProbe?: string
		}

		// BOTH platforms hand back `publicKeyCompressedHex`, and it is the only form this returns
		// (spike 103). The caller (ConfirmationScreen) feeds it straight into the association
		// request, `issueAttestationChallenge` (as `challenge.deviceKey`) and the stored Association,
		// so it must be the one form every consumer decodes:
		//   - every `SignatureValidP256` CHECK decodes the key as HEX, so Android's other field,
		//     `publicKeyBase64` (X.509 SPKI DER), was refused at the first self-signed row (B-13);
		//   - `VoteBlockVoter.DeviceKey` must equal `Association.DeviceKey` exactly AND verify as hex;
		//   - iOS: `produceIos`'s §3.4 obligation compares against native's `publicKeyCompressedHex`,
		//     and `verifyCrossSign` parses `challenge.deviceKey` as a P-256 point;
		//   - Android: `verifyKeyAttestation` compares the attested leaf's key to
		//     `challenge.deviceKey` as POINTS, so the hex challenge binds the same key the SPKI did.
		const publicKey = result.publicKeyCompressedHex
		// Fail closed. Reading an absent field yields `undefined`, which flows on as a challenge
		// bound to the string "undefined" and surfaces only as an opaque signature failure at the
		// authority. That is precisely how the iOS field mismatch survived a clean typecheck, a
		// green unit test and a successful bundle: nothing here ever asserted the field was there.
		if (typeof publicKey !== 'string' || publicKey === '') {
			throw new Error(
				`provisionDeviceKey: native resolved no publicKeyCompressedHex ` +
					`(got: ${Object.keys(result).join(', ') || 'no keys'}) — refusing to issue a challenge ` +
					'against an undefined device key.',
			)
		}
		currentDeviceKey = publicKey
		return { publicKey, reprovisioned: result.reprovisioned, voteKeyProbe: result.voteKeyProbe }
	}

	// Same field as provision: the compressed hex on both platforms (see the notes above).
	async function doGetCurrentDeviceKey(): Promise<{ publicKey: string }> {
		const native = getNative()
		const result = (await native.getCurrentDeviceKey(KEY_ALIAS)) as {
			publicKeyBase64?: string
			publicKeyCompressedHex?: string
		}
		const publicKey = result.publicKeyCompressedHex
		if (typeof publicKey !== 'string' || publicKey === '') {
			throw new Error(
				`getCurrentDeviceKey: native resolved no publicKeyCompressedHex ` +
					`(got: ${Object.keys(result).join(', ') || 'no keys'}) — refusing to look up an undefined device key.`,
			)
		}
		// The key under the alias IS the current key, so refreshing the cache keeps it consistent.
		currentDeviceKey = publicKey
		return { publicKey }
	}

	return {
		provisionDeviceKey: doProvisionDeviceKey,
		getCurrentDeviceKey: doGetCurrentDeviceKey,

		async produce(challenge: AttestationChallenge): Promise<DeviceAttestation> {
			// BOUND_DIGEST is IDENTICAL on both platforms (ATTESTATION-CONTRACT-IOS.md §1) — it is the
			// one value the two contracts share. Everything after this point diverges.
			const boundDigest = computeBoundDigest(challenge.nonce, challenge.deviceKey)
			const native = getNative()

			if (getPlatformOS() === 'ios') {
				const attestation = await produceIos(native, challenge, boundDigest, opts.enableDeviceCheck ?? false)
				// produceIos already threw (§3.4 CALLER OBLIGATION) if the vote key under KEY_ALIAS did
				// not match challenge.deviceKey — reaching here means the two are proven equal.
				currentDeviceKey = challenge.deviceKey
				return attestation
			}

			// ---- Android ----
			// Three distinct nonce forms (Pitfall 5) — never reuse one variable for two:
			//   (1) challenge.nonce            — RAW authority nonce, used ONLY for platformDetails.nonce below.
			//   (2) boundDigest                — BOUND_DIGEST base64url string, sent AS-IS to Play Integrity setNonce (§2).
			//   (3) boundDigestUtf8Base64      — base64(utf8(BOUND_DIGEST)), sent to Keystore setAttestationChallenge (§3).
			// Do not symmetrize (2) and (3) — this asymmetry is intentional and matches the shipped verifier exactly.
			const boundDigestUtf8Base64 = base64FromUtf8(boundDigest)

			// Spike 104 (R1d): a throwaway key answers the nonce; the voting key under KEY_ALIAS stays
			// and later signs the answer. No biometric prompt here — the throwaway key never signs.
			const result = (await native.produceFreshAttestation(KEY_ALIAS, boundDigest, boundDigestUtf8Base64, opts.enablePlayIntegrity)) as {
				certificateChainBase64: string[]
				deviceKeyCertificateChainBase64?: string[]
				integrityToken: string
				androidId: string
				attestationTimeMillis: number
				publicKeyCompressedHex?: string
			}

			// CALLER OBLIGATION, the Android twin of iOS §3.4: the voting key's chain must be the key the
			// challenge names. They differ if the key was re-provisioned after the request was signed;
			// say so here rather than let the authority refuse with an opaque leaf-binding reason.
			if (result.publicKeyCompressedHex !== challenge.deviceKey) {
				throw new Error(
					'Android attestation aborted: the voting key under the alias no longer matches the key this ' +
						'challenge was issued against (it was re-provisioned after the request was signed). ' +
						'Start a new request for the current key.',
				)
			}
			const deviceKeyCertificateChain = result.deviceKeyCertificateChainBase64
			if (!Array.isArray(deviceKeyCertificateChain) || deviceKeyCertificateChain.length === 0) {
				throw new Error('produceFreshAttestation: native resolved no deviceKeyCertificateChainBase64 — refusing to answer without the voting key\'s own chain.')
			}

			return {
				publicKey: challenge.deviceKey,
				deviceId: result.androidId,
				attestationTime: result.attestationTimeMillis,
				// The THROWAWAY key's nonce-bound chain; native already drops the trailing root (D-15b).
				certificateChain: result.certificateChainBase64,
				platformDetails: {
					type: 'Android',
					safetyNetAttestation: result.integrityToken,
					keystorePublicKey: challenge.deviceKey,
					// RAW challenge.nonce — NOT BOUND_DIGEST (Pitfall 5; AssociationAssociateBuilder's
					// validateNonceCrossField rejects BOUND_DIGEST here with NONCE_MISMATCH).
					nonce: challenge.nonce,
					// The voting key's own chain (provisioning tag) — what proves the key that votes is
					// hardware-backed (T-51-02-01); the verifier checks both chains.
					deviceKeyCertificateChain,
				},
			}
		},

		/**
		 * D-02/D-18 (plan 51-14, closing 51-11/51-13's Known Gap): sign an arbitrary caller-supplied
		 * digest under whichever key currently sits under `KEY_ALIAS`, via the existing
		 * `native.signWithDeviceKey`. Does NOT regenerate/reprovision the key: `signWithDeviceKey`
		 * deliberately never does that itself (module doc comment above, `:88`), and this method
		 * never calls `produceAttestation`.
		 *
		 * PLATFORM ASYMMETRY — load-bearing, defined once in `native-sign-input.ts`
		 * (`nativeSignInputBase64`): the schema verifier (`verifySigP256`, noble default prehash:true)
		 * checks ECDSA(sha256(digest)); Android native hashes internally (pass the digest as-is) while
		 * iOS native signs its input as the final hash (pass sha256(digest)). Digest contract
		 * otherwise unchanged: PLAIN standard-alphabet base64 of whichever 32 raw bytes are signed.
		 *
		 * `options.prompt` is display copy only: it never enters the signed bytes, and iOS shows only
		 * the subtitle (as the LAContext reason). An invalid prompt is refused before any native call.
		 * `options.signal`, already aborted when the native call is due, rejects `ABORTED` without
		 * calling native (see `SignDeviceKeyDigestOptions.signal`).
		 */
		async signDeviceKeyDigest(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature> {
			const prompt = resolveSignPrompt(options)
			const native = getNative()
			let signerKey = currentDeviceKey
			if (signerKey === undefined) {
				// Defensive fallback only — every real caller provisions or looks the key up first. The
				// device key is a PERSISTENT hardware key that can already exist under KEY_ALIAS from a
				// prior app session; name it with the READ-ONLY lookup. Never provision here: on Android
				// that would replace the voting key with a new one just to sign with it.
				;({ publicKey: signerKey } = await doGetCurrentDeviceKey())
			}

			// See this method's platform-asymmetry doc comment above — iOS must pre-hash, Android must not.
			const digestBase64 = nativeSignInputBase64(digest, getPlatformOS())
			// Review WR-01: the last point before native, after every await above. Nothing below awaits
			// before the native call, so an abort after this line comes after the call is issued.
			// TurboModule calls reach native in the order they were made, and the Android sign
			// reserves its pending-sign gate on the calling (native-modules) thread before it posts
			// the prompt, so a `cancelPendingSign` issued after this check always finds the
			// reservation and settles the sign CANCELED: no orphan prompt. (iOS reserves its slot
			// synchronously in the method body too.)
			if (options?.signal?.aborted) throw abortedBeforeNativeSign()
			const result = (await native.signWithDeviceKey(
				KEY_ALIAS,
				digestBase64,
				prompt.title,
				prompt.subtitle,
				prompt.negativeButton,
			)) as { signatureHex: string }

			return {
				// Already compact, low-S hex (`derToCompactLowS`, 49-04) — do NOT re-normalize, mirrors
				// `apps/VoteTorrentAuthority/src/engines/device-signer.ts`'s identical contract.
				signature: result.signatureHex,
				signerKey,
				// D-02/D-04: a prospective registrant/association-request self-signer has no user id —
				// association-engine.ts's `submitAssociationRequest` documents that `signerUserId` is
				// NEVER read on this path. Mirrors `StubAttestationProducer.signDeviceKeyDigest`'s
				// identical empty-string convention.
				signerUserId: '',
			}
		},
	}
}
