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
   (`apps/VoteTorrentVoter` — the voter-app producer target that will emit
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
default is UNPROVISIONED, not a usable secret. As of D-09 (Phase 47), an
absent key pair no longer blocks construction: `engine-factory.ts`'s
`'association'` case **does** construct the real `PlayIntegrityVerifier`,
threading the unprovisioned state into its `keysProvisioned` constructor
argument. `PlayIntegrityVerifier.verify()` then returns `{ ok: false, reason:
'Play Console key material is not provisioned — see SETUP.md' }` as the FIRST
thing it checks, and `associate()` turns that `{ ok: false }` into a thrown
error — so the associate ceremony (binding a new device to a registrant)
still fails closed. Association and registrant **reads and administration
continue to work normally** with no keys provisioned; only the write path
(`associate()`) is gated. This replaced an earlier all-zero placeholder-key
default, which — combined with the pre-fix verifier — allowed a full Play
Integrity bypass (CR-01/CR-03). The verifier stays fail-closed until you
supply the real values from step 1.4.

**Do this:**

1. Base64-encode the two downloaded key files.
2. **Inject them at build/deploy time. Do NOT edit the tracked file in place.**
   The two constants live in
   `apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts`, which
   is **git-tracked**, and whose committed values are empty on purpose. Supply
   the real values from outside version control — a CI secret, a secrets
   manager, or a `.gitignore`d local config consumed by your build — and have
   that mechanism write the file only inside the ephemeral build workspace,
   restoring the empty default afterwards. `engine-factory.ts` reads whatever
   is there into `LocalConfigKeyProviderConfig` when it constructs
   `LocalConfigKeyProvider`; once both are non-empty, `verify()` stops
   short-circuiting on the provisioning check and the `'association'` case's
   verifier is fully live. This is a config-only change — the seam's shape
   (`IIntegrityKeyProvider`) never changes, so no verifier code is touched.

   > **Why not just edit it and remember not to commit it?** Because this
   > codebase already has evidence that "remember not to commit it" fails.
   > `proof-flags.generated.ts` — previously cited right here as the pattern to
   > follow — routinely shows up modified in `git status` whenever a run
   > script's EXIT trap does not fire. The same accident applied to this file
   > commits a live Play Console decryption key.

3. **The guard.**
   `apps/VoteTorrentAuthority/src/engines/__tests__/attestation-keys.secretGuard.test.ts`
   fails whenever `PLAY_CONSOLE_DECRYPTION_KEY_BASE64` or
   `PLAY_CONSOLE_VERIFICATION_KEY_BASE64` is non-empty in the tracked file, and
   also flags any long base64-looking literal elsewhere in it. It runs with the
   rest of the app suite, so CI rejects a commit carrying key material. If you
   provision locally for a manual test, expect that test to go red — that
   redness IS the signal that your working tree now holds a secret. Clear the
   values (or `git checkout --` the file) before committing; never weaken the
   guard to make it green.

   **Still open (47-REVIEW WR-10):** that guard is a DETECTION control, not a
   prevention one. There is as yet no build-time injection step in this repo,
   so "make the safe path the only path" is not fully delivered — adding one
   (codegen from an env var, or a `.gitignore`d local module) needs a
   build-tooling decision this runbook does not make for you. Note that the
   obvious shortcut — a statically-imported, `.gitignore`d
   `attestation-keys.local.ts` — does NOT work here: Metro resolves static
   imports at bundle time and a missing module breaks the build, while dynamic
   `require()` breaks Metro outright (Phase 16-07).

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


### 4d. Pinned Apple App Attest root (iOS, Phase 51 — PROVISIONED 2026-08-26; paid team 2026-09-01)

`AppAttestVerifier` is the iOS counterpart of `PlayIntegrityVerifier` and holds the same offline
posture: the Apple trust anchor is an INJECTED, bundled, committed snapshot, never fetched at
verify-time.

**The root is embedded** in `apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts`.
**`APPLE_APP_ID` is committed alongside it**, and as of **2026-09-01** it holds the **paid Apple
Developer Program team** value `6849Q7KVP5.org.votetorrent.voter`. `APP_ATTEST_PROVISIONED` is
`true` and the iOS branch does not fail closed on missing config:

```
Apple App Attest root material is not provisioned — see SETUP.md   (root half — satisfied 2026-08-26)
Apple App ID (<teamId>.<bundleId>) is not provisioned — see SETUP.md   (App ID half — satisfied 2026-08-27, D-13)
```

Those reasons are returned FIRST, before any other check, so an unprovisioned deployment can never
report a misleading downstream failure instead (the same D-09 discipline `PlayIntegrityVerifier`
uses for Play Console keys), and they are separate so the message names which half is missing.

**D-13's accepted risk is now retired.** From 2026-08-27 to 2026-09-01 this constant deliberately
held the FREE PERSONAL TEAM value `94TY7UR2W5.org.votetorrent.voter`, so that spike 085's real
iPhone 13 proof could run end to end; the accepted consequence was that an authority built from
that tree would treat a personal team's builds as the legitimate App Attest producer. The mitigation
was machine-enforced rather than documentary — `scripts/fastlane/vt_appattest_release_gate.rb`
(D-14) failed the `build_apk`/`build_aab` lanes and the iOS `beta`/`release` lanes for as long as
that value stood. With the paid Team ID in place, **that gate now clears**. Check it without
building:

```
fastlane android verify_appattest_config
```

**Two cautions survive the swap.**

1. **The hardware fixtures still pin the personal team, on purpose.**
   `vote-engine/test/ios-hardware-attestation.spec.ts` replays bytes a real Secure Enclave produced
   under `94TY7UR2W5`. That is a recording, not configuration — rewriting its `APP_ID` to match the
   committed constant would invalidate the only end-to-end hardware proof this project has.
2. **A mistyped Team ID clears every automated gate.** The release gate only asserts the value is
   not the personal one, and `appattest-keys.provisioned.test.ts` only asserts the shape and the
   bundle id (WR-03). Ten wrong-but-well-formed characters fail-closed reject every genuine iPhone
   with an App ID mismatch, and nothing upstream reports the real cause. Verify the Team ID against
   developer.apple.com → Membership details before editing it. A local cross-check on a machine that
   can sign for the team: `security find-certificate -a -c "Apple Development" -p | openssl x509
   -noout -subject` prints the Team ID in the `OU` field.

> **The file moved.** Until this section was corrected it named
> `apps/VoteTorrentVoter/src/engines/appattest-roots.generated.ts`. The voter is the attestation
> PRODUCER and never holds a trust anchor; the AUTHORITY is what verifies, and its `EngineFactory`
> is what injects the roots. The voter-side copy was imported by nothing and has been removed.

**Two more values live in the same file, and both are now set.** An empty root pool is not the only
way this could go back to unprovisioned:

| Constant | Meaning | Current state |
|---|---|---|
| `APPLE_APP_ATTEST_ROOTS_BASE64` | Apple's trust anchor | provisioned 2026-08-26 |
| `APPLE_APP_ID` | `<teamId>.<bundleId>` of the **voter** app | paid team `6849Q7KVP5`, swapped 2026-09-01 (retires D-13) |
| `APP_ATTEST_ENVIRONMENT` | `production` (the strict, and only committed, value) | the literal `'production'` (D-15) |

`APPLE_APP_ID` is reported as its own configuration error rather than being allowed to flow into the
`rpIdHash === SHA256(appId)` check, where an empty value rejects every genuine device with
"attestation is for a different app" — blaming the device for a deployment mistake.

`APP_ATTEST_ENVIRONMENT` stays the literal `'production'` in the committed tree (D-15) and should
never be edited there. Spike 085 measured that the **provisioning profile** decides the environment,
not the entitlement plist: a build with no entitlements file at all still received a `development`
attestation, while TestFlight/App Store builds get `production` regardless. Do not flip the committed
constant to `development` to "make a test device work" — that accepts every sideloaded build. If you
need a dev-only authority build that talks to a development-environment attestation (for example, to
exercise the free-team proof end-to-end), build a purpose-built local variant with this one constant
flipped, run it, and never commit that change; `scripts/fastlane/vt_appattest_release_gate.rb` (D-14)
fails any Fastlane publish lane while it is not the literal `'production'`.

**Provisioning the root.**

Apple publishes a single long-lived root as a static PEM — there is no JSON endpoint and no
rotation feed, unlike Google's:

```
curl -O https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
```

Before embedding it, verify these properties — this step is why the file is not auto-generated:

```
# 1. genuinely self-signed: subject must equal issuer ...
openssl x509 -in Apple_App_Attestation_Root_CA.pem -noout -subject -issuer

# 2. ... and the signature actually verifies under its own key. Name equality alone proves
#    nothing: a forged certificate can carry whatever subject it likes.
openssl verify -CAfile Apple_App_Attestation_Root_CA.pem Apple_App_Attestation_Root_CA.pem

# 3. fingerprint
openssl x509 -in Apple_App_Attestation_Root_CA.pem -noout -fingerprint -sha256
```

> **CORRECTION, 2026-08-26.** This section used to say to check the fingerprint against "the value
> Apple publishes on its certificate-authority page". **Apple publishes no such value** — verified
> on the date above; https://www.apple.com/certificateauthority/private/ carries the download link
> and nothing else. Anyone following the old instruction would find nothing to compare against and
> would either skip the step or invent a substitute. What replaces it:
>
> - **Compare against the recorded value.** `1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932`
>   — pinned in the app config, in the vote-engine test fixture, and in this file. Three
>   independently-edited places that must agree.
> - **Corroborate cryptographically, which needs no second network path at all.** The root must
>   verify the certificate chain inside a REAL attestation captured from Apple hardware. Substituting
>   the root mid-download would require also holding the key that signed Apple's real intermediate.
>   This is pinned as a permanent test — `vote-engine/test/ios-hardware-attestation.spec.ts`, the
>   "§2 chain" block — and it is a stronger check than comparing a published hex string.
> - Certificate Transparency (crt.sh) is a reasonable extra channel; it was returning 502 on
>   2026-08-26 and is not required.

Then strip the PEM header/footer/newlines and paste the base64 DER body into
`APPLE_APP_ATTEST_ROOTS_BASE64` in
`apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts`, and set `APPLE_APP_ID`
alongside it.

> **Do not skip the out-of-band check.** A trust anchor is the one value in this system where a
> wrong-but-well-formed input does not fail — it silently redefines what "genuine Apple hardware"
> means. Everything else in the attestation path fails loudly when it is wrong.

**What is still unproven on iOS.**

The verifier, the wire format (`ATTESTATION-CONTRACT-IOS.md`) and the Swift TurboModule are all
implemented and covered by tests, but **every fixture is synthetic**. `DCAppAttestService` requires
a signed build from a registered Apple Developer team and a physical iPhone —
`isSupported` is `false` on the Simulator, always. See
`.planning/todos/pending/2026-08-25-ios-appattest-team-id-and-entitlement.md`.

Superseded in part: spike 085 (2026-08-25) proved legs 3–7 on a real iPhone 13 against a **free
personal team**, and the real attestation verified end to end under `verifyAppAttest` with Apple's
genuine root pinned. The fixtures behind the synthetic tests are no longer the only evidence. What
remains is the **production** environment — a paid Team ID, tracked as ROADMAP 51-04 — and this
authority's own root/App ID snapshot, which is what this section is about.

**Wiring status.** `EngineFactory`'s `association` case injects
`PlatformDispatchingAttestationVerifier(PlayIntegrityVerifier, AppAttestVerifier)` — so the iOS
verifier is reached by the running app, and fails closed on the config above rather than being dead
code. Each half gates independently: absent Play Console keys disable only the Android branch, an
absent Apple root/App ID only the iOS one.

**iOS compile gates.** `packages/attestation-native` carries two, and the difference matters:

| Script | What a PASS means | Needs |
|---|---|---|
| `yarn typecheck:ios` | The Apple SDK APIs line up, and `import React` is present and load-bearing. Runs a NEGATIVE CONTROL on every invocation and fails if it cannot detect a stripped import. | An iOS SDK |
| `yarn typecheck:ios:app` | **Authoritative.** The Swift compiles inside the real voter target against React Native's real headers, and its objects are verified present in `libAttestationNative.a`. | CocoaPods (`pod install`), no signing identity |

Neither needs a Team ID. The standalone gate was previously unsound — it declared the RCTPromise*
typealiases at global scope, which is exactly what a missing `import React` leaves undefined, so it
reported PASS for the whole of Phase 51 on code that could not build in an app. It now compiles
those stand-ins into a module NAMED `React`, so the import is required for them to resolve.

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

## 7. Voter-app producer setup (Play Integrity leg + on-device proof)

This section covers what the **producer** side (the voter app,
`apps/VoteTorrentVoter`) needs before the Pixel 8 on-device proof can pass
against the verifier documented in §§1-6 above. It is config + docs only —
no verifier code changes.

### 7a. Play Console / Cloud prereqs for REAL Play Integrity

The voter app (`apps/VoteTorrentVoter`, `applicationId org.votetorrent.voter`)
must itself be registered on Play Console — on the **internal-testing
track** — with the Play Integrity API enabled and its Cloud project linked,
following the same flow as §1/§2 above (that registration is for the app
that CONSUMES tokens on Play Console's side; the voter app is the one that
PRODUCES them and must be the one carrying the listing). Real Play Integrity
verdicts are unavailable until that internal-testing listing exists — until
then, real on-device proof runs use the stubbed Play Integrity leg described
in §7b (deferred per D-01).

### 7b. The independent Play-Integrity proof-flag (D-12)

An independent, `__DEV__`-gated JS proof-flag —
`USE_STUB_PLAY_INTEGRITY`, in
`apps/VoteTorrentVoter/src/engines/proof-flags.generated.ts` — feeds the
native `enablePlayIntegrity` gate. Committed default is `false` (real). The
gate is `!(__DEV__ && USE_STUB_PLAY_INTEGRITY)`: a release build ALWAYS
evaluates this to `true` regardless of the flag's committed or locally
edited value, so the flag can never weaken a release build — flipping it
only ever affects a `__DEV__` build.

This flag is **independent** of the overall `resolveAttestationProducer`
stub gate (`apps/VoteTorrentVoter/src/engines/attestation-producer.ts`).
Flipping `USE_STUB_PLAY_INTEGRITY` to `true` in a `__DEV__` build disables/
stubs ONLY the Play Integrity leg — the hardware key-attestation leg still
runs for real against the real Keystore/StrongBox/TEE. This is the
**real-key + stub-PI** test tier (D-01): it lets the Pixel 8 proof exercise
real hardware key attestation before the Play Console internal-testing
listing (§7a) exists.

As with `USE_LOCAL_DB_FACTORY` (the analogous pattern already in
`proof-flags.generated.ts`), never commit an enabled (`true`) override.

### 7c. The dev-stub→real flip

`resolveAttestationProducer()`'s actual precedence is four rungs, in order:
(1) a supplied `realProducer` argument — always wins, but neither
`ConfirmationScreen` nor `DeviceAttestationScreen` ever supplies one, so this
rung is not reachable through the app's own call sites; (2)
`resolveRealProducerForced()` (`__DEV__ && USE_REAL_ATTESTATION_PRODUCER`,
§7f below) — the REAL producer, reachable from a `__DEV__` build; (3) the
`__DEV__` stub (`StubAttestationProducer`, Phase 44 default); (4) the release
real producer.

To run real Play Integrity end-to-end: (1) register the Play Console app per
§7a, (2) provision the two verifier-side keys per §3, (3) leave
`USE_STUB_PLAY_INTEGRITY = false` (the committed default) in a build that
also is NOT running with the overall stub producer active — i.e. either a
release build (rung 4), or a `__DEV__` build with `USE_REAL_ATTESTATION_PRODUCER
= true` (rung 2, §7f).

### 7d. EXPECTED_APP_PACKAGE correction (Pitfall 1, on the D-01 proof critical path)

`apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts` pins
the VOTER app's package name and signing-certificate digest (it is the
producer's identity the verifier's WR-03 app-identity gate checks) — it
MUST read `EXPECTED_APP_PACKAGE = 'org.votetorrent.voter'` with a populated
`EXPECTED_APP_CERT_SHA256_DIGESTS` (not left as the Phase-43 placeholder
`'org.votetorrent.authority'` with an empty digest array), or the Pixel 8
proof fails the WR-03 app-identity gate before it ever reaches the
Play-Integrity/key-attestation logic. This correction ships as part of this
same plan (config-only; the verifier itself is untouched).

### 7e. Pinned-root re-fetch (Pitfall 7)

Google rotated the hardware attestation root effective **Feb 1 2026** — a
"Key Attestation CA1" now co-signs chains that a stale single-root snapshot
will reject with "no verifiable certificate chain path to a pinned Google
hardware root," even for a genuinely valid Pixel 8 attestation. Immediately
before running the Pixel 8 proof, re-run §4a's
`curl https://android.googleapis.com/attestation/root` regeneration
procedure and re-verify/re-embed the current root set — do not rely on
whatever snapshot happens to already be committed.

### 7f. The debug-build real-key + stub-PI recipe (USE_REAL_ATTESTATION_PRODUCER)

**Why it exists.** An on-device proof needs a `__DEV__` build so Metro
live-reload stays active while iterating — but before this flag existed,
`__DEV__` ALSO unconditionally forced `resolveAttestationProducer()` onto
`StubAttestationProducer` (§7c's rung 3), making every hardware attestation
leg unreachable from any build that also had live-reload. Meanwhile a
release build reaches the real producer (rung 4), but also forces the real
Play Integrity network call — deferred per D-01 (no Play Console app /
Cloud project yet). No build configuration satisfied the D-12 "real-key +
stub-PI" tier until this flag was added. The 45-09 on-device proof log
recognized the stub path empirically: `provisionDeviceKey` returning in
~40 ms and `produce()` in ~2 ms with **no BiometricPrompt ever presented**
is dispositive that a stub, not real hardware, was exercised — use that
same signature to sanity-check a proof run before trusting its result.

**The recipe.** In
`apps/VoteTorrentVoter/src/engines/proof-flags.generated.ts`, set BOTH:

```ts
export const USE_REAL_ATTESTATION_PRODUCER = true;
export const USE_STUB_PLAY_INTEGRITY = true;
```

Then build and install a **debug** build (`:app:installDebug`), run the
proof (real hardware key generation + attestation + BiometricPrompt, with
the Play Integrity leg stubbed), and afterwards `git checkout` the file
before committing anything else — never commit either flag as `true`.

**The safety property.** `resolveRealProducerForced()` (§7c rung 2) is
`__DEV__ && USE_REAL_ATTESTATION_PRODUCER` — in a release build `__DEV__` is
`false`, so this expression evaluates to `false` regardless of what value
the flag file holds, committed or locally edited. A release build's
behavior is therefore completely unaffected by this flag's existence: it
can never let a release build skip real hardware attestation, and it can
never let a release build reach `StubAttestationProducer` (CR-03 /
T-45-05-04 hold unconditionally).

As with `USE_LOCAL_DB_FACTORY` and `USE_STUB_PLAY_INTEGRITY`, never commit
an enabled (`true`) override of `USE_REAL_ATTESTATION_PRODUCER`.

Add to §6's summary checklist:

- [ ] Voter app registered on Play Console internal-testing track (§7a) —
      or deliberately deferred with `USE_STUB_PLAY_INTEGRITY` posture noted
- [ ] `EXPECTED_APP_PACKAGE` corrected to `org.votetorrent.voter` with a
      populated `EXPECTED_APP_CERT_SHA256_DIGESTS` (§7d)
- [ ] Pinned attestation root re-fetched immediately before the Pixel 8
      proof (§7e / §4a)
- [ ] `USE_STUB_PLAY_INTEGRITY` posture confirmed for the intended proof
      tier (real-PI vs. real-key + stub-PI) before running the proof
- [ ] `USE_REAL_ATTESTATION_PRODUCER` reverted to `false` after any on-device proof run (§7f)
