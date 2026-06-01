#!/usr/bin/env bash
# CI grep guard: rejects colon-prefix SQL bind keys in builder files.
# Pitfall 3: Quereus colon-prefix parameter binding quirk must stay
# contained at the engine layer -- builders must never construct SQL
# bind objects with :colonPrefix keys.
#
# Usage:
#   bash scripts/ci-grep-guard.sh
#   BUILDERS_DIR=/path/to/dir bash scripts/ci-grep-guard.sh
#
# Exits 0 if clean, 1 if violations found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"

# Allow override for testing
if [ -n "${BUILDERS_DIR:-}" ]; then
  SEARCH_DIR="$BUILDERS_DIR"
else
  SEARCH_DIR="$PACKAGE_ROOT/src"
fi

# Find all .ts files in builders/ directories
if [ -n "${BUILDERS_DIR:-}" ]; then
  # When BUILDERS_DIR is explicitly set, scan all .ts files in it
  TS_FILES=$(find "$SEARCH_DIR" -name '*.ts' -type f 2>/dev/null || true)
else
  # Default: scan only files inside builders/ subdirectories
  TS_FILES=$(find "$SEARCH_DIR" -path '*/builders/*.ts' -type f 2>/dev/null || true)
fi

if [ -z "$TS_FILES" ]; then
  echo "CI grep guard: clean -- no builder .ts files found to scan."
  exit 0
fi

# Detect colon-prefix bind keys: patterns like ':identifier' used in SQL bind objects.
# This catches:
#   ':userId'   ':networkId'   ":key"   ':signerKey'
# But not:
#   kind: "x"   message: "y"   // comment with :foo
#   https://url   import/export statements   TypeScript annotations
#
# Strategy: look for the specific SQL bind pattern -- a colon immediately
# followed by a letter, inside quotes (single or double), which is the
# Quereus parameter binding convention.
VIOLATIONS=$(echo "$TS_FILES" | xargs grep -rnE "['\"]:[a-zA-Z][a-zA-Z0-9]*['\"]" 2>/dev/null \
  | grep -v '^\s*//' \
  | grep -v '//' \
  | grep -v '/\*' \
  | grep -v 'http' \
  | grep -v 'https' \
  || true)

if [ -n "$VIOLATIONS" ]; then
  echo "PITFALL 3 VIOLATION: Colon-prefix SQL bind keys detected in builder files."
  echo ""
  echo "The following lines contain colon-prefix patterns that may be SQL bind keys:"
  echo "$VIOLATIONS"
  echo ""
  echo "Builders must never construct SQL bind objects. The colon-prefix parameter"
  echo "binding quirk (Pitfall 3) must stay contained at the engine layer."
  exit 1
fi

echo "CI grep guard: clean -- no colon-prefix bind keys in builder files."
exit 0
