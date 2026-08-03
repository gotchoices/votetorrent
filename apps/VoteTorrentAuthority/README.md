# VoteTorrent Authority

The VoteTorrent Authority app is a mobile application designed for election administrators to manage and oversee elections within the VoteTorrent ecosystem. It serves as a crucial component in the decentralized voting system, allowing authorities to create, manage, and certify elections while maintaining the security and integrity of the voting process.

This is the `votetorrent-authority` workspace — a React Native app inside the [VoteTorrent monorepo](../../README.md).

## Features

- **Election Management**

  - Create and configure new elections
  - Set election timeframes and parameters
  - Manage election keyholders

- **Ballot Management**

  - Create and publish ballot templates
  - Update ballot content as needed
  - Manage district-specific ballots

- **Authority Administration**

  - Manage officer roles and permissions
  - Oversee election certification process

## Installing the app (end users)

- Android device (APK available at [votetorrent.org/authority.apk](https://votetorrent.org/authority.apk))
- iOS device (coming soon to the App Store)

To install on Android:

1. Download the APK from [votetorrent.org/authority.apk](https://votetorrent.org/authority.apk)
2. Install the application on your Android device
3. Launch the app and complete the initial setup with your administrator credentials

## Running from source (developers)

The Authority app is part of a Yarn 4 monorepo. Install dependencies once from the **repository root** — the workspace resolves vendored portals during a root install, so installing inside this directory alone is not enough.

### Prerequisites

- **Node.js** `>=20.19` (the repo pins `22.15.0` in `.nvmrc`)
- **Yarn 4** — pinned to `yarn@4.7.0` via the root `packageManager` field; enable it with [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`)
- A configured **Android** and/or **iOS** toolchain (JDK 17, Android SDK with `ANDROID_HOME` set; Xcode + CocoaPods for iOS)

### Setup

```bash
# from the repository root
yarn install
```

### Run on a device or emulator

From the repository root, the convenience scripts target this app:

```bash
yarn start     # start the Metro bundler
yarn android   # build & run on Android
yarn ios       # build & run on iOS
```

Equivalently, scope the workspace explicitly from anywhere in the repo:

```bash
yarn workspace votetorrent-authority start
yarn workspace votetorrent-authority android
yarn workspace votetorrent-authority ios
```

### Build, test, and lint

```bash
yarn workspace votetorrent-authority test    # run the Jest suite
yarn workspace votetorrent-authority lint     # run ESLint
yarn workspace votetorrent-authority build    # bin/build.sh
```

For producing a signed, standalone release APK, see [BUILD-RELEASE.md](BUILD-RELEASE.md). For details on the `portal:`/vendored dependency layout, Metro configuration, and Hermes polyfills that this app relies on, see [PORTAL-SETUP.md](PORTAL-SETUP.md).

## Technical Architecture

The VoteTorrent Authority app is built using:

- TypeScript
- React Native
- libp2p for peer-to-peer networking
- Optimystic distributed database system

The app connects to two main networks:

1. **Directory Network**: For storing and retrieving authority records
2. **Election Network**: For managing election-specific data and operations

It builds on the shared `@votetorrent/vote-core` and `@votetorrent/vote-engine` workspaces for protocol types and the SQL/Quereus-backed engine. For the full protocol and system design, see the monorepo [Technical Architecture](../../doc/architecture.md).

## Contributing

We welcome contributions to the VoteTorrent Authority app! If you're interested in helping, here are some areas where we could use assistance:

### Development

- TypeScript/React Native development
- UI/UX improvements
- Testing and quality assurance
- Performance optimization
- Security enhancements

### Other Ways to Help

- Documentation improvements
- Translation/localization
- Bug reporting
- Feature suggestions

### Getting Started with Development

1. Fork the [VoteTorrent repository](https://github.com/gotchoices/votetorrent)
2. Clone your fork
3. Install dependencies from the repository root:
   ```bash
   yarn install
   ```
4. Run the app on a device or emulator (see [Running from source](#running-from-source-developers) above):
   ```bash
   yarn android   # or: yarn ios
   ```

### Submitting Changes

1. Create a new branch for your feature/fix
2. Make your changes
3. Submit a pull request to the main repository

## Security

The VoteTorrent Authority app handles sensitive election data and administrator credentials. All contributions must maintain the highest security standards. Note that the development connection gater is intentionally permissive for emulator/local use — see the Security Caveat in [PORTAL-SETUP.md](PORTAL-SETUP.md) before deploying. Please review our security guidelines before contributing.

## License

This project is open source and available under the same license as the main VoteTorrent project.

## Support

For support, please:

1. Check the [main VoteTorrent documentation](../../README.md)
2. Review the [technical architecture](../../doc/architecture.md)
3. Open an issue in the [GitHub repository](https://github.com/gotchoices/votetorrent) if you encounter problems
