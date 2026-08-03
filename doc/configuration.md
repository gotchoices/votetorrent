# Configuration

This document describes the configuration of the VoteTorrent monorepo as it
exists in the repository: the Node/Yarn toolchain, workspace resolutions and
in-repo vendoring, TypeScript settings, lint/format tooling, the React Native
authority app's build and runtime configuration, and the few environment
variables the code actually reads.

Every value below is taken from a tracked file; the source path is cited.

## Node / Yarn toolchain

| Setting | Value | Source |
|---------|-------|--------|
| Package manager | `yarn@4.7.0` | `package.json` `packageManager` |
| Node engine (root) | `>=20.19` | `package.json` `engines.node` |
| Node engine (app) | `>=20.19` | `apps/VoteTorrentAuthority/package.json` `engines.node` |
| Pinned Node version | `22.15.0` | `.nvmrc` |
| Module type | ESM (`"type": "module"`) | `package.json` |

Use `nvm use` (or any tool that reads `.nvmrc`) to select Node `22.15.0`, which
satisfies the `>=20.19` engine constraint. The root and every package declare
`"type": "module"`, so all `.js`/`.mjs` files are treated as ES modules.

### Yarn settings (`.yarnrc.yml`)

| Setting | Value | Purpose |
|---------|-------|---------|
| `nodeLinker` | `node-modules` | Classic `node_modules` layout (required by React Native / Metro). |
| `enableGlobalCache` | `true` | Shared Yarn package cache. |
| `nmHoistingLimits` | `workspaces` | Limits hoisting so each workspace keeps its own deps — needed for React Native. |
| `logFilters` | discard code `YN0086` | Suppresses the cosmetic peer-dependency warning emitted by `@optimystic/quereus-plugin-*` (they peer-want `@quereus/quereus@^0.16.2`, the repo pins `3.3.0`). |
| `packageExtensions` | adds `@babel/core`, `@babel/runtime` peers to `react-native`; adds `@react-native/gradle-plugin` peer to `@react-native-community/cli-platform-android` | Quiets missing-peer warnings. |

The `YN0086` discard is project-wide because the warning lines are generic
aggregate summaries that name no package. To keep that broad discard safe,
`scripts/check-peer-requirements.mjs` asserts the set of allowed peer
mismatches and exits non-zero on any unexpected one. This guard is wired into
the root `package.json`:

- `postinstall` runs it on every `yarn install`.
- `lint` runs it before the per-workspace lints.
- `lint:peers` runs it on demand.

To confirm a warning-free install: `yarn install 2>&1 | grep -c YN0086` should
report `0`.

## Workspaces

The root `package.json` declares a Yarn 4 workspace tree:

```json
"workspaces": {
  "packages": ["packages/*", "apps/*"],
  "nohoist": [
    "**/react-native", "**/react-native/**",
    "**/@react-native/**", "**/@react-native-*", "**/react-native-*",
    "**/@react-navigation/**", "**/react-i18next", "**/i18next", "**/@babel/**"
  ]
}
```

Members:

| Workspace | Package name | Notes |
|-----------|--------------|-------|
| `packages/vote-core` | `@votetorrent/vote-core` | Core voting interfaces/types. |
| `packages/vote-engine` | `@votetorrent/vote-engine` | Concrete voting implementation; has a `./rn` export. |
| `packages/p2p-probe-host` | `p2p-probe-host` | Private dev tooling (dial-proof drone). |
| `apps/VoteTorrentAuthority` | `votetorrent-authority` | Private React Native app. |

The `nohoist` globs keep React Native, React Navigation, i18next, and Babel
packages inside each workspace rather than hoisted to the root, which the RN
toolchain requires.

### Root scripts

| Script | Command |
|--------|---------|
| `clean` | `yarn workspaces foreach -A run clean` |
| `build` | `yarn workspaces foreach -A run build` |
| `lint` | `node scripts/check-peer-requirements.mjs && yarn workspaces foreach -A run lint` |
| `test` | `yarn workspaces foreach -A run test` |
| `start` | `yarn workspace votetorrent-authority start` |
| `android` | `yarn workspace votetorrent-authority android` |
| `ios` | `yarn workspace votetorrent-authority ios` |
| `all` | `yarn workspace votetorrent-authority ios && yarn workspace votetorrent-authority android` |
| `lint:peers` | `node scripts/check-peer-requirements.mjs` |
| `postinstall` | `node scripts/check-peer-requirements.mjs` |

## Dependency resolutions, patches, and vendoring

The root `package.json` `resolutions` block pins shared transitive versions and
redirects several `@serfab/*` and `@optimystic/*` packages to in-repo vendored
copies via `portal:` targets.

### Version pins

| Package(s) | Resolved to |
|------------|-------------|
| `uint8arrays@^5.0.0` / `^5.0.1` / `^5.0.2` / `^5.1.0` | `3.1.1` |
| `uuid` | `9.0.1` |
| `react-native-screens` | `4.10.0` |
| `@multiformats/multiaddr` | `13.0.1` |
| `p2p-fret` | `npm:^0.4.0` |
| `@noble/curves` | `2.2.0` |
| `@noble/hashes` | `2.2.0` |
| `@libp2p/crypto` | `5.1.20` |

### Portal-vendored packages

These resolve to built `dist/` copies kept under `vendor/`:

| Package | Portal target |
|---------|---------------|
| `@serfab/cadre-core` | `portal:./vendor/@serfab/cadre-core` |
| `@serfab/quereus-plugin-sereus` | `portal:./vendor/@serfab/quereus-plugin-sereus` |
| `@serfab/strand-proto` | `portal:./vendor/@serfab/strand-proto` |
| `@optimystic/db-core` | `portal:./vendor/@optimystic/db-core` |
| `@optimystic/db-p2p` | `portal:./vendor/@optimystic/db-p2p` |
| `@optimystic/db-p2p-storage-rn` | `portal:./vendor/@optimystic/db-p2p-storage-rn` |

Vendoring lets the app — and a release APK — build from a clean clone with no
sibling source checkout. The app declares the same packages with relative
`portal:../../vendor/...` paths in `apps/VoteTorrentAuthority/package.json`. See
`vendor/VENDOR.md` for the source commits and the rebuild/re-sync procedure.

### Patches

Only two patches are wired into root `package.json` `resolutions` and applied by
`yarn install`:

| Package | Patch |
|---------|-------|
| `@quereus/quereus@^3.3.0` and `@^3.2.1` | `.yarn/patches/@quereus-quereus-npm-3.3.0-5d38946b35.patch` (both ranges resolve to patched `3.3.0`) |
| `@optimystic/quereus-plugin-optimystic@0.13.5` | `.yarn/patches/@optimystic-quereus-plugin-optimystic-npm-0.13.5-6fbe2eccab.patch` |

A third file, `.yarn/patches/@serfab-cadre-core-npm-0.7.1-518fb48136.patch`,
exists on disk but is an inert orphan: it is not referenced in `resolutions`,
any `patch:` entry, `.yarnrc.yml`, or `yarn.lock`, so `yarn install` never
applies it. `@serfab/cadre-core` is instead vendored via
`portal:./vendor/@serfab/cadre-core`, and the `connectionGater` change that
patch represented is baked into the vendored `dist/` by source-edit (see
`apps/VoteTorrentAuthority/PORTAL-SETUP.md`).

`@quereus/quereus`, `@optimystic/quereus-plugin-crypto`, and
`@optimystic/quereus-plugin-optimystic` intentionally stay on published ranges
plus these patches rather than being vendored (`vendor/VENDOR.md`, "Boundary").
The patch rationale for `@optimystic/quereus-plugin-optimystic` (composite
primary keys) is documented in `patches/optimystic-quereus-plugin-composite-pk.md`.

## TypeScript configuration

There is no root `tsconfig.json`; each package configures TypeScript
independently.

### `packages/vote-core`

- `tsconfig.json` extends `aegir/src/config/tsconfig.aegir.json` and sets
  `outDir: dist`, `strictFunctionTypes: true`, `noUncheckedIndexedAccess: true`;
  includes `src`, `test`; excludes `oldsrc`.
- `tsconfig.build.json` extends `./tsconfig`, includes `src/**/*.ts`, and
  excludes `node_modules`, tests.

### `packages/vote-engine`

- `tsconfig.json`: `module: ESNext`, `moduleResolution: Bundler`,
  `target: ES2022`, `lib: ["ES2022"]`, `types: ["node", "mocha"]`,
  `strictNullChecks`, `strictFunctionTypes`, `noUncheckedIndexedAccess`,
  `esModuleInterop`, `skipLibCheck`, `outDir: dist`. Includes `src`, `test`, and
  `../db-p2p/src/node.ts`.
- `tsconfig.build.json` extends `./tsconfig` with `declaration: true` and
  `sourceMap: true`; used by `build` (`tsc -p tsconfig.build.json`).
- `tsconfig.test.json` extends `./tsconfig.json` with `moduleResolution: node`,
  `strict: true`, `allowImportingTsExtensions: true`, and `ts-node` ESM
  settings; used by the Mocha test run.

The package also configures `ts-node` (`esm: true`,
`experimentalSpecifierResolution: node`) in `package.json`, and
`register-ts-node.mjs` registers the `ts-node/esm` loader for test runs.

### React Native app (`apps/VoteTorrentAuthority`)

`tsconfig.json` extends `@react-native/typescript-config/tsconfig.json` and adds
`types: ["jest", "react-native"]`.

## Lint and format

| Tool | Scope | Config |
|------|-------|--------|
| EditorConfig | repo-wide | `.editorconfig`: UTF-8, tab indent (size 2), final newline, trim trailing whitespace; `*.ts` uses single quotes; `*.md` uses space indent and no max line length. |
| aegir lint | `vote-core`, `vote-engine` | `lint` script runs `aegir lint`; both packages also depend on `eslint` and `eslint-plugin-n`. |
| ESLint (RN) | app | `.eslintrc.js` (`root: true`, extends `@react-native`); `lint` script runs `eslint .`. |
| Prettier (RN) | app | `.prettierrc` sets `printWidth: 100`; `prettier` pinned to `2.8.8`. |

The only recommended VS Code extension is `EditorConfig.EditorConfig`
(`.vscode/extensions.json`). `.vscode/settings.json` additionally configures
PlantUML export to `doc/figures` (PNG) and a project word list for the spell
checker. `.vscode/launch.json` defines Mocha debug launch configs for
`vote-engine` (using `register-ts-node.mjs` and `tsconfig.test.json`).

## React Native app build and runtime config

### Metro (`metro.config.js`)

Metro is built on `@react-native/metro-config` (`getDefaultConfig` +
`mergeConfig`). The load-bearing customizations:

- `watchFolders` includes the workspace root and its parent.
- `resolver.nodeModulesPaths` lists the app and workspace `node_modules`.
- `resolver.unstable_enableSymlinks: true` and
  `resolver.unstable_enablePackageExports: true`.
- `resolver.extraNodeModules` aliases the vendored `@serfab/*` and
  `@optimystic/db-*` packages to `vendor/...`, and shims Node builtins:
  `os`/`node:os` and `crypto`/`node:crypto` to local polyfills, `stream`/
  `node:stream` to `readable-stream`, `buffer`/`node:buffer` to `buffer`, and
  `net`/`tls` (and their `node:` forms) to an empty stub
  (`polyfills/empty.js`).
- `transformer.minifierConfig` sets `keep_classnames` and `keep_fnames` (in both
  the top level and `mangle`) so release (Hermes, minified) builds preserve
  function and class names that Quereus and libp2p resolve by name.
- A wrapped `resolver.resolveRequest` redirects `@multiformats/multiaddr/convert`
  to a v12.5.1 copy (`@multiformats/multiaddr-v12`) and rewrites
  `@libp2p/crypto` and `@chainsafe/libp2p-noise` requests to their browser-field
  variants. The browser-field maps are mandatory; config load throws if either
  cannot be loaded.

### Babel (`babel.config.js`)

Single preset: `module:@react-native/babel-preset`.

### App manifest (`app.json`)

- `name`: `VoteTorrentAuthority`
- `displayName`: `VoteTorrent Authority`
- `expo.plugins`: `["react-native-screens"]`

### Jest (`jest.config.js`)

- `preset: react-native`
- `moduleNameMapper` redirects `react-native-localize` and `@optimystic/db-p2p`
  to local mocks under `__mocks__/`.

### Polyfills (`index.js`)

`index.js` imports `./polyfills.bootstrap` before any libp2p / Optimystic /
Quereus import, then registers the app component. It also conditionally invokes
several dev-only proof runners gated on `__DEV__` and the flags in
`src/engines/proof-flags.generated.ts`.

### Android (`android/gradle.properties`)

- `newArchEnabled=true`
- `hermesEnabled=true`

### iOS (Ruby / CocoaPods)

`Gemfile` requires Ruby `>= 2.6.10` and pins CocoaPods (`>= 1.13`, excluding
`1.15.0` and `1.15.1`), `activesupport`, `xcodeproj`, and `concurrent-ruby`
ranges to avoid known build failures. `.bundle/config` sets
`BUNDLE_PATH: vendor/bundle` and `BUNDLE_FORCE_RUBY_PLATFORM: 1`.

### Release build (`bin/build.sh`)

The app `build` script runs `bin/build.sh`. For Android it runs
`./gradlew assembleRelease` (output APK at
`android/app/build/outputs/apk/release/app-release.apk`). The iOS path is not
yet implemented.

## Runtime feature flags

`apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts` is a
git-tracked file holding dev-only proof flags, all defaulting to `false`:

- `PROOF_ENABLED`
- `DIAL_PROBE_ENABLED`
- `REPLICATION_PROOF_ENABLED`
- `USE_LOCAL_DB_FACTORY`
- `SIGNING_PROOF_ENABLED`

The run scripts (e.g. `scripts/run-vtest02.sh`, `scripts/run-dial-probe.sh`)
overwrite this file before bundling and restore the all-`false` content in an
exit trap. Because it is tracked, never commit an enabled-flag override; if a
run script is interrupted, restore it with
`git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts`.

## Environment variables

Very little of the codebase reads environment variables directly. Only the
following are read in tracked source:

| Variable | Default | Read at |
|----------|---------|---------|
| `STRAND_ID` | `'UPDATE_WITH_TEST_NETWORK_HASH'` | `packages/p2p-probe-host/drone.mjs:92` |
| `VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY` | unset (skips deploy) | `apps/VoteTorrentAuthority/bin/build.sh` |
| `NVM_DIR` | `$HOME/.nvm` | `scripts/sync-vendor.sh:34`, `scripts/verify-vendoring.sh:57` |

`STRAND_ID` selects the strand the probe-host drone joins; when unset it falls
back to a placeholder. `VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY`, when set,
makes `bin/build.sh` `scp` the release APK to that destination; when unset the
deploy step is skipped. `NVM_DIR` lets the vendor scripts locate an existing nvm
installation.

The root `.gitignore` ignores `.env` and `.env.test`, but no `.env.example` or
`.env`-consuming loader exists in the repository, and the application code does
not read a `.env` file.
