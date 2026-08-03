# Android release builds

Signed release APKs for both React Native apps (`votetorrent-voter` and
`votetorrent-authority`) are built and published by
[`.github/workflows/release-android.yml`](../../.github/workflows/release-android.yml).

For **local** builds — including the fastlane lanes that validate your signing
environment before starting a 10-minute gradle run — see
[apps/VoteTorrentAuthority/BUILD-RELEASE.md](../../apps/VoteTorrentAuthority/BUILD-RELEASE.md).

## 1. Shareable permalinks

These two URLs are the deliverable: paste them into docs, QR codes, or chat.
They never change, and each is updated independently of the other app's
release cadence.

* **Voter:** `https://github.com/gotchoices/votetorrent/releases/download/latest-voter/votetorrent-voter-latest.apk`
* **Authority:** `https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk`

The workflow is repo-agnostic — it builds its URLs from `${{ github.repository }}` —
so if release duty ever moves, only these documented links need updating.

Why these URLs and not GitHub's built-in
`https://github.com/<repo>/releases/latest/download/<asset>` shortcut: that
form resolves to the newest non-prerelease release across **all** tags in the
repo. Because Voter and Authority are released independently and on different
cadences, an Authority-only release would silently 404 the Voter permalink (and
vice versa). Instead, each app's workflow leg force-moves its own `latest-voter` /
`latest-authority` tag to the commit it just built and re-uploads a version-free
asset name with `--clobber`. The permalink depends on nothing but the tag name
and the asset name, so it is stable by construction.

The `latest-voter` and `latest-authority` releases are marked
`--prerelease --latest=false`, so they never hijack the "Latest" badge or
`/releases/latest` — the real versioned release always holds that spot.

## 2. How to cut a release

Tag prefix selects which app(s) build. `workflow_dispatch` overrides.

| Trigger | Builds |
|---|---|
| `voter-v*` (e.g. `voter-v0.2.0`) | Voter only |
| `authority-v*` (e.g. `authority-v0.0.4`) | Authority only |
| `v*` (e.g. `v1.2.3`) | Both |
| Manual `workflow_dispatch` with `apps: both\|voter\|authority` | as chosen |

```bash
git tag voter-v0.2.0     && git push origin voter-v0.2.0      # Voter only
git tag authority-v0.0.4 && git push origin authority-v0.0.4  # Authority only
git tag v1.2.3           && git push origin v1.2.3            # Both
```

The tag-prefix `case` in the workflow tests `voter-v*` and `authority-v*`
**before** the bare `v*` branch, because `v*` as a glob also matches
`voter-v0.2.0`. Reordering those branches would misclassify a single-app
release as "both".

To build without cutting a version tag, run the workflow manually from the
Actions tab. A manual run uploads a workflow artifact and still refreshes the
rolling permalink, but does **not** create a versioned GitHub Release.

## 3. Repository secrets

Both apps' keys live in **one** keystore, so the keystore and its store password
are shared and only the key password is per-app. The secret names are identical
to the environment variables used for local builds — there is no translation
layer between what you export in a shell and what CI reads.

Create these as **repository-level** secrets:
**Settings → Secrets and variables → Actions → "New repository secret"**.

| Secret | Required | Value |
|---|---|---|
| `KEYSTORE_BASE64_VOTETORRENT` | yes | base64 of the shared keystore |
| `PASSWORD_STORE_VOTETORRENT` | yes | keystore password |
| `PASSWORD_KEY_AUTHORITY` | yes | password for the Authority key |
| `PASSWORD_KEY_VOTER` | yes | password for the Voter key |
| `KEY_ALIAS_AUTHORITY` | no | defaults to `org.votetorrent.authority` |
| `KEY_ALIAS_VOTER` | no | defaults to `org.votetorrent.voter` |

Encode the keystore and set it without going through the clipboard:

```bash
gh secret set KEYSTORE_BASE64_VOTETORRENT --repo gotchoices/votetorrent \
  < <(base64 -i "$STORE_FILE_VOTETORRENT")

gh secret set PASSWORD_STORE_VOTETORRENT --repo gotchoices/votetorrent
gh secret set PASSWORD_KEY_AUTHORITY     --repo gotchoices/votetorrent
gh secret set PASSWORD_KEY_VOTER         --repo gotchoices/votetorrent
```

(On Linux use `base64 -w0` instead of `base64 -i`.)

Keystores are **never committed** — `apps/*/android/.gitignore` blocks
`*.keystore` and suffixed copies. Do not override that with `git add -f`.

## 4. Signing gates

The workflow refuses to publish an incorrectly signed APK, in three stages:

1. **Preflight** — fails immediately on a missing secret, rather than 20 minutes
   into a gradle build.
2. **Decode and prove** — runs [`scripts/VerifyKeystore.java`](../../scripts/VerifyKeystore.java),
   which drives the same `KeyStore` API the Android Gradle Plugin uses, and
   proves the store password, the alias, and the key password before building.

   This deliberately avoids `keytool`. On a PKCS12 keystore `keytool` discards
   `-keypass` and substitutes the store password
   ([JDK-8008292](https://bugs.openjdk.org/browse/JDK-8008292), Won't Fix), so
   `keytool -list` proves nothing about the key password — and it fails outright
   on a keystore that gradle signs with perfectly well. See BUILD-RELEASE.md for
   the full explanation.
3. **Verify APK signature** — `apksigner verify --print-certs` on the output,
   refusing to publish anything carrying the debug certificate.

## 5. Changing the signing key or application id

Both are **permanent** once an app is published. Android treats a build signed
with a different key, or carrying a different `applicationId`, as a different
app: existing users cannot update in place and must uninstall and reinstall.

Back up the keystore and its password somewhere durable (a password manager,
not this repo) before doing anything else with them. Losing the key means the
app can never be updated in place again.

When the Voter app's signing key or application id changes, update the pinned
values in
[`apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts`](../../apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts)
— the Authority app pins the Voter app's package name and signing-certificate
digest for device attestation, and a mismatch fails closed once the Play Console
keys there are provisioned.
