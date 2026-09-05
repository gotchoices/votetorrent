# VoteTorrent

Crowd voting protocol and reference application.

Voting without a central server: voters self-organize over a peer-to-peer
network, pool their votes into anonymized blocks, and submit them together. The
result is verifiable by anyone — voters can confirm their own vote is present
and correctly counted, and stakeholders can confirm that only eligible voters
voted and that the tally matches — without anyone learning how a given voter
voted.

* [End-user FAQ](doc/user-faq.md) — start here for what it is and why
* [Technical Architecture](doc/architecture.md) — protocol and subsystems
* [Election Logic](doc/election.md) — how an election actually runs
* [Figma wireframes](https://www.figma.com/proto/egzbAF1w71hJVPxLQEfZKL/Mobile-App?node-id=53-865&t=b6kRPTs8TXLtsWgk-1)

## Apps

Two React Native reference apps:

* **VoteTorrent Voter** — registration, ballots, casting a vote.
* **VoteTorrent Authority** — networks, authorities, elections, keyholding.

Android APKs are signed and published by the key holder to rolling download
links. App Store / Play Store releases are not yet available.

* [Voter APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-voter/votetorrent-voter-latest.apk)
* [Authority APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk)

CI builds both apps on every push to prove they compile and bundle, but those
builds are debug-signed and are never published — the signing key does not leave
the key holder's machine. See
[doc/releases/RELEASE-ANDROID.md](doc/releases/RELEASE-ANDROID.md).

## Host a stand-alone node

Stand-alone nodes run on any platform supporting Node.js, in one of two
profiles:

* **Transaction** — limited storage. Facilitates registration, voting, and
  validation, plus matchmaking between peers.
* **Storage** — server or cloud service, long-term storage capable. Run by
  press, municipalities, and similar stakeholders. Provides storage stability
  and archival of election results.

Either profile can additionally serve as a public IP/DNS address (accepting
incoming connections from mobile apps, and assisting NAT traversal) or as a
bootstrap node (a stable entry point into the network).

---

# Development

## Repository layout

Yarn 4 monorepo. Source lives in two workspace roots, `packages/*` and `apps/*`:

| Workspace | Package | Description |
| --- | --- | --- |
| `packages/vote-core` | `@votetorrent/vote-core` | Shared types, domain models, and engine interfaces. Published library (`dist/src/index.js`). Also holds the canonical SQL schema, `schema/votetorrent.qsql`. |
| `packages/vote-engine` | `@votetorrent/vote-engine` | Concrete implementation of the `vote-core` interfaces, over a Quereus SQL database. Published library (`dist/index.js`, plus a `./rn` React Native entry). |
| `packages/p2p-probe-host` | `p2p-probe-host` | Host-side drone used by the P2P dial and replication proofs. Dev tooling; private. |
| `apps/VoteTorrentVoter` | `votetorrent-voter` | React Native Voter app. Private. |
| `apps/VoteTorrentAuthority` | `votetorrent-authority` | React Native Authority app. Private. |

`vote-core` and `vote-engine` are published under the MIT license; the probe
host and both apps are private workspaces.

Dependency direction is strictly downward: `vote-core` → `vote-engine` → apps.
No React Native, libp2p, or storage dependency enters the libraries — those live
only in the app layer, behind injected factories. See
[doc/codebase-architecture.md](doc/codebase-architecture.md) for the full tour.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | `>=20.19` | The repo pins `22.15.0` in `.nvmrc`; `nvm use` selects it. |
| Yarn | `4.7.0` | Pinned via `packageManager`. Enable through [Corepack](https://nodejs.org/api/corepack.html) — do not install Yarn globally. |

The libraries are plain ESM TypeScript, so the table above is everything you
need to build, test, and lint them.

Running either **app** on a device additionally needs a React Native toolchain:

* **Android** — JDK 17, the Android SDK, and `ANDROID_HOME` set. Both apps build
  with the new architecture and Hermes enabled.
* **iOS** (macOS only) — Xcode with the iOS SDK, plus Ruby `>= 2.6.10` and
  Bundler for CocoaPods. Each app's `Gemfile` pins compatible CocoaPods,
  `activesupport`, `xcodeproj`, and `concurrent-ruby` ranges around known build
  failures.

If you have never set up React Native before, follow the official
[Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment)
guide for your platform first.

## Install

```bash
git clone https://github.com/gotchoices/votetorrent.git
cd votetorrent
corepack enable
nvm use          # selects Node 22.15.0 from .nvmrc
yarn install
```

Install everything from the **repository root** — installing inside a single app
directory will not resolve the workspace links.

A `postinstall` hook runs `scripts/check-peer-requirements.mjs`, which guards a
known set of peer-dependency mismatches. A clean install prints no `YN0086`
warnings; confirm with `yarn install 2>&1 | grep -c YN0086` (expect `0`). See
[doc/development.md](doc/development.md) for why that guard exists.

## Build and test

From the repository root. Each fans out to every workspace via
`yarn workspaces foreach`:

```bash
yarn build   # build every workspace
yarn test    # run every workspace's test suite
yarn lint    # peer-requirements guard, then lint every workspace
yarn clean   # clean every workspace
```

A green `yarn build` and `yarn test` is the fastest confirmation that your
toolchain works — neither needs any React Native tooling.

Scope to one workspace with `yarn workspace <package-name> <script>`:

```bash
yarn workspace @votetorrent/vote-engine test
```

## Running an app

Metro must be running in its own terminal, then launch the app in a second one:

```bash
# Authority
yarn start           yarn android           yarn ios

# Voter
yarn start:voter     yarn android:voter     yarn ios:voter
```

The first native build takes several minutes. For a signed, self-contained
release APK (JS bundle embedded, no Metro), see
[doc/releases/RELEASE-ANDROID.md](doc/releases/RELEASE-ANDROID.md).

## Contributing

Most useful skills: **TypeScript**, **Node.js**, **React Native**, **libp2p**.
We can always use help with documentation, testing, and translation.

Read [CONTRIBUTING.md](CONTRIBUTING.md), then submit pull requests to
[gotchoices/votetorrent](https://github.com/gotchoices/votetorrent).

## Documentation

Protocol and design:

* [Technical Architecture](doc/architecture.md) — subsystems, networks, requirements
* [Election Logic](doc/election.md) — election processes end to end
* [Administration](doc/administration.md) — authorities, administrators, officers
* [Registration](doc/registration.md) — voter registration and device association
* [End-user FAQ](doc/user-faq.md)
* [Tutorials](doc/tutorials) — scripts for explainer videos

The distributed database and matchmaking layers are documented in the
[Optimystic repository](https://github.com/gotchoices/Optimystic/tree/main/docs).

Developer:

* [Development](doc/development.md) — day-to-day workflow, build pipeline, tooling
* [Codebase Architecture](doc/codebase-architecture.md) — workspaces and runtime composition
* [Android builds and releases](doc/releases/RELEASE-ANDROID.md)
* [Contributing](CONTRIBUTING.md)
