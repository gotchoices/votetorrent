import { SecureStorageReact } from '../secure-storage-react.js';
import { createLogger } from '../common/logger.js';
import * as Keychain from 'react-native-keychain';
import { hashMessage } from '../common/crypto-utils.js';

const log = createLogger('AuthManager');

/**
 * Authentication method types
 */
export enum AuthMethod {
	BIOMETRIC = 'biometric',
	PIN = 'pin',
	BIOMETRIC_OR_PIN = 'biometric_or_pin',
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
	method: AuthMethod;
	/** Number of failed attempts before lockout */
	maxAttempts?: number;
	/** Lockout duration in milliseconds */
	lockoutDuration?: number;
	/** Require biometric re-authentication after this duration (ms) */
	biometricTimeout?: number;
	/** Require PIN re-authentication after this duration (ms) */
	pinTimeout?: number;
}

/**
 * Authentication result
 */
export interface AuthResult {
	success: boolean;
	method?: AuthMethod;
	error?: string;
	remainingAttempts?: number;
	lockedUntil?: number;
}

/**
 * Authentication state stored securely
 */
interface AuthState {
	pinHash?: string;
	failedAttempts: number;
	lockedUntil?: number;
	lastBiometricAuth?: number;
	lastPinAuth?: number;
}

/**
 * AuthManager provides secure authentication using biometrics and/or PIN
 *
 * Features:
 * - Biometric authentication (FaceID, TouchID, Fingerprint)
 * - PIN authentication with secure hashing
 * - Failed attempt tracking and lockout
 * - Configurable authentication timeout
 * - Secure storage of authentication state
 *
 * Security considerations:
 * - PINs are hashed using SHA-256, never stored in plaintext
 * - Authentication state stored in hardware-backed secure storage
 * - Biometric authentication uses platform security (Keychain/Keystore)
 * - Automatic lockout after max failed attempts
 * - Session timeout requires re-authentication
 */
export class AuthManager {
	private storage: SecureStorageReact;
	private config: Required<AuthConfig>;
	private static readonly STORAGE_KEY = 'auth_state';
	private static readonly DEFAULT_MAX_ATTEMPTS = 5;
	private static readonly DEFAULT_LOCKOUT_DURATION = 5 * 60 * 1000; // 5 minutes
	private static readonly DEFAULT_BIOMETRIC_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private static readonly DEFAULT_PIN_TIMEOUT = 15 * 60 * 1000; // 15 minutes

	constructor(config: AuthConfig) {
		this.storage = new SecureStorageReact('votetorrent.auth');
		this.config = {
			method: config.method,
			maxAttempts: config.maxAttempts ?? AuthManager.DEFAULT_MAX_ATTEMPTS,
			lockoutDuration: config.lockoutDuration ?? AuthManager.DEFAULT_LOCKOUT_DURATION,
			biometricTimeout: config.biometricTimeout ?? AuthManager.DEFAULT_BIOMETRIC_TIMEOUT,
			pinTimeout: config.pinTimeout ?? AuthManager.DEFAULT_PIN_TIMEOUT,
		};
	}

	/**
	 * Initialize authentication with a PIN
	 * @param pin - 4-8 digit PIN
	 */
	async setupPin(pin: string): Promise<void> {
		// Validate PIN format
		if (!/^\d{4,8}$/.test(pin)) {
			throw new Error('PIN must be 4-8 digits');
		}

		const pinHash = hashMessage(pin);
		const state: AuthState = {
			pinHash,
			failedAttempts: 0,
		};

		await this.storage.setItem(AuthManager.STORAGE_KEY, state);
		log.info('PIN authentication configured');
	}

	/**
	 * Check if biometric authentication is available
	 */
	async isBiometricAvailable(): Promise<boolean> {
		try {
			const biometryType = await this.storage.getBiometryType();
			return biometryType !== null;
		} catch (error) {
			log.warn('Failed to check biometric availability', {}, { error: error instanceof Error ? error.message : String(error) });
			return false;
		}
	}

	/**
	 * Get the type of biometric authentication available
	 */
	async getBiometryType(): Promise<Keychain.BIOMETRY_TYPE | null> {
		return await this.storage.getBiometryType();
	}

	/**
	 * Authenticate using biometrics
	 */
	async authenticateWithBiometric(): Promise<AuthResult> {
		// Check if biometric is available
		const available = await this.isBiometricAvailable();
		if (!available) {
			return {
				success: false,
				error: 'Biometric authentication not available',
			};
		}

		// Check lockout
		const lockoutResult = await this.checkLockout();
		if (!lockoutResult.success) {
			return lockoutResult;
		}

		try {
			// Attempt biometric authentication by accessing secure storage
			const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);

			if (!state) {
				return {
					success: false,
					error: 'Authentication not configured',
				};
			}

			// Update last biometric auth time
			state.lastBiometricAuth = Date.now();
			state.failedAttempts = 0;
			await this.storage.setItem(AuthManager.STORAGE_KEY, state);

			log.info('Biometric authentication successful');
			return {
				success: true,
				method: AuthMethod.BIOMETRIC,
			};
		} catch (error) {
			await this.recordFailedAttempt();
			log.warn('Biometric authentication failed', {}, { error: error instanceof Error ? error.message : String(error) });

			return {
				success: false,
				method: AuthMethod.BIOMETRIC,
				error: 'Biometric authentication failed',
			};
		}
	}

	/**
	 * Authenticate using PIN
	 */
	async authenticateWithPin(pin: string): Promise<AuthResult> {
		// Validate PIN format
		if (!/^\d{4,8}$/.test(pin)) {
			return {
				success: false,
				error: 'Invalid PIN format',
			};
		}

		// Check lockout
		const lockoutResult = await this.checkLockout();
		if (!lockoutResult.success) {
			return lockoutResult;
		}

		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);
		if (!state || !state.pinHash) {
			return {
				success: false,
				error: 'PIN not configured',
			};
		}

		// Hash and compare PIN
		const pinHash = hashMessage(pin);
		if (pinHash !== state.pinHash) {
			await this.recordFailedAttempt();
			const currentState = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);

			log.warn('PIN authentication failed', {
				remainingAttempts: this.config.maxAttempts - (currentState?.failedAttempts ?? 0)
			});

			return {
				success: false,
				method: AuthMethod.PIN,
				error: 'Incorrect PIN',
				remainingAttempts: this.config.maxAttempts - (currentState?.failedAttempts ?? 0),
			};
		}

		// Success - reset failed attempts and update last auth time
		state.failedAttempts = 0;
		state.lastPinAuth = Date.now();
		state.lockedUntil = undefined;
		await this.storage.setItem(AuthManager.STORAGE_KEY, state);

		log.info('PIN authentication successful');
		return {
			success: true,
			method: AuthMethod.PIN,
		};
	}

	/**
	 * Authenticate using configured method
	 */
	async authenticate(pin?: string): Promise<AuthResult> {
		switch (this.config.method) {
			case AuthMethod.BIOMETRIC:
				return await this.authenticateWithBiometric();

			case AuthMethod.PIN:
				if (!pin) {
					return {
						success: false,
						error: 'PIN required',
					};
				}
				return await this.authenticateWithPin(pin);

			case AuthMethod.BIOMETRIC_OR_PIN:
				// Try biometric first
				const biometricResult = await this.authenticateWithBiometric();
				if (biometricResult.success) {
					return biometricResult;
				}

				// Fall back to PIN if provided
				if (pin) {
					return await this.authenticateWithPin(pin);
				}

				return {
					success: false,
					error: 'Biometric or PIN required',
				};

			default:
				return {
					success: false,
					error: 'Invalid authentication method',
				};
		}
	}

	/**
	 * Check if re-authentication is required based on timeout
	 */
	async requiresReauth(): Promise<boolean> {
		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);
		if (!state) {
			return true;
		}

		const now = Date.now();

		switch (this.config.method) {
			case AuthMethod.BIOMETRIC:
				if (!state.lastBiometricAuth) {
					return true;
				}
				return (now - state.lastBiometricAuth) > this.config.biometricTimeout;

			case AuthMethod.PIN:
				if (!state.lastPinAuth) {
					return true;
				}
				return (now - state.lastPinAuth) > this.config.pinTimeout;

			case AuthMethod.BIOMETRIC_OR_PIN:
				// Either method is valid
				const lastAuth = Math.max(
					state.lastBiometricAuth ?? 0,
					state.lastPinAuth ?? 0
				);
				if (lastAuth === 0) {
					return true;
				}
				const timeout = Math.min(this.config.biometricTimeout, this.config.pinTimeout);
				return (now - lastAuth) > timeout;

			default:
				return true;
		}
	}

	/**
	 * Change PIN
	 */
	async changePin(oldPin: string, newPin: string): Promise<AuthResult> {
		// Verify old PIN
		const authResult = await this.authenticateWithPin(oldPin);
		if (!authResult.success) {
			return authResult;
		}

		// Validate new PIN format
		if (!/^\d{4,8}$/.test(newPin)) {
			return {
				success: false,
				error: 'New PIN must be 4-8 digits',
			};
		}

		// Don't allow same PIN
		const oldHash = hashMessage(oldPin);
		const newHash = hashMessage(newPin);
		if (oldHash === newHash) {
			return {
				success: false,
				error: 'New PIN must be different from old PIN',
			};
		}

		// Update PIN
		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);
		if (!state) {
			return {
				success: false,
				error: 'Authentication state not found',
			};
		}

		state.pinHash = newHash;
		state.failedAttempts = 0;
		await this.storage.setItem(AuthManager.STORAGE_KEY, state);

		log.info('PIN changed successfully');
		return {
			success: true,
			method: AuthMethod.PIN,
		};
	}

	/**
	 * Reset authentication (clear all data)
	 */
	async reset(): Promise<void> {
		await this.storage.removeItem(AuthManager.STORAGE_KEY);
		log.info('Authentication reset');
	}

	/**
	 * Check if authentication is configured
	 */
	async isConfigured(): Promise<boolean> {
		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);
		return state !== undefined && (state.pinHash !== undefined || this.config.method === AuthMethod.BIOMETRIC);
	}

	/**
	 * Check lockout status
	 */
	private async checkLockout(): Promise<AuthResult> {
		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY);
		if (!state) {
			return { success: true };
		}

		if (state.lockedUntil && Date.now() < state.lockedUntil) {
			const remainingMs = state.lockedUntil - Date.now();
			const remainingMinutes = Math.ceil(remainingMs / 60000);

			log.warn('Authentication locked', { remainingMinutes });
			return {
				success: false,
				error: `Account locked. Try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`,
				lockedUntil: state.lockedUntil,
			};
		}

		return { success: true };
	}

	/**
	 * Record a failed authentication attempt
	 */
	private async recordFailedAttempt(): Promise<void> {
		const state = await this.storage.getItem<AuthState>(AuthManager.STORAGE_KEY) ?? {
			failedAttempts: 0,
		};

		state.failedAttempts += 1;

		// Lock account if max attempts reached
		if (state.failedAttempts >= this.config.maxAttempts) {
			state.lockedUntil = Date.now() + this.config.lockoutDuration;
			log.warn('Account locked due to too many failed attempts', {
				maxAttempts: this.config.maxAttempts,
				lockoutDuration: this.config.lockoutDuration,
			});
		}

		await this.storage.setItem(AuthManager.STORAGE_KEY, state);
	}
}
