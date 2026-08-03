# Android builds and releases

There are two distinct things here, and keeping them separate is the whole design:

| | Who | Key | Publishable |
|---|---|---|---|
| **Verification builds** | CI, on every push — [`build-android.yml`](../../.github/workflows/build-android.yml) | debug (committed) | no |
| **Release builds** | the key holder, locally | the real VoteTorrent keystore | yes |

**The signing key never leaves the key holder's machine.** No keystore is uploaded
to GitHub, no signing secrets exist on the repository, and CI cannot produce a
publishable artifact even if it wanted to.

## 1. Verification builds (automatic, no key)

Every push and pull request builds **release-variant** APKs for both apps and
attaches them as workflow artifacts (Actions → the run → Artifacts, kept 14 days).

Release variant rather than debug, on purpose: the release path is where this
project's bugs have actually lived — the Metro production bundle and the Hermes
compile (`99ddcf0`, `7f430ae`, `599dda6`). A debug build skips JS bundling
entirely and loads from a Metro dev server, so it cannot catch any of them. The
workflow explicitly fails if the APK comes out without `assets/index.android.bundle`.

With no `STORE_FILE_VOTETORRENT` in the environment, `apps/*/android/app/build.gradle`
falls back to the committed debug key. The resulting APK installs and runs
standalone, so it is genuinely testable — it simply carries a different app
identity and must never be published.

Anyone can produce the same thing locally:

```bash
cd apps/VoteTorrentVoter          # or VoteTorrentAuthority
yarn build:apk:dev
```

## 2. Release builds (manual, key required)

Only the key holder can make one. See
[apps/VoteTorrentAuthority/BUILD-RELEASE.md](../../apps/VoteTorrentAuthority/BUILD-RELEASE.md)
for the full signing setup.

```bash
export STORE_FILE_VOTETORRENT="$HOME/path/to/votetorrent.keystore"
export PASSWORD_STORE_VOTETORRENT='...'
export PASSWORD_KEY_AUTHORITY='...'
export PASSWORD_KEY_VOTER='...'

cd apps/VoteTorrentAuthority && yarn verify:keystore && yarn build:apk
cd ../VoteTorrentVoter        && yarn verify:keystore && yarn build:apk
```

`build_apk` runs `apksigner verify` on the result and **fails** if the APK carries
the debug certificate, so a missing or misspelled env var can never yield a
silently debug-signed "release".

## 3. Publishing

Three separate places hold artifacts, and it is worth keeping them straight:

| Where | What lives there | Updated by |
|---|---|---|
| your disk | `android/app/build/outputs/apk/release/app-release.apk` | `yarn build:apk` |
| GitHub Releases | the `.apk` files people download | `gh release upload` |
| votetorrent.org | `web/join.html` — the *page* holding the download links | `web/publish` (scp) |

votetorrent.org hosts the **page**; GitHub hosts the **files**. The download
links in `join.html` point at
`github.com/gotchoices/votetorrent/releases/download/...`, so an APK never
touches the web server.

Upload a locally built APK to the rolling per-app release:

```bash
gh release upload latest-voter     <path-to-voter-apk>     --clobber
gh release upload latest-authority <path-to-authority-apk> --clobber
```

Create a rolling release first if it does not exist yet:

```bash
gh release create latest-voter --prerelease --latest=false \
  --title "Rolling: latest Voter APK" --notes "Always the newest Voter APK."
```

`--prerelease --latest=false` keeps these rolling tags from hijacking the
"Latest" badge on the Releases page.

Then, only if the HTML changed:

```bash
cd web && ./publish html
```

## 4. Changing the signing key or application id

Both are **permanent** once an app is published. Android treats a build signed
with a different key, or carrying a different `applicationId`, as a different
app: existing users cannot update in place and must uninstall and reinstall.

Back up the keystore and its password somewhere durable (a password manager, not
this repo). Losing the key means the app can never be updated in place again.

Keystores are never committed — `apps/*/android/.gitignore` blocks `*.keystore`
and suffixed copies. Do not override that with `git add -f`.

When the Voter app's signing key or application id changes, update the pinned
values in
[`apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts`](../../apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts)
— the Authority app pins the Voter app's package name and signing-certificate
digest for device attestation, and a mismatch fails closed once the Play Console
keys there are provisioned.
