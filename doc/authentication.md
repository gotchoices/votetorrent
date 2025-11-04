# Authentication System

## Overview

VoteTorrent implements a secure, hardware-backed authentication system supporting both biometric and PIN-based authentication. The system is designed to protect sensitive operations and data access.

## Architecture

### Components

1. **AuthManager** (`packages/vote-engine/src/auth/auth-manager.ts`)
   - Core authentication logic
   - Session management
   - Failed attempt tracking and lockout
   - PIN hashing and verification

2. **SecureStorageReact** (`packages/vote-engine/src/secure-storage-react.ts`)
   - Hardware-backed secure storage
   - Biometric authentication integration
   - iOS Keychain and Android Keystore support

## Authentication Methods

### Biometric Authentication

Supports device biometrics including:
- **iOS**: Face ID, Touch ID
- **Android**: Fingerprint, Face unlock

**Features:**
- Hardware-backed security
- Platform-managed biometric data
- No biometric data stored in app
- Automatic fallback to device security

**Configuration:**
```typescript
const authManager = new AuthManager({
  method: AuthMethod.BIOMETRIC,
  biometricTimeout: 5 * 60 * 1000, // 5 minutes
});
```

### PIN Authentication

4-8 digit numeric PIN with secure hashing.

**Features:**
- SHA-256 hashed PINs (never stored in plaintext)
- Failed attempt tracking
- Automatic lockout after max attempts
- Configurable timeout and lockout duration

**Configuration:**
```typescript
const authManager = new AuthManager({
  method: AuthMethod.PIN,
  maxAttempts: 5,
  lockoutDuration: 5 * 60 * 1000, // 5 minutes
  pinTimeout: 15 * 60 * 1000, // 15 minutes
});

// Setup PIN
await authManager.setupPin('1234');
```

### Hybrid Authentication

Supports biometric with PIN fallback.

**Configuration:**
```typescript
const authManager = new AuthManager({
  method: AuthMethod.BIOMETRIC_OR_PIN,
  biometricTimeout: 5 * 60 * 1000,
  pinTimeout: 15 * 60 * 1000,
});
```

## Usage Examples

### Basic Setup and Authentication

```typescript
import { AuthManager, AuthMethod } from '@votetorrent/vote-engine';

// Create auth manager
const authManager = new AuthManager({
  method: AuthMethod.PIN,
  maxAttempts: 5,
  lockoutDuration: 5 * 60 * 1000,
});

// Setup PIN
await authManager.setupPin('1234');

// Authenticate
const result = await authManager.authenticate('1234');
if (result.success) {
  console.log('Authentication successful');
} else {
  console.error('Authentication failed:', result.error);
  console.log('Remaining attempts:', result.remainingAttempts);
}
```

### Checking Biometric Availability

```typescript
const available = await authManager.isBiometricAvailable();
if (available) {
  const biometryType = await authManager.getBiometryType();
  console.log('Biometric type:', biometryType); // "FaceID", "TouchID", etc.
}
```

### Session Management

```typescript
// Check if re-authentication required
const needsReauth = await authManager.requiresReauth();
if (needsReauth) {
  await authManager.authenticate(pin);
}
```

### Changing PIN

```typescript
const result = await authManager.changePin(oldPin, newPin);
if (result.success) {
  console.log('PIN changed successfully');
} else {
  console.error('PIN change failed:', result.error);
}
```

### Reset Authentication

```typescript
// Clear all authentication data
await authManager.reset();
```

## Security Features

### PIN Security

1. **Hashing**: PINs are hashed using SHA-256 before storage
2. **No Plaintext**: PINs never stored in plaintext
3. **Secure Storage**: Hashes stored in hardware-backed keychain
4. **Salt**: Each installation has unique storage namespace

### Failed Attempt Protection

1. **Attempt Tracking**: Counts failed authentication attempts
2. **Progressive Lockout**: Account locks after max attempts
3. **Time-based Unlock**: Automatic unlock after lockout duration
4. **Reset on Success**: Failed attempts reset on successful auth

### Session Management

1. **Timeout-based**: Sessions expire after inactivity
2. **Configurable**: Different timeouts for biometric vs PIN
3. **Automatic**: System tracks last authentication time
4. **Transparent**: Apps query `requiresReauth()` to check

### Storage Security

1. **Hardware-backed**: iOS Keychain, Android Keystore
2. **Encryption**: Automatic encryption at rest
3. **Secure Enclave**: Uses hardware security when available
4. **Biometric Protection**: Can require biometric for access

## Error Handling

### Authentication Results

```typescript
interface AuthResult {
  success: boolean;           // Whether authentication succeeded
  method?: AuthMethod;        // Method used (if successful)
  error?: string;            // Error message (if failed)
  remainingAttempts?: number; // Remaining attempts before lockout
  lockedUntil?: number;      // Lockout expiration timestamp
}
```

### Common Error Scenarios

1. **Incorrect PIN**
   ```typescript
   {
     success: false,
     error: "Incorrect PIN",
     remainingAttempts: 4
   }
   ```

2. **Account Locked**
   ```typescript
   {
     success: false,
     error: "Account locked. Try again in 5 minutes",
     lockedUntil: 1730000000000
   }
   ```

3. **Biometric Failed**
   ```typescript
   {
     success: false,
     error: "Biometric authentication failed"
   }
   ```

4. **Not Configured**
   ```typescript
   {
     success: false,
     error: "PIN not configured"
   }
   ```

## Configuration Options

### AuthConfig Interface

```typescript
interface AuthConfig {
  method: AuthMethod;              // Required: BIOMETRIC, PIN, or BIOMETRIC_OR_PIN
  maxAttempts?: number;            // Default: 5
  lockoutDuration?: number;        // Default: 5 minutes (ms)
  biometricTimeout?: number;       // Default: 5 minutes (ms)
  pinTimeout?: number;             // Default: 15 minutes (ms)
}
```

### Recommended Settings

**High Security (Sensitive Operations):**
```typescript
{
  method: AuthMethod.BIOMETRIC_OR_PIN,
  maxAttempts: 3,
  lockoutDuration: 10 * 60 * 1000, // 10 minutes
  biometricTimeout: 2 * 60 * 1000,  // 2 minutes
  pinTimeout: 5 * 60 * 1000,        // 5 minutes
}
```

**Standard Security (General Use):**
```typescript
{
  method: AuthMethod.BIOMETRIC_OR_PIN,
  maxAttempts: 5,
  lockoutDuration: 5 * 60 * 1000,  // 5 minutes
  biometricTimeout: 5 * 60 * 1000,  // 5 minutes
  pinTimeout: 15 * 60 * 1000,       // 15 minutes
}
```

**Convenience (Low Security):**
```typescript
{
  method: AuthMethod.PIN,
  maxAttempts: 10,
  lockoutDuration: 1 * 60 * 1000,   // 1 minute
  pinTimeout: 60 * 60 * 1000,       // 1 hour
}
```

## Integration with VoteTorrent Authority

### Application Startup

```typescript
// In AppProvider.tsx
import { AuthManager, AuthMethod } from '@votetorrent/vote-engine';

const authManager = new AuthManager({
  method: AuthMethod.BIOMETRIC_OR_PIN,
  maxAttempts: 5,
  lockoutDuration: 5 * 60 * 1000,
});

// Check if configured
const configured = await authManager.isConfigured();
if (!configured) {
  // Show PIN setup screen
  navigation.navigate('SetupPIN');
}
```

### Protecting Sensitive Operations

```typescript
// Before signing or accessing keys
async function performSensitiveOperation() {
  const needsReauth = await authManager.requiresReauth();
  if (needsReauth) {
    const result = await authManager.authenticate(userPin);
    if (!result.success) {
      Alert.alert('Authentication Required', result.error);
      return;
    }
  }

  // Proceed with sensitive operation
  await signDocument();
}
```

## Testing

Comprehensive test suite in `packages/vote-engine/test/auth-manager.spec.ts`:

- PIN setup and validation
- Authentication success/failure
- Failed attempt tracking
- Lockout and unlock
- PIN change
- Session timeout
- Biometric availability
- Edge cases and error handling

Run tests:
```bash
cd packages/vote-engine
yarn test
```

## Security Considerations

### Threat Model

**Protected Against:**
- ✅ Brute force attacks (lockout mechanism)
- ✅ Plaintext PIN exposure (SHA-256 hashing)
- ✅ Storage compromise (hardware-backed encryption)
- ✅ Session hijacking (timeout mechanism)
- ✅ Replay attacks (unique hashes per installation)

**Not Protected Against:**
- ⚠️ Shoulder surfing (user responsibility)
- ⚠️ Device compromise (if device rooted/jailbroken)
- ⚠️ Malware with keylogging (OS-level issue)
- ⚠️ Physical device access with user PIN (biometric adds layer)

### Best Practices

1. **Always use biometric when available**
   - Stronger security than PIN
   - Better user experience
   - Platform-managed security

2. **Enforce strong PINs**
   - Minimum 6 digits for sensitive apps
   - Avoid sequential (1234) or repeated (1111) patterns
   - Consider adding PIN strength validation

3. **Set appropriate timeouts**
   - Shorter for sensitive operations
   - Balance security vs user experience
   - Consider user context (enterprise vs personal)

4. **Monitor failed attempts**
   - Log authentication failures
   - Alert on repeated failures
   - Consider additional verification after lockouts

5. **Protect during development**
   - Don't disable auth in debug builds
   - Test lockout mechanisms thoroughly
   - Verify secure storage is used

## Future Enhancements

1. **Advanced PIN Validation**
   - Reject weak patterns (1234, 1111)
   - PIN strength scoring
   - Custom validation rules

2. **Multi-factor Authentication**
   - SMS/Email verification
   - Hardware security keys
   - TOTP support

3. **Adaptive Authentication**
   - Risk-based authentication
   - Device fingerprinting
   - Behavioral analysis

4. **Enterprise Features**
   - Remote wipe capability
   - Admin password reset
   - Compliance reporting

5. **Analytics**
   - Authentication metrics
   - Failure pattern detection
   - Security event logging
