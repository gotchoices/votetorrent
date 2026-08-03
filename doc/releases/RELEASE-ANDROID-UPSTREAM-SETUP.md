# Setting up Android release CI on `gotchoices/votetorrent`

Handoff for a repository **admin** of `gotchoices/votetorrent`. The same pipeline is
already running and fully validated on the `inspirions/votetorrent` fork; this brings it
upstream.

Everything here needs admin rights — setting Actions secrets is admin-only, and no
organization-level secrets are involved (they were unavailable on the account that built
this, so the workflow deliberately depends only on repository-level secrets).

Budget ~30 minutes, plus one ~20-minute CI build to verify.

---

## 0. Decide first: which signing keys?

**Read this before generating anything — it is the one irreversible choice here.**

An Android APK's signing key *is* its identity. A build signed with a different key is
treated by Android as a different app: existing users cannot update in place, they must
uninstall and reinstall. Losing a key is unrecoverable.

| Option | When it's right | Consequence |
|---|---|---|
| **A. Reuse the existing keys** | You want upstream releases to be upgrade-compatible with anything already distributed from the fork, or the Authority key is already the project's real identity | Someone must transfer two keystore files + their passwords to you over a secure channel (see below) |
| **B. Generate fresh keys** | Upstream is the canonical channel starting now, and prior fork builds were throwaway test releases | Clean separation, no key handoff — but any APK already installed from the fork cannot update to an upstream build |

As of 2026-08-03 the only releases ever published from the fork are `voting-v0.1.0` and
`authority-v0.1.0`, both first-ever CI test builds. That argues for **B** for the Voting
app. The **Authority** key is a different matter: it was deliberately rotated on
2026-07-30 and may already be the project's real signing identity — check with the
maintainer before replacing it.

**If transferring keys (option A):** send the `.keystore` files and passwords through a
password manager's secure-share, an encrypted archive over a separate channel, or in
person. Never email, Slack, or paste them into an issue, PR, or chat. Never commit a
keystore — `apps/*/android/.gitignore` blocks `*.keystore`, and that guard should not be
overridden with `git add -f`.

---

## 1. Get the workflow into the repo

The workflow does not exist upstream yet. It arrives via a PR from the fork
(`inspirions/votetorrent`), which contains:

```
.github/workflows/release-android.yml          the workflow
apps/VoteTorrentVoting/android/app/build.gradle real release signingConfig (was debug-signed)
apps/VoteTorrentVoting/android/.gitignore       blocks committing a keystore
doc/releases/RELEASE-ANDROID.md                         the operating runbook
```

Merge that PR into your default branch **before** the tag push in step 5.

Two things to know about branch placement:

- **Tag pushes work from any branch** — a push-tag event uses the workflow file at the
  tagged commit.
- **`workflow_dispatch` (the manual "Run workflow" button) requires the workflow on the
  default branch.** Until it's merged there, the button does not appear.

One repo-specific note: `doc/releases/RELEASE-ANDROID.md` currently documents the *fork's*
permalinks. Once releases are cut upstream, update those URLs to `gotchoices`. The
workflow itself needs no edit — it builds its URLs from `${{ github.repository }}`.

---

## 2. Generate keystores (skip if reusing existing keys)

Do this somewhere outside the repository working tree.

```bash
KEYDIR="$HOME/.votetorrent/release-keys"
mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"

# Voting
keytool -genkeypair -v \
  -keystore "$KEYDIR/voting-release.keystore" \
  -storetype PKCS12 \
  -alias org.votetorrent.voting \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=VoteTorrent Voting, OU=VoteTorrent, O=GotChoices, L=Unknown, ST=Unknown, C=US"

# Authority — ONLY if not reusing the existing rotated key
keytool -genkeypair -v \
  -keystore "$KEYDIR/authority-release.keystore" \
  -storetype PKCS12 \
  -alias org.votetorrent.authority \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=VoteTorrent Authority, OU=Engineering, O=VoteTorrent, L=Salt Lake City, ST=UT, C=US"
```

`-validity 10000` (~27 years) clears Google Play's requirement that the certificate stay
valid past 2033-10-22. PKCS12 uses one password for both the store and the key — supply
the same value for each prompt.

Record the fingerprints now; you will check published APKs against them:

```bash
keytool -list -v -keystore "$KEYDIR/voting-release.keystore" \
  -alias org.votetorrent.voting | grep "SHA256:"
```

**Back up `$KEYDIR` to durable, encrypted storage before going further.** There is no
recovery from a lost release key.

---

## 3. Set the eight repository secrets

All eight are **repository-level**: Settings → Secrets and variables → Actions → *New
repository secret*. Or via `gh`:

```bash
REPO=gotchoices/votetorrent
KEYDIR="$HOME/.votetorrent/release-keys"

# macOS uses `base64 -i`; GNU/Linux needs `base64 -w0` to avoid line wrapping.
base64 -i "$KEYDIR/voting-release.keystore"    | tr -d '\n' | gh secret set VOTING_KEYSTORE_BASE64    --repo "$REPO"
base64 -i "$KEYDIR/authority-release.keystore" | tr -d '\n' | gh secret set AUTHORITY_KEYSTORE_BASE64 --repo "$REPO"

printf '%s' 'org.votetorrent.voting'    | gh secret set VOTING_KEY_ALIAS    --repo "$REPO"
printf '%s' 'org.votetorrent.authority' | gh secret set AUTHORITY_KEY_ALIAS --repo "$REPO"

# Prompted, so the password never lands in shell history:
gh secret set VOTING_KEYSTORE_PASSWORD    --repo "$REPO"
gh secret set VOTING_KEY_PASSWORD         --repo "$REPO"
gh secret set AUTHORITY_KEYSTORE_PASSWORD --repo "$REPO"
gh secret set AUTHORITY_KEY_PASSWORD      --repo "$REPO"
```

For a PKCS12 keystore, `*_KEYSTORE_PASSWORD` and `*_KEY_PASSWORD` are the same value.

| Secret | Value |
|---|---|
| `VOTING_KEYSTORE_BASE64` | base64 of the Voting keystore |
| `VOTING_KEYSTORE_PASSWORD` | Voting store password |
| `VOTING_KEY_ALIAS` | `org.votetorrent.voting` |
| `VOTING_KEY_PASSWORD` | same as the store password |
| `AUTHORITY_KEYSTORE_BASE64` | base64 of the Authority keystore |
| `AUTHORITY_KEYSTORE_PASSWORD` | Authority store password |
| `AUTHORITY_KEY_ALIAS` | `org.votetorrent.authority` |
| `AUTHORITY_KEY_PASSWORD` | same as the store password |

Confirm all eight landed:

```bash
gh secret list --repo gotchoices/votetorrent
```

### Verify the base64 before trusting it

A truncated or line-wrapped keystore secret is the classic silent failure — it surfaces as
a confusing signing error 20 minutes into a build. Prove the round-trip locally, decoding
exactly the way the workflow does:

```bash
B64=$(base64 -i "$KEYDIR/voting-release.keystore" | tr -d '\n')
echo "$B64" | base64 -d > /tmp/rt.keystore
cmp -s "$KEYDIR/voting-release.keystore" /tmp/rt.keystore && echo "round-trip OK"
keytool -list -keystore /tmp/rt.keystore -alias org.votetorrent.voting   # must open
rm -f /tmp/rt.keystore
```

---

## 4. Confirm Actions is enabled

```bash
gh api repos/gotchoices/votetorrent/actions/permissions
```

Expect `"enabled": true`. The workflow uses only first-party `actions/*` at major-version
tags plus the runner's preinstalled `gh` CLI, so an `allowed_actions` policy restricted to
GitHub-owned actions is sufficient — no third-party allowlisting needed.

The workflow declares `permissions: contents: write`, which it needs to create releases and
push the rolling tags. If your org sets the default `GITHUB_TOKEN` permissions to
read-only, that declaration still grants what's required; but if a policy *caps* workflow
token permissions org-wide, publishing will fail until that cap is lifted for this repo.

---

## 5. Verify with a real release

Nothing short of a tag push exercises signing, bundling, and publishing. Cut a throwaway
version first.

```bash
git tag -a voting-v0.0.1 -m "CI verification" <commit-with-the-workflow>
git push origin voting-v0.0.1
gh run watch --repo gotchoices/votetorrent
```

Tag conventions:

| Tag | Builds |
|---|---|
| `v1.2.3` | both apps |
| `voting-v1.2.3` | Voting only |
| `authority-v1.2.3` | Authority only |

Then check the artifacts rather than trusting the green checkmark:

```bash
# The permalink resolves
curl -sIL -o /dev/null -w "%{http_code}\n" \
  https://github.com/gotchoices/votetorrent/releases/download/latest-voting/votetorrent-voting-latest.apk

# The published APK is signed by YOUR key, not a debug cert
curl -sL -o /tmp/v.apk \
  https://github.com/gotchoices/votetorrent/releases/download/latest-voting/votetorrent-voting-latest.apk
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs /tmp/v.apk
```

The printed SHA-256 must equal the fingerprint recorded in step 2, and `CN=Android Debug`
must not appear. Delete the throwaway tag and its two releases afterward:

```bash
gh release delete voting-v0.0.1 --repo gotchoices/votetorrent --yes
git push origin :refs/tags/voting-v0.0.1
```

### The cross-app check worth doing once

Release **one** app, then confirm the **other** app's permalink still resolves. That is the
property the whole permalink design exists to guarantee, and it is easy to regress.

---

## Known failure modes — already fixed, don't reintroduce

Both of these were found by running real builds; neither is catchable by local testing,
linting, or YAML validation. If you refactor the workflow, preserve the fixes.

**1. `actions/setup-node` cannot cache this repo's Yarn.**
`cache: yarn` makes the action shell out to `yarn cache dir` using the runner's global
Yarn 1.22.22, which hard-errors against this repo's `packageManager: yarn@4.7.0` pin. The
workflow therefore omits `cache: yarn`, enables Corepack in its own step, and caches
`~/.yarn/berry/cache` explicitly via `actions/cache@v4`. Re-adding `cache: yarn` breaks the
build immediately.

**2. The workspace must be built before gradle.**
Packages export their entrypoints from `dist/` (e.g. `@votetorrent/vote-engine` exports
`./rn` → `./dist/rn-entry.js`), and `dist/` is gitignored. A clean CI checkout has none, so
Metro fails with `Unable to resolve module @votetorrent/vote-engine/rn` during
`:app:createBundleReleaseJsAndAssets`. Local builds only work because `dist/` is already on
disk. The workflow runs:

```bash
yarn workspaces foreach -At --include 'packages/*' run build
```

The `--include 'packages/*'` scope is deliberate: `votetorrent-authority`'s `build` script
is `bin/build.sh`, which shells into gradle. Dropping the scope runs an unsigned,
unconfigured Android build inside the dependency step.

---

## How the permalinks work, and why

Each app gets a rolling release (`latest-voting`, `latest-authority`) whose single
fixed-name asset is replaced on every build:

```
https://github.com/gotchoices/votetorrent/releases/download/latest-voting/votetorrent-voting-latest.apk
https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk
```

These deliberately avoid GitHub's native
`https://github.com/<owner>/<repo>/releases/latest/download/<asset>` form. That form
resolves to the newest non-prerelease release across **all** tags — so after an
Authority-only release, the Voting link 404s, because the newest release carries no Voting
asset. This is not hypothetical: it was reproduced on the fork, where the native form
returned 404 for Voting at the same moment the rolling permalink returned 200.

The rolling releases are created `--prerelease --latest=false` so they never take the
"Latest" badge from real versioned releases.

---

## Safety properties to preserve

The workflow fails loudly rather than shipping a wrongly-signed APK. Three gates:

1. Missing/empty secrets are caught before anything else runs.
2. `keytool -list` proves the password opens the keystore *before* the ~20-minute build.
3. `apksigner verify --print-certs` rejects any APK bearing `CN=Android Debug`.

There is no debug-signing fallback, by design — a missing secret is a hard build failure,
never a silently-wrong artifact. Keep it that way.

The decoded keystore is removed from the runner in an `if: always()` step so it cannot
survive a failed build.

---

## Reference

- `doc/releases/RELEASE-ANDROID.md` — day-to-day operating runbook
- Working reference implementation: `inspirions/votetorrent`, validated end-to-end on
  2026-08-03 (both apps published, permalinks serving correctly-signed APKs, cross-app
  survival confirmed)
