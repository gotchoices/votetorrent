# Getting Started

This guide takes you from a fresh clone to a building, tested monorepo and a
running Authority app. It is the happy-path walkthrough; for deeper topics it
points you to the more detailed guides rather than repeating them.

VoteTorrent is a Yarn 4 monorepo with four workspaces — two libraries
(`@votetorrent/vote-core`, `@votetorrent/vote-engine`), a dev-tooling drone
(`p2p-probe-host`), and the React Native reference app (`votetorrent-authority`).
You can work on the libraries with nothing more than Node and Yarn; running the
Authority app additionally needs a React Native toolchain.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | `>=20.19` | The repo pins `22.15.0` in `.nvmrc`. Use a version manager so the right version is selected automatically. |
| Yarn | `4.7.0` | Pinned via the `packageManager` field; enable it through Corepack (below). Do not install Yarn globally. |
| Git | any recent | To clone the repository. |

The libraries are plain ESM TypeScript packages, so the table above is all you
need for `yarn build` / `yarn test` / `yarn lint`.

To run the **Authority app** on a device or emulator, you additionally need a
React Native toolchain for your target platform:

- **Android:** JDK 17, the Android SDK, and `ANDROID_HOME` set. The app builds
  with the new architecture and Hermes enabled (`android/gradle.properties`).
- **iOS (macOS only):** Xcode with the iOS SDK, plus Ruby `>= 2.6.10` and
  Bundler for CocoaPods. The app's `Gemfile` pins compatible CocoaPods,
  `activesupport`, `xcodeproj`, and `concurrent-ruby` ranges to avoid known
  build failures.

If you have never set up a React Native development environment, follow the
official React Native "Set Up Your Environment" guide for your platform first,
then return here.

### Selecting Node with nvm

If you use [nvm](https://github.com/nvm-sh/nvm), the pinned version is read from
`.nvmrc`:

```bash
nvm install   # installs 22.15.0 the first time
nvm use       # selects it for this shell
node --version   # should print v22.15.0
```

Any version `>=20.19` satisfies the engine constraint; `22.15.0` is the version
the project is validated against.

### Enabling Yarn 4 via Corepack

Yarn is managed by [Corepack](https://nodejs.org/api/corepack.html), which ships
with Node. Enable it once and Corepack will use the pinned `yarn@4.7.0`
automatically inside the repo:

```bash
corepack enable
```

## Installation

```bash
git clone https://github.com/gotchoices/votetorrent.git
cd votetorrent
yarn install
```

A few things happen during `yarn install` that are worth knowing about:

- The `@serfab/*` and `@optimystic/db-*` dependencies are resolved from in-repo
  vendored copies under `vendor/` via `portal:` targets. This means a **clean
  clone builds with no sibling source checkout** — you do not need the `sereus`
  or `Optimystic` repositories alongside this one.
- A `postinstall` hook runs `scripts/check-peer-requirements.mjs`, which guards
  the set of allowed peer-dependency mismatches. A clean install prints no
  `YN0086` peer warnings; you can confirm with
  `yarn install 2>&1 | grep -c YN0086` (expect `0`).

See [Configuration](configuration.md) for the full picture of the Yarn settings,
resolutions, patches, and vendoring.

## Build, test, and lint

Run these from the repository root. Each fans out to every workspace via
`yarn workspaces foreach`:

```bash
yarn build   # build every workspace (aegir / tsc)
yarn test    # run all workspace test suites
yarn lint    # check peer requirements, then lint every workspace
```

To scope a command to a single workspace, use `yarn workspace <name> <script>`,
for example:

```bash
yarn workspace @votetorrent/vote-engine test
```

A green `yarn build` and `yarn test` confirm your toolchain is set up correctly —
this is the fastest "did my environment work?" check, and it needs no React
Native tooling at all.

## Running the Authority app

With dependencies installed, launch the React Native Authority app from the
repository root. These root scripts delegate to the `votetorrent-authority`
workspace:

```bash
yarn start     # start the Metro bundler (leave running in its own terminal)
yarn android   # build and run on a connected Android device / emulator
yarn ios       # build and run on an iOS simulator (macOS only)
```

A typical first run:

1. In one terminal, start Metro: `yarn start`.
2. In a second terminal, launch the app on your platform: `yarn android` (or
   `yarn ios`). The first build compiles the native project and can take several
   minutes.
3. The app boots, the bundle loads from Metro, and the Authority UI appears on
   the device/emulator.

For a signed, self-contained **release APK** (no Metro, JS bundle embedded), see
the app's [`BUILD-RELEASE.md`](../apps/VoteTorrentAuthority/BUILD-RELEASE.md),
which covers the signing keystore and `./gradlew :app:assembleRelease`.

## Optional: running the P2P probe-host drone

`packages/p2p-probe-host` is dev tooling — a storage-profile node that listens on
an ephemeral WebSocket address so an emulator can dial it. It is a normal
workspace, so its dependencies are already installed. To start it:

```bash
cd packages/p2p-probe-host
node drone.mjs
```

The drone prints its control `peerId` and WebSocket multiaddr, then stays alive
until you stop it with Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM). It reads an
optional `STRAND_ID` environment variable to select the strand it joins; when
unset it falls back to a placeholder. You usually only need the drone when
exercising the P2P dial/replication proofs.

## Next steps

- [Development](development.md) — local workflow, build commands, code style,
  and conventions.
- [Testing](testing.md) — how to run and write tests across the workspaces.
- [Configuration](configuration.md) — the Node/Yarn toolchain, resolutions,
  vendoring, and the React Native app's build and runtime configuration.
- [Codebase Architecture](codebase-architecture.md) — how the workspaces fit
  together.

To understand the protocol itself rather than the codebase, read the
[Technical Architecture](architecture.md) and the
[end-user FAQ](user-faq.md).
