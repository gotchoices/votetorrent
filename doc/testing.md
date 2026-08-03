# Testing

This document describes how tests are organized across the VoteTorrent
workspaces, which test runners each workspace actually uses, how to run the
whole suite or a single file, and what the end-to-end proof scripts under
`scripts/` demonstrate. It also gives guidance for adding a new test that fits
the existing conventions.

For first-time setup (Node version, `yarn install`, building) see
[Getting Started](getting-started.md). For day-to-day workflow and the build
pipeline see [Development](development.md). For how the code itself is laid out
see [Codebase Architecture](codebase-architecture.md).

There is no continuous-integration service wired up in this repository — every
test runner and proof script described below is run locally.

## How tests are organized

The repository is a Yarn 4 workspace monorepo, and each workspace owns its own
tests and chooses its own runner. There is no single shared test config at the
root; `yarn test` simply fans the per-workspace `test` script out across every
workspace.

| Workspace | Test runner | Test location | `test` script |
| --- | --- | --- | --- |
| `@votetorrent/vote-engine` (`packages/vote-engine`) | Mocha + ts-node (Chai assertions) | `test/**/*.spec.ts` | `mocha … "test/**/*.spec.ts"` |
| `votetorrent-authority` (`apps/VoteTorrentAuthority`) | Jest (`react-native` preset) | `__tests__/` and `src/**/__tests__/` | `jest` |
| `@votetorrent/vote-core` (`packages/vote-core`) | aegir | (no test files present yet) | `aegir test` |
| `p2p-probe-host` (`packages/p2p-probe-host`) | — | (dev tooling, no tests) | (no `test` script) |

A note on what the assignment hint expected versus what is actually in the
tree: the library packages are *configured* around aegir (aegir is the root
dev-dependency and `vote-core` still runs `aegir test`), but the package that
actually carries the test suite — `vote-engine` — runs **Mocha directly**
through a ts-node ESM loader rather than through `aegir test`. `vote-core`
currently has no `*.spec.ts` / `*.test.ts` files (only a `dist/`, a `src/`, and
an `oldsrc/` tree), so `aegir test` there is a no-op placeholder until tests are
added. The React Native app uses **Jest**, as the hint anticipated.

### `vote-engine` — the main unit suite

The bulk of the automated tests live in `packages/vote-engine/test/`. There are
~24 top-level `*.spec.ts` files plus a `quereus-repros/` subdirectory of 7
focused reproduction cases. They exercise the concrete engines against a real
Quereus database — for example:

- `test/signing.spec.ts` — signing-engine round trips and signature tasks.
- `test/elections.spec.ts`, `test/election.spec.ts` — election engine behavior.
- `test/networks.spec.ts`, `test/network.spec.ts` — network engine behavior.
- `test/authority.spec.ts`, `test/user.spec.ts`, `test/invitation.spec.ts` —
  the remaining domain engines.
- `test/schema-load.spec.ts`, `test/canonical-binding.spec.ts`,
  `test/digest-parity.spec.ts` — schema loading and canonical/digest invariants.
- `test/quereus-repros/*.spec.ts` — minimal cases that pin down specific Quereus
  SQL-engine behaviors the engine relies on (composite-PK deletes, deferred
  CHECK visibility, IN-subqueries, scalar subqueries, and so on).

Shared test infrastructure lives alongside the specs:

- `test/fixtures/` — reusable builders and vectors. `test-context.ts` provides
  helpers such as `createTestNetwork`, `addTestAuthority`, `addTestElection`,
  and `makeTestSignature`; `keys.ts` provides `randomTestKeyPair`;
  `digest-vectors.ts` holds canonical digest test vectors;
  `builder-drafts/` holds builder-draft fixtures.
- `test/shims/react-native.ts` — an in-memory `AsyncStorage` shim so engine
  code that expects the React Native storage interface can run under Node.

### `votetorrent-authority` — the app suite

The app is tested with Jest using the `react-native` preset. Configuration is in
`apps/VoteTorrentAuthority/jest.config.js`, which maps two modules to manual
mocks:

- `react-native-localize` → `__mocks__/react-native-localize.js`
- `@optimystic/db-p2p` → `__mocks__/@optimystic/db-p2p.js`

App tests live both in the top-level `__tests__/` directory and in
`__tests__/` folders next to the code they cover:

- `__tests__/App.test.tsx` — smoke test that `<App />` renders via
  `react-test-renderer`.
- `__tests__/i18n-parity.test.ts` — asserts EN/ES translation parity and scans
  the source tree for `t("key")` calls that are missing from the bundle.
- `src/components/__tests__/SyncChip.test.tsx`,
  `src/providers/__tests__/CadreNodeProvider.test.tsx`,
  `src/screens/networks/__tests__/NetworksScreen.bootstrap.test.tsx` — component
  and provider/screen tests.
- `src/engines/__tests__/key-network-strand.test.ts`,
  `src/engines/__tests__/replication-proof-runner.test.ts`,
  `src/engines/__tests__/rn-db-factory.test.ts` — engine-wiring tests on the app
  side (some written as RED scaffolds against modules they expect to exist).

## Running the tests

All commands are run from the repository root unless noted. Make sure
dependencies are installed first (`yarn install` — see
[Getting Started](getting-started.md)).

### Everything

```bash
yarn test
```

This runs `yarn workspaces foreach -A run test`, which invokes each workspace's
own `test` script: Mocha for `vote-engine`, Jest for the app, and `aegir test`
for `vote-core` (a no-op while it has no test files).

### A single workspace

```bash
# the engine unit suite (Mocha)
yarn workspace @votetorrent/vote-engine test

# the app suite (Jest)
yarn workspace votetorrent-authority test
```

### A single file or a subset

For `vote-engine`, run Mocha directly against a path inside the workspace. The
workspace's Mocha invocation relies on the ts-node ESM loader and tsconfig-paths,
so the simplest way to scope it is to pass the spec glob through the same script
machinery from inside the package:

```bash
cd packages/vote-engine
TS_NODE_PROJECT=./tsconfig.test.json \
  yarn mocha --node-option=import=./register-ts-node.mjs \
  --node-option=experimental-specifier-resolution=node \
  --require tsconfig-paths/register \
  test/signing.spec.ts
```

You can also narrow within a file with Mocha's `--grep` to match a `describe`/
`it` title:

```bash
cd packages/vote-engine
TS_NODE_PROJECT=./tsconfig.test.json \
  yarn mocha --node-option=import=./register-ts-node.mjs \
  --node-option=experimental-specifier-resolution=node \
  --require tsconfig-paths/register \
  "test/**/*.spec.ts" --grep "signing"
```

For the app, Jest's standard filtering works once you are in the app workspace:

```bash
cd apps/VoteTorrentAuthority
# a single file
yarn jest __tests__/i18n-parity.test.ts
# all tests whose name matches a pattern
yarn jest -t "renders correctly"
# watch mode
yarn jest --watch
```

### The engine grep guards

`vote-engine` ships two shell guards under `packages/vote-engine/scripts/` that
enforce engine-layer invariants by scanning source rather than executing code.
They have their own spec coverage (`test/ci-grep-guard.spec.ts`,
`test/not-implemented-guard.spec.ts`) and can also be run on their own:

```bash
# rejects colon-prefix SQL bind keys in builder files
yarn workspace @votetorrent/vote-engine guard:builders
# or directly:
bash packages/vote-engine/scripts/ci-grep-guard.sh

# rejects un-allowlisted "Not implemented" throws in vote-engine/src
bash packages/vote-engine/scripts/not-implemented-guard.sh
```

## End-to-end proof scripts

The `scripts/` directory holds device-level proof scripts. These are not part of
`yarn test`; they are operator-driven, on-device verifications that drive an
Android emulator (or real device) over `adb`, flip a build-time feature flag in
`apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts`, relaunch the
app, and assert on a verdict line emitted to `logcat`. Each script anchors its
working directory to the repo root and restores the committed default-false flag
file on exit. They share the polling helper in `scripts/lib/logcat-wait.sh`.

| Script | Proves | Verdict line |
| --- | --- | --- |
| `run-signing-proof.sh` | On-device signing round trip succeeds on the initial boot *and* survives a force-stop / relaunch, and the pre-fix `sign is not a function` FATAL does not reproduce. | `SIGNING VERDICT: PASS` |
| `run-dial-probe.sh` | A device→host WebSocket dial completes without a "connection gater denied" error, validating the cadre-core `connectionGater` patch. | `DIAL VERDICT: PASS` |
| `run-replication-proof.sh` | Symmetric replication between two emulators: Peer A boots solo and creates a proof strand, the host drone connects, and both peers reach a passing verdict; also checks peerId stability across a relaunch and `peers >= 1`. | `REPLICATION VERDICT: PASS` (both peers) |
| `run-vtest02.sh` | Full-chain restart persistence: after a write phase persists a reference, a force-stop / relaunch read phase re-attaches the store and reproduces the chain. | `FULL-CHAIN VERDICT: PASS` |

Each script documents its own prerequisites in its header comment. In general
they require `adb` on `PATH`, the debug app installed on a running emulator (or
real device), and Metro reachable. `run-dial-probe.sh` and
`run-replication-proof.sh` additionally need the host drone from
`packages/p2p-probe-host` (`node drone.mjs`, Node 22); `run-dial-probe.sh`
requires `CONTROL_ADDR` in `apps/VoteTorrentAuthority/src/engines/dial-probe.ts`
to point at the drone's advertised multiaddr, and it aborts early if the
committed placeholder address is still in place.

Typical invocation:

```bash
# signing proof against the default emulator
SERIAL=emulator-5554 ./scripts/run-signing-proof.sh

# dial probe (start the drone first, in a separate terminal)
cd packages/p2p-probe-host && node drone.mjs   # keep running
./scripts/run-dial-probe.sh
```

A script exits `0` on a captured `PASS` verdict and `1` on a `FAIL` verdict,
a missing verdict within the timeout, or a missing prerequisite.

If a proof script is interrupted before its exit trap runs, the generated flag
file may be left modified. Restore it with:

```bash
git checkout -- apps/VoteTorrentAuthority/src/engines/proof-flags.generated.ts
```

Never commit a proof-enabled override of that file.

## Writing a new test

Match the conventions of the workspace you are adding to.

### Adding an engine test (`vote-engine`)

Put a new `*.spec.ts` file under `packages/vote-engine/test/` (or
`test/quereus-repros/` for a focused SQL-engine reproduction). Use
[`test/signing.spec.ts`](../packages/vote-engine/test/signing.spec.ts) as the
reference template — it shows the standard shape:

- Import `Database` from `@quereus/quereus` and the engines you are exercising
  from `../src/...`, with `expect` from `chai`.
- Build context through the shared fixtures in `test/fixtures/test-context.ts`
  (`createTestNetwork`, `addTestAuthority`, `addTestElection`, …) and
  `test/fixtures/keys.ts` (`randomTestKeyPair`) rather than hand-rolling state.
- When engine code expects React Native storage, use the in-memory
  `AsyncStorage` from `test/shims/react-native.ts`.
- Write `describe` / `it` blocks with Chai `expect(...)` assertions.

The file will be picked up automatically by the `test/**/*.spec.ts` glob — no
registration step is needed. Compilation goes through `tsconfig.test.json` and
the ts-node ESM loader in `register-ts-node.mjs`, so `.ts` imports and path
aliases work without a separate build.

### Adding an app test (`votetorrent-authority`)

Put the file in `__tests__/` (cross-cutting) or in an `__tests__/` folder beside
the code under test (component, provider, screen, or engine wiring). Name it
`*.test.ts` or `*.test.tsx`. Jest with the `react-native` preset is already
configured.

- For component rendering, follow
  [`__tests__/App.test.tsx`](../apps/VoteTorrentAuthority/__tests__/App.test.tsx)
  and render through `react-test-renderer` inside `ReactTestRenderer.act(...)`.
- For engine-wiring tests, follow
  [`src/engines/__tests__/key-network-strand.test.ts`](../apps/VoteTorrentAuthority/src/engines/__tests__/key-network-strand.test.ts),
  which builds small `jest.fn()` stubs for the libp2p/fret surface.
- If your code imports `react-native-localize` or `@optimystic/db-p2p`, the
  existing manual mocks under `apps/VoteTorrentAuthority/__mocks__/` are applied
  automatically via `jest.config.js`; add new module mocks there if needed.

## Coverage

No coverage thresholds are configured in this repository. Neither the Mocha
invocation in `vote-engine` nor the Jest config in the app defines a coverage
gate, and there is no separate coverage tool (`nyc`, `c8`, etc.) wired up. Jest
can still produce an ad-hoc report on demand from inside the app workspace:

```bash
cd apps/VoteTorrentAuthority
yarn jest --coverage
```
