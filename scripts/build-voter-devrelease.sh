#!/usr/bin/env bash
#
# build-voter-devrelease.sh
#
# Purpose : Build the voter release APK signed with the dev-release keystore, for
#           the CR-02 attestation cert-pin proof. Wraps `gradlew assembleRelease`
#           with the env vars apps/VoteTorrentVoter/android/app/build.gradle:123-130
#           already reads, plus the preflight that catches the one failure mode
#           that would otherwise pass silently.
#
#           THE SILENT FAILURE THIS GUARDS: build.gradle:86 sets
#           hasReleaseSigningEnv from STORE_FILE_VOTETORRENT alone, and
#           buildTypes.release falls back to signingConfigs.debug when it is
#           empty. So a release build with a missing/typo'd env var still
#           SUCCEEDS — signed with the public debug key. The APK looks right and
#           installs fine; only the certificate differs. Verifying the digest
#           afterwards (step 3) is what catches it.
#
# Usage   : STORE_FILE_VOTETORRENT=... PASSWORD_STORE_VOTETORRENT=... \
#           PASSWORD_KEY_VOTER=... ./scripts/build-voter-devrelease.sh
#
# Prereqs : JDK 17+ (for the Android Gradle Plugin), Android SDK, and a keystore
#           from ./scripts/make-devrelease-keystore.sh.
#
# Exit    : 0 — APK built and signed with the intended (non-debug) certificate
#           1 — missing env, keystore preflight failure, or gradle failure
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO_ROOT="$(pwd)"
VOTER_ANDROID="apps/VoteTorrentVoter/android"
APK_PATH="${VOTER_ANDROID}/app/build/outputs/apk/release/app-release.apk"
KEY_ALIAS="${KEY_ALIAS_VOTER:-org.votetorrent.voter}"

log() { echo "[build-voter-devrelease] $*"; }
die() { echo "[build-voter-devrelease] ERROR: $*" >&2; exit 1; }

# ── STEP 0: require the full signing env ─────────────────────────────────────
# Checked here rather than left to gradle, because gradle's own guard keys on
# STORE_FILE_VOTETORRENT ONLY and silently debug-signs when it is absent.
for var in STORE_FILE_VOTETORRENT PASSWORD_STORE_VOTETORRENT PASSWORD_KEY_VOTER; do
  if [ -z "${!var:-}" ]; then
    die "${var} is not set.
  All three are required, or gradle silently falls back to DEBUG signing and the
  proof is void. See doc/releases/DEVRELEASE-ATTESTATION-PROOF.md."
  fi
done

if [ ! -f "${STORE_FILE_VOTETORRENT}" ]; then
  die "keystore not found at STORE_FILE_VOTETORRENT=${STORE_FILE_VOTETORRENT}
  Generate one with ./scripts/make-devrelease-keystore.sh"
fi

# ── STEP 1: keystore preflight ───────────────────────────────────────────────
# Reuses the existing fastlane preflight, which loads the store and calls
# getEntry(alias, PasswordProtection(keyPassword)) exactly as the Android Gradle
# Plugin does — so a pass here genuinely predicts a successful signed build.
# keytool cannot do this check on PKCS12 (JDK-8008292); see VerifyKeystore.java.
#
# VerifyKeystore ALWAYS EXITS 0 unless it cannot run at all (documented in its
# header) — a wrong password still exits 0. Its verdict lives in the KEY=VALUE
# lines on stdout, so parse those; checking $? here would silently pass anything.
# Its passwords come from VT_STORE_PW / VT_KEY_PW, not the build's own var names.
if command -v java >/dev/null 2>&1; then
  log "keystore preflight: ${KEY_ALIAS}"
  PREFLIGHT="$(VT_STORE_PW="${PASSWORD_STORE_VOTETORRENT}" \
               VT_KEY_PW="${PASSWORD_KEY_VOTER}" \
               java scripts/VerifyKeystore.java "${STORE_FILE_VOTETORRENT}" "${KEY_ALIAS}" 2>&1 || true)"

  grep -q '^STORE_OK=1' <<<"${PREFLIGHT}" || die "cannot open the keystore — wrong PASSWORD_STORE_VOTETORRENT?
${PREFLIGHT}"

  grep -q '^ALIAS_OK=1' <<<"${PREFLIGHT}" || die "keystore has no key with alias '${KEY_ALIAS}'.
$(grep '^ALIASES=' <<<"${PREFLIGHT}" || true)
  Override the alias with KEY_ALIAS_VOTER if the key is named differently."

  grep -q '^KEY_OK=1' <<<"${PREFLIGHT}" || die "cannot unlock key '${KEY_ALIAS}' — wrong PASSWORD_KEY_VOTER?
  On a PKCS12 keystore the key password equals the store password (JDK-8008292).
${PREFLIGHT}"

  log "keystore preflight OK (store, alias, and key all verified)"
else
  log "WARNING: java not on PATH — skipping keystore preflight (gradle will fail later if the key is wrong)"
fi

# ── STEP 1b: voter workspace dependencies ────────────────────────────────────
# settings.gradle includes @react-native/gradle-plugin as a composite build from
# the voter workspace's own node_modules (nmHoistingLimits: workspaces keeps it
# unhoisted). Without an install, gradle fails with a misleading
# "Error resolving plugin [id: 'com.facebook.react.settings']" rather than
# naming the real cause.
if [ ! -d "apps/VoteTorrentVoter/node_modules/@react-native/gradle-plugin" ]; then
  die "voter workspace dependencies are not installed.

  apps/VoteTorrentVoter/node_modules/@react-native/gradle-plugin is missing, which
  makes gradle fail with a confusing 'Error resolving plugin com.facebook.react.settings'.

  Install them first (from the repo root):
    yarn install

  This repo sets nmHoistingLimits: workspaces, so each app keeps its own
  node_modules — a populated authority workspace does not imply a populated voter one."
fi

# ── STEP 2: build ────────────────────────────────────────────────────────────
# build.gradle reads these from the environment; export so the gradle daemon
# inherits them. They are NOT passed as -P properties, which would land in
# the daemon's command line and thus in `ps`.
export STORE_FILE_VOTETORRENT PASSWORD_STORE_VOTETORRENT PASSWORD_KEY_VOTER
export KEY_ALIAS_VOTER="${KEY_ALIAS}"

log "building voter release APK (this compiles Hermes bytecode — expect several minutes)"
( cd "${VOTER_ANDROID}" && ./gradlew --no-daemon assembleRelease )

[ -f "${APK_PATH}" ] || die "gradle reported success but no APK at ${APK_PATH}"

log "built ${APK_PATH}"

# ── STEP 3: prove it is NOT debug-signed ─────────────────────────────────────
# The whole point of the exercise: confirm the fallback at build.gradle:144 did
# not quietly take over.
log ""
log "verifying the signing certificate..."
./scripts/read-apk-cert-digest.sh "${APK_PATH}"
