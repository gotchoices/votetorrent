# Dev-release attestation cert-pin proof (CR-02)

Proves the app-identity certificate pin works end-to-end against a genuinely
release-signed voter build, **without needing the production signing key**.

## Why this exists

`EXPECTED_APP_CERT_SHA256_DIGESTS` in
`apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts` currently
lists exactly one certificate: the universal Android SDK debug key. Its private
key ships in every Android SDK install and is committed in this repo at
`apps/VoteTorrentVoter/android/app/debug.keystore`. A pin that accepts only a
certificate anyone can produce proves nothing about app identity — it reduces the
CR-04/WR-03 anti-relay property to "some app".

An interim guard (`buildExpectedCertDigests(__DEV__)`) strips public debug digests
from release builds, leaving an empty allowlist that both verifier halves reject.
That makes the gap **fail loudly instead of silently**, but it does not close it.
Closing it needs a real release-signed build to pin against — which is what this
runbook produces.

The dev-release key is a **test identity**. It exists to prove the mechanism. It
must never sign a published artifact, and its digest must never ship as the
production pin.

---

## Step 1 — Generate the dev-release keystore

```bash
export DEVRELEASE_STORE_PASSWORD='choose-a-strong-passphrase'
./scripts/make-devrelease-keystore.sh
```

Writes `~/.votetorrent-keys/votetorrent-devrelease.keystore` with one key per app
(`org.votetorrent.voter`, `org.votetorrent.authority`), matching the shared-keystore
layout the build already expects (see `RELEASE-ANDROID.md`).

The script **refuses to write anywhere inside the git working tree** — a committed
keystore is the very defect this proof closes.

> **PKCS12 and key passwords.** `keytool` refuses `-keypass` on PKCS12 keystores and
> substitutes the store password (JDK-8008292, closed Won't Fix — same note in
> `scripts/VerifyKeystore.java`). Every key therefore shares the store password. Set
> the per-app key password vars to that same value; the Android Gradle Plugin handles
> it fine.

## Step 2 — Build the voter release APK

> **Prerequisite: install the voter workspace's dependencies.** This repo sets
> `nmHoistingLimits: workspaces`, so each app keeps its own `node_modules` — a
> populated authority workspace does **not** imply a populated voter one. At the
> time of writing `apps/VoteTorrentVoter/node_modules` does not exist, and
> `settings.gradle` includes `@react-native/gradle-plugin` from it as a composite
> build. Without an install, gradle fails with the misleading
> `Error resolving plugin [id: 'com.facebook.react.settings']`. Run `yarn install`
> from the repo root first; the build script checks for this and says so plainly.

```bash
export STORE_FILE_VOTETORRENT="$HOME/.votetorrent-keys/votetorrent-devrelease.keystore"
export PASSWORD_STORE_VOTETORRENT="$DEVRELEASE_STORE_PASSWORD"
export PASSWORD_KEY_VOTER="$DEVRELEASE_STORE_PASSWORD"

./scripts/build-voter-devrelease.sh
```

These are the variables `apps/VoteTorrentVoter/android/app/build.gradle:123-130`
already reads. The script runs the `VerifyKeystore.java` preflight first, which
loads the store and calls `getEntry(alias, PasswordProtection(keyPassword))` exactly
as the Gradle plugin does — so a pass genuinely predicts a successful signed build.

> **The failure mode this guards against.** `build.gradle:86` derives
> `hasReleaseSigningEnv` from `STORE_FILE_VOTETORRENT` **alone**, and
> `buildTypes.release` (line 144) falls back to `signingConfigs.debug` when it is
> empty. A release build with a missing or misspelled env var therefore **still
> succeeds** — signed with the public debug key. The APK installs and runs
> normally; only the certificate differs. This is why step 3 reads the digest off
> the APK rather than the keystore.

## Step 3 — Read the digest off the built APK

```bash
./scripts/read-apk-cert-digest.sh \
  apps/VoteTorrentVoter/android/app/build/outputs/apk/release/app-release.apk
```

Emits the digest as lowercase hex with no colons — the exact storage form of
`EXPECTED_APP_CERT_SHA256_DIGESTS`. **Exits non-zero if the APK turns out to be
debug-signed**, which is the silent-fallback case above.

Step 2 runs this automatically at the end; run it standalone to re-check an
existing APK.

## Step 4 — Pin the digest

```bash
./scripts/pin-voter-cert-digest.sh <digest>          # dry run, prints the diff
./scripts/pin-voter-cert-digest.sh <digest> --apply  # writes
```

Dry-run by default. `--apply` appends the entry (labelled as a TEST identity unless
you pass `--production`), flips the guard test that asserts the release allowlist is
empty, runs prettier, and runs the guard suite.

It refuses to pin the public debug digest, refuses a malformed digest, and refuses a
duplicate.

## Step 5 — Run the attestation leg on device

> ### Prerequisite: Play Console key material
>
> **The cert-pin check is unreachable until this is provisioned.**
> `PlayIntegrityVerifier.verify()`'s *first statement*
> (`packages/vote-engine/src/association/play-integrity-verifier.ts:59-61`) returns
> `Play Console key material is not provisioned — see SETUP.md` when
> `keysProvisioned` is false, before either the Play Integrity half or the key
> attestation half runs. With
> `PLAY_CONSOLE_DECRYPTION_KEY_BASE64` / `PLAY_CONSOLE_VERIFICATION_KEY_BASE64`
> empty (the committed default), an on-device run will report exactly that reason
> and never reach the digest comparison — a green-looking "fails closed" that
> proves nothing about the pin.
>
> Provision both per `packages/vote-engine/SETUP.md` before running this step.

Both apps must be **release** builds:

- The authority's CR-02 guard only strips public debug digests when `__DEV__` is
  false, so a debug authority build accepts the debug digest and the pin is not
  under test.
- `useStub = __DEV__ && USE_STUB_ATTESTATION_VERIFIER` (`engine-factory.ts:442`)
  means a release authority build always uses the real verifier.

Install both, run the association ceremony, and expect:

| Outcome | Meaning |
|---|---|
| `associate()` succeeds | Pin matches the dev-release cert — **mechanism proven** |
| `...does not match any allowlisted signing-certificate digest` | Pin mismatch — the APK's cert is not the one pinned; re-run step 3 |
| `Play Console key material is not provisioned` | Prerequisite above not met; the pin was never evaluated |

### Narrower proof, without Play Console keys

If provisioning Play Console keys is not yet practical, the **key-attestation half
alone** exercises the same `expectedAppIdentity` pin and needs no Play Console key
material: `verifyKeyAttestation` (`verifiers/key-attestation.ts:193-197`) compares
`attestationApplicationId.signatureDigests` from the hardware key's certificate
chain against the same allowlist. Capture a real cert chain from a release-signed
voter build on device and drive `verifyKeyAttestation` directly. That proves the pin
against genuine TEE-produced material while leaving the Play Integrity half for
later.

---

## Cleanup

Before shipping, remove the dev-release entry from
`EXPECTED_APP_CERT_SHA256_DIGESTS` and restore the guard test's empty-allowlist
assertion — or replace both with the real production digest.

If the voter app is distributed through Play, the production pin does **not** come
from any local keystore: Play re-signs with Google's app signing key, and that
certificate (Play Console → App integrity → App signing key certificate) is what
real attestation tokens will carry.
