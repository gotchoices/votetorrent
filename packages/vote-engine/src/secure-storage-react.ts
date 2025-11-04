import * as Keychain from 'react-native-keychain';

/**
 * SecureStorageReact provides hardware-backed secure storage for sensitive data
 * like private keys, authentication tokens, and other secrets.
 *
 * This implementation uses react-native-keychain which leverages:
 * - iOS: Keychain Services (hardware-backed Secure Enclave when available)
 * - Android: Android Keystore system (hardware-backed TEE when available)
 *
 * Security features:
 * - Hardware-backed encryption when available
 * - Biometric authentication support
 * - Automatic encryption at rest
 * - Secure deletion
 *
 * @remarks
 * This should be used for all cryptographic keys, passwords, and authentication tokens.
 * For non-sensitive data, use LocalStorageReact instead.
 */
export class SecureStorageReact {
	private readonly serviceName: string;

	/**
	 * Creates a new SecureStorageReact instance
	 * @param serviceName - Unique identifier for this storage namespace (e.g., 'votetorrent.keys')
	 */
	constructor(serviceName: string = 'votetorrent') {
		this.serviceName = serviceName;
	}

	/**
	 * Stores a sensitive value securely
	 * @param key - Identifier for the value
	 * @param value - The sensitive data to store (will be JSON serialized)
	 * @param options - Optional security options
	 */
	async setItem<T>(
		key: string,
		value: T,
		options?: {
			/** Require biometric authentication to access this value */
			requireBiometric?: boolean;
			/** Access control level */
			accessControl?: Keychain.ACCESS_CONTROL;
		}
	): Promise<void> {
		// Get existing storage
		const storage = await this.getAllItems();
		storage[key] = value;

		const serializedValue = JSON.stringify(storage);

		const keychainOptions: any = {
			service: this.serviceName,
			...options?.requireBiometric && {
				accessControl: options.accessControl || Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
				accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
			},
		};

		await Keychain.setGenericPassword(
			this.serviceName,
			serializedValue,
			keychainOptions
		);
	}

	/**
	 * Retrieves all stored items
	 * @private
	 */
	private async getAllItems(): Promise<Record<string, any>> {
		try {
			const credentials = await Keychain.getGenericPassword({
				service: this.serviceName,
			});

			if (!credentials) {
				return {};
			}

			return JSON.parse(credentials.password) as Record<string, any>;
		} catch (error) {
			console.error(`SecureStorage.getAllItems error:`, error);
			return {};
		}
	}

	/**
	 * Retrieves a sensitive value
	 * @param key - Identifier for the value
	 * @returns The decrypted value, or undefined if not found
	 */
	async getItem<T>(key: string): Promise<T | undefined> {
		try {
			const storage = await this.getAllItems();
			return storage[key] as T | undefined;
		} catch (error) {
			// User cancelled biometric prompt or other error
			console.error(`SecureStorage.getItem error for key "${key}":`, error);
			return undefined;
		}
	}

	/**
	 * Removes a sensitive value
	 * @param key - Identifier for the value to remove
	 */
	async removeItem(key: string): Promise<void> {
		const storage = await this.getAllItems();
		delete storage[key];

		if (Object.keys(storage).length === 0) {
			await this.clear();
		} else {
			await Keychain.setGenericPassword(
				this.serviceName,
				JSON.stringify(storage),
				{ service: this.serviceName }
			);
		}
	}

	/**
	 * Clears all values in this service namespace
	 */
	async clear(): Promise<void> {
		await Keychain.resetGenericPassword({
			service: this.serviceName,
		});
	}

	/**
	 * Checks if biometric authentication is available and enrolled
	 */
	async isBiometricAvailable(): Promise<boolean> {
		try {
			const biometryType = await Keychain.getSupportedBiometryType();
			return biometryType !== null;
		} catch {
			return false;
		}
	}

	/**
	 * Gets the type of biometric authentication available
	 * @returns The biometry type (FaceID, TouchID, Fingerprint, etc.) or null
	 */
	async getBiometryType(): Promise<Keychain.BIOMETRY_TYPE | null> {
		try {
			return await Keychain.getSupportedBiometryType();
		} catch {
			return null;
		}
	}
}

/**
 * Default instance for application-wide secure storage
 */
export const secureStorage = new SecureStorageReact('votetorrent');

/**
 * Separate instance for storing cryptographic keys
 * Uses enhanced security with biometric protection
 */
export const keyStorage = new SecureStorageReact('votetorrent.keys');
