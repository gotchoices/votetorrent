#!/usr/bin/env bash
#
# typecheck-ios-app.sh — THE AUTHORITATIVE iOS gate: compile this package the way an app compiles
# it, against React Native's real headers, inside a real Xcode target.
#
# WHY THIS EXISTS SEPARATELY FROM typecheck-ios.sh
#
# `typecheck:ios` compiles the Swift standalone against a stand-in `React` module. That is fast,
# needs no CocoaPods, and runs anywhere an iOS SDK exists — but a stand-in is a stand-in. It can
# prove the Apple SDK APIs line up and that `import React` is present and load-bearing; it cannot
# prove that the module's actual React surface (RCT_EXTERN_MODULE registration, bridging headers,
# the podspec's source_files globs, `RCTBridgeModule` conformance) is intact, because it never sees
# any of it.
#
# Phase 51 learned this the expensive way. The package had NO podspec, NO RCT_EXTERN_MODULE shim
# and NO `import React`, and the standalone gate reported PASS throughout. All three surfaced at
# once the first time anyone ran an actual build.
#
# NO SIGNING IDENTITY REQUIRED. This builds for `generic/platform=iOS` with code signing disabled,
# so it needs neither a Team ID nor a connected device — it is the compile step only. A build that
# must also RUN on hardware is a different (and genuinely Team-ID-adjacent) thing; that is the
# device ceremony, not this gate.
#
# Skips cleanly (exit 0) when Xcode or the CocoaPods install is absent, so it is safe in CI.
# Run `pod install` in apps/VoteTorrentVoter/ios first to make it do real work.
set -uo pipefail
cd "$(dirname "$0")/.."

REPO_ROOT=$(cd ../.. && pwd)
IOS_DIR="$REPO_ROOT/apps/VoteTorrentVoter/ios"
WORKSPACE="$IOS_DIR/VoteTorrentVoter.xcworkspace"
SCHEME="VoteTorrentVoter"

if [ -z "${DEVELOPER_DIR:-}" ]; then
  for candidate in /Applications/Xcode*.app; do
    [ -d "$candidate/Contents/Developer" ] && export DEVELOPER_DIR="$candidate/Contents/Developer" && break
  done
fi

if ! command -v xcodebuild >/dev/null 2>&1 || ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "typecheck-ios-app: no Xcode / iOS SDK — SKIPPED (this is not a failure)"
  exit 0
fi

if [ ! -d "$IOS_DIR/Pods" ] || [ ! -d "$WORKSPACE" ]; then
  echo "typecheck-ios-app: CocoaPods not installed — SKIPPED (this is not a failure)"
  echo "  run: (cd apps/VoteTorrentVoter/ios && pod install)"
  exit 0
fi

# The package must actually be IN the build, or a green build proves nothing about it. This is the
# check that would have caught Phase 51's missing podspec, when `attestation` was simply absent
# from Podfile.lock and the Swift compiled into nothing.
if ! grep -q 'AttestationNative' "$IOS_DIR/Podfile.lock"; then
  echo "typecheck-ios-app: FAIL — AttestationNative is not in Podfile.lock."
  echo "  The app would build green while this package compiled into nothing. Check the podspec"
  echo "  and re-run pod install."
  exit 1
fi

LOG=$(mktemp -t iosappbuild.XXXXXX)
DERIVED=$(mktemp -d -t iosappderived.XXXXXX)
trap 'rm -f "$LOG"; rm -rf "$DERIVED"' EXIT

echo "typecheck-ios-app: building $SCHEME for generic/platform=iOS (code signing disabled)..."
#
# SKIP_BUNDLING=1 turns off the "Bundle React Native code and images" phase. This gate is about
# NATIVE compilation; Metro bundling is a different concern with its own gate, and leaving it on
# makes this script fail for reasons that have nothing to do with the Swift (a JS dependency that
# does not resolve, a stale Metro cache, a checkout whose node_modules are symlinked). Measured
# 2026-08-26: with bundling on, this exact build failed at `@babel/runtime/helpers/
# interopRequireDefault` LONG AFTER the Swift had compiled and linked cleanly.
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  SKIP_BUNDLING=1 \
  build >"$LOG" 2>&1
STATUS=$?

if [ $STATUS -ne 0 ]; then
  # Distinguish "your CocoaPods sandbox is stale" from "the code does not compile". The former is
  # an environment state, not a defect, and it is common: SPEC CHECKSUMS in the committed
  # Podfile.lock can differ from a local `pod install` for reasons that have nothing to do with
  # this package's sources (CocoaPods version, checkout path). Failing the gate for that trains
  # people to ignore it; the existing "Pods not installed" skip sets the precedent.
  if grep -q 'sandbox is not in sync with the Podfile.lock' "$LOG"; then
    echo "typecheck-ios-app: CocoaPods sandbox is out of sync — SKIPPED (this is not a failure)"
    echo "  run: (cd apps/VoteTorrentVoter/ios && pod install)   then re-run this gate"
    exit 0
  fi
  echo "typecheck-ios-app: FAIL"
  # xcodebuild logs are enormous; surface the errors rather than the whole transcript.
  grep -E 'error:|BUILD FAILED' "$LOG" | head -40
  echo "  (full log was at $LOG)"
  exit $STATUS
fi

# A green build is necessary but not sufficient: confirm our sources were actually COMPILED, not
# skipped by an excluded podspec glob. This is the check that catches "the app builds fine and this
# package compiled into nothing".
#
# Check the built ARTIFACT, not the log. An earlier version grepped the transcript for
# "AttestationNativeModule.swift" and would have reported a FALSE FAILURE: Xcode 26 does not echo
# Swift compile commands the way it echoes clang ones, so the string is absent from a build that
# compiled the file perfectly well. The object file either is in the archive or it is not.
LIB=$(/usr/bin/find "$DERIVED" -name 'libAttestationNative.a' -print -quit 2>/dev/null)
if [ -z "$LIB" ]; then
  echo "typecheck-ios-app: FAIL — build succeeded but no libAttestationNative.a was produced."
  exit 1
fi

MEMBERS=$(/usr/bin/ar -t "$LIB" 2>/dev/null)
for expected in AttestationNativeModule.o SignatureEncoding.o; do
  if ! printf '%s\n' "$MEMBERS" | grep -qx "$expected"; then
    echo "typecheck-ios-app: FAIL — $expected is missing from libAttestationNative.a."
    echo "  The build was green but this source never compiled into the product. Check the"
    echo "  podspec's source_files glob."
    echo "  archive members were:"
    printf '%s\n' "$MEMBERS" | sed 's/^/    /'
    exit 1
  fi
done

echo "typecheck-ios-app: PASS — compiled against React Native's real headers"
exit 0
