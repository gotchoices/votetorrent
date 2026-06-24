#!/usr/bin/env bash
# scripts/lint-stubs.sh
#
# CI grep guard — exits 1 if any stub console.log handler remains in app screens.
#
# Rule: any prop whose name ends in "Press" or "Pressed" (e.g. onPress, onIconPress,
# makePermanentPressed) must NOT have a console.log call in its handler body.
# Intentional diagnostic logging uses console.info / console.warn / console.error — those
# are explicitly allowed and will not trip this guard.
#
# Exclusion: ScreenScaffoldsDebugScreen.tsx is a dev-only scaffold route, not a production
# screen. Its console.log calls are intentional dev tooling and are excluded from the sweep.
#
# Implementation: uses Perl (-0777 full-file slurp) so a handler body that spans
# multiple lines (e.g. `onPress={() => {\n  console.log("x")\n}}`) is still caught.
# The pattern matches any word-characters followed by Press or Pressed, then an = { ... }
# block containing console.log (but NOT console.info/warn/error).
#
# Usage:
#   bash scripts/lint-stubs.sh    # exits 0 if clean, 1 if stubs found
#   yarn lint:stubs               # npm script alias

set -euo pipefail

SCREENS_DIR="apps/VoteTorrentAuthority/src/screens"
EXCLUDE_FILE="ScreenScaffoldsDebugScreen.tsx"

FOUND_ANY=0
FOUND_FILES=""

# Find all .tsx files under screens/, excluding the dev-only scaffold.
while IFS= read -r f; do
  # Perl full-file slurp + multiline match:
  # \w+(Press|Pressed)\s*=\s*\{[^}]*console\.log  (not .logInfo/.logWarn/.logError)
  # The negative lookahead ensures console.info/warn/error are NOT flagged.
  if perl -0777 -e '
    my $src = do { local $/; <STDIN> };
    if ($src =~ /\w+(?:Press|Pressed)\s*=\s*\{[^}]*console\.log(?!Error|Info|Warn)/s) {
      exit 0;   # match found → exit 0 so the shell knows to flag it
    }
    exit 1;     # no match → exit 1 so shell knows it is clean
  ' < "$f"; then
    FOUND_ANY=1
    FOUND_FILES="$FOUND_FILES $f"
  fi
done < <(find "$SCREENS_DIR" -name "*.tsx" ! -name "$EXCLUDE_FILE")

if [ "$FOUND_ANY" -eq 0 ]; then
  echo "OK: no stub console.log handlers found in $SCREENS_DIR (excluding $EXCLUDE_FILE)."
  exit 0
fi

echo "ERROR: stub console.log handler(s) found in the following files:"
for f in $FOUND_FILES; do
  echo "  $f"
  # Print matching lines for context (single-line grep for line numbers)
  grep -Pn '\w+(?:Press|Pressed)\s*=.*console\.log' "$f" 2>/dev/null || \
    grep -n 'console\.log' "$f" || true
done
echo ""
echo "Fix: disable the affordance in place (D-03) or migrate to console.info (D-04)."
echo "     Do NOT remove buttons — keep them visible, just remove the console.log handler."
exit 1
