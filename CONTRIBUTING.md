# Contributing to VoteTorrent

Thanks for your interest in VoteTorrent — a crowd voting protocol and reference
application. This guide covers how to get set up, the conventions we follow, and
how to get a change reviewed and merged.

VoteTorrent is a Yarn 4 monorepo (TypeScript, with a React Native reference app).
If you would like to help out, the following skills are most useful:

* TypeScript
* Node.js
* React Native
* libp2p

We can always use help with **documentation, testing, and translation**, in
addition to feature work and bug fixes.

## Getting set up

The full prerequisites and first-run steps live in
[doc/getting-started.md](doc/getting-started.md). In short:

* **Node.js** `>=20.19` — the repo pins `22.15.0` in `.nvmrc`.
* **Yarn 4** — pinned to `yarn@4.7.0` via the `packageManager` field. Enable it
  with [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`.
* Working on the React Native Authority app additionally requires a configured
  Android and/or iOS toolchain.

Install dependencies from the repository root:

```bash
corepack enable
yarn install
```

## Repository layout

Source lives in two workspace roots, `packages/*` and `apps/*`:

* `packages/vote-core` (`@votetorrent/vote-core`) — shared types and protocol primitives.
* `packages/vote-engine` (`@votetorrent/vote-engine`) — concrete voting implementation, including the SQL/Quereus-backed engine.
* `packages/p2p-probe-host` (`p2p-probe-host`) — dev tooling for the P2P dial proof (private).
* `apps/VoteTorrentAuthority` (`votetorrent-authority`) — React Native reference app (private).

For a deeper tour of how the workspaces fit together, see
[doc/codebase-architecture.md](doc/codebase-architecture.md).

## Contribution workflow

1. **Fork** `gotchoices/votetorrent` and clone your fork.
2. **Create a branch** off the default branch (`master`) for your change.
3. Make your change, keeping commits focused.
4. **Run the checks** before opening a PR (see below).
5. **Open a pull request against the upstream repository**,
   [`gotchoices/votetorrent`](https://github.com/gotchoices/votetorrent). Describe
   what changed and why, and reference any related issue.

### Before you submit

Run the linters and tests from the repository root and make sure they pass:

```bash
yarn lint   # checks peer requirements, then lints every workspace
yarn test   # runs the test suites across every workspace
```

If you are touching a single workspace, you can scope the commands to iterate
faster, for example:

```bash
yarn workspace @votetorrent/vote-engine lint
yarn workspace @votetorrent/vote-engine test
```

The root `yarn lint` first runs `scripts/check-peer-requirements.mjs` (a guard for
known peer-dependency mismatches) and then fans out to each workspace's `lint`
script via `yarn workspaces foreach`.

## Commit messages

The project uses [Conventional Commits](https://www.conventionalcommits.org/)
with a scope. The history shows the observed pattern clearly:

```
fix(app): network selection takes effect without an app restart
chore(quereus): apply quereus patch ref in vote-engine package.json
feat(27-01): add scripts/sync-vendor.sh maintainer re-sync script
build(260623-jmj): release signing keystore setup + BUILD-RELEASE.md
docs(27-01): assert SC1+SC3 and record D-01 superset divergence in VENDOR.md
test(28): add @noble/curves dedupe regression spec
```

Use a `type(scope): summary` subject line. Common types in this repo are `feat`,
`fix`, `chore`, `build`, `docs`, and `test`. The scope is typically the affected
area or component (for example `app`, `quereus`, or a work-item identifier).
Keep the summary in the imperative mood and concise.

## Coding standards

* **TypeScript** throughout the `packages/*` workspaces.
* **Formatting** follows `.editorconfig`: UTF-8, tab indentation (size 2), a final
  newline, and trimmed trailing whitespace. TypeScript files use single quotes.
  Markdown uses space indentation with no max line length.
* **Linting** for the library packages (`vote-core`, `vote-engine`) is run with
  [`aegir`](https://github.com/ipfs/aegir) via `aegir lint`. The
  `apps/VoteTorrentAuthority` app lints with ESLint using the `@react-native`
  config and formats with Prettier (`printWidth: 100`).
* Run `yarn lint` from the root to apply all of these in one pass before
  submitting.

## Testing

Test commands and how to write new tests are documented in
[doc/testing.md](doc/testing.md). The short version:

* `yarn test` from the root runs every workspace's test suite.
* `vote-core` uses `aegir test`; `vote-engine` runs Mocha specs under `test/**/*.spec.ts`;
  the Authority app uses Jest.
* Add or update tests alongside behavioral changes, and make sure `yarn test`
  passes before opening a PR.

## Reporting issues and requesting features

Open issues on the upstream repository,
[`gotchoices/votetorrent`](https://github.com/gotchoices/votetorrent/issues).
For bug reports, please include:

* Steps to reproduce.
* What you expected to happen and what actually happened.
* Relevant environment details (OS, Node.js version, and whether the issue is in a
  library package or the React Native app).

Feature requests are welcome — describe the use case and the problem you are
trying to solve.

## License

By contributing, you agree that your contributions to the published packages
(`@votetorrent/vote-core` and `@votetorrent/vote-engine`) are licensed under the
project's MIT license.
