# Console.log Replacement Checklist

This document tracks the replacement of console.log/error/warn statements with structured logging.

## Status: IN PROGRESS

**Completed:**
- ✅ Created structured logging system (`logger.ts`)
- ✅ Comprehensive test suite for logger
- ✅ Replaced console.error in `secure-storage-react.ts` (2 instances)
- ✅ Exported logger from vote-engine

**Remaining:**

### Vote Engine (packages/vote-engine/src)

**Mock Engines (Low Priority - Development Only):**
- `elections/mock-elections-engine.ts`: 9 console.log statements (lines 92, 107, 111, 127, 131, 138, 145, 150)
- `authority/mock-authority-engine.ts`: 6 console.warn + 1 console.log (lines 53, 70, 86, 96, 109, 117)
- `network/mock-network-engine.ts`: 3 instances (lines 118, 270, 275, 287)
- `user/mock-user-engine.ts`: 1 console.warn (line 75)
- `tasks/mock-keys-tasks-engine.ts`: 1 console.log (line 198)

**Total Mock Engine Statements:** 20

### Authority App (apps/VoteTorrentAuthority/src)

**High Priority:**
- `components/AuthorizationSection.tsx`: 1 console.error (line 57)
- `navigation/index.tsx`: 1 console.error (line 56)
- `providers/AppProvider.tsx`: Already fixed (replaced with TODO comment)

**Screens:**
- `screens/elections/ElectionsScreen.tsx`: 1 console.log + 1 console.error (lines 78, 82)
- `screens/elections/ElectionDetailsScreen.tsx`: 1 console.error (line 29)
- `screens/authorities/AuthorityDetailsScreen.tsx`: 4 console.error (lines 49, 63, 82, 135)
- `screens/authorities/AuthoritiesScreen.tsx`: 2 console.error (lines 39, 52, 88)
- `screens/networks/NetworksScreen.tsx`: 4 console.log (lines 71, 93, 99, 105)
- `screens/networks/NetworkDetailsScreen.tsx`: 2 console (lines 41, 59, 62)
- `screens/networks/AddNetworkScreen.tsx`: 3 console.log (lines 55, 160, 187)
- `screens/networks/HostingScreen.tsx`: 2 console.log (lines 62, 86)
- `screens/administration/ReplaceAdministrationScreen.tsx`: 8 console (lines 38, 46, 59, 60, 62, 68, 74, 79, 112)
- `screens/administration/EditAdministratorScreen.tsx`: 2 console.error (lines 48, 104)
- `screens/users/UserDetailsScreen.tsx`: 2 console (lines 48, 51, 72)
- `screens/users/ReviseUserScreen.tsx`: 2 console.error (lines 30, 49)
- `screens/users/DefaultUserScreen.tsx`: 1 console.error (line 28)
- `screens/users/RevokeKeyScreen.tsx`: 1 console.error (line 58)
- `screens/tasks/TasksScreen.tsx`: 5 console.log (lines 30, 51, 58, 64, 66)
- `screens/tasks/KeyTaskScreen.tsx`: 1 console.log (line 23)
- `screens/tasks/SignatureTaskScreen.tsx`: 2 console.log (lines 30, 35)
- `screens/settings/SettingsScreen.tsx`: 5 console (lines 61, 91, 95, 116, 120, 135)

**Utils:**
- `utils/dataUtils.ts`: 1 console.log (line 9)

**Total App Statements:** 51

## Replacement Pattern

### Before (Insecure):
```typescript
console.log('User data', { userId, password: 'secret' });
console.error('Failed to save', error);
```

### After (Secure):
```typescript
import { createLogger } from '@votetorrent/vote-engine';

const log = createLogger('ComponentName');

log.info('User data', { userId }); // password auto-redacted
log.error('Failed to save', error);
```

## Security Benefits

1. **Automatic redaction** of sensitive fields (passwords, keys, tokens)
2. **Structured data** for better analysis and debugging
3. **Log levels** for production vs development
4. **Contextual information** (component, timestamps)
5. **Extensible** for remote logging services

## Next Steps

1. Replace all console statements in Authority app screens
2. Replace console statements in Authority app components
3. Add structured logging to all error paths
4. Configure production log level (WARN or ERROR only)
5. Add remote logging integration (Phase 5)
