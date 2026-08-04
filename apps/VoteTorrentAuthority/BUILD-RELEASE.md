# Building the Authority app (Android)

Builds run through fastlane, from `android/`. All lanes are thin wrappers around
`./gradlew` — nothing is injected that a plain gradle invocation with the same
environment wouldn't do.

| Lane | Needs the keystore? | What it does |
|------|---|--------------|
| `verify_keystore` | yes | proves the signing env works, in seconds, without building |
| `prepare` | no | `yarn install` + builds the workspace packages |
| `build_debug` | no | debug-signed APK; needs a running Metro server to start |
| `build_apk_dev` | **no** | release-mode APK signed with the DEBUG key — installable, not publishable |
| `build_apk` | yes | signed release APK, app id `org.votetorrent.authority` — publishable |
| `build_aab` | yes | signed release `.aab` for the Play Store |

Or from the app directory: `yarn verify:keystore`, `yarn build:apk`, `yarn build:apk:dev`,
`yarn build:debug`, `yarn build:aab`, `yarn prepare:workspace`.

## Who needs the keystore

Only whoever publishes. Everyone else — contributors, contractors, CI — uses
`build_apk_dev`, which produces a **genuine release-mode build**: same Metro
production bundle, same Hermes compile, same ProGuard settings. The only
difference is the signature.

That matters, because this project's bugs have historically lived in exactly
that release path and are invisible in a debug build (`99ddcf0` release APK
bundle + Hermes boot, `7f430ae` babel plugin for on-device bundling, `599dda6`
missing workspace `dist/`). A debug build skips JS bundling entirely — it loads
from a Metro dev server — so it cannot catch any of them.

The trade-off: a debug-signed APK is a different app identity, so switching
between it and a real signed build requires uninstalling first. It must never be
published, and `build_apk` enforces that by running `apksigner verify` and
refusing to ship anything carrying the debug certificate.

`.github/workflows/build-android.yml` builds both apps this way on every push,
with no secrets of any kind.

## Prerequisites

- Node ≥ 20.19, Yarn 4.7.0 (Berry, `nodeLinker: node-modules`)
- JDK 17, Android SDK, `ANDROID_HOME` set (or `~/Library/Android/sdk` on macOS)
- `bundle install` once in `apps/VoteTorrentAuthority/` (installs fastlane into `vendor/bundle`)
- The workspace built — `bundle exec fastlane android prepare`, or from the repo root:
  ```bash
  yarn install
  yarn workspaces foreach -At --include 'packages/*' run build
  ```
  `packages/*/dist` is gitignored, so a fresh clone has none. Debug builds still
  work without it (Metro serves from source), but the **release** bundle step
  fails with `Unable to resolve module @votetorrent/vote-engine/rn`.

## Signing

Both VoteTorrent apps share **one keystore** holding **one key each**, so only
the key alias and key password are per-app. The `release` signingConfig in
`android/app/build.gradle` reads these directly:

| Env var | Purpose |
|---------|---------|
| `STORE_FILE_VOTETORRENT` | path to the shared keystore |
| `PASSWORD_STORE_VOTETORRENT` | keystore password |
| `PASSWORD_KEY_AUTHORITY` | password for this app's key |
| `KEY_ALIAS_AUTHORITY` | optional; defaults to `org.votetorrent.authority` |

**`STORE_FILE_VOTETORRENT` is the switch.** When it is set, release builds use
the real key. When it is absent, `build.gradle` falls back to the committed debug
key and logs:

```
[signing] STORE_FILE_VOTETORRENT is not set — release builds will be signed with
the DEBUG key and are NOT publishable.
```

So `./gradlew assembleRelease` works for everyone, and only the key holder can
produce a publishable artifact.

The Voter app has an identical set of lanes (`apps/VoteTorrentVoter/android/fastlane`)
and uses the same first two vars plus `PASSWORD_KEY_VOTER` / `KEY_ALIAS_VOTER`, so
one exported set covers both apps. Both Fastfiles are thin wrappers over the shared
[`scripts/fastlane/vt_signing.rb`](../../scripts/fastlane/vt_signing.rb).

Keystores are **never committed** — `android/.gitignore` excludes `*.keystore`
(and suffixed copies) but whitelists `debug.keystore`.

`fastlane` expands `~` and resolves `STORE_FILE_VOTETORRENT` to an absolute path
before handing it to gradle. Gradle's own `file()` does neither, so if you invoke
`./gradlew` directly, **export an absolute path**.

## Build

```bash
export STORE_FILE_VOTETORRENT="$HOME/path/to/votetorrent.keystore"
export PASSWORD_STORE_VOTETORRENT='...'
export PASSWORD_KEY_AUTHORITY='...'

cd apps/VoteTorrentAuthority/android

bundle exec fastlane android verify_keystore   # check the env first — seconds, not minutes
bundle exec fastlane android build_apk
```

Or from the app directory: `yarn verify:keystore`, `yarn build:apk`, `yarn build:debug`, `yarn build:aab`.

Output: `android/app/build/outputs/apk/release/app-release.apk` — a signed,
self-contained APK with the production JS bundle embedded. ProGuard/minify is OFF
(`enableProguardInReleaseBuilds=false`); Hermes is ON.

`build_apk` runs `apksigner verify --print-certs` on the result and **fails** if
the APK carries the debug certificate, so a blank password env var can never
silently produce a debug-signed "release".

Install: `adb install -r android/app/build/outputs/apk/release/app-release.apk`

## One keystore, two keys

Both apps' keys live in a single keystore. This is normal and fully supported —
`apksigner --ks-key-alias` exists precisely because multi-key keystores are the
expected case. Whether the two keys may have *different passwords* depends on the
keystore format:

| Format | Multiple keys | Per-key password ≠ store password |
|---|---|---|
| JKS | yes | yes |
| PKCS12 created by `keytool` | yes | **no** — silently forced equal |
| PKCS12 created via the `KeyStore` API | yes | yes |

The restriction is **keytool policy, not the PKCS#12 format**. RFC 7292 allows
per-key encryption passwords, and `sun.security.pkcs12.PKCS12KeyStore` implements
them. But `keytool` contains a hard check (`Main.java`) that overwrites `-keypass`
with `-storepass` whenever the store type is PKCS12, printing:

```
Warning: Different store and key passwords not supported for PKCS12 KeyStores.
         Ignoring user-specified -keypass value.
```

This is [JDK-8008292](https://bugs.openjdk.org/browse/JDK-8008292), closed
**Won't Fix** — the stated rationale being that other tools (browsers, etc.)
assume a single password.

**The consequence is a keytool-only blind spot.** If a PKCS12 keystore *does*
have per-key passwords (built with the KeyStore API, OpenSSL, BouncyCastle, or an
older/other toolchain), `keytool` cannot open the key at all:

```
keytool error: java.security.UnrecoverableKeyException: Get Key failed:
Given final block not properly padded.
```

...yet **gradle and apksigner sign with it perfectly**, because they call
`getEntry(alias, PasswordProtection(keyPassword))` and never go through keytool's
policy check. A keytool failure here does *not* mean your keystore is broken.

That is why `verify_keystore` uses [`fastlane/VerifyKeystore.java`](android/fastlane/VerifyKeystore.java)
— the same `KeyStore` API path AGP uses — rather than shelling out to `keytool`.
A pass is a genuine prediction that the build will sign.

## Troubleshooting

`verify_keystore` distinguishes the failure modes precisely:

- **"Could not open the keystore"** — `PASSWORD_STORE_VOTETORRENT` is wrong, or
  the path isn't a keystore.
- **"Alias ... is not in the keystore"** — it prints the aliases that *are*
  present; set `KEY_ALIAS_AUTHORITY` to one of them.
- **"...is encrypted with the STORE password"** — a keytool-made PKCS12, where
  the key password you intended was discarded at creation. Set
  `PASSWORD_KEY_AUTHORITY` equal to `PASSWORD_STORE_VOTETORRENT`.
- **"PASSWORD_KEY_AUTHORITY is wrong"** — the store opened and the key exists,
  so only the key password is at fault.

To get genuinely distinct key passwords, use JKS:

```bash
keytool -importkeystore -srckeystore votetorrent.p12 -srcstoretype PKCS12 \
  -destkeystore votetorrent.jks -deststoretype JKS
```

JKS is not deprecated and works in current JDKs, but as of JDK 26 the JDK warns
that JKS/JCEKS "will be removed in a future release" (no target version
announced) — so treat it as working-but-finite, not a long-term bet. Gradle needs
no configuration change either way: `keystore.type.compat` lets the default
PKCS12 `KeyStore` read a JKS file transparently.
