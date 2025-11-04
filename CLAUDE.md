# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VoteTorrent is a crowd voting protocol and reference application implementing a decentralized, peer-to-peer election system. The system uses Kademlia DHT-based networks for distributed data storage and libp2p for peer-to-peer networking.

## Repository Structure

This is a Yarn workspace monorepo with three main components:

- **packages/vote-core** - Core voting functionality (types, models, interfaces)
- **packages/vote-engine** - Concrete implementation of voting logic (database, network, tasks)
- **apps/VoteTorrentAuthority** - React Native mobile app for election administrators
- **web/** - Static website files for votetorrent.org
- **doc/** - Technical documentation including architecture, election logic, and protocols

## Common Commands

### Root Level
```bash
# Install all dependencies
yarn install

# Build all packages
yarn build

# Run linting across all workspaces
yarn lint

# Run tests across all workspaces
yarn test

# Clean all workspaces
yarn clean

# Start the Authority mobile app
yarn start

# Run Android app
yarn android

# Run iOS app (not yet fully implemented)
yarn ios
```

### Package-Specific Commands (vote-core and vote-engine)
```bash
# From package directory (packages/vote-core or packages/vote-engine)
yarn build        # Build using aegir
yarn lint         # Lint using aegir
yarn test         # Run all tests
yarn test:node    # Run only Node.js tests
yarn dep-check    # Check dependencies
yarn clean        # Clean build artifacts
```

### Authority Mobile App
```bash
# From apps/VoteTorrentAuthority
yarn android              # Run on Android
yarn ios                  # Run on iOS
yarn start                # Start React Native metro bundler
yarn test                 # Run Jest tests
yarn build                # Build release APK using bin/build.sh
```

The `bin/build.sh` script builds Android release APKs. Set `VOTETORRENT_AUTHORITY_ANDROID_APK_DEPLOY` environment variable to automatically deploy via scp after build.

## Architecture

### Core Concepts

**Network Types:**
- **Directory Network** - Global P2P network storing authority records and election network references
- **Election Network** - Election-scoped P2P network storing election-related records

**Key Technologies:**
- **Optimystic** - Distributed database system using logical transaction logs with block-based storage. Supports single and cross-collection transactions through multi-phase commit (pend → commit → propagate → checkpoint).
- **Matchmaking** - Rendezvous-based peer discovery system for forming voting blocks and coordinating distributed tasks. Uses adaptive rendezvous keys combining local node addresses with task-specific hashes.
- **Quereus** - Database library used by vote-engine for schema-based storage (@quereus/quereus package)

### Package Dependencies

- `vote-core` - Foundation layer with types and interfaces, minimal dependencies
- `vote-engine` - Implementation layer, depends on vote-core, includes libp2p, database, and React Native peer dependencies
- `VoteTorrentAuthority` - React Native app consuming both packages via workspace references

### Data Model

The core exports are organized by domain:
- **authority/** - Authority and administrator models
- **election/** - Election and ballot models
- **user/** - User and key management
- **tasks/** - Signature and key tasks
- **network/** - Network and subscription models
- **common/** - Shared utilities (signatures, envelopes, storage)

vote-engine mirrors this structure with concrete implementations (e.g., `user-engine.ts`, `network-engine.ts`) and mock implementations for testing.

### Database & Schema

vote-engine uses Quereus database with schema loading via `schema-loader.ts`. Database operations in `quereus-database.ts`. React Native async storage integration in `local-storage-react.ts`.

## Key Files to Reference

- `doc/architecture.md` - System architecture and subsystems overview
- `doc/election.md` - Election processes (registration, voting, validation)
- `doc/optimystic.md` - Distributed database transaction system
- `doc/matchmaking.md` - Peer-to-peer matchmaking protocol
- `doc/administration.md` - Authority and administrator management

## Testing

Tests use aegir test runner. Mock implementations available in vote-engine for:
- `mock-network-engine.ts`
- `mock-user-engine.ts`
- `mock-keys-tasks-engine.ts`
- `mock-signature-tasks-engine.ts`

## Development Notes

- All packages use ES modules (`"type": "module"`)
- TypeScript compilation via aegir build tooling
- React Native dependencies are "nohoisted" in the workspace config to avoid compatibility issues
- The mobile app requires Node.js >= 18
- Schema changes require understanding the Quereus database system and migration patterns
