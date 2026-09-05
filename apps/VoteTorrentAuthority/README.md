# VoteTorrent Authority

Mobile app for election administrators. It is the counterpart to the
[Voter app](../VoteTorrentVoter/README.md), and covers the administrative side
of the VoteTorrent protocol: standing up a network, delegating authority,
publishing elections and ballots, and holding election keys.

This is the `votetorrent-authority` workspace inside the
[VoteTorrent monorepo](../../README.md).

## Features

- **Networks and authorities** — create a network, invite other authorities,
  manage administrators and officer roles.
- **Elections** — create and revise elections, set timeframes and rules, publish
  and update ballot templates for a district.
- **Keyholding** — manage election keyholders and the key-release process.
- **Certification** — oversee the certification of each ballot's outcome.

Available in English and Spanish.

## Installing (end users)

Download the signed APK:
[Authority APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-authority/votetorrent-authority-latest.apk).
iOS is not yet available.

## Running from source

Install from the **repository root** — installing inside this directory alone
will not resolve the workspace links. Prerequisites and install steps are in the
[root README](../../README.md#prerequisites).

```bash
# from the repository root
yarn start     # Metro bundler, leave running
yarn android   # build & run on Android
yarn ios       # build & run on iOS (macOS only)
```

Or scope the workspace explicitly from anywhere in the repo:

```bash
yarn workspace votetorrent-authority start
yarn workspace votetorrent-authority test    # Jest
yarn workspace votetorrent-authority lint    # ESLint
```

For a signed, standalone release APK, see
[BUILD-RELEASE.md](BUILD-RELEASE.md) and
[doc/releases/RELEASE-ANDROID.md](../../doc/releases/RELEASE-ANDROID.md).

## Architecture

TypeScript and React Native over libp2p, with the Sereus strand layer and the
Optimystic distributed database. The app connects to two networks:

1. **Directory Network** — storing and retrieving authority records.
2. **Election Network** — election-specific data and operations.

It supplies everything platform-specific (storage, P2P transport, device
signing) and injects it into the shared `@votetorrent/vote-core` and
`@votetorrent/vote-engine` workspaces, which hold the protocol types and the
Quereus-backed engine. See
[Codebase Architecture](../../doc/codebase-architecture.md) for the composition,
and [Technical Architecture](../../doc/architecture.md) for the protocol.

The Metro configuration carries several load-bearing workarounds for running
this stack on Hermes — read
[the constraints table](../../doc/development.md#react-native--hermes-constraints)
before changing it.

## Security

This app handles sensitive election data and administrator credentials.

> **Caveat:** the libp2p connection gater is currently permissive
> (`denyDialMultiaddr: async () => false` in `src/providers/CadreNodeProvider.tsx`)
> to allow emulator and local-host dialing during development. This must be
> tightened before any production deployment.

The app also pins the Voter app's package name and signing-certificate digest
for device attestation (`src/engines/attestation-*.generated.ts`). Changing the
Voter app's signing key or application id requires updating those pins — see
[RELEASE-ANDROID.md](../../doc/releases/RELEASE-ANDROID.md).

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Help is especially welcome with
UI/UX, testing, performance, security, translation, and documentation.

## Support

1. [Main documentation](../../README.md)
2. [Technical architecture](../../doc/architecture.md)
3. [Open an issue](https://github.com/gotchoices/votetorrent/issues)
