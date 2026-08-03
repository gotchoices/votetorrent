# Android release builds

Signed release APKs for both React Native apps (`votetorrent-voting` and
`votetorrent-authority`) are built and published by
[`.github/workflows/release-android.yml`](../.github/workflows/release-android.yml).

## 1. Shareable permalinks

These two URLs are the deliverable: paste them into docs, QR codes, or chat.
They never change, and each is updated independently of the other app's
release cadence.

* **Voting:** `https://github.com/gotchoices/votetorrent/releases/download/latest-voting/votetorrent-voting-latest.apk`
* **Authority:** `https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk`

Why these URLs and not GitHub's built-in
`https://github.com/<repo>/releases/latest/download/<asset>` shortcut: that
form resolves to the newest non-prerelease release across **all** tags in the
repo. Because Voting and Authority are released independently and on
different cadences, an Authority-only release would silently 404 the Voting
permalink (and vice versa). Instead, each app's workflow leg force-moves its
own `latest-voting` / `latest-authority` tag to the commit it just built and
re-uploads a version-free asset name with `--clobber`. The permalink depends
on nothing but the tag name and the asset name, so it is stable by
construction and immune to what the other app's releases do.

The `latest-voting` and `latest-authority` releases are marked
`--prerelease --latest=false`, so they never hijack the "Latest" badge or
`/releases/latest` on the Releases page — the real versioned release (see
below) always holds that spot.

## 2. How to cut a release

Tag prefix selects which app(s) build. `workflow_dispatch` overrides.

| Trigger | Builds |
|---|---|
| `voting-v*` (e.g. `voting-v0.1.0`) | Voting only |
| `authority-v*` (e.g. `authority-v0.0.4`) | Authority only |
| `v*` (e.g. `v1.2.3`) | Both |
| Manual `workflow_dispatch` with `apps: both\|voting\|authority` | as chosen |

The remote in this clone is named `gotchoices`, not `origin` — use that name
when pushing tags:

```bash
# Voting only
git tag voting-v0.1.0
git push gotchoices voting-v0.1.0

# Authority only
git tag authority-v0.0.4
git push gotchoices authority-v0.0.4

# Both apps, coordinated release
git tag v1.2.3
git push gotchoices v1.2.3
```

To build without cutting a version tag (e.g. to sanity-check signing or grab
an artifact ad hoc), run the workflow manually from the Actions tab and pick
`both`, `voting`, or `authority`. A manual run uploads a workflow artifact and
still refreshes the rolling permalink for the chosen app(s), but it does
**not** create a versioned GitHub Release (there is no tag to attach one to).

## 3. Repository secrets (required)

All eight secrets below must be created as **repository-level** secrets:
**Settings -> Secrets and variables -> Actions -> "New repository secret"**.
Organization secrets are **not available** on this account, so nothing in the
workflow may rely on them — every secret must be created individually on this
repository.

| Secret | App | Source |
|---|---|---|
| `VOTING_KEYSTORE_BASE64` | Voting | base64 of the Voting release keystore (see section 4) |
| `VOTING_KEYSTORE_PASSWORD` | Voting | user's password manager |
| `VOTING_KEY_ALIAS` | Voting | keytool alias, e.g. `org.votetorrent.voting` |
| `VOTING_KEY_PASSWORD` | Voting | user's password manager |
| `AUTHORITY_KEYSTORE_BASE64` | Authority | base64 of `apps/VoteTorrentAuthority/android/app/release.keystore` (rotated 2026-07-30, untracked) |
| `AUTHORITY_KEYSTORE_PASSWORD` | Authority | user's password manager |
| `AUTHORITY_KEY_ALIAS` | Authority | `org.votetorrent.authority` |
| `AUTHORITY_KEY_PASSWORD` | Authority | user's password manager |

The Authority `release.keystore` is gitignored and not tracked in this repo
(`git ls-files` under `apps/VoteTorrentAuthority/android/app/` shows only
`debug.keystore`) — it and its password live only on the machine that
generated them and in the user's password manager. It must be typed into the
GitHub secret UI (or piped via `gh secret set`, never committed to the repo).

Encode a keystore to base64 and copy it to the clipboard (macOS):

```bash
base64 -i apps/VoteTorrentAuthority/android/app/release.keystore | tr -d '\n' | pbcopy
```

On Linux, use `base64 -w0` instead (it already emits no line wrapping):

```bash
base64 -w0 apps/VoteTorrentAuthority/android/app/release.keystore | pbcopy
```

Or set the secret directly with the `gh` CLI, without going through the
clipboard:

```bash
gh secret set AUTHORITY_KEYSTORE_BASE64 --repo gotchoices/votetorrent \
  < <(base64 -i apps/VoteTorrentAuthority/android/app/release.keystore)
```

## 4. Creating a Voting keystore

The Voting app does not have a release keystore yet. Generate one with:

```bash
keytool -genkeypair -v \
  -keystore release.keystore \
  -alias org.votetorrent.voting \
  -keyalg RSA -keysize 2048 -validity 10000
```

**Losing this key means the app can never be updated in place** — a new
release with a different signing key is treated by Android as a different
app, so every installed user would have to uninstall and reinstall from
scratch. Back up `release.keystore` and its password somewhere durable (a
password manager, not this repo) before doing anything else with it.

`apps/VoteTorrentVoting/android/.gitignore` already ignores `*.keystore` (and
suffixed copies), so a locally generated `release.keystore` stays out of git
by default — do not override that with `git add -f`.

## 5. Local release builds

To reproduce CI's signing locally (e.g. to sanity-check a keystore before
uploading its secrets), export the same env vars the workflow sets, then run
`./gradlew assembleRelease` from the relevant `android/` directory:

```bash
export VOTETORRENT_STORE_FILE=release.keystore
export VOTETORRENT_STORE_PASSWORD='...'

# For Voting:
export VOTING_KEY_ALIAS=org.votetorrent.voting
export VOTING_KEY_PASSWORD='...'
cd apps/VoteTorrentVoting/android && ./gradlew assembleRelease

# For Authority:
export AUTHORITY_KEY_ALIAS=org.votetorrent.authority
export AUTHORITY_KEY_PASSWORD='...'
cd apps/VoteTorrentAuthority/android && ./gradlew assembleRelease
```

Debug builds (`assembleDebug`, `yarn android`, `yarn android:voting`) need
**none** of these env vars — both apps' `debug` signingConfig is unconditional
and unaffected by this setup.

## 6. Post-merge manual verification (cannot be automated locally)

The workflow's YAML shape, tag-selection logic, and gradle signing
configuration are verified automatically (see the plan's `<verification>`
section). What can **only** be proven by actually pushing a tag and watching
GitHub Actions run — the following checklist is the honest boundary of local
verification and should be worked through once after the secrets exist:

- [ ] Create all 8 repository secrets (section 3).
- [ ] Push a throwaway tag `voting-v0.0.0-ci1`; confirm the workflow runs,
      that **only** the Voting matrix leg exists (proving the tag-prefix
      `case` ordering resolves prefixed tags before the bare `v*` glob), and
      that it fails loudly (not silently) if a secret is missing.
- [ ] Download the permalink URL; run `apksigner verify --print-certs`
      locally and confirm the signer is **not** `CN=Android Debug`; install
      the APK on a device.
- [ ] Push `authority-v0.0.4`; re-check the **Voting** permalink still
      returns the older Voting APK unchanged — this is the exact regression
      the rolling-tag scheme (section 1) exists to prevent.
- [ ] Confirm the Releases page still shows the versioned release as
      "Latest" and the two `latest-*` releases as pre-releases only.
- [ ] Delete the throwaway tag and its release once verified.

Do not treat any of the above as passing until it has actually been run
against a real GitHub Actions execution — nothing in this checklist can be
verified from a local git checkout.
