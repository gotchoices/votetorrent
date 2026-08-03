# VoteTorrent
Crowd voting protocol and reference application.

See the following documentation:

* [End-user Frequently Asked Questions](doc/user-faq.md)
* [Figma Wireframes](https://www.figma.com/proto/egzbAF1w71hJVPxLQEfZKL/Mobile-App?node-id=53-865&t=b6kRPTs8TXLtsWgk-1)
* [Technical Architecture](doc/architecture.md)
* [Election Logic](doc/election.md)

## How to use:

### Host a stand-alone node

Stand-alone nodes can be hosted on any platform supporting Node.js.  A node can be configured as either of the following:
  * **Transaction** - limited storage
    * Facilitates data storage and matchmaking operations, such as:
      * Registration
      * Voting
      * Validation
  * **Storage** - server or cloud service - long term storage capable
    * User: press, municipalities, etc.
    * Facilitates:
      * Stability and robustness of storage
      * Archival of election results

Whether transactional or storage, a stand-alone node can optionally serve as a:
  * Public IP/DNS address - incoming connections from mobile apps and NAT traversal
  * Bootstrap - stable entry points for the network

### Use the reference app

**Mobile apps coming soon:**
* VoteTorrent Election
* VoteTorrent Authority ([android APK](https://votetorrent.org/authority.apk))

These will be available in the Apple App Store and Google Play Store.

### Releases

Signed Android release APKs are built by CI and published to permanent
per-app download links — see [doc/releases/RELEASE-ANDROID.md](doc/releases/RELEASE-ANDROID.md)
for the release process and repository secret setup.

* [Voter APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-voter/votetorrent-voter-latest.apk)
* [Authority APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk)

## Contributing

If you would like to help out, the following skills will be most useful:

* Typescript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [VoteTorrent repository](https://github.com/gotchoices/votetorrent)

## Repository layout

VoteTorrent is a Yarn 4 monorepo. Source lives in two workspace roots, `packages/*` and `apps/*`:

| Workspace | Package | Description |
| --- | --- | --- |
| `packages/vote-core` | `@votetorrent/vote-core` | Core voting functionality — shared types and protocol primitives. Library (`dist/src/index.js`). |
| `packages/vote-engine` | `@votetorrent/vote-engine` | Concrete implementation of the voting functionality, including the SQL/Quereus-backed engine. Library (`dist/index.js`, plus a `./rn` React Native entry). |
| `packages/p2p-probe-host` | `p2p-probe-host` | Host-side drone used as dev tooling for the P2P dial proof. Not published. |
| `apps/VoteTorrentAuthority` | `votetorrent-authority` | React Native reference app for setting up networks, authorities, and elections. |

The `vote-core` and `vote-engine` packages are published under the MIT license; the probe host and the Authority app are private workspaces.

## Prerequisites

* **Node.js** `>=20.19` (the repo pins `22.15.0` in `.nvmrc`).
* **Yarn 4** — the project is pinned to `yarn@4.7.0` via the `packageManager` field. Enable it with [Corepack](https://nodejs.org/api/corepack.html):

```bash
corepack enable
```

Working on the React Native Authority app additionally requires a configured Android and/or iOS toolchain. See [doc/getting-started.md](doc/getting-started.md) for the full setup.

## Build & test

From the repository root:

```bash
yarn install   # install dependencies across all workspaces
yarn build     # build every workspace (aegir / tsc)
yarn test      # run the test suites across all workspaces
yarn lint      # check peer requirements, then lint every workspace
```

These root scripts fan out to each workspace via `yarn workspaces foreach`. To target a single workspace, scope the command, for example:

```bash
yarn workspace @votetorrent/vote-engine test
```

To run the Authority app on a device or emulator:

```bash
yarn start                       # start the Metro bundler
yarn android                     # build & run on Android
yarn ios                         # build & run on iOS
```

## Documentation

Protocol and design documentation lives under [`doc/`](doc):

* [Technical Architecture](doc/architecture.md) — protocol and technical architecture
* [Election Logic](doc/election.md)
* [End-user FAQ](doc/user-faq.md)
* [Registration](doc/registration.md) · [Validations](doc/validations.md) · [Invitations](doc/invitations.md) · [Matchmaking](doc/matchmaking.md) · [Repository](doc/repository.md) · [Optimystic](doc/optimystic.md)
* [Tutorials](doc/tutorials)

Developer-facing guides:

* [Getting Started](doc/getting-started.md) — prerequisites and first run
* [Development](doc/development.md) — local workflow, build, and conventions
* [Testing](doc/testing.md) — how to run and write tests
* [Configuration](doc/configuration.md) — environment and configuration settings
* [Codebase Architecture](doc/codebase-architecture.md) — how the workspaces fit together
* [Contributing](CONTRIBUTING.md) — contribution guidelines
