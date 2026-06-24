# @votetorrent/vote-engine

The concrete engine library for VoteTorrent. It implements the `@votetorrent/vote-core` interfaces against a [Quereus](https://github.com/optimystic) SQL `Database`, driving all domain behaviour from the shared schema in `vote-core/schema/votetorrent.qsql` (Quereus/Sereus SQL on top of Optimystic).

Part of the [VoteTorrent](https://github.com/gotchoices/votetorrent) monorepo. See the [root README](../../README.md) and [doc/codebase-architecture.md](../../doc/codebase-architecture.md) for how this package fits into the whole.

## What it provides

`vote-core` defines the types and `IXxx` interfaces (the contracts); `vote-engine` is the schema-driven layer that makes them concrete. Its structure mirrors `vote-core` — each domain folder (`networks/`, `network/`, `elections/`, `election/`, `authority/`, `signing/`, `user/`, `tasks/`, `invite/`) contains:

- **Engines** (`*-engine.ts`) — implement the `IXxx` interfaces by issuing SQL against a shared `EngineContext`. The schema's row shapes (Network, Election, Authority, User, etc.) flow through these engines as typed rows.
- **Mock engines** (`mock-*.ts`) — in-memory implementations used by tests and early UI development.
- **Builders** (`*/builders/*-builder.ts`) — typed query builders implementing the `vote-core` `IBuilder` contract: immutable draft objects with per-setter and cross-field validators that produce a validated payload and `commit()` it through an engine. For example, `NetworksCreateBuilder` delegates to `NetworksEngine.create`.

The database tier lives under `src/database/`:

- `schema-sql.ts` — the schema DDL bundled as a string constant (`VOTETORRENT_SCHEMA_SQL`), auto-generated from `vote-core/schema/votetorrent.qsql`. It is a string (not a file read) so `initDB` works under Hermes, which cannot parse `import.meta` and has no Node `fs`.
- `initialize.ts` — `registerDbPlugins` (registers the `@optimystic/quereus-plugin-crypto` plugin plus the custom `SignatureValid` / `isISODatetime` SQL functions), `initDB` (executes the schema), and the schema-version / TID-sequence helpers that gate create-vs-reattach.

Two abstractions in `src/types.ts` decouple the engine from its runtime:

- `EngineContext` — `{ db: Database; user?: User }`, the per-network handle the engines operate on.
- `DbFactory` — `(networkHash) => Promise<Database>`, the injected factory that produces a `Database` for a given network. The only built-in factory is an in-memory `new Database()`; the persistent and P2P factories live in the app layer.

## Relationship to the rest of the repo

- **`@votetorrent/vote-core`** — the upstream dependency. `vote-engine` implements its interfaces and consumes its types; the canonical schema (`votetorrent.qsql`) also lives in `vote-core`.
- **The app** — composes `vote-engine` behind its own platform layer. The app supplies the concrete persistent / P2P `DbFactory` and consumes the React Native entry point.

## Entry points

The package has two entry points:

- `.` (`src/index.ts`) — the default barrel. It deliberately **omits `NetworksEngine`** so it is not pulled into non-RN consumers.
- `./rn` (`src/rn-entry.ts`) — the single controlled React Native export path. It exposes `NetworksEngine` and the other concrete engines plus `LocalStorageReact`, the `DbFactory` / `EngineContext` types, `H16`, `VOTETORRENT_SCHEMA_SQL`, and the digest vectors.

The published entry is `dist/index.js` (types `dist/index.d.ts`); the RN subpath resolves to `dist/rn-entry.js`.

```ts
// Default consumers (mocks, builders, types):
import { NetworksCreateBuilder } from '@votetorrent/vote-engine'

// React Native / engine consumers:
import { NetworksEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
```

## Build and test

This package builds with `tsc` directly (not aegir) and tests with Mocha. From this directory:

| Command | Description |
| --- | --- |
| `yarn build` | Compile TypeScript to `dist/` via `tsc -p tsconfig.build.json`. |
| `yarn clean` | Remove the `dist/` output. |
| `yarn test` | Run the Mocha suite (`test/**/*.spec.ts`) under ts-node. |
| `yarn lint` | Lint with aegir. |
| `yarn dep-check` | Check dependency usage with aegir. |
| `yarn guard:builders` | Enforce generated-builder integrity (see below). |

> The `react` / `react-native` / `@react-native-async-storage` dependencies back the `LocalStorageReact` adapter and are also declared as `peerDependencies`.

### Regenerating the bundled schema

`src/database/schema-sql.ts` is auto-generated from `vote-core/schema/votetorrent.qsql` and must not be edited by hand. When the schema changes, regenerate the string constant (the exact command is documented in the header comment of `schema-sql.ts`) and rebuild.

### Guarding the builders

`yarn guard:builders` runs `scripts/ci-grep-guard.sh`, which scans every `*/builders/*.ts` file and rejects colon-prefix SQL bind keys (e.g. `':userId'`). Builders must never construct SQL bind objects directly — the Quereus colon-prefix parameter-binding quirk stays contained at the engine layer. The guard exits non-zero on any violation, so it can run in CI.

## License

MIT (per this package's `license` field).
