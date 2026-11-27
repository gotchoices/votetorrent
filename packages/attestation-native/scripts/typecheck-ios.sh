#!/usr/bin/env bash
#
# typecheck-ios.sh — compile-gate the iOS TurboModule without an Xcode project.
#
# It typechecks against the real iOS SDK, not macOS — availability annotations differ
# (DCAppAttestService is iOS 14+), so a macOS-SDK pass would prove less than it appears to.
#
# Skips cleanly (exit 0) where no Xcode is installed, so it can live in CI on Linux runners.
#
# ---------------------------------------------------------------------------------------------
# HOW THIS GATE WAS UNSOUND, AND WHAT CHANGED (2026-08-26)
#
# The previous version wrote a shim declaring RCTPromiseResolveBlock / RCTPromiseRejectBlock at
# GLOBAL scope and compiled it alongside the module. Those are precisely the two types a missing
# `import React` leaves undefined — so the gate supplied the very thing it existed to check. It
# reported PASS for the whole of Phase 51 while the Swift could not compile inside a real app, and
# the defect surfaced only when the package was first podded into the voter app, as
# "cannot find type 'RCTPromiseResolveBlock' in scope".
#
# The fix is not to delete the stand-ins — without them there is no standalone gate at all — but to
# put them where React puts them: inside a MODULE NAMED React. The module sources are then compiled
# with `-I` against it, so:
#
#   * with `import React` present, the types resolve and the file typechecks;
#   * with `import React` missing, they are NOT in scope, and the gate FAILS — the same failure the
#     real build gives, for the same reason.
#
# And because "this gate cannot fail" is the exact bug being fixed, the script no longer asks you to
# take that on trust: STEP 3 runs a NEGATIVE CONTROL on every invocation. It strips `import React`
# from a copy of the source and requires that copy to FAIL. If the control PASSES, the gate has
# become blind again and this script reports FAIL and says so, rather than reporting a green tick it
# has not earned.
#
# SCOPE, still. A PASS here means "the Apple SDK APIs line up and the React import is real". It is
# not a substitute for compiling against React's actual headers — for that, see
# `typecheck:ios:app`, which builds the voter app with CocoaPods and needs no signing identity.
# ---------------------------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="arm64-apple-ios15.1"
SOURCES=(ios/AttestationNativeModule.swift ios/SignatureEncoding.swift)

if [ -z "${DEVELOPER_DIR:-}" ]; then
  for candidate in /Applications/Xcode*.app; do
    [ -d "$candidate/Contents/Developer" ] && export DEVELOPER_DIR="$candidate/Contents/Developer" && break
  done
fi

if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "typecheck-ios: no iOS SDK available — SKIPPED (this is not a failure)"
  exit 0
fi

SDK=$(xcrun --sdk iphoneos --show-sdk-path)
WORK=$(mktemp -d -t rnstub.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# ---- STEP 1: build a stand-in `React` MODULE (not global typealiases) ----
cat > "$WORK/React.swift" <<'SWIFT'
// Stand-in for React Native's Swift-visible surface, for the standalone typecheck ONLY.
//
// These MUST live in a module named React rather than at global scope. That is the entire
// mechanism by which this gate can detect a missing `import React` — the failure mode that made
// the previous version of this script report PASS on code that could not build.
import Foundation
public typealias RCTPromiseResolveBlock = (Any?) -> Void
public typealias RCTPromiseRejectBlock = (String?, String?, Error?) -> Void
SWIFT

if ! xcrun --sdk iphoneos swiftc -emit-module \
      -module-name React \
      -target "$TARGET" -sdk "$SDK" \
      -emit-module-path "$WORK/React.swiftmodule" \
      "$WORK/React.swift" 2>"$WORK/react.err"; then
  echo "typecheck-ios: FAIL — could not build the stand-in React module"
  cat "$WORK/react.err"
  exit 1
fi

# ---- STEP 2: typecheck the real sources against it ----
xcrun --sdk iphoneos swiftc -typecheck \
  -target "$TARGET" -sdk "$SDK" -I "$WORK" \
  "${SOURCES[@]}"
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "typecheck-ios: FAIL"
  exit $STATUS
fi

# ---- STEP 3: NEGATIVE CONTROL — prove this gate can still fail ----
# A gate is only worth its green tick if it is demonstrably sensitive to the defect it targets.
# Strip `import React` from a COPY and require that copy to be rejected.
CONTROL="$WORK/control"
mkdir -p "$CONTROL"
for src in "${SOURCES[@]}"; do
  cp "$src" "$CONTROL/$(basename "$src")"
done
# Remove the import and any `#if canImport(React)` guard around it, so the control genuinely has
# no path to those types.
/usr/bin/sed -i '' -E '/^[[:space:]]*import React[[:space:]]*$/d; /^[[:space:]]*#if canImport\(React\)[[:space:]]*$/d' \
  "$CONTROL/AttestationNativeModule.swift"

if ! grep -qE '^[[:space:]]*import React[[:space:]]*$' ios/AttestationNativeModule.swift; then
  echo "typecheck-ios: FAIL — ios/AttestationNativeModule.swift has no top-level 'import React'."
  echo "  The negative control below cannot mean anything without it, and the real build needs it."
  exit 1
fi

CONTROL_SOURCES=()
for src in "${SOURCES[@]}"; do
  CONTROL_SOURCES+=("$CONTROL/$(basename "$src")")
done

xcrun --sdk iphoneos swiftc -typecheck \
  -target "$TARGET" -sdk "$SDK" -I "$WORK" \
  "${CONTROL_SOURCES[@]}" >"$WORK/control.out" 2>&1
CONTROL_STATUS=$?

if [ $CONTROL_STATUS -eq 0 ]; then
  echo "typecheck-ios: FAIL — the negative control PASSED."
  echo
  echo "  A copy of AttestationNativeModule.swift with 'import React' removed still typechecked."
  echo "  That means the RCTPromise* types are reachable without importing React — the stand-ins"
  echo "  have leaked back into global scope, or something else now declares them. This gate is"
  echo "  blind again in exactly the way it was before 2026-08-26."
  echo
  echo "  Do NOT silence this by deleting the control. Find what is vending those types."
  exit 1
fi

echo "typecheck-ios: PASS against $(basename "$SDK")"
echo "typecheck-ios: negative control correctly FAILED without 'import React' (gate is sensitive)"
exit 0
