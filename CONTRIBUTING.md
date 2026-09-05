# Contributing to VoteTorrent

Thanks for your interest in VoteTorrent — a crowd voting protocol and reference
application. This guide covers the conventions we follow and how to get a change
reviewed and merged.

VoteTorrent is a Yarn 4 monorepo (TypeScript, with two React Native reference
apps). If you would like to help out, the most useful skills are:

* TypeScript
* Node.js
* React Native
* libp2p

We can always use help with **documentation, testing, and translation**, in
addition to feature work and bug fixes.

## Getting set up

Prerequisites, install, and the repository layout are in the
[README](README.md#prerequisites). Once installed, the day-to-day workflow —
build pipeline, guard scripts, cross-package edit loop, on-device proofs — is in
[doc/development.md](doc/development.md).

## Contribution workflow

1. **Fork** `gotchoices/votetorrent` and clone your fork.
2. **Create a branch** off the default branch (`master`) for your change.
3. Make your change, keeping commits focused.
4. **Run the checks** before opening a PR (see below).
5. **Open a pull request** against
   [`gotchoices/votetorrent`](https://github.com/gotchoices/votetorrent).
   Describe what changed and why, and reference any related issue.

### Before you submit

Run the linters and tests from the repository root and make sure they pass:

```bash
yarn lint   # peer-requirements guard, then lints every workspace
yarn test   # runs every workspace's test suite
```

Scope to a single workspace to iterate faster:

```bash
yarn workspace @votetorrent/vote-engine lint
yarn workspace @votetorrent/vote-engine test
```

If your change touches app screens, also run `yarn lint:stubs`; if it touches a
`builders/` directory, run
`yarn workspace @votetorrent/vote-engine guard:builders`. Both are explained in
[doc/development.md](doc/development.md#guards).

## Commit messages

The project uses [Conventional Commits](https://www.conventionalcommits.org/)
with a scope:

```
fix(app): network selection takes effect without an app restart
feat(44-09): add tslib CJS UMD redirect to voter metro config
docs(releases): document the asset rename that the permalinks depend on
test(28): add @noble/curves dedupe regression spec
```

Use a `type(scope): summary` subject line. Common types here are `feat`, `fix`,
`chore`, `build`, `docs`, and `test`. The scope is typically the affected area
or component (`app`, `quereus`, or a work-item identifier). Keep the summary in
the imperative mood and concise.

## Coding standards

* **TypeScript** throughout `packages/*`.
* **Formatting** follows `.editorconfig`: UTF-8, tab indentation (size 2), final
  newline, trimmed trailing whitespace. TypeScript files use single quotes;
  Markdown uses space indentation with no max line length.
* **Linting**: the libraries use [`aegir`](https://github.com/ipfs/aegir); both
  apps use ESLint with the `@react-native` config plus Prettier.
* `yarn lint` from the root applies all of these in one pass.

## Testing

* `yarn test` from the root runs every workspace's suite.
* `vote-core` uses `aegir test`; `vote-engine` runs Mocha specs under
  `test/**/*.spec.ts`; both apps use Jest.
* Jest mocks the crypto and multiformats layers, so it cannot catch bundling or
  Hermes-runtime defects. Changes to the engine, polyfill, or Metro surfaces
  should also be exercised with the
  [on-device proofs](doc/development.md#on-device-proofs).
* Add or update tests alongside behavioral changes, and make sure `yarn test`
  passes before opening a PR.

## Reporting issues and requesting features

Open issues on
[`gotchoices/votetorrent`](https://github.com/gotchoices/votetorrent/issues).
For bug reports, please include:

* Steps to reproduce.
* What you expected to happen, and what actually happened.
* Relevant environment details (OS, Node.js version, and whether the issue is in
  a library package or one of the apps).

Feature requests are welcome — describe the use case and the problem you are
trying to solve.

## License

By contributing, you agree that your contributions to the published packages
(`@votetorrent/vote-core` and `@votetorrent/vote-engine`) are licensed under the
project's MIT license.
