# @votetorrent/vote-core

Core domain model for VoteTorrent: the shared types, data models, and engine
interfaces that define the crowd-voting protocol.

Part of the [VoteTorrent](https://github.com/gotchoices/votetorrent) monorepo.

## Role in the monorepo

`vote-core` is the source of truth for the domain model. It exports the plain
data shapes (`models.ts`) and the engine *interfaces* (`types.ts`) for each
domain area, but holds no concrete engine logic and depends on nothing else in
the repository.

- **`@votetorrent/vote-core`** (this package) defines the contracts.
- **`@votetorrent/vote-engine`** implements those interfaces against a Quereus
  database and the libp2p network. It depends on `vote-core`.
- The reference **app** consumes the `vote-core` types and the `vote-engine`
  implementation to drive the UI.

Dependency direction is strictly downward, so `vote-core` is the foundation the
other packages build on. See
[`doc/codebase-architecture.md`](../../doc/codebase-architecture.md) for the
full picture.

## Installation

This package is consumed within the monorepo workspace. Other workspace
packages reference it by name:

```json
{
  "dependencies": {
    "@votetorrent/vote-core": "^0.0.1"
  }
}
```

Runtime dependencies are minimal: `@libp2p/interface`, `@libp2p/peer-id`, and
`uint8arrays`.

## Usage

`src/index.ts` re-exports a set of domain-scoped barrels. Import the models and
engine interfaces you need from the package root:

```ts
import type {
  INetworksEngine,
  INetworkEngine,
  IElectionsEngine,
  IElectionEngine,
  IAuthorityEngine,
  NetworkInit,
  NetworkReference,
  User,
  Proposal,
  Signature
} from '@votetorrent/vote-core'
```

Each `IXxxEngine` interface is the contract an engine implementation must
satisfy (for example `INetworksEngine` is implemented by `vote-engine`), while
the model types are the plain data shapes passed across that boundary.

## Exported modules

| Module | Responsibility |
| --- | --- |
| `authority/` | Authorities, administrators, officers, and their invites |
| `network/` · `networks/` | A single network, and the collection / recents of networks |
| `election/` · `elections/` | A single election, and the collection of elections |
| `signing/` | Signing sessions and signature primitives |
| `invite/` | Authority / officer / keyholder invitations |
| `tasks/` | Onboarding, key-release, and signature task queues |
| `user/` | User records and keys |
| `subscription/` | Live-query subscription interfaces |
| `common/` | Shared primitives: `IBuilder`, cursors, signatures, image/video refs, threshold policies, `LocalStorage`, district ranges, and feature errors |

The `common/builder.ts` `IBuilder<TInput, TOutput>` contract underpins the
form-builder pattern used throughout the UI.

The canonical SQL schema also lives in this package at
[`schema/votetorrent.qsql`](./schema/votetorrent.qsql) — a single Quereus DDL
file defining all domain tables and their constraints.

## Build and test

Build and test scripts run through [aegir](https://github.com/ipfs/aegir):

```bash
yarn workspace @votetorrent/vote-core build
yarn workspace @votetorrent/vote-core test
```

Additional scripts: `clean`, `lint`, `test:node`, and `dep-check`.

## License

MIT
