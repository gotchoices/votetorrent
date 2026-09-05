# Development

Day-to-day guide for working **inside** the VoteTorrent monorepo: which commands
to run where, how the build pipeline is wired, what the guard scripts enforce,
and how to run the on-device proofs.

Prerequisites and first install are in the [README](../README.md#prerequisites).
For how the packages compose at runtime, see
[Codebase Architecture](codebase-architecture.md).

This document covers what you cannot get by reading a config file. Where a
tracked file already explains itself — `metro.config.js` in particular carries
extensive rationale in comments — this points at the file rather than
transcribing it.

## Working in the monorepo

Workspaces are declared in the root `package.json` (`packages/*` and `apps/*`).
Target one by **package name**, not directory:

```bash
yarn workspace @votetorrent/vote-core build
yarn workspace @votetorrent/vote-engine test
yarn workspace votetorrent-voter lint
```

Root convenience scripts for the apps:

| Authority | Voter |
| --- | --- |
| `yarn start` | `yarn start:voter` |
| `yarn android` | `yarn android:voter` |
| `yarn ios` | `yarn ios:voter` |
| `yarn all` | `yarn all:voter` |

Release scripts run across **both** apps: `yarn verify:keystore`,
`yarn build:apk`, `yarn publish:apk`, and `yarn release:apk` (all three in
order). See [Android builds and releases](releases/RELEASE-ANDROID.md).

Note that root `yarn build` runs `foreach -A`, which is **unordered**. During a
cross-package edit loop, build the specific workspaces in dependency order
instead — see [Editing across packages](#editing-across-packages).

## Build pipeline

Each workspace owns its own `build`/`clean`/`lint`/`test`; the root only fans
them out. The two libraries build differently, on purpose:

**`@votetorrent/vote-core`** uses **aegir** for build, clean, lint, and test.
aegir compiles `src/` to `dist/` per `tsconfig.build.json`, matching the
package's `exports` map (`dist/src/index.js`). It runs without a checked-in
`.aegir.*` config — defaults plus the package `tsconfig`.

**`@votetorrent/vote-engine`** builds with **`tsc` directly**, not aegir, so it
can emit the dual `.` / `./rn` entry points its `exports` map declares
(`dist/index.js` and `dist/rn-entry.js`). It tests with **Mocha** under
`ts-node/esm` (`register-ts-node.mjs` + `tsconfig.test.json`).

**The apps** bundle through **Metro** and test with **Jest**.

## Guards

Three grep/assert guards enforce invariants a type checker cannot. All are wired
into CI-facing scripts, so a violation fails the build rather than merely being
discouraged.

### Peer requirements — `yarn lint:peers`

`scripts/check-peer-requirements.mjs`. Runs as the root `postinstall` and as the
first step of root `lint`.

Why it exists: under Yarn 4 with `nodeLinker: node-modules`, the unmet-peer
summary (`YN0086`) is a generic project-wide line naming no package, so it
cannot be filtered narrowly. `.yarnrc.yml` therefore discards `YN0086`
globally — which would also hide a *real* new mismatch. This guard restores that
signal for the surface the discard could mask: it runs
`yarn explain peer-requirements`, drills into each folded detail tree (the
summary folds multiple consumers into one line, hiding some), and **fails
closed** on any `@optimystic/quereus-plugin-*` mismatch outside its
`KNOWN_ALLOWED` set.

The allowed set lives in the script. When you intentionally introduce a mismatch
(bumping a plugin, say), update it there. When upstream publishes a clean
version, remove the entry **and** drop the `logFilters: YN0086` block from
`.yarnrc.yml` — the script prints an `INFO: disappeared` hint when a known
mismatch stops showing up.

### SQL bind keys — `yarn workspace @votetorrent/vote-engine guard:builders`

`packages/vote-engine/scripts/ci-grep-guard.sh` greps `src/**/builders/*.ts` and
rejects colon-prefixed SQL bind keys (a quoted `':userId'`, for example).
Quereus' colon-prefix parameter-binding quirk must stay contained at the engine
layer: builders construct **domain objects**, never SQL bind objects. Run it
after touching anything under a `builders/` directory.

### Stub handlers — `yarn lint:stubs`

`scripts/lint-stubs.sh` fails if any app screen still has a placeholder
`console.log` inside a press handler — any prop whose name ends in
`Press`/`Pressed`. Intentional diagnostics use `console.info`/`warn`/`error`,
which are allowed. This is what keeps unwired buttons from silently shipping.

## Lint and format

* `vote-core` and `vote-engine` lint with **aegir** (`aegir lint`, ESLint plus
  `eslint-plugin-n`). Both also expose `dep-check` for unused/undeclared deps.
* Both apps lint with the React Native ESLint config (`eslint .`) and format
  with **Prettier**.

Editor style comes from `.editorconfig`: **tabs**, `indent_size = 2`, final
newline, trimmed trailing whitespace, single quotes in `.ts`. Markdown is the
exception — spaces, no max line length. The only recommended VS Code extension
is `EditorConfig.EditorConfig`.

## Editing across packages

Dependency direction is `vote-core` -> `vote-engine` -> apps. The apps consume
the libraries through `workspace:*`, so they pick up local changes once the
library's `dist/` is rebuilt. A typical loop:

1. Edit `packages/vote-core/src/...`.
2. Rebuild the dependency: `yarn workspace @votetorrent/vote-core build`.
3. Rebuild the dependent: `yarn workspace @votetorrent/vote-engine build`.
4. If a `builders/` file changed, run `guard:builders`.
5. Restart Metro with `yarn start --reset-cache` so the app re-bundles the new
   `dist/`.

## React Native / Hermes constraints

The P2P and SQL stack was written for Node and runs here on Hermes. Several
non-obvious workarounds hold that together. Each is commented in place — read
the file before changing any of them, and do not remove one because it looks
inert:

| Where | Constraint |
| --- | --- |
| `apps/*/metro.config.js` — `minifierConfig` | `keep_fnames` + `keep_classnames`. Quereus resolves SQL UDFs and CHECK constraints *by function name*, as does libp2p. Without this the app boots fine and network creation silently fails, **release builds only** (debug does not minify). |
| `apps/*/metro.config.js` — `resolveRequest` | Forces every `tslib` request to the CJS UMD build, redirects `@multiformats/multiaddr/convert` to a v12 alias (v13 dropped the subpath gossipsub still imports), and rewrites `@libp2p/crypto` / `@chainsafe/libp2p-noise` to their browser-field variants. The browser maps are mandatory — config load throws if either cannot be resolved. |
| `apps/*/metro.config.js` — `extraNodeModules` | Shims the Node builtins the stack pulls transitively: `os`/`crypto` to local polyfills, `stream` to `readable-stream`, `buffer` to `buffer`, and `net`/`tls`/`http2` to an empty stub. Metro must statically resolve every module reachable via `import()` — including code paths that never execute on-device. |
| `apps/*/index.js` | Imports `./polyfills.bootstrap` **before** any libp2p / Optimystic / Quereus import. Order is load-bearing. |
| `vote-engine` `src/database/schema-sql.ts` | The schema DDL is bundled as a **string constant**, generated from `vote-core/schema/votetorrent.qsql`. It is not a file read because Hermes cannot parse `import.meta` and has no Node `fs`. Regenerate it when the `.qsql` changes. |
| root `package.json` `workspaces.nohoist` | Keeps React Native, React Navigation, i18next, and Babel inside each workspace rather than hoisted, which the Metro resolver requires. |

## Known development-only relaxations

These are deliberate, and must be tightened before any production deployment:

* **Permissive libp2p connection gater.** Both apps set
  `connectionGater: { denyDialMultiaddr: async () => false }` in
  `src/providers/CadreNodeProvider.tsx`, so the node will dial any multiaddr.
  This is what lets an emulator reach the host alias `10.0.2.2` and local
  drones. The proof runners set the same thing.
* **Mock engines.** `vote-engine` ships `mock-*.ts` in-memory engines used by
  tests and by UI work ahead of the real path. Screens must not reach a mock
  engine on a real build.

## On-device proofs

`scripts/run-*.sh` and `scripts/voter-boot-smoke.sh` are runnable proofs that
exercise an app on a connected Android device/emulator over `adb` and parse
`logcat` for a verdict line. They are dev/CI tooling, not part of the app build.
Each is self-documented in its header, anchors its working directory to the repo
root, and restores temporary state on exit.

| Script | What it proves |
| --- | --- |
| `run-dial-probe.sh` | A device→host WebSocket dial completes with no "connection gater denied". Needs the probe-host drone running first. |
| `run-replication-proof.sh` | Symmetric P2P replication across two emulators (`emulator-5554` + `emulator-5556`): both emit `REPLICATION VERDICT: PASS`, peerId is stable across relaunch, peer count ≥ 1. Launches the drone itself. |
| `run-signing-proof.sh` | On-device signing round-trip on first boot **and** after force-stop/relaunch. Invoke as `SERIAL=emulator-5554 ./scripts/run-signing-proof.sh`. |
| `run-vtest02.sh` | Full-chain restart persistence — force-stops, relaunches, polls for `FULL-CHAIN VERDICT: PASS`. Requires the app to have completed its write phase once. |
| `voter-boot-smoke.sh` | The Voter app's real-engine register path **bundles and boots on Hermes** — the defect class Jest is structurally blind to, because it mocks `@peculiar`/`@noble`/`multiformats`. |

Common prerequisites: `adb` on `PATH`, the app installed on a connected
device/AVD, and (for replication and signing) `nvm` with Node 22. The shared
logcat wait/poll helper is `scripts/lib/logcat-wait.sh`.

Several proofs flip `apps/*/src/engines/proof-flags.generated.ts` before
bundling and restore it in an exit trap. That file is **tracked**, and every
flag must stay `false` in a commit. If a run is interrupted, restore it:

```bash
git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts
```

### Probe-host drone

`packages/p2p-probe-host` is a storage-profile node that listens on an ephemeral
WebSocket address so an emulator can dial it. It is a normal workspace, so its
dependencies are already installed:

```bash
cd packages/p2p-probe-host && node drone.mjs
```

It prints its control `peerId` and WebSocket multiaddr, then stays alive until
`Ctrl-C`. `STRAND_ID` selects the strand it joins; unset, it falls back to a
placeholder.

## Environment variables

Very little of the codebase reads the environment directly:

| Variable | Read by | Effect |
| --- | --- | --- |
| `STRAND_ID` | `packages/p2p-probe-host/drone.mjs` | Strand the drone joins. Falls back to a placeholder. |
| `DRONE_BOOTSTRAP_CONTROL_ADDR` / `DRONE_BOOTSTRAP_STRAND_ADDR` | same | Optional bootstrap multiaddrs. |
| `STORE_FILE_VOTETORRENT`, `PASSWORD_STORE_VOTETORRENT`, `PASSWORD_KEY_AUTHORITY`, `PASSWORD_KEY_VOTER` | `apps/*/android/app/build.gradle`, fastlane | Real release signing. Unset, the build falls back to the committed debug key and is unpublishable by design. |
| `NVM_DIR` | the verification scripts | Locates an existing nvm install. |

`.gitignore` ignores `.env`, but no `.env` loader exists — application code does
not read one.

## Editor and debugging

`.vscode/launch.json` ships three configurations: **Mocha – Current test file
(vote-engine)**, **Mocha – All tests (vote-engine)**, and **Debug Core Tests**
(aegir). `.vscode/settings.json` configures PlantUML export to `doc/figures` and
a project `cSpell` word list.
