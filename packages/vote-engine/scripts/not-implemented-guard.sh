#!/usr/bin/env bash
# ENG-07 grep guard: rejects literal 'Not implemented' throws in vote-engine/src.
#
# Allowlisted function names represent intentionally deferred implementations.
# Each allowlist entry must name the gating phase as justification.
# Extending the allowlist requires a deliberate edit to this file (reviewable in one place).
#
# Usage:
#   bash scripts/not-implemented-guard.sh
#   SRC_DIR=/path/to/dir bash scripts/not-implemented-guard.sh
#
# Exits 0 if clean, 1 if violations found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"

# Allow override for testing (analogous to BUILDERS_DIR in ci-grep-guard.sh)
if [ -n "${SRC_DIR:-}" ]; then
  SEARCH_DIR="$SRC_DIR"
else
  SEARCH_DIR="$PACKAGE_ROOT/src"
fi

# Allowlisted function+phase pairs (format: "function_name:GatingPhase")
# Each entry represents a 'Not implemented' throw that is intentionally deferred.
# The grep guard ignores any 'Not implemented' literal found within ~5 lines of
# a matching async function declaration.
ALLOWLIST=(
  "connectDevice:Phase22"     # UKEY-04 — P2P fabric wiring
  "getHistory:Phase19"        # ENG-02 — user event table (schema-backed log)
  "inviteKeyholder:Phase21"   # INV-03 — signing pipeline (MockElectionEngine)
  "proposeRevision:Phase21"   # signing pipeline (MockElectionEngine)
  "revokeKeyholder:Phase21"   # signing pipeline (MockElectionEngine)
)

# Grep for the literal 'Not implemented' in .ts source files.
# Filter out commented lines (lines beginning with optional whitespace then //)
# so key-network-libp2p.ts commented stubs are never flagged.
RAW_HITS=$(grep -rn "Not implemented" "$SEARCH_DIR" --include="*.ts" || true)

# Remove lines that are comments (^\s*//)
VIOLATIONS=$(echo "$RAW_HITS" | grep -v '^\s*//' | grep -v '^[^:]*:[0-9]*:\s*//' || true)

if [ -z "$VIOLATIONS" ]; then
  echo "ENG-07 grep guard: clean — no 'Not implemented' literals found."
  exit 0
fi

# For each remaining violation, check if an allowlisted function name appears
# in the ~5 preceding lines of context. If so, the throw is sanctioned.
CLEAN=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  FILE=$(echo "$line" | cut -d: -f1)
  LINE_NUM=$(echo "$line" | cut -d: -f2)

  # Read up to 5 preceding lines for context (function signature)
  START_LINE=$(( LINE_NUM > 5 ? LINE_NUM - 5 : 1 ))
  CONTEXT=$(sed -n "${START_LINE},${LINE_NUM}p" "$FILE" 2>/dev/null || true)

  ALLOWED=false
  for entry in "${ALLOWLIST[@]}"; do
    FNAME="${entry%%:*}"
    if echo "$CONTEXT" | grep -qE "async[[:space:]].*${FNAME}[[:space:](]"; then
      ALLOWED=true
      break
    fi
  done

  if [ "$ALLOWED" = false ]; then
    echo "ENG-07 VIOLATION: $line"
    CLEAN=false
  fi
done <<< "$VIOLATIONS"

if [ "$CLEAN" = true ]; then
  echo "ENG-07 grep guard: clean — all 'Not implemented' literals are allowlisted."
  exit 0
fi

echo ""
echo "Replace remaining 'Not implemented' throws with FeatureNotAvailableError or real SQL."
echo "If the throw is intentionally deferred, add the function name to ALLOWLIST in this script."
exit 1
