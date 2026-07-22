# SETUP: Making the Play Integrity / Key Attestation Verifier Live (D-10)

This is a human-only runbook. Every step below is gated behind a Google
account and has no CLI substitute — do not attempt to script or automate
account/app registration.

**Current state:** the verifier code (`PlayIntegrityVerifier`, composing
`verifyPlayIntegrity` + `verifyKeyAttestation`) is fully implemented and
swap-in ready, and is wired as the app's default `'association'` engine
verifier. It is proven end-to-end on Node against synthetic fixtures signed
by a test root, with the wire format between the (not-yet-built) voter-app
producer and this verifier locked in `ATTESTATION-CONTRACT.md`. The following
steps are what remain before the verifier can pass against a genuine
Play-Integrity-issued token from a real device: real Play Console key
provisioning, and the on-device/production end-to-end proof run. Both are
explicitly deferred (D-10) — not blocking, not silently dropped.

## 1. Register the app in Play Console + enable Play Integrity API

1. Sign in to the [Google Play Console](https://play.google.com/console) with
   the account that will own this app's listing.
2. Create (or select) the app entry for the VoteTorrent voter app
   (`apps/VoteTorrentVoting` — the voter-app producer target that will emit
   these tokens (see `ATTESTATION-CONTRACT.md` for the wire-format contract
   it must satisfy); note the
   authority side, `apps/VoteTorrentAuthority`, is the CONSUMER of the
   resulting tokens and does not itself need a Play Store listing).
3. In the app's dashboard, navigate to **App integrity → Play Integrity API**
   and enable it for the app.
4. Under **App integrity → Response encryption**, follow Google's flow to
   generate/download the **response-encryption key** (the A256KW/A256GCM
   symmetric key `verifyPlayIntegrity` uses to decrypt the outer JWE) and the
   **response-verification key** (the ES256 public key used to verify the
   inner JWS signature). These are the two secrets `IIntegrityKeyProvider`
   needs.

This is the D-04 "local self-managed decryption" posture: no GCP service
account, no server-to-server call, no live Google dependency at verify-time —
these two downloaded keys are ALL the verifier needs, held and used entirely
offline by the authority peer.

## 2. Create the associated Cloud project

Google Play Console's Play Integrity setup flow will prompt you to link (or
create) a Google Cloud project as part of enabling the API in step 1.4 above
— there is no separate manual Cloud Console step beyond following that
prompt. Record the linked project ID for your own operational records; the
verifier itself never calls out to this project (D-04's offline posture).

**Centralization note (D-04b):** one VoteTorrent voter-app Play Console
listing = one Cloud project = one response-encryption/verification key pair,
shared across ALL authority peers that verify tokens for that app. There is
no per-authority-peer key provisioning — every authority peer's
`LocalConfigKeyProvider` is configured with the SAME two keys.

## 3. Place the downloaded keys where `LocalConfigKeyProvider` reads them

`LocalConfigKeyProvider` (`packages/vote-engine/src/association/key-provider.ts`)
is the real, currently-shipping (not a stub) implementation of
`IIntegrityKeyProvider`. It is constructed with:

```ts
interface LocalConfigKeyProviderConfig {
  decryptionKeyBase64: string    // the response-encryption key, base64
  verificationKeyBase64: string  // the response-verification key, base64
}
```

Today, `apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts`
ships the two key fields (`PLAY_CONSOLE_DECRYPTION_KEY_BASE64`,
`PLAY_CONSOLE_VERIFICATION_KEY_BASE64`) as **empty strings** — the committed
default is UNPROVISIONED, not a usable secret. Because the keys are absent,
`engine-factory.ts`'s `'association'` case **fails closed**: it refuses to
construct the real `PlayIntegrityVerifier` (throwing at construction) unless
the explicit `__DEV__ && USE_STUB_ATTESTATION_VERIFIER` dev gate is active.
This replaced an earlier all-zero placeholder-key default, which — combined
with the pre-fix verifier — allowed a full Play Integrity bypass (CR-01/CR-03).
The verifier stays fail-closed until you supply the real values from step 1.4.

**Do this:**

1. Base64-encode the two downloaded key files.
2. **NEVER commit the real key values into git.** Follow the same
   git-ignored, default-safe convention this codebase already uses for
   dev-only secrets (`proof-flags.generated.ts`'s pattern: a git-tracked file
   holding a safe/placeholder default, with the real value supplied outside
   version control at build/deploy time — e.g. an environment variable, a
   secrets manager, or a local `.gitignore`'d config file read at app-start).
3. Supply the real values as the two exported constants
   `PLAY_CONSOLE_DECRYPTION_KEY_BASE64` and `PLAY_CONSOLE_VERIFICATION_KEY_BASE64`
   in `apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts`
   (or via the out-of-band secure-config mechanism from step 2) — `engine-factory.ts`
   reads them into `LocalConfigKeyProviderConfig` when it constructs
   `LocalConfigKeyProvider`. Once both are non-empty the `'association'` case
   stops failing closed and builds the real verifier. This is a config-only
   change — the seam's shape (`IIntegrityKeyProvider`) never changes, so no
   verifier code needs to be touched.

## 4. Pinned hardware root + revoked-serial snapshots (D-04 offline posture)

`verifyKeyAttestation` never fetches `https://android.googleapis.com/attestation/*`
at verify-time — both the pinned Google hardware-attestation root(s) and the
revoked/suspended-serial list are INJECTED, bundled, committed snapshots. As
of this writing they live in the app layer:
`apps/VoteTorrentAuthority/src/engines/attestation-roots.generated.ts` and
`apps/VoteTorrentAuthority/src/engines/attestation-status.generated.ts`
(fetched live once during Wave 3-4 execution, 2 self-signed root certs +
1728 REVOKED serial entries at fetch time).

### 4a. Regenerating the pinned-root snapshot

```
curl https://android.googleapis.com/attestation/root
```

This returns base64-encoded DER root certificate(s). Each should be verified
as genuinely self-signed (`openssl x509 -in <cert> -noout -subject -issuer` —
`subject` must equal `issuer`) before being embedded, and decoded to a
`Uint8Array` at module load in `attestation-roots.generated.ts`.

### 4b. Regenerating the revoked-serial snapshot

```
curl https://android.googleapis.com/attestation/status
```

This returns a JSON map of revoked/suspended attestation key serials. Entries
mix decimal and already-hex serial representations upstream — both must be
normalized to the SAME convention `verifyKeyAttestation`'s `normalizeSerialHex`
uses (lowercase hex, leading DER `00` sign-padding byte(s) stripped) before
being embedded as the `REVOKED_ATTESTATION_SERIALS: Set<string>` export in
`attestation-status.generated.ts`. Both REVOKED and SUSPENDED entries should
be included in the set — `verifyKeyAttestation` rejects a match against
either status.

### 4c. The verifier CONSULTS this snapshot at verify-time — it does not fetch it

This is the operationally important distinction: `verifyKeyAttestation`
**consults** the bundled `REVOKED_ATTESTATION_SERIALS` set on **every single
verification call**, offline, in-process — checking every certificate in the
presented chain (leaf AND intermediates) against it and rejecting with
`{ ok: false, reason: "attestation key revoked/suspended — ..." }` on any
match. This is a real, active, per-verification enforcement gate, not a
document you merely keep around.

What is refreshed out-of-band is the **snapshot's contents**, not whether
it's consulted. Refresh the snapshot (re-run steps 4a/4b, regenerate the two
`*.generated.ts` files, and ship the update) on a stated cadence — e.g. **once
per app release, or on a periodic schedule (recommended: no less often than
monthly)** — never as a live per-verification network fetch (that would
violate D-04's offline posture and introduce a live Google dependency the
whole architecture was designed to avoid).

**Staleness tradeoff (operator must understand this):** a serial revoked by
Google AFTER your last snapshot refresh will NOT be caught until your NEXT
refresh ships. The refresh cadence directly bounds this exposure window — a
monthly cadence means a compromised/revoked attestation key could pass
verification for up to ~30 days after Google revokes it, until the next
snapshot update reaches deployed authority peers. Choose the cadence with
this window in mind; a shorter cadence (e.g. weekly, or triggered by a
Google revocation-list change notification if one becomes available) shrinks
the window at the cost of more frequent app releases/updates to authority
peers.

## 5. Deferred follow-ups (explicitly deferred, not dropped)

### 5a. Real-device golden capture (D-09)

The verifier's test suite (`packages/vote-engine/test/fixtures/attestation/`)
is proven exhaustively against SYNTHETIC fixtures — tokens and cert chains
signed by a test root the verifier is pointed at in tests, covering every
branch and negative case (tampered, expired, wrong-nonce, wrong-key,
wrong-package, failed verdict). CI runs synthetic-only.

D-09 also calls for a small set of **real-device golden captures** — actual
Play-Integrity-issued tokens and Keystore attestation chains from a real
device against Google's real root — to prove format fidelity beyond the
synthetic model. This requires a Play-linked app (the registration this
document's steps 1-2 complete) and is deferred until that app exists.

**Rate-limit budget when you do capture these:** the classic Play Integrity
API is rate-limited to **5 integrity tokens per minute per app instance**
(and 10,000 requests/app/day by default) — this is appropriate for its
"high-value action" design intent, not bulk fixture generation. Budget for
capturing a handful of golden vectors, not a broad matrix, when this step is
picked up.

### 5b. RN/Hermes WebCrypto on-device smoke for `jose`

`jose` (the JWE/JWS library `verifyPlayIntegrity` depends on) requires
`globalThis.crypto.subtle` (WebCrypto) for AES-GCM decrypt, AES-KW unwrap,
and ECDSA verify. This phase's entire proof obligation runs on Node (which
has full native WebCrypto support) — whether React Native's Hermes engine on
the actual `apps/VoteTorrentAuthority` runtime exposes a COMPLETE
`crypto.subtle` (not just `crypto.getRandomValues`) is UNVERIFIED. This
codebase has prior direct experience with a related class of bug (the
secp256k1-on-Hermes multi-copy binding failure, spike finding 013 —
`Skill("spike-findings-votetorrent")`), so this is flagged as a real risk
class, not a theoretical one.

**Before wiring `PlayIntegrityVerifier` live in the shipping app** (i.e.
before flipping `USE_STUB_ATTESTATION_VERIFIER` off in a real device build
that will process real tokens), run a small on-device smoke test: call
`compactDecrypt`/`compactVerify` directly inside the actual
`apps/VoteTorrentAuthority` Hermes runtime with a synthetic token, and
confirm it succeeds exactly as it does on Node. If it fails (e.g.
`crypto.subtle is not a function`/`undefined`, which will NOT reproduce in
the Node test suite), the documented fallback is a pure-JS path using the
already-vetted `@noble/curves` (`p256` export for ES256) plus a small
AES-GCM/AES-KW implementation, avoiding introducing a new native-binding
dependency class.

## 6. Summary checklist

- [ ] Play Console app registered, Play Integrity API enabled
- [ ] Response-encryption key + response-verification key downloaded
- [ ] Cloud project linked (via the Play Console flow, no separate manual step)
- [ ] Real key material base64-encoded and supplied to `LocalConfigKeyProviderConfig`
      via a `.gitignore`'d/out-of-band mechanism (never committed)
- [ ] `attestation-roots.generated.ts` regenerated from a verified
      `https://android.googleapis.com/attestation/root` fetch
- [ ] `attestation-status.generated.ts` regenerated from
      `https://android.googleapis.com/attestation/status`, normalized to
      `normalizeSerialHex` convention, REVOKED + SUSPENDED both included
- [ ] Refresh cadence for the revoked-serial snapshot chosen and documented
      operationally (recommended: no less often than monthly)
- [ ] Deferred: real-device golden capture (D-09) — budget for rate limits
- [ ] Deferred: RN/Hermes WebCrypto on-device smoke for `jose` before live use

Until every box above is checked, the verifier remains code-complete and
proven on Node via the synthetic harness, with real end-to-end device
verification deferred per D-10.
