# Building a standalone release APK

The app consumes all `@serfab/*` + `@optimystic/db-*` packages from the in-repo `vendor/` dir
(see `../../vendor/VENDOR.md`), so a release build needs **no sibling `sereus`/`Optimystic` checkout**.

## Prerequisites

- Node ≥ 20.19 (`nvm use 22.15.0`), Yarn 4.7.0 (Berry, `nodeLinker: node-modules`)
- JDK 17, Android SDK, `ANDROID_HOME` set
- `yarn install` at the repo root (resolves the vendored portals)

## Signing keystore

The `release` signingConfig in `android/app/build.gradle` reads four env vars (keystore path defaults
to `release.keystore` next to `build.gradle`, alias defaults to `org.votetorrent.authority`):

| Env var | Purpose |
|---------|---------|
| `VOTETORRENT_STORE_FILE` | path to the keystore (default `release.keystore`) |
| `VOTETORRENT_STORE_PASSWORD` | keystore password |
| `AUTHORITY_KEY_ALIAS` | key alias (default `org.votetorrent.authority`) |
| `AUTHORITY_KEY_PASSWORD` | key password |

The keystore is **never committed** (`android/.gitignore` excludes `*.keystore`). Generate a local one:

```bash
cd android/app
keytool -genkeypair -v -keystore release.keystore \
  -alias org.votetorrent.authority -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <STORE_PW> -keypass <KEY_PW> \
  -dname "CN=VoteTorrent Authority, OU=Dev, O=VoteTorrent, L=, ST=, C=US"
```

> For a production release, use a real keystore with strong passwords managed outside the repo.

## Build

```bash
export VOTETORRENT_STORE_PASSWORD=<STORE_PW>
export AUTHORITY_KEY_PASSWORD=<KEY_PW>
cd android
./gradlew :app:assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk` — a signed, self-contained APK with the
JS bundle (Metro production build, vendored portals compiled in) embedded. ProGuard/minify is OFF
(`enableProguardInReleaseBuilds=false`); Hermes is ON.

Install: `adb install -r android/app/build/outputs/apk/release/app-release.apk`
