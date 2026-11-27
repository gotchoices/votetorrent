# VoteTorrent Voter

Mobile app for voters. It is the counterpart to the
[Authority app](../VoteTorrentAuthority/README.md), and covers the voter side of
the VoteTorrent protocol: joining a network, registering, associating a device,
and casting a vote.

This is the `votetorrent-voter` workspace inside the
[VoteTorrent monorepo](../../README.md).

## Features

- **Join a network** — by QR, NFC, deep link, or discovery through the Directory
  Network.
- **Register** — furnish the public and private detail an authority requires,
  and complete its verification steps.
- **Device association** — attest the device to the authority so votes can be
  bound to it.
- **Vote** — review the ballot, make selections, and submit into an anonymized
  vote block.
- **Verify** — confirm your own vote is present and correct once results are
  released.

Available in English and Spanish.

## Installing (end users)

Download the signed APK:
[Voter APK (latest)](https://github.com/gotchoices/votetorrent/releases/download/latest-voter/votetorrent-voter-latest.apk).
iOS is not yet available.

## Running from source

Install from the **repository root** — installing inside this directory alone
will not resolve the workspace links. Prerequisites and install steps are in the
[root README](../../README.md#prerequisites).

```bash
# from the repository root
yarn start:voter     # Metro bundler, leave running
yarn android:voter   # build & run on Android
yarn ios:voter       # build & run on iOS (macOS only)
```

Or scope the workspace explicitly from anywhere in the repo:

```bash
yarn workspace votetorrent-voter start
yarn workspace votetorrent-voter test        # Jest
yarn workspace votetorrent-voter lint        # ESLint
yarn workspace votetorrent-voter typecheck   # tsc --noEmit
```

Jest mocks the crypto and multiformats layers, so it cannot catch bundling or
Hermes-runtime failures in the real register path. Use the on-device boot smoke
for that:

```bash
./scripts/voter-boot-smoke.sh
```

For a signed, standalone release APK, see
[doc/releases/RELEASE-ANDROID.md](../../doc/releases/RELEASE-ANDROID.md).

## Architecture

TypeScript and React Native over libp2p, with the Sereus strand layer and the
Optimystic distributed database. The app supplies everything platform-specific
(storage, P2P transport, device signing, attestation production) and injects it
into the shared `@votetorrent/vote-core` and `@votetorrent/vote-engine`
workspaces, which hold the protocol types and the Quereus-backed engine.

See [Codebase Architecture](../../doc/codebase-architecture.md) for the
composition, [Technical Architecture](../../doc/architecture.md) for the
protocol, and [Election Logic](../../doc/election.md) for what happens during an
election.

The attestation values this app produces are consumed by the Authority app's
verifier under a locked wire format — see
[ATTESTATION-CONTRACT.md](../../packages/vote-engine/ATTESTATION-CONTRACT.md).

The Metro configuration carries several load-bearing workarounds for running
this stack on Hermes — read
[the constraints table](../../doc/development.md#react-native--hermes-constraints)
before changing it.

## Security

This app handles voter registration detail and the voter's private key.

> **Caveat:** the libp2p connection gater is currently permissive
> (`denyDialMultiaddr: async () => false` in `src/providers/CadreNodeProvider.tsx`)
> to allow emulator and local-host dialing during development. This must be
> tightened before any production deployment.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Support

1. [Main documentation](../../README.md)
2. [End-user FAQ](../../doc/user-faq.md)
3. [Open an issue](https://github.com/gotchoices/votetorrent/issues)
