#!/usr/bin/env bash
# run-two-party-ceremony.sh — Phase 51 Plan 13, Task 1/2 (D-17's scripted entry point).
#
# Drives every part of the D-17 two-party ceremony's setup that does NOT require a human hand on a
# phone, in the self-describing style `packages/vote-engine/scripts/run-reattach-proof.sh` set:
# every resolved input is echoed before it is used. Provenance is the failure mode this project
# keeps hitting (a symlinked node_modules once made CocoaPods compile the wrong checkout; a stale
# Metro once served the wrong tree's bundle) — a run that cannot say what it used is not evidence.
#
# Sequence:
#   1. Working-tree provenance: git SHA, git status --porcelain (warn loudly if dirty).
#   2. Rebuild packages/vote-engine's dist/ (the deep-require path both apps use) and print the
#      built artifact's mtime.
#   3. Transport routing (D-28/D-29, Phase 62 Plan 25): neither app carries a dev base-URL
#      constant any longer. Association is P2P-only in both apps (D-28) — this bridge's
#      association endpoints (`/staged-association-requests`, `/staged-association-attestations`,
#      `/association-decisions`) have no app consumer any more. The Authority's registration REST
#      path (D-29) now reaches this bridge only through the https URL a `'vrg'` officer saves in
#      the app's Registration Bridge card, stored in the signed, replicated `AuthorityIntakePolicy`
#      — never a local source edit. This bridge serves plain http, so a real device session needs
#      an https terminator in front of it (e.g. a local TLS proxy) before an officer can save this
#      bridge's URL. The two-party association ceremony over the peer path remains proof debt
#      against P2P-11 (D-37) — this script no longer stages a courier for it.
#   4. Assert the COMMITTED tree's APP_ATTEST_ENVIRONMENT is 'production' (D-15) and print the
#      current WORKING-TREE value beside it (which may legitimately read 'development' while a
#      dev-only authority build is staged for Phase B — that edit must never be committed).
#   5. Check for a connected physical iOS device (best-effort via `xcrun xctrace list devices`)
#      and FAIL LOUDLY with an actionable message if none is found — App Attest cannot be produced
#      by a simulator, so a phoneless run cannot proceed past this point. `--skip-device-check`
#      is available for staging the bridge ahead of physically attaching the phone.
#   6. Start the bridge and print the staging directory path.
#
# Usage:
#   bash scripts/device-proof/run-two-party-ceremony.sh [--port 8791] [--host 0.0.0.0] \
#       [--staging-dir <path>] [--skip-device-check]
#
# Safe to re-run: step 3/4 are read-only assertions, step 2 is idempotent, and the bridge (step 6)
# uses a fresh staging directory by default on every invocation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

PORT=8791
HOST=0.0.0.0
STAGING_DIR=""
SKIP_DEVICE_CHECK=0

while [ $# -gt 0 ]; do
	case "$1" in
	--port)
		PORT="$2"
		shift 2
		;;
	--host)
		HOST="$2"
		shift 2
		;;
	--staging-dir)
		STAGING_DIR="$2"
		shift 2
		;;
	--skip-device-check)
		SKIP_DEVICE_CHECK=1
		shift
		;;
	*)
		echo "run-two-party-ceremony.sh: unrecognized argument $1" >&2
		exit 1
		;;
	esac
done

if [ -z "$STAGING_DIR" ]; then
	STAGING_DIR="$(mktemp -d -t votetorrent-association-bridge)"
fi

echo "=== Phase 51 Plan 13 — run-two-party-ceremony.sh ==="
echo "Repo root: $REPO_ROOT"
echo

# --- [1/6] working-tree provenance -----------------------------------------
echo "--- [1/6] working-tree provenance ---"
GIT_SHA="$(git rev-parse --short HEAD)"
echo "git SHA: $GIT_SHA"
GIT_STATUS="$(git status --porcelain)"
if [ -n "$GIT_STATUS" ]; then
	echo "WARNING: working tree is dirty (expected while the dev-only APP_ATTEST_ENVIRONMENT flip"
	echo "is staged for this session — that edit may never be committed):"
	echo "$GIT_STATUS"
else
	echo "working tree is clean."
fi
echo

# --- [2/6] rebuild packages/vote-engine dist -------------------------------
echo "--- [2/6] rebuild packages/vote-engine dist ---"
(cd packages/vote-engine && yarn build)
DIST_FILE="packages/vote-engine/dist/association/transport/rest-association-transport.js"
if [ ! -f "$DIST_FILE" ]; then
	echo "FATAL: $DIST_FILE does not exist after build — the deep-require path both apps and" >&2
	echo "the bridge's digest oracle depend on will fail to resolve. Aborting." >&2
	exit 1
fi
DIST_MTIME="$(stat -f '%Sm' "$DIST_FILE" 2>/dev/null || stat -c '%y' "$DIST_FILE" 2>/dev/null || echo 'unknown')"
echo "Built artifact: $DIST_FILE"
echo "mtime:          $DIST_MTIME"
echo

# --- [3/6] transport routing (D-28/D-29) -----------------------------------
echo "--- [3/6] transport routing (D-28/D-29) ---"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')"
if [ -z "$LAN_IP" ]; then
	echo "WARNING: could not auto-detect a LAN IP (tried en0/en1 via ipconfig). Find one manually"
	echo "  (e.g. 'ifconfig | grep inet') and substitute it in the base URL below."
	LAN_IP="<detect-manually>"
fi
BRIDGE_URL="http://${LAN_IP}:${PORT}"
echo "Bridge will bind to: http://${HOST}:${PORT}"
echo "Detected LAN IP candidate (phone-reachable, NOT 127.0.0.1/10.0.2.2): $LAN_IP"
echo

echo "Neither app carries a dev base-URL constant any longer — 62-22 retired the Voter's, and"
echo "  62-25 retired the Authority's registration one. There is nothing left to locally edit."
echo
echo "Association is P2P-only in BOTH apps (D-28): neither app binds this bridge's"
echo "  /staged-association-requests, /staged-association-attestations or /association-decisions"
echo "  endpoints — they have no app consumer any more. The two-party association ceremony over"
echo "  the peer path remains proof debt against P2P-11 (D-37); this script does not exercise it."
echo
echo "Registration reaches this bridge only through the https URL a 'vrg' officer saves in the"
echo "  Authority app's Registration Bridge card (D-29), stored in the signed, replicated"
echo "  AuthorityIntakePolicy — never a local source edit. This relay serves plain http"
echo "  ($BRIDGE_URL), so a real device session needs an https terminator in front of it before"
echo "  an officer can save this bridge's URL (the policy's RestBridgeUrl CHECK is https-only)."
echo
echo "The Voter (62-22) reads the SAME replicated AuthorityIntakePolicy bridge URL — no local"
echo "  Voter edit is needed for this ceremony either."
echo

# --- [4/6] APP_ATTEST_ENVIRONMENT (D-15) -----------------------------------
echo "--- [4/6] APP_ATTEST_ENVIRONMENT (D-15) ---"
ATTEST_FILE="apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts"
COMMITTED_LINE="$(git show HEAD:"$ATTEST_FILE" | grep 'APP_ATTEST_ENVIRONMENT' || true)"
WORKING_LINE="$(grep 'APP_ATTEST_ENVIRONMENT' "$ATTEST_FILE" || true)"
echo "Committed (git HEAD) value: $COMMITTED_LINE"
echo "Working-tree value:         $WORKING_LINE"
# Extract ONLY the assigned value (the text after the final '= '), never the whole declaration
# line — the declaration's own TYPE ANNOTATION is the union `'development' | 'production'`, so a
# naive whole-line grep for either literal always matches regardless of what is actually assigned.
COMMITTED_ASSIGNED="$(echo "$COMMITTED_LINE" | grep -oE "= '[a-z]+';" || true)"
WORKING_ASSIGNED="$(echo "$WORKING_LINE" | grep -oE "= '[a-z]+';" || true)"
if ! echo "$COMMITTED_ASSIGNED" | grep -q "'production'"; then
	echo
	echo "FATAL: the COMMITTED value of APP_ATTEST_ENVIRONMENT is not 'production'. D-15 requires" >&2
	echo "the committed tree to stay 'production' at all times — a release build's own gate" >&2
	echo "depends on this literal. Refusing to continue; fix the committed tree first." >&2
	exit 1
fi
echo "Committed value is 'production' — good."
if echo "$WORKING_ASSIGNED" | grep -q "'development'"; then
	echo "NOTE: the WORKING TREE currently reads 'development'. This is expected ONLY while a"
	echo "  dev-only authority build is staged for Phase B, and this edit must be reverted before"
	echo "  this file is ever committed."
else
	echo "NOTE: for Phase B, build the DEV-ONLY AUTHORITY app with this file's"
	echo "  APP_ATTEST_ENVIRONMENT locally flipped to 'development' (never commit that edit), then"
	echo "  revert it before committing anything. This script does not flip it for you."
fi
echo

# --- [5/6] physical device presence (best-effort) --------------------------
echo "--- [5/6] physical iOS device check ---"
if [ "$SKIP_DEVICE_CHECK" -eq 1 ]; then
	echo "SKIPPED (--skip-device-check passed) — the bridge will start, but the ceremony itself"
	echo "  cannot proceed past submission without a real device: App Attest cannot be produced by"
	echo "  a simulator."
else
	DEVICE_LIST="$(xcrun xctrace list devices 2>/dev/null | awk '/== Devices ==/{flag=1; next} /== Simulators ==/{flag=0} flag && NF' || true)"
	PHYSICAL_DEVICES="$(echo "$DEVICE_LIST" | grep -vi 'simulator' | grep -vi '^this mac' || true)"
	if [ -z "$PHYSICAL_DEVICES" ]; then
		echo
		echo "FATAL: no physical iOS device is attached (xcrun xctrace list devices found none" >&2
		echo "outside the Simulator/this-Mac sections). App Attest cannot be produced by a" >&2
		echo "simulator — this ceremony's D-17 exit criterion is unreachable without real hardware." >&2
		echo >&2
		echo "ACTION REQUIRED:" >&2
		echo "  1. Connect the iPhone 13 via USB (or ensure it is paired for wireless debugging)." >&2
		echo "  2. Unlock the phone and, if prompted, tap 'Trust This Computer'." >&2
		echo "  3. Confirm it appears: xcrun xctrace list devices" >&2
		echo "  4. Re-run this script." >&2
		echo "  (Or pass --skip-device-check to start the bridge now and attach the phone after —" >&2
		echo "  the ceremony itself will still not progress past submission without it.)" >&2
		exit 1
	fi
	echo "Physical device(s) detected:"
	echo "$PHYSICAL_DEVICES" | sed 's/^/  /'
fi
echo

# --- [6/6] start the bridge --------------------------------------------------
echo "--- [6/6] starting the bridge ---"
echo "Staging directory: $STAGING_DIR"
echo "Command: node scripts/device-proof/association-rest-bridge.mjs --port $PORT --host $HOST --staging-dir $STAGING_DIR"
echo
exec node scripts/device-proof/association-rest-bridge.mjs --port "$PORT" --host "$HOST" --staging-dir "$STAGING_DIR"
