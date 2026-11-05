# Attestation Contract (iOS): App Attest wire format and the K_vote cross-sign

Sibling of `packages/vote-engine/ATTESTATION-CONTRACT.md`, which locks the **Android** wire format.
This document locks the **iOS** one. Read the Android contract first — §1 here is deliberately
identical to §1 there, and the whole design is "keep everything that can be kept, and state
precisely where iOS cannot follow."

> **PROVEN ON REAL HARDWARE, 2026-08-25** (spike 085 — iPhone 13 / iOS 26.6.1, free personal team,
> Apple team `94TY7UR2W5`). A genuine Apple App Attest attestation was produced on-device and
> verified end to end by `verifyAppAttest` with the **real Apple App Attest Root CA** pinned:
> `ok=true`. The §2 `clientDataHash` derivation, the credCert nonce OID, the keyId binding, the
> rpIdHash, the counter and the aaguid all hold against Apple's own bytes. The vendored 104-line
> CBOR decoder parsed a real 5,873-byte attestation object.
>
> Also measured: **App Attest works under a FREE personal team** — no paid Apple Developer Program
> membership was needed to produce or verify an attestation. And a build with **no entitlements file
> at all** received a `development` attestation (aaguid `appattestdevelop`, receipt `sandbox`), so
> the absence of the entitlement does NOT imply production — the provisioning profile decides.
>
> **§3 and §4 are ALSO hardware-proven** (spike 085 run 2, real digests injected):
> `verifyCrossSign -> ok=true`, a real Apple assertion binding a real Secure Enclave voting key with
> a real proof-of-possession signature. That run found a genuine bug in §3.3's implementation — the
> assertion signature is DOUBLE-hashed and was being verified as single-hashed, which a synthetic
> fixture could not catch because it generated signatures the same wrong way. See §3.3.
>
> Still unproven: biometric-set invalidation (`.biometryCurrentSet`) and the `LAError` code table —
> neither is Team-ID-blocked; they need a deliberate Face ID re-enrolment.

**Status:** the wire format below is implemented by
`src/association/verifiers/app-attest.ts` + `verifiers/app-attest-assertion.ts` and covered by
`test/app-attest-verifier.spec.ts` against SYNTHETIC fixtures. It has **never seen a real device** —
`DCAppAttestService` requires a signed build and a physical iPhone. Treat every claim here as
specified-and-self-consistent, not verified, until spike 083 leg 5 runs.
(Originally derived in spike 084; moved here verbatim in Phase 51.)

---

## 0. Why iOS needs a cross-sign at all

Android's Keystore key **both** carries the attestation certificate chain **and** signs votes. One
key, one attestation, done.

Apple's App Attest key can only ever be used through `generateAssertion`. It **cannot sign arbitrary
payloads**, so it cannot be the voting key. iOS therefore has two keys:

| | Key | Provenance | Used for |
|---|---|---|---|
| `K_att` | App Attest key | `DCAppAttestService.generateKey()` | attestation + assertions only |
| `K_vote` | Secure Enclave P-256 key | `SecKeyCreateRandomKey` w/ `kSecAttrTokenIDSecureEnclave` | signing ballots — this is `challenge.deviceKey` |

`K_vote` has **no attestation of its own**. Apple exposes no key-attestation API for arbitrary
Secure Enclave keys. The cross-sign is what connects the attested identity to the voting key, and
§5 states exactly how strong that connection is and is not.

---

## 1. The canonical bound value — IDENTICAL to Android

```ts
// packages/vote-engine/src/association/verifiers/digest-binding.ts
export function recomputeChallengeDigest (nonce: string, deviceKey: string): string {
  return digestFields([nonce, deviceKey], hasher, encode) as string   // sha256 / base64url
}
```

`BOUND_DIGEST = Digest(challenge.nonce, challenge.deviceKey)`, a **base64url STRING**.

On iOS, `challenge.deviceKey` is `K_vote`'s 33-byte compressed SEC1 point, hex-encoded
(`publicKeyCompressedHex`) — the same `UserKey.PubKey` form Android registers. `BOUND_DIGEST`
therefore already commits to the voting key, exactly as on Android.

**This function is shared, not reimplemented.** The producer's JS layer calls the same
`computeBoundDigest` that `packages/attestation-native/src/real-attestation-producer.ts` uses today
(SIGN-05: no independent reimplementation).

---

## 2. Attestation side — `clientDataHash` for `attestKey`

The device calls:

```swift
service.attestKey(keyId, clientDataHash: SHA256(utf8(BOUND_DIGEST)))
```

**Contract:** `clientDataHash` is the **raw 32 SHA-256 bytes of the UTF-8 encoding of the
`BOUND_DIGEST` string**. Not base64url-decoded bytes, not the string itself.

This is a **third** encoding of `BOUND_DIGEST`, alongside Android's two:

| Consumer | Form | Type |
|---|---|---|
| Play Integrity `setNonce` (Android §2) | `BOUND_DIGEST` verbatim | base64url string |
| Keystore `setAttestationChallenge` (Android §3) | `utf8(BOUND_DIGEST)` | bytes of that string |
| **iOS `attestKey` `clientDataHash`** | **`SHA256(utf8(BOUND_DIGEST))`** | **32 raw bytes** |

Apple then derives a **fourth** value the device never sees and the verifier must recompute:

```
attestationNonce = SHA256( authenticatorData ‖ clientDataHash )
```

and places it in the credCert extension **OID `1.2.840.113635.100.8.2`**, wrapped as
`SEQUENCE { [1] { OCTET STRING nonce } }`.

> `clientDataHash` is concatenated **RAW**. It is already a hash; it is **not** hashed again. This
> spike's first pass got that wrong (an extra `SHA256`), which is precisely the class of silent
> wrong-bytes error this document exists to prevent.

Verified by spike 081's `verify-app-attest.ts` (15/15, incl. a tampered-nonce negative).

---

## 3. The cross-sign — `clientDataHash` for `generateAssertion`

This is the part with no Android counterpart, and the part 083's placeholder
(`boundDigest + "|" + voteKeyHex`) got wrong. **Naive string concatenation is forbidden here for
the same reason the Android contract forbids `sha256(nonce + deviceKey)`: it is not injective.**

### 3.1 The assertion digest

```ts
const ASSERTION_DIGEST = digestFields(
  ['votetorrent/ios-assertion/v1', BOUND_DIGEST, voteKeyCompressedHex],
  hasher,   // sha256
  encode    // base64url
) as string
```

- Computed in **JS**, in the producer's orchestration layer — exactly where `computeBoundDigest`
  already lives. It is **not** computed in Swift: `digestFields`' length-prefixed, type-tagged
  encoding must not be re-derived in a second language (SIGN-05). Swift receives the finished
  string.
- Field 1 is a **domain-separation tag**. Without it the assertion and the attestation could be
  asked to sign related values, and a signature produced for one purpose could be argued into the
  other. It costs one field.
- Field 3 restates `voteKeyCompressedHex` even though `BOUND_DIGEST` already commits to it. This is
  deliberate: it makes the binding **self-evident to a verifier that holds the submitted vote key**,
  rather than transitive through a digest it must first trust.

### 3.2 What the device passes to Apple

```swift
service.generateAssertion(keyId, clientDataHash: SHA256(utf8(ASSERTION_DIGEST)))
```

Same shape as §2 — `SHA256` of the UTF-8 bytes of the base64url string. The symmetry with §2 is
intentional and load-bearing: **one rule** ("hash the UTF-8 of the base64url string") covers both
`clientDataHash` values, so there is exactly one place to get it wrong instead of two.

### 3.3 What Apple returns

CBOR `{ signature: bytes, authenticatorData: bytes }`, where

```
assertionNonce = SHA256( authenticatorData ‖ clientDataHash )
```

and the signature is a standard **ECDSA-SHA256 signature over `assertionNonce`** — so the digest
actually signed is `SHA256(assertionNonce)`, a **second** hash. Verified against `K_att`'s public
key, which the authority extracted from the credCert during §2 and stored.

> **This is NOT the same shape as §2, despite appearances.** In §2 the nonce is compared as a value
> (it sits in the credCert extension); here it is *signed*, and signing hashes it again. Implementing
> this with the nonce as the final digest (`prehash: false`) produces a verifier that rejects every
> real Apple assertion — and, because a synthetic fixture will happily generate signatures the same
> wrong way, a fully green test suite. That is exactly what happened; it was caught only by a real
> device assertion (spike 085, run 2). Verify against hardware before trusting this section.

### 3.4 Producer call order (this order is required)

1. `provisionDeviceKey()` → `{ publicKeyCompressedHex: K_vote, appAttestKeyId }`.
2. Request the challenge with `deviceKey = K_vote`. Authority issues `{ nonce, deviceKey }`.
3. JS computes `BOUND_DIGEST`, then `ASSERTION_DIGEST`.
4. `produceAttestation(keyAlias, boundDigest, assertionDigest, enableDeviceCheck)` — native calls
   `attestKey` with §2's hash, then `generateAssertion` with §3.2's hash.
5. JS calls `signWithDeviceKey` over §4's digest to prove possession of `K_vote`.

> **JS producer implemented 2026-08-25** in
> `packages/attestation-native/src/real-attestation-producer.ts`: `produce()` now branches on
> `Platform.OS` and `produceIos()` executes steps 1-5 in this order. Before that the producer was
> Android-shaped with NO platform branch at all — it passed `boundDigestUtf8Base64` into the
> `assertionDigest` slot, parsed `androidId`/`integrityToken`, and hardcoded
> `platformDetails.type: 'Android'`, so no iOS ceremony could ever have succeeded. The native module
> and the verifier were both complete; only the seam between them was missing.
>
> `ASSERTION_DIGEST` and `POP_DIGEST` exist in two independent implementations (device producer,
> authority verifier) that must never drift. `vote-engine/test/ios-producer-verifier-agreement.spec.ts`
> pins the verifier against CAPTURED PRODUCER OUTPUT — not against values recomputed from the
> verifier itself, which would agree by construction.

> **PROVEN ON HARDWARE 2026-08-25** — iPhone 13, iOS 26.x, App Attest *development* environment.
> The shipping producer ran end-to-end (`attestKey` -> `generateAssertion` -> POP), and its output
> was verified by the real authority verifiers: `verifyCrossSign` PASSES on the device's own bytes,
> and `verifyAppAttest` PASSES against Apple's real root (fetched out-of-band, SHA-256
> `1cb9823b…c932`). Fixture and regression suite: `vote-engine/test/ios-hardware-attestation.spec.ts`
> (10 tests, 5 of them negative controls); the run itself is
> `.planning/spikes/085-ios-hardware-capability-probe/produce-result-2026-08-25.json`.
>
> Two defects had to be fixed to get there, neither visible to any static check:
>
> 1. **`provisionDeviceKey()` read the wrong native field.** It returned `publicKeyBase64`, which
>    iOS never resolves — so `challenge.deviceKey` was `undefined` and no iOS ceremony could start.
>    The two platforms genuinely differ (Android: SPKI DER; iOS: compressed SEC1 hex, because §3.4
>    compares it and `verifyCrossSign` parses it as a P-256 point), so the read is now platform-
>    branched and fails closed on an absent field.
> 2. **An invalidated `K_vote` was unrecoverable.** `loadKey(tag:) ?? create…` kept returning a key
>    destroyed by biometric re-enrolment — it still loads and still yields a public key, and fails
>    only at signing. The device was permanently wedged: attest a key, never sign with it. Native
>    now probes liveness without raising a prompt (`interactionNotAllowed`) and re-mints ONLY on a
>    positive invalidation signal, reporting `reprovisioned: true`. Measured on this device:
>    `CryptoTokenKit:-3` -> deleted -> fresh key -> ceremony succeeded.
>
> Still UNPROVEN: the `production` App Attest environment (needs a paid Team ID, ROADMAP 51-04), and
> the app's own pinned-root table, which ships empty by design (SETUP.md §4d).

> **Implemented 2026-08-25** in `083-ios-native-parity-surface/ios/AttestationNativeModule.swift`:
> `produceAttestation(keyAlias, boundDigest, assertionDigest, enableDeviceCheck)`. The Android
> ABI-parity leftover `boundDigestUtf8Base64` (which iOS never used) is gone, and the native
> concatenation is deleted — the digest arrives finished from JS.

---

## 4. Proof of possession of `K_vote` — REQUIRED on iOS

Neither §2 nor §3 proves the device holds `K_vote`'s **private** key. Both are signed by `K_att`.
A device could attest and assert over a `K_vote` it does not control.

**Contract:** the producer MUST also submit a signature by `K_vote` itself:

```
POP_DIGEST = digestFields(['votetorrent/ios-pop/v1', BOUND_DIGEST], sha256, base64url)
popSignature = signWithDeviceKey(keyAlias, base64(SHA256(utf8(POP_DIGEST))))
```

`signWithDeviceKey`'s existing byte contract applies unchanged: **plain base64 of the raw 32 digest
bytes**, never base64url, never UTF-8-of-a-string. The result is 64-byte compact low-S `r‖s` hex
(see `SignatureEncoding.swift`, proven 17/17 in spike 083).

The verifier checks `popSignature` against the submitted `deviceKey` with
`prehash: FALSE, lowS: true, format: 'compact'`.

`prehash: false` is NOT the `@noble/curves` v2 default, and the deviation is load-bearing. The device
signs with `.ecdsaSignatureDigestX962SHA256` over the 32 bytes `SHA256(utf8(POP_DIGEST))`, so those
bytes ARE the ECDSA digest — there is no second hash. Passing `prehash: true` would hash them again
and reject every genuine signature. (Corrected 2026-08-26: this line and §8 rule 11 both said
`prehash: true`, contradicting the shipped code. The code is right and is now hardware-proven —
`verifyCrossSign` accepts a real iPhone 13 POP signature, `ios-hardware-attestation.spec.ts`. Note
this is the OPPOSITE of the assertion check in §3.3, which genuinely does need `prehash: true`; that
asymmetry is why the two must be stated separately.)

> **This has no Android counterpart, and that is a finding, not an oversight — see §6.**

### 4.1 Officer and general digest signing

Every other native signature checked by `verifySigP256` / `SignatureValidP256` (noble default
`prehash: true`, i.e. ECDSA(sha256(digest))) goes through one helper,
`nativeSignInputBytes` / `nativeSignInputBase64` in `@votetorrent/attestation-native`
(`src/native-sign-input.ts`): iOS native signs its input as the final hash, so the helper passes
`sha256(digest)`; Android's `SHA256withECDSA` hashes once, so it passes the digest as-is; any other
platform throws `UNSUPPORTED_SIGNING_PLATFORM`. The hardware fact behind this is pinned by the
iPhone 13 vector in `ios-native-sign-domain.hardware.test.ts` (Authority app): the raw iOS output
verifies with `prehash: false` over the digest and fails `verifySigP256`. §4's PoP stays
`prehash: false` over `sha256(utf8(POP_DIGEST))` and is unchanged.

---

## 5. What the iOS chain proves, precisely

| Property | Proven by | Strength |
|---|---|---|
| The app is genuine, correctly signed, unmodified | App Attest `rpIdHash = SHA256(teamId.bundleId)` + Apple only issues to registered apps | **Hardware-rooted** |
| The device is genuine Apple hardware | credCert chains to the Apple App Attest root | **Hardware-rooted** |
| `K_att` lives in the Secure Enclave | ditto | **Hardware-rooted** |
| The ceremony answers *this* challenge | §2 nonce ≡ `SHA256(authData ‖ SHA256(utf8(BOUND_DIGEST)))` | **Hardware-rooted** |
| `K_vote` is the key this attested app nominated | §3 assertion over `ASSERTION_DIGEST` | **Attested-app's word** |
| The device holds `K_vote`'s private key | §4 `popSignature` | **Cryptographic** |
| **`K_vote` is hardware-backed / non-exportable** | — | **NOT PROVEN** |
| **The OS is untampered / not jailbroken** | — | **NOT PROVEN** (spike 082: no iOS equivalent at any price) |
| **This is a device that has not already associated another registrant (D-06)** | — | **NOT PROVEN — and structurally unprovable at Bar A** (see below) |

The three "NOT PROVEN" rows are the honest cost of iOS support and belong in the threat model.

### 5.1 D-06 device-uniqueness is ENFORCED ON ANDROID ONLY

`AssociationEngine.associate`'s D-06 guard looks for another registrant already holding the same
`AssociationPrivate.DeviceId`. On iOS that column carries the **App Attest key id**, because iOS
has no stable device id by design. A key id is the **app-install** identity, not the device:

- `provisionDeviceKey` calls `DCAppAttestService.generateKey()` unconditionally and overwrites the
  stored id;
- `attestKey` may be called only **once per key**, so a re-attestation *requires* a fresh key id
  (§9, "Re-attestation cadence") — the very property D-13's key-non-reuse claim rests on.

So the same physical iPhone yields a **different** `deviceId` on every ceremony. The D-06 lookup
can never match, the conflict branch is never entered, and no `PollingDevice` waiver is ever
demanded. A voter can associate registrant A and registrant B from one phone with no signal
anywhere.

This is an **accepted limitation**, recorded here rather than left implied by a guard that reads as
if it applied to both platforms. Closing it needs either a durable iOS device identity (none exists
at Bar A — DeviceCheck's per-device bits would be the bar-B candidate, and Bar A excludes it) or a
policy flag that refuses iOS where uniqueness is required. `ElectionAttestationPolicy` carries no
such column today, so that is a schema change, not a verifier change.

`K_vote`'s hardware backing rests on a **transitive trust** argument: App Attest proves the app is
genuine and unmodified, and a genuine build of this app only ever puts a
`kSecAttrTokenIDSecureEnclave` key there. That is weaker than Android's direct proof, but it is not
nothing — defeating it requires defeating App Attest's app-integrity guarantee first.

---

## 6. A gap this contract surfaced in the ANDROID verifier — CLOSED 2026-08-27 (plan 51-02)

> **Update:** the gap described below is now closed. `verifyKeyAttestation` gained check `4b-2`
> (`packages/vote-engine/src/association/verifiers/key-attestation.ts`), which compares the leaf
> certificate's SubjectPublicKeyInfo against `challenge.deviceKey` in constant time and fails closed
> on an undecodable key. Mutation-proven in `test/key-attestation-verifier.spec.ts`'s
> `leaf public key binding (folded 2026-08-25 defect)` describe block. See
> `ATTESTATION-CONTRACT.md` §4 rule 7 / §4a for the authoritative record. The analysis below is kept
> for historical context (why the gap existed and why it made the iOS transitive-trust argument
> below relevant) but no longer describes the shipped verifier's behavior.

While deriving §4 it became clear that **`verifyKeyAttestation` never compares the attested leaf
certificate's public key to `challenge.deviceKey`.** It checks the attestation challenge equals
`Digest(nonce, deviceKey)`, that the key is TEE/StrongBox, hardware-`GENERATED`, `SIGN`-purposed,
and made by our app — but never that *the attested key is the key being registered*.

So a modified Android app could attest a genuine hardware key while registering an exportable
software key as `deviceKey`, and every check above would pass.

**Residual risk is low** — Play Integrity's `PLAY_RECOGNIZED` + the `attestationApplicationId`
binding are what stop a modified app from running at all, so this is defence-in-depth rather than an
open hole. But it means Android relies on the *same* transitive-trust argument iOS does for this
one property, which makes the iOS gap in §5 smaller than it first appears.

**Recommended (Android, separate from iOS work):** compare the leaf certificate's public key to
`challenge.deviceKey` in `verifyKeyAttestation`. ~~Filed as a follow-up, not fixed here — this
document specifies iOS and does not change shipped Android behaviour.~~ Fixed in plan 51-02 — see
the update note above.

---

## 7. Model shape

Additive to `IOSAttestationDetails` only; the top-level `DeviceAttestation` does **not** change
(spike 080 P7 — `attestationStatement` carries the CBOR attestation object, `certificateChain`
carries `x5c`, and the engine persists `platformDetails` as opaque JSON).

```ts
export interface IOSAttestationDetails {
  type: 'iOS'
  secureEnclavePublicKey: string      // EXISTING — K_vote, compressed SEC1 hex (== challenge.deviceKey)
  deviceCheckToken?: string           // EXISTING — unused under bar A (spike 082); kept for bar B
  // --- additive ---
  appAttestKeyId: string              // base64, SHA-256 of K_att's public key
  assertionBase64: string             // CBOR { signature, authenticatorData } — the §3 cross-sign
  assertionCounter: number            // from assertion authenticatorData; must strictly increase
  popSignatureHex: string             // §4 proof of possession, 64-byte compact low-S
  boundDigest: string                 // the BOUND_DIGEST this ceremony answered (§1)
  environment: 'development' | 'production'   // must match the credCert aaguid (spike 081)
}
```

---

## 8. Acceptance rules the iOS verifier enforces

All must pass; a single passing half never authorizes association (D-01's spirit, adapted per spike
082's bar A).

**Attestation half** (spike 081 `verifyAppAttest`, all tested):
1. `x5c` chains to a **pinned** Apple App Attest root — never a root the chain itself supplies.
2. credCert OID `1.2.840.113635.100.8.2` nonce ≡ `SHA256(authData ‖ SHA256(utf8(BOUND_DIGEST)))`.
3. `keyId` ≡ `SHA256(K_att public key, uncompressed X9.62)` ≡ authData credential id.
4. `rpIdHash` ≡ `SHA256(appId)` where `appId = <teamId>.<bundleId>`.
5. Attestation counter is `0`.
6. `aaguid` matches the expected environment — a `development` attestation is **never** accepted by
   a production authority.

**Cross-sign half** (this spike's `verifyAssertion`):
7. Assertion CBOR decodes to `{ signature, authenticatorData }`.
8. Assertion `rpIdHash` ≡ `SHA256(appId)`.
9. Assertion signature verifies over `SHA256(authenticatorData ‖ SHA256(utf8(ASSERTION_DIGEST)))`
   under `K_att`'s public key, where `ASSERTION_DIGEST` is **recomputed by the verifier** from
   `challenge.nonce`, `challenge.deviceKey` and the submitted vote key — never taken from the
   submission.
10. Assertion counter is **strictly greater** than any counter previously stored for this
    `appAttestKeyId` (replay protection; at association time the stored value is absent and the
    counter must be ≥ 1).

**Possession half:**
11. `popSignatureHex` verifies over `SHA256(utf8(POP_DIGEST))` against `challenge.deviceKey` with
    `prehash: false, lowS: true, format: 'compact'` — those bytes are already the ECDSA digest, so
    hashing them again rejects every genuine signature. See §4; contrast rule 9's assertion check,
    which does use `prehash: true`.

**Error discipline:** identical to the Android verifiers — every failure is a structured
`{ ok: false, reason }`, never a throw, never a silent false-reject.

---

## 9. What this contract does NOT cover

- UI, ceremony timing, and native-module architecture (spike 083).
- DeviceCheck. Bar A (spike 082) excludes it; `deviceCheckToken` remains in the model for a future
  bar-B switch.
- Re-attestation cadence. `attestKey` is **once per key**, so a new `generateKey` is required per
  ceremony — which grants D-13's key-non-reuse property structurally, and which is *also* why D-06
  device-uniqueness cannot work on iOS (§5.1).
- D-06 device-uniqueness / Sybil resistance on iOS. Enforced on Android only — see §5.1.
- Assertion use **after** association (ongoing request integrity). This document covers the
  association ceremony only; the counter rule in §8.10 is written so that a later per-request
  assertion scheme can extend it without a format change.

## 10. Device-key alias → Keychain tag (62-127)

`provisionDeviceKey`, `getCurrentDeviceKey`, `produceAttestation` and `signWithDeviceKey` resolve the
Secure Enclave key's Keychain tag from the `keyAlias` argument through one mapping,
`deviceKeyTag(for:)` in `AttestationNativeModule.swift`, as Android does:

| `keyAlias` | Keychain tag |
|---|---|
| `VOTETORRENT_DEVICE_KEY_V1` (Voter) | `org.votetorrent.voter.VOTE_KEY_V1` (the original tag) |
| `VOTETORRENT_AUTHORITY_SIGNING_KEY_V1` (Authority) | `org.votetorrent.voter.VOTE_KEY_V1` (the original tag) |
| any other `^[A-Z0-9_]{1,64}$` | `org.votetorrent.devicekey.<alias>` |
| anything else | rejected `INVALID_ARGUMENT` before any Keychain call; the alias is not echoed |

The two aliases in use keep the original tag deliberately: before this change every alias used that
tag, so every installed key lives under it, and re-tagging would orphan the voter's and the
officer's device identity. The two apps' Keychains are separate sandboxes, so sharing the tag
across the two legacy aliases cannot make them collide. `provisionRecoveryKey` and
`signWithRecoveryKey` still use the fixed recovery tag and ignore their alias (same defect,
not changed here; only one recovery alias exists).
