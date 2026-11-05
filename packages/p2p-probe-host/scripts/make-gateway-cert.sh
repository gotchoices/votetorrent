#!/usr/bin/env bash
# packages/p2p-probe-host/scripts/make-gateway-cert.sh — 56-08 D-12 certificate tooling.
#
# Issues a REAL leaf certificate for the public-observer gateway from a locally-installed
# mkcert CA, and emits the SPKI pin 56-11 can use as a fallback to system-trust validation.
#
# CERTIFICATE MECHANISM DECISION (D-12 / RESEARCH Open Question 4 / Assumption A4 — settled here):
#
#   CHOSEN — mkcert-issued leaf from a locally-installed CA.
#     One-time `brew install mkcert` + `mkcert -install`, then a leaf for
#     `localhost 127.0.0.1 ::1`. Both Node (`NODE_EXTRA_CA_CERTS=$(mkcert -CAROOT)/rootCA.pem`)
#     and 56-11's Playwright Chromium validate a GENUINE chain, so a broken TLS setup can still
#     fail the gate. It also generalizes cleanly to a real deployment: only the issuer changes
#     (see doc/public-gateway-deploy.md §7), the `https: { cert, key }` seam does not.
#
#   REJECTED — self-signed certificate + a browser TLS bypass (`--ignore-certificate-errors`).
#     Disables certificate validation GLOBALLY in the gate's browser, so the 56-11 gate could
#     never fail on a broken TLS configuration. A green gate that cannot fail proves nothing.
#
#   REJECTED — a hand-rolled openssl CA.
#     The hard part of "real certificate handling" is the per-platform trust-store install,
#     which is precisely what mkcert exists to do correctly. Hand-rolling it is more code, less
#     portable, and still requires the same admin prompt mkcert already handles.
#
# This script NEVER falls back to a self-signed certificate. If mkcert is unavailable it exits
# non-zero and prints the exact remediation commands — see the negative-control acceptance
# criterion in 56-08-PLAN.md Task 1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CERTS_DIR="${PKG_DIR}/certs"
CERT_PATH="${CERTS_DIR}/gateway-cert.pem"
KEY_PATH="${CERTS_DIR}/gateway-key.pem"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "FATAL: mkcert is not installed — this script refuses to fall back to a self-signed certificate." >&2
  echo "" >&2
  echo "Install it, then re-run this script:" >&2
  echo "  brew install mkcert" >&2
  echo "  mkcert -install   # writes the local CA into the system trust store (admin password required)" >&2
  exit 1
fi

mkdir -p "${CERTS_DIR}"

CAROOT="$(mkcert -CAROOT)"
if [ ! -f "${CAROOT}/rootCA.pem" ]; then
  echo "FATAL: mkcert has no root CA at ${CAROOT}/rootCA.pem — run 'mkcert -install' first." >&2
  exit 1
fi

# Issue the leaf directly into certs/ with fixed filenames (mkcert's own naming is
# hostname-derived and would drift as hostnames change).
TMP_CERT="${CERTS_DIR}/.tmp-gateway-cert.pem"
TMP_KEY="${CERTS_DIR}/.tmp-gateway-key.pem"
rm -f "${TMP_CERT}" "${TMP_KEY}"

( cd "${CERTS_DIR}" && mkcert -cert-file ".tmp-gateway-cert.pem" -key-file ".tmp-gateway-key.pem" localhost 127.0.0.1 ::1 )

mv "${TMP_CERT}" "${CERT_PATH}"
mv "${TMP_KEY}" "${KEY_PATH}"
chmod 600 "${KEY_PATH}"

SPKI_SHA256=$(openssl x509 -in "${CERT_PATH}" -noout -pubkey \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | openssl enc -base64)

echo "MKCERT_CAROOT=${CAROOT}"
echo "GATEWAY_TLS_CERT=${CERT_PATH}"
echo "GATEWAY_TLS_SPKI_SHA256=${SPKI_SHA256}"
