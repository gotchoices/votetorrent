#!/usr/bin/env bash
#
# read-apk-cert-digest.sh
#
# Purpose : Read the signing-certificate SHA-256 off a built APK and emit it in
#           the exact form the attestation pin stores — lowercase hex, no colons
#           (see EXPECTED_APP_CERT_SHA256_DIGESTS in
#           apps/VoteTorrentAuthority/src/engines/attestation-keys.generated.ts).
#
#           Reads the APK rather than the keystore ON PURPOSE. The keystore tells
#           you what you MEANT to sign with; the APK tells you what actually
#           signed it. Those differ precisely in the case that matters — the
#           debug-signing fallback at build.gradle:144 — and that case is
#           invisible from the keystore side.
#
# Usage   : ./scripts/read-apk-cert-digest.sh <path-to.apk>
#
# Prereqs : apksigner from the Android SDK build-tools. Auto-located under
#           $ANDROID_HOME / $ANDROID_SDK_ROOT / ~/Library/Android/sdk if not on PATH.
#
# Exit    : 0 — digest read and it is NOT a known-public debug certificate
#           1 — apksigner missing, APK unreadable, or DEBUG-SIGNED (proof void)
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APK="${1:-}"

# The universal Android SDK debug certificate. Anyone can sign with it, which is
# why the CR-02 guard strips it from release builds. Kept in sync with
# PUBLIC_DEBUG_CERT_SHA256_DIGESTS in attestation-keys.generated.ts.
PUBLIC_DEBUG_DIGEST='fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'

log() { echo "[read-apk-cert-digest] $*"; }
die() { echo "[read-apk-cert-digest] ERROR: $*" >&2; exit 1; }

[ -n "${APK}" ] || die "usage: $0 <path-to.apk>"
[ -f "${APK}" ] || die "no such APK: ${APK}"

# ── STEP 0: locate apksigner ─────────────────────────────────────────────────
APKSIGNER="$(command -v apksigner || true)"
if [ -z "${APKSIGNER}" ]; then
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [ -n "${sdk}" ] && [ -d "${sdk}/build-tools" ] || continue
    # Highest build-tools version wins; sort -V handles 9.x vs 10.x correctly.
    candidate="$(find "${sdk}/build-tools" -maxdepth 2 -name apksigner -type f 2>/dev/null \
      | sort -V | tail -1)"
    if [ -n "${candidate}" ]; then APKSIGNER="${candidate}"; break; fi
  done
fi
[ -n "${APKSIGNER}" ] || die "apksigner not found. Install Android SDK build-tools, or set ANDROID_HOME."

# ── STEP 1: read the certificate ─────────────────────────────────────────────
CERTS_OUT="$("${APKSIGNER}" verify --print-certs "${APK}" 2>&1)" \
  || die "apksigner could not verify ${APK}:
${CERTS_OUT}"

DIGEST="$(printf '%s\n' "${CERTS_OUT}" \
  | grep -i 'SHA-256 digest' | head -1 \
  | sed 's/.*digest:[[:space:]]*//' | tr -d ': ' | tr 'A-F' 'a-f')"

[ -n "${DIGEST}" ] || die "no SHA-256 digest in apksigner output:
${CERTS_OUT}"

if ! printf '%s' "${DIGEST}" | grep -qE '^[0-9a-f]{64}$'; then
  die "parsed digest is not 64 lowercase hex chars: '${DIGEST}'"
fi

# ── STEP 2: reject a debug-signed APK ────────────────────────────────────────
if [ "${DIGEST}" = "${PUBLIC_DEBUG_DIGEST}" ]; then
  log ""
  log "APK: ${APK}"
  log "digest: ${DIGEST}"
  die "this APK is signed with the PUBLIC ANDROID DEBUG CERTIFICATE.

  The release build silently fell back to debug signing — build.gradle:144 does
  that whenever STORE_FILE_VOTETORRENT is empty (guard at build.gradle:86).

  Pinning this digest would re-create the exact CR-02 defect: a pin that accepts
  a certificate anyone can produce. Fix the signing env and rebuild:
    ./scripts/build-voter-devrelease.sh"
fi

# ── STEP 3: emit ─────────────────────────────────────────────────────────────
log "APK:    ${APK}"
log "signer: not a known-public debug certificate (good)"
log ""
log "digest (lowercase hex, no colons) — this is the pin value:"
printf '%s\n' "${DIGEST}"
log ""
log "Next: ./scripts/pin-voter-cert-digest.sh ${DIGEST}"
