#!/usr/bin/env bash
#
# make-devrelease-keystore.sh
#
# Purpose : Generate a dedicated NON-PRODUCTION release keystore for the CR-02
#           attestation cert-pin proof. The committed app-identity pin currently
#           lists only the universal Android debug certificate, whose private key
#           is public — so the pin proves nothing until a real release-signed
#           build exists to pin against. This makes such a key WITHOUT needing
#           the production keystore.
#
#           The keystore holds one key per app, matching the shared-keystore
#           layout the release build already expects (doc/releases/RELEASE-ANDROID.md):
#           alias org.votetorrent.voter and org.votetorrent.authority.
#
# Usage   : DEVRELEASE_STORE_PASSWORD='...' ./scripts/make-devrelease-keystore.sh [output-path]
#
#           Default output: $HOME/.votetorrent-keys/votetorrent-devrelease.keystore
#
# Prereqs : keytool on PATH (any JDK 11+).
#
# Exit    : 0 — keystore created (or already present and left untouched)
#           1 — refused: bad password, unsafe output path, or keytool failure
#
# SAFETY   This key is a TEST IDENTITY. It must never sign a published artifact
#          and its digest must never be presented as the production pin. The
#          script refuses to write anywhere inside the git working tree so the
#          keystore cannot be committed by accident.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO_ROOT="$(pwd)"
OUT_PATH="${1:-$HOME/.votetorrent-keys/votetorrent-devrelease.keystore}"
VALIDITY_DAYS=3650
DNAME="CN=VoteTorrent Dev Release (NOT FOR PRODUCTION), OU=Engineering, O=VoteTorrent, C=US"
ALIASES=("org.votetorrent.voter" "org.votetorrent.authority")

log() { echo "[make-devrelease-keystore] $*"; }
die() { echo "[make-devrelease-keystore] ERROR: $*" >&2; exit 1; }

# ── STEP 0: validate the password ────────────────────────────────────────────
# Passwords arrive via the environment, never argv, so they stay out of `ps`
# (same rule as scripts/VerifyKeystore.java).
if [ -z "${DEVRELEASE_STORE_PASSWORD:-}" ]; then
  die "DEVRELEASE_STORE_PASSWORD is not set.
  Set it in your shell (it never appears in argv):
    export DEVRELEASE_STORE_PASSWORD='choose-a-strong-passphrase'"
fi
if [ "${#DEVRELEASE_STORE_PASSWORD}" -lt 6 ]; then
  die "DEVRELEASE_STORE_PASSWORD must be at least 6 characters (keytool's minimum)."
fi

# NOTE ON PKCS12 AND PER-KEY PASSWORDS
# keytool REFUSES to honour -keypass on a PKCS12 keystore: it prints
# "Different store and key passwords not supported for PKCS12 KeyStores" and
# substitutes the store password (JDK-8008292, closed Won't Fix — see the same
# note in scripts/VerifyKeystore.java). So every key here shares the store
# password. When you export the build env, set the per-app key password vars to
# that SAME value; the Android Gradle Plugin handles it fine.

# ── STEP 1: refuse unsafe output paths ───────────────────────────────────────
OUT_DIR="$(dirname "${OUT_PATH}")"
mkdir -p "${OUT_DIR}"
ABS_OUT="$(cd "${OUT_DIR}" && pwd)/$(basename "${OUT_PATH}")"

case "${ABS_OUT}" in
  "${REPO_ROOT}"/*)
    die "refusing to write inside the repository working tree:
    ${ABS_OUT}
  A keystore committed to git is exactly the CR-02 defect this proof exists to close.
  Pick a path outside ${REPO_ROOT} (default: \$HOME/.votetorrent-keys/)." ;;
esac

if [ -f "${ABS_OUT}" ]; then
  log "keystore already exists, leaving it untouched: ${ABS_OUT}"
  log "delete it yourself if you intend to regenerate (that CHANGES the digest and invalidates any pin)."
  exit 0
fi

# ── STEP 2: generate one key per app ─────────────────────────────────────────
for alias in "${ALIASES[@]}"; do
  log "generating key: ${alias}"
  keytool -genkeypair \
    -keystore "${ABS_OUT}" \
    -storetype PKCS12 \
    -storepass "${DEVRELEASE_STORE_PASSWORD}" \
    -alias "${alias}" \
    -keyalg RSA \
    -keysize 4096 \
    -sigalg SHA256withRSA \
    -validity "${VALIDITY_DAYS}" \
    -dname "${DNAME}" \
    >/dev/null
done

chmod 600 "${ABS_OUT}"

# ── STEP 3: report the digests this keystore will produce ────────────────────
log "created ${ABS_OUT}"
log ""
log "Certificate digests (these are what the attestation pin compares against):"
for alias in "${ALIASES[@]}"; do
  digest="$(keytool -list -v \
    -keystore "${ABS_OUT}" \
    -storepass "${DEVRELEASE_STORE_PASSWORD}" \
    -alias "${alias}" 2>/dev/null \
    | grep 'SHA256:' | head -1 | sed 's/.*SHA256: //' | tr -d ': ' | tr 'A-F' 'a-f')"
  log "  ${alias}"
  log "    ${digest}"
done
log ""
log "NOTE: the digest that gets pinned must come from the BUILT APK, not from here —"
log "      read it with ./scripts/read-apk-cert-digest.sh so a silent debug-signing"
log "      fallback cannot go unnoticed. These values are for cross-checking only."
log ""
log "Next: export the build environment, then run ./scripts/build-voter-devrelease.sh"
log "  export STORE_FILE_VOTETORRENT='${ABS_OUT}'"
log "  export PASSWORD_STORE_VOTETORRENT=\"\$DEVRELEASE_STORE_PASSWORD\""
log "  export PASSWORD_KEY_VOTER=\"\$DEVRELEASE_STORE_PASSWORD\"      # PKCS12: same as store"
log "  export PASSWORD_KEY_AUTHORITY=\"\$DEVRELEASE_STORE_PASSWORD\"  # only if building authority too"
