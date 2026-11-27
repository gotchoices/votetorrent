# iOS builds and releases

| | Who | Signing | Publishable |
|---|---|---|---|
| **Verification builds** | CI, on every pull request to `master` — [`build-ios.yml`](../../.github/workflows/build-ios.yml) | disabled | no |
| **Release builds** | the admin, on their own Mac | Xcode automatic signing, paid team `6849Q7KVP5` | yes |

**The half of Android's key-custody principle that carries, and the half that doesn't.**
Android's design is that the signing key never leaves the key holder's machine and CI
cannot produce a publishable artifact even if it wanted to. On iOS, the same half holds:
the private signing key stays in the admin's login keychain, nothing signing-related is
ever uploaded to this repository, `build-ios.yml` references zero `secrets.*`, and it
builds with signing disabled — so CI still cannot produce a publishable artifact. The
half that does **not** carry is the "losing the key is permanent" warning: Apple, not
this repository, is the root of trust for a distribution identity. A distribution
certificate is issued by Apple and can be revoked and reissued from the Developer
portal, so a lost local certificate does not strand the app the way a lost Android
keystore would. Section 4 below states this precisely — do not read it as parity.

## Compared with `RELEASE-ANDROID.md`

| Android section | iOS section | Maps? |
|---|---|---|
| `## 1. Verification builds (automatic, no key)` | `## 1. Verification builds (automatic, no signing)` | Cleanly — same CI-holds-no-secrets framing, different artifact (an unsigned, not-uploaded `.xcarchive` instead of a debug-signed APK). |
| `## 2. Release builds (manual, key required)` | `## 2. Release builds (manual, signing required)` | Structurally, with a different "key" — Xcode automatic signing under a paid Apple ID rather than an exported keystore file. |
| `## 3. Publishing` | `## 3. Publishing` | **Does not map — this is where parity genuinely breaks.** No GitHub-Releases-`.ipa` equivalent exists. |
| `## 4. Changing the signing key or application id` | `## 4. Changing the signing identity or bundle id` | Structurally, with a corrected consequence — Apple can reissue a lost certificate; a lost Android keystore cannot be replaced. |
| — | `## 5. TestFlight testers: internal and external` | iOS-only. |
| — | `## 6. The votetorrent.org download page` | iOS-only. |
| — | `## 7. What has not been proven` | iOS-only. |

A reader arriving here from the Android doc should not assume the two platforms ship the
same way. They don't, in four specific places, and each is called out below.

## 1. Verification builds (automatic, no signing)

[`build-ios.yml`](../../.github/workflows/build-ios.yml) runs two jobs.

`ruby-gates` runs on `ubuntu-24.04` and executes every `scripts/fastlane/*_test.rb` file
in its own Ruby process, plus `VtTeamGate.assert_team!` against the real checkout as a CI
lint — closing a real, previously-existing gap: nothing in this repository ever ran those
Minitest files before this workflow existed.

`archive` runs on `macos-15`, gated behind `needs: ruby-gates`, as a matrix over both apps
(`fail-fast: false`, so one app's failure never hides the other's result). It archives
from the `.xcworkspace` with all three signing-disable settings together —
`CODE_SIGN_IDENTITY=""`, `CODE_SIGNING_REQUIRED=NO`, `CODE_SIGNING_ALLOWED=NO` — and the
resulting archive is **not installable**. That is the point: it is what keeps "CI cannot
publish" true even though the job runs a real `xcodebuild archive` against real arm64
device slices. A step then asserts the archived `.app` contains `main.jsbundle` and fails
the job if it does not — this project's bugs have historically lived in the release
JS-bundle and Hermes compile path, invisible to anything that skips real bundling.

The trigger is `pull_request` targeting `master` plus `workflow_dispatch`, with
`paths-ignore` for `doc/**`, `**/*.md` and `web/**`. **There is no `push:` trigger.** The
narrowing that follows from that, stated plainly: the Ruby gates run on pull requests to
`master` and on manual dispatch, but **not on a direct push to `master`**. This is an
accepted limitation, not an oversight — the named follow-up is moving the `ruby-gates`
job into `dashboard.yml`, which already runs on push and is a cheap Linux job, giving it
push coverage at zero macOS cost.

Unlike Android, the `.xcarchive` produced here is deliberately **not** uploaded as a
workflow artifact, even though the APKs are on the Android side. Publishing an
uninstallable archive invites exactly the "here is the iOS build" misreading this
document exists to prevent. Only the `xcodebuild` log is uploaded, and only when the job
fails, with 14-day retention.

`build-ios.yml` has never been executed by a real GitHub Actions run. See section 7.

## 2. Release builds (manual, signing required)

Only the admin whose Mac carries the paid Apple Developer account can make one. See
[apps/VoteTorrentVoter/BUILD-RELEASE-IOS.md](../../apps/VoteTorrentVoter/BUILD-RELEASE-IOS.md)
and
[apps/VoteTorrentAuthority/BUILD-RELEASE-IOS.md](../../apps/VoteTorrentAuthority/BUILD-RELEASE-IOS.md)
for the full per-app signing setup — this section gives the shape only, the same way
`RELEASE-ANDROID.md` section 2 points at `BUILD-RELEASE.md` rather than duplicating detail
inline.

A prerequisite, not a fallback: the admin must have opened the app's Xcode project once
with the paid Apple ID added to Xcode's accounts and automatic signing enabled for the
project. Both apps' publish lanes no longer call `get_provisioning_profile` — there is
**no fallback that will create or download a profile for you**. A lane run on a Mac
without that one-time Xcode setup fails at the archive step.

```bash
export APPLE_ID='admin@example.com'
export TEAM_ID='6849Q7KVP5'
export FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD='...'

cd apps/VoteTorrentVoter          # or VoteTorrentAuthority
yarn release:ios:beta
```

`FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` is marked **ASSUMED**: it has no precedent
anywhere else in this repository and was not verified against current fastlane
documentation. Confirm the exact variable name with `fastlane action
upload_to_testflight` before the first real upload. Read the value from a password
manager and export it — never paste it inline into a command that lands in shell
history, and never use the Apple ID account password; this must be an app-specific
password generated at appleid.apple.com. No credential value is ever committed, and the
`Appfile`s read everything from the environment.

An Apple ID plus app-specific password was chosen over an App Store Connect API key
because it needs no portal key generation (D-07). The trade-off: the credential is tied
to one person's Apple ID, and the two-factor session behind it can **expire** mid-upload
— a lane can fail after the archive has already been built, with re-running it
re-authenticating from scratch.

## 3. Publishing

This is the section that does not map to Android. Android publishes a `.apk` to GitHub
Releases and links to it from `web/join.html`. iOS has **no equivalent**, and this is not
an oversight: a build distributed outside the App Store must carry an ad-hoc or
development provisioning profile with each target device's UDID baked in **at build
time**, so there is no single downloadable `.ipa` that installs on an arbitrary device the
way an APK does.

What iOS actually does instead: archive, export with `app-store` as the export method,
and upload straight to App Store Connect — `upload_to_testflight` (TestFlight) in the
`beta` lane, or `upload_to_app_store` (with `submit_for_review: true`) in the `release`
lane.

Where Android has three places (your disk, GitHub Releases, votetorrent.org), iOS has
two: the admin's disk and App Store Connect. GitHub Releases holds no iOS artifact, and
votetorrent.org links to none. The upload happens from the admin's laptop with
credentials that never leave it — that is the half of the Android principle that does
carry across, even though the destination shape does not.

## 4. Changing the signing identity or bundle id

The bundle ids `org.votetorrent.voter` and `org.votetorrent.authority` are permanent once
published, mirroring Android's `applicationId` warning. Unlike Android, though, a lost
signing identity is recoverable: Apple issues the distribution certificate and can revoke
and reissue it from the Developer portal, so losing local key material does not strand
the app the way losing an Android keystore would.

There is a real attestation consequence, though. The Authority pins the Voter's identity
for App Attest in
[`apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts`](../../apps/VoteTorrentAuthority/src/engines/appattest-keys.generated.ts)
as `APPLE_APP_ID` (`6849Q7KVP5.org.votetorrent.voter`). Changing either the team or the
Voter's bundle id invalidates that pin, and attestation then fails closed for every
device. Releases use the paid team `6849Q7KVP5`; the personal team `94TY7UR2W5` must
**never** ship. The specific hazard that motivated a dedicated gate: a **mistyped** team
id would reject every genuine iPhone while every other gate stayed green, which is why
[`scripts/fastlane/vt_team_gate.rb`](../../scripts/fastlane/vt_team_gate.rb) positive-matches
the exact expected value `6849Q7KVP5` rather than merely asserting "not the personal
value."

`packages/vote-engine/test/ios-hardware-attestation.spec.ts` pins `94TY7UR2W5` **on
purpose** — it replays bytes a real iPhone 13 Secure Enclave produced under that team, a
recording of hardware rather than configuration, and must never be "aligned" with the
committed constant.

Versions are currently in hand-maintained cross-platform lockstep. As of 2026-09-01:

| App | Android `versionCode` / `versionName` | iOS `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` |
|---|---|---|
| Authority | `3` / `"0.0.3"` | `3` / `0.0.3` |
| Voter | `1` / `"1.0"` | `1` / `1.0` |

`increment_build_number` runs in both apps' publish lanes and **will break that lockstep
on the first upload** — the iOS build number moves ahead while the Android `versionCode`
stays put. This drift is the accepted trade, not an oversight to fix: the iOS build
number only has to be monotonic within App Store Connect. The operational consequence:
every upload mutates the tracked `project.pbxproj` file, and the admin must expect to see
it modified in `git status` afterward and commit it.

## 5. TestFlight testers: internal and external

Internal testers are App Store Connect users on the team; a build reaches them as soon as
processing finishes, with no Apple review. External testers are a much larger audience
reached by a public link or email invitation, and the first build of each version goes
through Beta App Review before external testers can install it.

This project uses **internal testers only, for now**. External testing implies a public
join link, and the download page's iOS section stays hidden until a build actually
exists on TestFlight (section 6), so external testing cannot begin before that reveal
step regardless.

Apple's published caps, as of the time of writing and not something this project has
exercised: roughly 100 internal testers (App Store Connect users) and up to 10,000
external testers. Treat these as policy-at-time-of-writing, not as measurements this
project has made.

## 6. The votetorrent.org download page

`web/join.html` currently states that iOS builds are not yet available for outside
testing, and both download cards read "Android only" — and that remains accurate as of
this phase, because no iOS build has been uploaded anywhere. A prepared but hidden
iOS/TestFlight section is being added to that page separately. The one-line change that
reveals it, once a real TestFlight build exists, will be documented in this section once
that markup lands. This section is deliberately the landing spot only — it carries no
reveal procedure, no markup and no commands.

## 7. What has not been proven

- No signed iOS build has been produced by this project.
- Nothing has been uploaded to TestFlight or App Store Connect.
- **No attestation has ever been produced under the paid team `6849Q7KVP5`.** The only
  end-to-end hardware attestation this project holds was made under the personal team
  `94TY7UR2W5`.
- [`build-ios.yml`](../../.github/workflows/build-ios.yml) has never been executed by a
  real GitHub Actions run — the first run after merge is its genuine proof and should be
  watched, not assumed green.
- The publish lanes themselves have never been executed. `build_ios_app`,
  `upload_to_testflight` and `upload_to_app_store` are syntactically valid and
  semantically untested.

The paid-team attestation proof is tracked as an open item in the project's planning
notes; it is not closed, in progress, or scheduled by this document.

## 8. Revealing the iOS section on the download page

`web/join.html` already carries the iOS/TestFlight download card, wrapped in a single
HTML comment delimited by the sentinels `VT_IOS_JOIN_SECTION_BEGIN` and
`VT_IOS_JOIN_SECTION_END`. `grep` for those two tokens to find it. It is a comment
rather than a CSS-based hide because a comment cannot be revealed by a stale
stylesheet, a DevTools display toggle, or a crawler, and `./publish html` ships HTML
without `styles.css`.

**Do this only after** a build has actually been accepted and is installable on
TestFlight (section 5). At the time this section was written, no signed build existed
and nothing had been uploaded; the page's current claims are true and must stay true
until that changes.

**The edit is two line deletions, not one:** delete the line carrying the `<!--`
opener (`VT_IOS_JOIN_SECTION_BEGIN`) and the line carrying the `-->` closer
(`VT_IOS_JOIN_SECTION_END`). A single-line reveal was rejected because it would
require collapsing the whole section onto one unreviewable physical line.

**Replace the placeholder link.** Substitute the literal `TESTFLIGHT_LINK_PENDING`
with the public TestFlight invite URL copied from App Store Connect itself — never
from an email or a chat message, and never invented. No `testflight.apple.com` URL is
present anywhere in the repo today, deliberately, so a stale or wrong invite code
cannot ship by accident.

**Fix the surrounding claims in the same change, or the page contradicts itself.**
`web/join.html:42` ("iOS builds are not yet available for outside testing.", line
number will drift) must be replaced with an accurate sentence, and the two
`p.build-note` "Android only" notes (currently `:28`, `:35`) must be revisited.
Revealing the card while those three statements still stand is a **worse** outcome
than leaving it hidden.

**Publish with `./publish main`**, not `./publish html` — the new card relies on
`.info-box`/`.download-card`/`.app-download`/`.build-note` rules that live in
`styles.css`, and an HTML-only publish would ship the markup against a possibly stale
stylesheet (`index.html` requests `styles.css?v=3`; bump that query string if the CSS
itself changes).

**Verify afterwards:** `VT_IOS_JOIN_SECTION_BEGIN` and `VT_IOS_JOIN_SECTION_END` no
longer appear in `web/join.html`, and `TESTFLIGHT_LINK_PENDING` no longer appears
anywhere in the file.
