/**
 * key-vault.ts — Phase 62 Plan 21 (D-04). The Authority's `IKeyVault` adapter over 62-08's native
 * `wrapSecret`/`unwrapSecret` secret-wrap TurboModule pair.
 *
 * Three points:
 *  1. This is the 62-04 `IKeyVault` adapter (`doc/encryption-formats.md` section 4's normative
 *     contract) — only 62-08 native-wrapped ciphertext is ever written to `AsyncStorage`. No
 *     plaintext secret byte is ever stored at rest, logged, or otherwise persisted.
 *  2. The officer encryption-key wrap alias (`VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1`,
 *     `requireAuth: false`) is defined HERE, per 62-08's "one alias = one auth policy, forever"
 *     naming rule, and is used for every `requireUserAuth: false` secret this vault stores.
 *     Auth-required consumers (62-26's keyholder-share alias, 62-17's DKG round-secret alias)
 *     inject their OWN alias through the `authRequiredWrap` constructor option — this file is never
 *     edited to add a new auth-required alias.
 *  3. 62-08's native wrap on iOS is a Keychain AES key, NOT Secure Enclave-backed. Device behaviour
 *     (both platforms) is code-complete and unverified on real hardware (D-23).
 */

import { KeyVaultError, assertKeyVaultAlias } from '@votetorrent/vote-engine/rn';
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn';
import { createNativeSecretWrapper, WRAP_KEY_ALIAS_PATTERN } from '@votetorrent/attestation-native';
import type { SecretWrapper, WrappedSecret, SecretWrapOptions, SecretWrapPrompt } from '@votetorrent/attestation-native';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dismissKeyboardForSystemPrompt } from '../utils/dismissKeyboardForSystemPrompt';

/** Native alias for every `requireUserAuth: false` secret this vault stores (point 2 above). */
export const VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1 = 'VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1';

/** `AsyncStorage` key = this prefix + the vault alias. */
export const KEY_VAULT_STORAGE_PREFIX = 'vt.keyvault.v1.';

const MAX_SECRET_BYTES = 4096;

/** Minimal storage surface this file needs — satisfied by `AsyncStorage`'s default export and by a
 * test fake. */
export interface KeyVaultStorage {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
}

/** Configures the `requireUserAuth: true` wrap path. `keyAlias` must match
 * `WRAP_KEY_ALIAS_PATTERN`; `prompt()` is called fresh on every wrap/unwrap so a caller can
 * localize or vary the copy per call. */
export interface AuthRequiredWrapConfig {
	keyAlias: string;
	prompt: () => SecretWrapPrompt;
}

export interface AuthorityKeyVaultOptions {
	wrapper?: SecretWrapper;
	storage?: KeyVaultStorage;
	authRequiredWrap?: AuthRequiredWrapConfig;
}

/** Stored record shape, fixed member order. */
interface StoredRecord {
	v: 1;
	alias: string;
	requireUserAuth: boolean;
	wrapped: WrappedSecret;
}

const AUTH_DENIED_CODES = new Set([
	'CANCELED',
	'NO_BIOMETRICS_ENROLLED',
	'LOCKOUT',
	'LOCKOUT_PERMANENT',
	'BIOMETRIC_ERROR',
	'DEVICE_LOCKED',
]);

function buildAad(alias: string, requireUserAuth: boolean): Uint8Array {
	return utf8ToBytes(`votetorrent/authority-key-vault/v1|${alias}|${requireUserAuth ? '1' : '0'}`);
}

/** Structural mapping only — never `instanceof` (survives Metro module duplication). The message
 * carries only the alias and the native code, never bytes. Also used by `keyholder-seat-vault.ts`. */
export function mapWrapError(err: unknown, alias: string, phase: 'put' | 'get'): KeyVaultError {
	const code = (err as { code?: unknown } | undefined)?.code;
	if (typeof code === 'string') {
		if (AUTH_DENIED_CODES.has(code)) {
			return new KeyVaultError('auth-denied', `key-vault: native wrap denied for alias '${alias}' (${code})`);
		}
		if (code === 'INVALID_ARGUMENT' && phase === 'put') {
			return new KeyVaultError('invalid-secret', `key-vault: native wrap rejected the secret for alias '${alias}' (${code})`);
		}
	}
	return new KeyVaultError(
		'unavailable',
		`key-vault: native wrap operation failed for alias '${alias}' (${typeof code === 'string' ? code : 'unknown'})`,
	);
}

function isWrappedSecretShape(value: unknown): value is WrappedSecret {
	if (value === null || typeof value !== 'object') return false;
	const w = value as Partial<WrappedSecret>;
	return typeof w.keyAlias === 'string' && typeof w.ivBase64 === 'string' && typeof w.ciphertextBase64 === 'string';
}

function parseStoredRecord(raw: string, alias: string): StoredRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new KeyVaultError('unavailable', `key-vault: stored record for alias '${alias}' is not valid JSON`);
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		(parsed as Partial<StoredRecord>).v !== 1 ||
		(parsed as Partial<StoredRecord>).alias !== alias ||
		typeof (parsed as Partial<StoredRecord>).requireUserAuth !== 'boolean' ||
		!isWrappedSecretShape((parsed as Partial<StoredRecord>).wrapped)
	) {
		throw new KeyVaultError('unavailable', `key-vault: stored record for alias '${alias}' has an unrecognized shape`);
	}
	return parsed as StoredRecord;
}

/**
 * Builds the Authority's `IKeyVault` adapter. Defaults to the native wrapper
 * (`createNativeSecretWrapper()`) and `AsyncStorage`. If `authRequiredWrap.keyAlias` fails
 * `WRAP_KEY_ALIAS_PATTERN`, throws `KeyVaultError('invalid-alias', ...)` at construction time —
 * before any secret is ever touched.
 */
export function createAuthorityKeyVault(options?: AuthorityKeyVaultOptions): IKeyVault {
	const wrapper = options?.wrapper ?? createNativeSecretWrapper();
	const storage: KeyVaultStorage = options?.storage ?? AsyncStorage;
	const authRequiredWrap = options?.authRequiredWrap;

	if (authRequiredWrap !== undefined && !WRAP_KEY_ALIAS_PATTERN.test(authRequiredWrap.keyAlias)) {
		throw new KeyVaultError(
			'invalid-alias',
			`key-vault: authRequiredWrap.keyAlias does not match WRAP_KEY_ALIAS_PATTERN (${authRequiredWrap.keyAlias})`,
		);
	}

	function storageKey(alias: string): string {
		return KEY_VAULT_STORAGE_PREFIX + alias;
	}

	/** Returns the native wrap alias + options for this (vault alias, requireUserAuth) pair, or
	 * `undefined` when `requireUserAuth` is true but no `authRequiredWrap` was configured. */
	function wrapTargetFor(
		alias: string,
		requireUserAuth: boolean,
	): { keyAlias: string; options: SecretWrapOptions } | undefined {
		if (!requireUserAuth) {
			return {
				keyAlias: VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1,
				options: { requireAuth: false, aad: buildAad(alias, false) },
			};
		}
		if (authRequiredWrap === undefined) return undefined;
		return {
			keyAlias: authRequiredWrap.keyAlias,
			options: { requireAuth: true, aad: buildAad(alias, true), prompt: authRequiredWrap.prompt() },
		};
	}

	return {
		async putSecret(alias: string, secret: Uint8Array, policy: KeyVaultPolicy): Promise<void> {
			assertKeyVaultAlias(alias);
			if (!(secret instanceof Uint8Array) || secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
				throw new KeyVaultError('invalid-secret', `key-vault: secret must be 1..${MAX_SECRET_BYTES} bytes, got ${secret?.length ?? 'n/a'}`);
			}

			const key = storageKey(alias);
			const existing = await storage.getItem(key);
			if (existing !== null) {
				throw new KeyVaultError('alias-exists', `key-vault: alias '${alias}' already holds a secret`);
			}

			const requireUserAuth = policy.requireUserAuth === true;
			const target = wrapTargetFor(alias, requireUserAuth);
			if (target === undefined) {
				throw new KeyVaultError(
					'unavailable',
					`key-vault: putSecret for alias '${alias}' requires user auth but no authRequiredWrap was configured`,
				);
			}

			// An auth-required wrap raises a BiometricPrompt: close the IME first (an open keyboard
			// leaves the prompt undrawn on MIUI/Android 10 — see the helper's doc comment).
			if (target.options.requireAuth) await dismissKeyboardForSystemPrompt();

			const secretCopy = Uint8Array.from(secret);
			let wrapped: WrappedSecret;
			try {
				wrapped = await wrapper.wrapSecret(target.keyAlias, secretCopy, target.options);
			} catch (err) {
				throw mapWrapError(err, alias, 'put');
			} finally {
				secretCopy.fill(0);
			}

			const record: StoredRecord = { v: 1, alias, requireUserAuth, wrapped };
			const serialized = JSON.stringify(record);
			await storage.setItem(key, serialized);
			const readBack = await storage.getItem(key);
			if (readBack !== serialized) {
				// Read-back failed — remove whatever (if anything) landed, so no half-written or
				// silently-dropped record is left behind. Nothing valid was ever stored.
				await storage.removeItem(key);
				throw new KeyVaultError('unavailable', `key-vault: write for alias '${alias}' was not read back correctly`);
			}
		},

		async getSecret(alias: string): Promise<Uint8Array | null> {
			assertKeyVaultAlias(alias);
			const raw = await storage.getItem(storageKey(alias));
			if (raw === null) return null;

			// Strict parse — a corrupt or tampered record is NEVER deleted, only reported.
			const record = parseStoredRecord(raw, alias);

			const target = wrapTargetFor(alias, record.requireUserAuth);
			if (target === undefined) {
				throw new KeyVaultError(
					'unavailable',
					`key-vault: getSecret for alias '${alias}' requires user auth but no authRequiredWrap was configured`,
				);
			}

			if (target.options.requireAuth) await dismissKeyboardForSystemPrompt();

			let plaintext: Uint8Array;
			try {
				plaintext = await wrapper.unwrapSecret(record.wrapped, target.options);
			} catch (err) {
				throw mapWrapError(err, alias, 'get');
			}
			const out = Uint8Array.from(plaintext);
			plaintext.fill(0);
			return out;
		},

		async hasSecret(alias: string): Promise<boolean> {
			assertKeyVaultAlias(alias);
			return (await storage.getItem(storageKey(alias))) !== null;
		},

		async deleteSecret(alias: string): Promise<boolean> {
			assertKeyVaultAlias(alias);
			const key = storageKey(alias);
			const existing = await storage.getItem(key);
			if (existing === null) return false;
			await storage.removeItem(key);
			return true;
		},
	};
}

let defaultVault: IKeyVault | undefined;
let testOverride: IKeyVault | undefined;

/** Test override: `undefined` restores the lazy default (constructed once, on first use after the
 * override is cleared). */
export function setAuthorityKeyVaultForTests(vault: IKeyVault | undefined): void {
	testOverride = vault;
}

/** The test override if set, else a lazily-built singleton with the native wrapper and
 * `AsyncStorage`, and no auth-required wrap configured. */
export function resolveAuthorityKeyVault(): IKeyVault {
	if (testOverride !== undefined) return testOverride;
	if (defaultVault === undefined) {
		defaultVault = createAuthorityKeyVault();
	}
	return defaultVault;
}
