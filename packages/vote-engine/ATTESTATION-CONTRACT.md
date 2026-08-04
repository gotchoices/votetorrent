# Attestation Contract: `Digest(nonce, deviceKey)` Wire Format

This document locks the exact byte/string form of the shared anti-relay binding
value (D-06) that MUST be produced identically by the voter-app attestation
producer (the not-yet-planned Phase-44 scope, `apps/VoteTorrentVoter`) and
consumed by this authority-side verifier (`packages/vote-engine/src/association/verifiers/*`).

It resolves RESEARCH.md's Open Question 1 / Assumption A4 with a decision
grounded in the ACTUAL implemented verifier code (Waves 3-4), not a proposal —
**this is the target Phase 44 must build against.** Do not plan Phase 44
without reading this file first; any mismatch between what the producer emits
and what is documented here is a contract bug, not a verifier bug.

## 1. The canonical bound value

```ts
// packages/vote-engine/src/association/verifiers/digest-binding.ts
const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

export function recomputeChallengeDigest (nonce: string, deviceKey: string): string {
  return digestFields([nonce, deviceKey], hasher, encode) as string
}
```

- Inputs: `challenge.nonce` (the server-issued `AttestationChallenge.nonce`) and
  `challenge.deviceKey` (the voting public key this attestation is being bound
  to), both plain strings, in that field order.
- `digestFields` (from `@optimystic/quereus-plugin-crypto`) uses a
  length-prefixed, type-tagged canonical field encoding — NOT naive string
  concatenation. `(nonce='n1', deviceKey='k1')` and `(nonce='n', deviceKey='1k1')`
  never collide. Do not hand-roll `sha256(nonce + deviceKey)` anywhere in the
  Phase-44 producer — mirror this exact call, or (better) treat this file as
  the single source of truth and share the function if the producer runtime
  can import it.
- Output: **a base64url-encoded STRING** (URL-safe base64, no padding
  characters requiring re-escaping) — `sha256` digest bytes, base64url-encoded.
  This deliberately mirrors the SQL `Digest()` UDF's registered config
  (`database/initialize.ts:99`: `{ algorithm: 'sha256', encoding: 'base64url' }`)
  so this pure-JS call produces byte-identical output to the SQL path for the
  same inputs (SIGN-05 "no independent reimplementation" rule).

Call this value `BOUND_DIGEST` for the rest of this document.

## 2. Play Integrity side — `requestDetails.nonce`

Verifier code (`verifiers/play-integrity.ts`):

```ts
const boundNonce = recomputeChallengeDigest(challenge.nonce, challenge.deviceKey)
if (requestDetails.nonce !== boundNonce) {
  return { ok: false, reason: 'requestDetails.nonce does not equal Digest(challenge.nonce, challenge.deviceKey) — D-06 anti-relay binding failed' }
}
```

**Contract:** the verifier does a direct string equality between the decoded
classic-API JWS payload's `requestDetails.nonce` and `BOUND_DIGEST` — the
base64url STRING itself, with no further decoding, re-encoding, or byte
conversion on the verifier side.

**What Phase 44's producer MUST do:** pass `BOUND_DIGEST` (the base64url
string, exactly as `recomputeChallengeDigest` returns it) directly into the
Play Integrity classic API's `setNonce(...)` call, with no intermediate
transform. This works because base64url IS URL-safe base64 — the classic
API's nonce field accepts a base64-encoded string and Play Integrity itself
performs no semantic interpretation of the nonce bytes, only echoes it back
verbatim in `requestDetails.nonce` of the decrypted token.

**Explicit non-requirement (per RESEARCH.md Common Pitfall 1):** this project
uses the CLASSIC Play Integrity API only. The verifier reads
`payload.requestDetails.nonce`. It NEVER reads the STANDARD/Google-managed
API's request-hash field (a similarly-named field that belongs to a
DIFFERENT Play Integrity API flow this project does not use) — that field
does not exist in a classic-flow decrypted payload and any code path
referencing it is wrong for this project's chosen flow (D-04).

## 3. Keystore side — `attestationChallenge`

Verifier code (`verifiers/key-attestation.ts`):

```ts
const expectedChallenge = new TextEncoder().encode(recomputeChallengeDigest(challenge.nonce, challenge.deviceKey))
const challengeBound = expectedChallenge.length === attestationChallengeBytes.length &&
  timingSafeEqual(expectedChallenge, attestationChallengeBytes)
```

**Contract:** the verifier does NOT compare against the raw sha256 digest
bytes. It re-derives `BOUND_DIGEST` (the same base64url STRING as §1/§2),
UTF-8 encodes THAT STRING via `TextEncoder`, and compares those UTF-8 bytes
byte-for-byte (`timingSafeEqual`) against the leaf certificate's parsed
`KeyDescription.attestationChallenge` (or `KeyMintKeyDescription.attestationChallenge`
on the KeyMint schema variant) field.

**What Phase 44's producer MUST do:** when calling Android's
`KeyGenParameterSpec.Builder.setAttestationChallenge(byte[])`, pass the
**UTF-8 bytes of the base64url STRING `BOUND_DIGEST`** — i.e.
`BOUND_DIGEST.getBytes(StandardCharsets.UTF_8)` (or the RN-bridge/native-module
equivalent) — NOT the raw sha256 digest bytes, and NOT a re-decoded
base64-to-bytes conversion. The Play Integrity side (§2) and the Keystore side
(§3) both start from the identical `BOUND_DIGEST` string; they diverge only
in what encoding step is applied on top (none for §2, UTF-8-encode for §3).
This asymmetry is intentional and matches the implemented verifier exactly —
do not "fix" it into symmetry on the producer side.

## 4. Acceptance rules the verifier enforces

Beyond the D-06 binding itself, `PlayIntegrityVerifier` (composing
`verifyPlayIntegrity` + `verifyKeyAttestation`, D-01) requires **BOTH halves
to pass** before returning `{ ok: true }`:

**Play Integrity half (`verifyPlayIntegrity`):**
1. The compact JWE-of-JWS token decrypts (A256KW/A256GCM) and verifies
   (ES256) against the keys `IIntegrityKeyProvider` supplies.
2. `requestDetails.requestPackageName === appIntegrity.packageName`.
3. `appIntegrity.appRecognitionVerdict === 'PLAY_RECOGNIZED'`.
4. `deviceIntegrity.deviceRecognitionVerdict` includes `'MEETS_DEVICE_INTEGRITY'`
   (D-02 balanced bar — `MEETS_BASIC_INTEGRITY`-only and emulator-class
   `MEETS_VIRTUAL_INTEGRITY` are both rejected; `STRONG` is not required).
5. `requestDetails.timestampMillis` is fresh (within a 5-minute window).
6. `requestDetails.nonce === BOUND_DIGEST` (§2, D-06).

**Key Attestation half (`verifyKeyAttestation`):**
1. The leaf-first DER chain builds to a chain terminating at one of the
   INJECTED, bundled `pinnedRootsDer` (never a self-signed root the presented
   chain itself supplies) — see `packages/vote-engine/SETUP.md` for how this
   snapshot is produced.
2. No certificate in the validated chain is expired or not-yet-valid.
3. The LEAF certificate specifically (never any other chain position, D-06/
   Pitfall 6) carries the `KeyDescription`/`KeyMintKeyDescription` extension
   (OID `1.3.6.1.4.1.11129.2.1.17`).
4. `attestationSecurityLevel` is TEE or StrongBox — `Software` is rejected
   (D-02 balanced bar).
5. `attestationChallengeBytes === TextEncoder(BOUND_DIGEST)` (§3, D-06).
6. **Revoked-serial rejection (T-43-08):** every certificate in the validated
   chain — leaf AND intermediates, not leaf-only — has its serial number
   normalized (`normalizeSerialHex`: lowercase hex, leading DER `00`
   sign-padding byte(s) stripped) and cross-checked against the INJECTED
   `revokedSerials: Set<string>` snapshot. A match on ANY chain certificate
   yields `{ ok: false, reason: "attestation key revoked/suspended — certificate serial '<serial>' is on the Google attestation-status revoked/suspended snapshot" }`.
   This check is fully offline — `revokedSerials` is a bundled, committed
   snapshot (see `SETUP.md` §4), never fetched at verify-time (D-04).

**Error discipline:** every failure returns a structured
`{ ok: false, reason: <specific, named string> }` — never a silent
false-reject and never an unhandled throw (both verifier functions wrap their
entire body in try/catch and convert crypto/ASN.1 library exceptions to this
same shape). If Phase 44's producer and this verifier ever disagree on wire
format, the failure will surface as one of the named `reason` strings above
(most likely `requestDetails.nonce does not equal Digest(...)` or
`attestationChallenge does not match Digest(...)`), not a generic crash —
Phase 44 implementers should treat those specific reason strings as the
primary format-mismatch diagnostic.

## 5. What this contract does NOT cover

This document locks the wire format only. It does not plan Phase 44's UI,
native-module architecture, or timing (see CONTEXT.md's D-05/D-06/D-15/D-16/D-17
— informational decisions already recorded for the voter-app producer, out of
this phase's scope). D-05 in particular constrains the producer's
implementation shape (an npm lib for the Play Integrity token + a small custom
native module for the Key Attestation chain, `KeyStore.generateKeyPair` with
`setAttestationChallenge`, StrongBox/TEE, non-exportable) — this contract
constrains only the exact bytes that native module must pass to
`setAttestationChallenge` and the exact string the npm lib must pass to
`setNonce`.
