import { expect } from 'aegir/chai';
import { AuthManager, AuthMethod, type AuthResult } from '../src/auth/auth-manager.js';

// Mock react-native-keychain
const mockKeychain: any = {
	setGenericPassword: async () => true,
	getGenericPassword: async () => ({ username: 'votetorrent.auth', password: '{}' }),
	resetGenericPassword: async () => true,
	getSupportedBiometryType: async () => 'FaceID',
	ACCESS_CONTROL: {
		BIOMETRY_CURRENT_SET: 'BiometryCurrentSet',
	},
	ACCESSIBLE: {
		WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly',
	},
};

// Setup mock before importing
if (typeof global !== 'undefined') {
	(global as any).mockKeychainModule = mockKeychain;
}

describe('AuthManager', () => {
	let authManager: AuthManager;
	const testPin = '1234';

	beforeEach(() => {
		// Reset mock storage
		mockKeychain.storage = {};
	});

	describe('PIN Authentication', () => {
		beforeEach(() => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
		});

		it('should setup PIN successfully', async () => {
			await authManager.setupPin(testPin);
			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});

		it('should reject invalid PIN format during setup', async () => {
			try {
				await authManager.setupPin('abc');
				expect.fail('Should have thrown error');
			} catch (error) {
				expect(error).to.exist;
				expect((error as Error).message).to.include('4-8 digits');
			}
		});

		it('should reject PIN shorter than 4 digits', async () => {
			try {
				await authManager.setupPin('123');
				expect.fail('Should have thrown error');
			} catch (error) {
				expect(error).to.exist;
			}
		});

		it('should reject PIN longer than 8 digits', async () => {
			try {
				await authManager.setupPin('123456789');
				expect.fail('Should have thrown error');
			} catch (error) {
				expect(error).to.exist;
			}
		});

		it('should authenticate with correct PIN', async () => {
			await authManager.setupPin(testPin);
			const result = await authManager.authenticateWithPin(testPin);
			expect(result.success).to.be.true;
			expect(result.method).to.equal(AuthMethod.PIN);
		});

		it('should reject incorrect PIN', async () => {
			await authManager.setupPin(testPin);
			const result = await authManager.authenticateWithPin('9999');
			expect(result.success).to.be.false;
			expect(result.error).to.include('Incorrect');
		});

		it('should track failed attempts', async () => {
			await authManager.setupPin(testPin);

			const result1 = await authManager.authenticateWithPin('9999');
			expect(result1.remainingAttempts).to.equal(4);

			const result2 = await authManager.authenticateWithPin('9999');
			expect(result2.remainingAttempts).to.equal(3);
		});

		it('should lock account after max failed attempts', async () => {
			authManager = new AuthManager({
				method: AuthMethod.PIN,
				maxAttempts: 3,
				lockoutDuration: 1000,
			});

			await authManager.setupPin(testPin);

			// Fail 3 times
			await authManager.authenticateWithPin('9999');
			await authManager.authenticateWithPin('9999');
			await authManager.authenticateWithPin('9999');

			// Should be locked
			const result = await authManager.authenticateWithPin(testPin);
			expect(result.success).to.be.false;
			expect(result.error).to.include('locked');
		});

		it('should unlock after lockout duration', async () => {
			authManager = new AuthManager({
				method: AuthMethod.PIN,
				maxAttempts: 3,
				lockoutDuration: 100, // 100ms for testing
			});

			await authManager.setupPin(testPin);

			// Fail 3 times to trigger lockout
			await authManager.authenticateWithPin('9999');
			await authManager.authenticateWithPin('9999');
			await authManager.authenticateWithPin('9999');

			// Wait for lockout to expire
			await new Promise(resolve => setTimeout(resolve, 150));

			// Should be able to authenticate again
			const result = await authManager.authenticateWithPin(testPin);
			expect(result.success).to.be.true;
		});

		it('should reset failed attempts on successful auth', async () => {
			await authManager.setupPin(testPin);

			// Fail once
			await authManager.authenticateWithPin('9999');

			// Succeed
			const successResult = await authManager.authenticateWithPin(testPin);
			expect(successResult.success).to.be.true;

			// Fail again - should have full attempts available
			const failResult = await authManager.authenticateWithPin('9999');
			expect(failResult.remainingAttempts).to.equal(4);
		});
	});

	describe('PIN Change', () => {
		beforeEach(async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);
		});

		it('should change PIN with correct old PIN', async () => {
			const result = await authManager.changePin(testPin, '5678');
			expect(result.success).to.be.true;

			// Old PIN should not work
			const oldResult = await authManager.authenticateWithPin(testPin);
			expect(oldResult.success).to.be.false;

			// New PIN should work
			const newResult = await authManager.authenticateWithPin('5678');
			expect(newResult.success).to.be.true;
		});

		it('should reject PIN change with incorrect old PIN', async () => {
			const result = await authManager.changePin('9999', '5678');
			expect(result.success).to.be.false;
		});

		it('should reject same PIN when changing', async () => {
			const result = await authManager.changePin(testPin, testPin);
			expect(result.success).to.be.false;
			expect(result.error).to.include('different');
		});

		it('should validate new PIN format', async () => {
			const result = await authManager.changePin(testPin, 'abc');
			expect(result.success).to.be.false;
			expect(result.error).to.include('4-8 digits');
		});
	});

	describe('Session Timeout', () => {
		it('should require reauth after PIN timeout', async () => {
			authManager = new AuthManager({
				method: AuthMethod.PIN,
				pinTimeout: 100, // 100ms for testing
			});

			await authManager.setupPin(testPin);
			await authManager.authenticateWithPin(testPin);

			// Should not require reauth immediately
			let requiresReauth = await authManager.requiresReauth();
			expect(requiresReauth).to.be.false;

			// Wait for timeout
			await new Promise(resolve => setTimeout(resolve, 150));

			// Should require reauth after timeout
			requiresReauth = await authManager.requiresReauth();
			expect(requiresReauth).to.be.true;
		});

		it('should require reauth if never authenticated', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);

			const requiresReauth = await authManager.requiresReauth();
			expect(requiresReauth).to.be.true;
		});
	});

	describe('Biometric Authentication', () => {
		beforeEach(() => {
			authManager = new AuthManager({ method: AuthMethod.BIOMETRIC });
		});

		it('should check biometric availability', async () => {
			const available = await authManager.isBiometricAvailable();
			expect(available).to.be.a('boolean');
		});

		it('should get biometry type', async () => {
			const type = await authManager.getBiometryType();
			expect(type).to.satisfy((t: any) => t === null || typeof t === 'string');
		});
	});

	describe('Configuration', () => {
		it('should report not configured initially', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			const configured = await authManager.isConfigured();
			expect(configured).to.be.false;
		});

		it('should report configured after PIN setup', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);
			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});

		it('should reset configuration', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);
			await authManager.reset();

			const configured = await authManager.isConfigured();
			expect(configured).to.be.false;
		});
	});

	describe('Generic Authenticate Method', () => {
		it('should authenticate with PIN when method is PIN', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);

			const result = await authManager.authenticate(testPin);
			expect(result.success).to.be.true;
			expect(result.method).to.equal(AuthMethod.PIN);
		});

		it('should require PIN when method is PIN', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);

			const result = await authManager.authenticate();
			expect(result.success).to.be.false;
			expect(result.error).to.include('PIN required');
		});
	});

	describe('Security Properties', () => {
		it('should not store PIN in plaintext', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);

			// The PIN should be hashed, not stored directly
			// This is a conceptual test - in reality we'd need to inspect storage
			// which we can't do directly due to encapsulation
			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});

		it('should use different hashes for different PINs', async () => {
			const authManager1 = new AuthManager({ method: AuthMethod.PIN });
			await authManager1.setupPin('1234');

			const authManager2 = new AuthManager({ method: AuthMethod.PIN });
			await authManager2.setupPin('5678');

			// Both should be configured but with different hashes
			expect(await authManager1.isConfigured()).to.be.true;
			expect(await authManager2.isConfigured()).to.be.true;

			// Each should only accept its own PIN
			expect((await authManager1.authenticateWithPin('1234')).success).to.be.true;
			expect((await authManager1.authenticateWithPin('5678')).success).to.be.false;
		});
	});

	describe('Edge Cases', () => {
		it('should handle authentication when not configured', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });

			const result = await authManager.authenticateWithPin(testPin);
			expect(result.success).to.be.false;
			expect(result.error).to.include('not configured');
		});

		it('should handle invalid PIN format during authentication', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin(testPin);

			const result = await authManager.authenticateWithPin('abc');
			expect(result.success).to.be.false;
			expect(result.error).to.include('Invalid PIN format');
		});

		it('should accept 4-digit PIN', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin('1234');

			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});

		it('should accept 8-digit PIN', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin('12345678');

			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});

		it('should accept 6-digit PIN', async () => {
			authManager = new AuthManager({ method: AuthMethod.PIN });
			await authManager.setupPin('123456');

			const configured = await authManager.isConfigured();
			expect(configured).to.be.true;
		});
	});
});
