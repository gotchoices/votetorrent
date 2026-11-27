# Building the Voter app (iOS)

Builds run through fastlane, from `ios/`. Both lanes are thin wrappers around
`build_ios_app` plus an upload action — nothing is injected that a plain `xcodebuild`
invocation with the same environment wouldn't do.

| Lane | Needs signing? | What it does |
|------|---|--------------|
| `beta` | yes | archives, exports for the App Store, uploads to TestFlight |
| `release` | yes | same archive, uploads to the App Store with review submission |

Or from the app directory: `yarn release:ios:beta`, `yarn release:ios:release`, quoted
exactly as they appear in this app's `package.json` (`cd ios && bundle exec fastlane ios
beta` / `... release`).

Unlike Android, there is no `build_apk_dev` equivalent here — no "installable but not
publishable" iOS artifact a contributor can produce without signing. That is exactly why
CI's archive (`build-ios.yml`) is unsigned and uninstallable rather than debug-signed:
there is no middle ground on iOS the way `build_apk_dev`'s debug-key signature gives
Android.

## Who can publish

Only an admin whose Mac has the paid Apple Developer account, team `6849Q7KVP5`, added to
Xcode with automatic signing enabled for this project. Both lanes no longer call
`get_provisioning_profile` (D-11), so nothing will create or download a profile for you —
opening the project once in Xcode with the paid account added is a hard prerequisite, and
a lane run on a Mac without it fails at the archive step.

Everyone else — contributors, contractors, CI — relies on
[`../../.github/workflows/build-ios.yml`](../../.github/workflows/build-ios.yml), which
compiles the same real arm64 device slices with signing disabled and holds no secrets,
producing something deliberately **not** installable.

## Prerequisites

- Node ≥ 20.19, Yarn 4.7.0 (Berry, `nodeLinker: node-modules`) — same as Android.
- Xcode with the paid Apple ID added under Accounts, and automatic signing enabled for
  the `VoteTorrentVoter` target.
- CocoaPods, with `pod install` run in `ios/`.
- `bundle install` once at the **app root** (`apps/VoteTorrentVoter/`), not in `ios/` —
  the Gemfile lives at the app root, so running fastlane from `ios/` through bundler
  resolves the same bundle the Android lanes already use. No new Ruby setup is needed.
- The workspace built from the repo root:
  ```bash
  yarn install
  yarn workspaces foreach -At --include 'packages/*' run build
  ```
  `packages/*/dist` is gitignored, so a fresh clone has none, and the release bundle step
  otherwise fails to resolve `@votetorrent/vote-engine/rn`. This applies to iOS
  identically to Android.

## App Store Connect credentials

| Env var | Purpose |
|---------|---------|
| `APPLE_ID` | the Apple ID email, consumed by the `Appfile` |
| `TEAM_ID` | the paid team `6849Q7KVP5`, consumed by the `Appfile` |
| `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` | **ASSUMED** — an app-specific password generated at appleid.apple.com |

`FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` is marked **ASSUMED**: it has no
precedent anywhere in this repository and was not verified against current fastlane
documentation. Confirm the exact variable name with `fastlane action
upload_to_testflight` before the first upload.

An Apple ID plus app-specific password was chosen over an App Store Connect API key
(D-07) because it needs no portal key generation, at the cost of being tied to one
person's Apple ID and of a two-factor session that can **expire** mid-upload — a lane can
fail after the archive is already built, and re-running it re-authenticates.

Read the password from a password manager and export it into the shell — never paste it
inline into a command that lands in shell history, and never use the Apple ID account
password. No credential value is ever committed; the `Appfile` reads everything from the
environment.

## Release gates

Both lanes open with `VtTeamGate.assert_team!(REPO_ROOT)`
([`../../scripts/fastlane/vt_team_gate.rb`](../../scripts/fastlane/vt_team_gate.rb)). It
positive-matches this project's `DEVELOPMENT_TEAM` against the expected paid team
`6849Q7KVP5`, and separately checks that value against the team prefix of the Authority's
pinned `APPLE_APP_ID`. This closes a real hole: the paid-team swap removed the last
automated check on that constant, and a mistyped team id would fail closed against every
genuine iPhone while every other gate stayed green with no other visible symptom.

The Voter deliberately does **not** use `VtAppAttestReleaseGate` — the Voter embeds no
`APPLE_APP_ID` (the Authority is the verifier that pins the Voter's identity), so that
gate would pass while proving nothing about the Voter's own team. A test pins this
exclusion by name.

These gates run in CI too, as `build-ios.yml`'s `ruby-gates` job — on pull requests to
`master` and on manual dispatch, **not** on a direct push to `master`.

## App Attest

The target declares `CODE_SIGN_ENTITLEMENTS` pointing at
`ios/VoteTorrentVoter/VoteTorrentVoter.entitlements` in both Debug and Release build
configurations. This file does **not** decide the App Attest environment — the
provisioning profile does. A build with no entitlements file at all was measured
producing a `development` attestation; the entitlement here exists for correctness and
explicitness only, never as the thing that selects the environment.

`APP_ATTEST_ENVIRONMENT` is the literal `'production'` in the Authority's
`appattest-keys.generated.ts`, so a locally built Voter running under a development
provisioning profile produces a `development` attestation that the committed Authority
config deliberately rejects. That is the strict direction, not a bug.

No attestation has ever been produced under the paid team `6849Q7KVP5`. The only
end-to-end hardware attestation this project holds was made under the personal team
`94TY7UR2W5`, which is why
[`../../packages/vote-engine/test/ios-hardware-attestation.spec.ts`](../../packages/vote-engine/test/ios-hardware-attestation.spec.ts)
pins that value deliberately, as a recording of real Secure Enclave bytes, and must never
be "aligned" with the committed constant.

## Build

```bash
export APPLE_ID='admin@example.com'
export TEAM_ID='6849Q7KVP5'
export FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD='...'

cd apps/VoteTorrentVoter
yarn release:ios:beta
```

Or the equivalent direct invocation:

```bash
cd apps/VoteTorrentVoter/ios
bundle exec fastlane ios beta
```

In order, the `beta` lane: runs `VtTeamGate.assert_team!`, then `increment_build_number`,
then `build_ios_app` with `scheme: "VoteTorrentVoter"`, `export_method: "app-store"` and
`configuration: "Release"` on a clean build, then `upload_to_testflight`. The `release`
lane is identical through the build step and finishes with `upload_to_app_store(force:
true, submit_for_review: true, automatic_release: true)`.

**This command has never been run successfully by this project.** It is written from the
lane definition, not from a completed release.

## Versioning

As of 2026-09-01, the Voter's Android `versionCode` / `versionName` is `1` / `"1.0"`,
and iOS's `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` is `1` / `1.0` — currently in
hand-maintained lockstep. `increment_build_number` (in both publish lanes) breaks that
lockstep on the first upload: the iOS build number moves ahead and the Android
`versionCode` does not follow. This drift is accepted, not a defect to be fixed — the iOS
build number only has to be monotonic within App Store Connect.

The operational consequence: **every upload edits
`ios/VoteTorrentVoter.xcodeproj/project.pbxproj`**, a tracked file. Expect `git status`
to show it modified after a lane run, and commit it.

## Troubleshooting

- **Archive fails to sign / "no signing certificate" errors.** The project was never
  opened in Xcode with the paid Apple ID added and automatic signing enabled — D-11's
  prerequisite. There is no `get_provisioning_profile` fallback any more to paper over
  this.
- **`vt_team_gate` fails with a `DEVELOPMENT_TEAM` mismatch.** Open the project in Xcode,
  confirm the paid team `6849Q7KVP5` is selected for the `VoteTorrentVoter` target in
  both Debug and Release, and re-run the lane.
- **Upload fails partway through, after the archive already built.** The two-factor
  session behind `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` expired mid-upload.
  Re-authenticate and re-run the lane.
- **A locally built app produces a `development` App Attest environment and the
  Authority rejects it.** This is intentional, not a bug — see App Attest above. It means
  the build was signed under a development provisioning profile, not that anything is
  misconfigured.
- **`Unable to resolve module @votetorrent/vote-engine/rn` at the bundle step.**
  `packages/*/dist` is missing — run `yarn workspaces foreach -At --include 'packages/*'
  run build` from the repo root first.

For the full list of what remains unproven about this path, see
[`../../doc/releases/RELEASE-IOS.md`](../../doc/releases/RELEASE-IOS.md).
