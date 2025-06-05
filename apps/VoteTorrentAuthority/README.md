# VoteTorrent Authority

The VoteTorrent Authority app is a mobile application designed for election administrators to manage and oversee elections within the VoteTorrent ecosystem. It serves as a crucial component in the decentralized voting system, allowing authorities to create, manage, and certify elections while maintaining the security and integrity of the voting process.

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

  - Manage administrator roles and permissions
  - Oversee election certification process

## Getting Started

- Android device (APK available at [votetorrent.org/authority.apk](https://votetorrent.org/authority.apk))
- iOS device (coming soon to the App Store)

### Installation

1. Download the APK from [votetorrent.org/authority.apk](https://votetorrent.org/authority.apk)
2. Install the application on your Android device
3. Launch the app and complete the initial setup with your administrator credentials

## Technical Architecture

The VoteTorrent Authority app is built using:

- TypeScript
- React Native
- libp2p for peer-to-peer networking
- Optimystic distributed database system

The app connects to two main networks:

1. **Directory Network**: For storing and retrieving authority records
2. **Election Network**: For managing election-specific data and operations

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
3. Install dependencies:
   ```bash
   cd apps/VoteTorrentAuthority
   yarn install
   ```
4. Start the development server:
   ```bash
   yarn run all
   ```

### Submitting Changes

1. Create a new branch for your feature/fix
2. Make your changes
3. Submit a pull request to the main repository

## Security

The VoteTorrent Authority app handles sensitive election data and administrator credentials. All contributions must maintain the highest security standards. Please review our security guidelines before contributing.

## License

This project is open source and available under the same license as the main VoteTorrent project.

## Support

For support, please:

1. Check the [main VoteTorrent documentation](https://github.com/gotchoices/votetorrent)
2. Review the [technical architecture](doc/architecture.md)
3. Open an issue in the GitHub repository if you encounter problems
