/**
 * keyholder-identity.ts — Phase 62 Plan 26 (D-21). Fresh keyholder identity provisioning, the
 * public identity store, and the per-signature signer.
 *
 * Four points:
 *  1. D-21: every keyholder accept provisions a FRESH identity — an app-minted `userId` (never the
 *     officer's device user id), a fresh secp256k1 signing key and a fresh DKG receiving key. Two
 *     provisions on the same device always mint two distinct identities.
 *  2. The signing key is a SOFTWARE secp256k1 key, wrapped at rest, not a hardware per-alias key.
 *     `AttestationNativeModule.swift`'s device-key provisioning and signing entry points ignore
 *     their `keyAlias` argument and always sign with the fixed `Self.voteKeyTag` — a hardware per-
 *     keyholder key would therefore silently reuse the OFFICER's device key on iOS, violating D-21.
 *     This is the same pattern 62-08 used for the Voter identity key and 62-02's
 *     `makeKeyholderProvisioning` test fixture. Open question for 62-30/the user.
 *  3. Prompt budget: provisioning performs 2 auth-required vault writes (signing key, receiving
 *     key) and 0 reads, inside ONE keyholder session (`withKeyholderSession`), so on the seat vault
 *     (`keyholder-seat-vault.ts`) they cost ONE prompt (the new seat key's wrap); on a plain
 *     per-alias vault they cost 2. `createKeyholderSigner` reads the signing key once per
 *     signature: one prompt per signature on its own, none extra inside a session that already
 *     unlocked the seat.
 *  4. The identity store (`KEYHOLDER_IDENTITY_STORAGE_KEY`) holds PUBLIC material only — userId,
 *     the invite slot Cid, both public keys, the signing key's type and creation time. No private
 *     key byte, in hex, base64 or base64url, is ever written to it.
 *
 * Error messages carry only a `code` and a `userId` — never key bytes, never logged.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	assertKeyVaultAlias,
	generateDkgReceivingKey,
	keyholderDkgReceivingKeyAlias,
	KEYHOLDER_DKG_RECEIVING_KEY_POLICY,
} from '@votetorrent/vote-engine/rn';
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn';
import type { KeyholderAcceptProvisioning, KeyholderDkgSigner, Signature, UserKey } from '@votetorrent/vote-core';
import { UserKeyType } from '@votetorrent/vote-core';
import type { KeyVaultStorage } from './key-vault';
import { withKeyholderSession } from './keyholder-session';

/** AsyncStorage key for the public-only identity store (point 4 above). */
export const KEYHOLDER_IDENTITY_STORAGE_KEY = 'vt.keyholder-identities.v1';

/** Every keyholder signing key is auth-required, forever. */
export const KEYHOLDER_SIGNING_KEY_POLICY: KeyVaultPolicy = { requireUserAuth: true };

/** `vt.keyholder-signing.<userId>` — validated against the shared `KEY_VAULT_ALIAS_PATTERN`. */
export function keyholderSigningKeyAlias(userId: string): string {
	const alias = `vt.keyholder-signing.${userId}`;
	assertKeyVaultAlias(alias);
	return alias;
}

/** 10 years, matching the Authority device-signing key convention. */
export const KEYHOLDER_SIGNING_KEY_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Public-only — never a private key byte. Fixed member order. */
export interface KeyholderIdentityRecord {
	v: 1;
	userId: string;
	inviteSlotCid: string;
	signingPublicKey: string;
	signingKeyType: 'M';
	dkgReceivingPublicKey: string;
	createdAt: string;
}

interface IdentityStoreShape {
	v: 1;
	identities: KeyholderIdentityRecord[];
}

export interface KeyholderIdentityDeps {
	vault: IKeyVault;
	storage?: KeyVaultStorage;
}

export interface ProvisionedKeyholderIdentity {
	userId: string;
	record: KeyholderIdentityRecord;
	provisioning: KeyholderAcceptProvisioning;
	/** Zeroes the in-memory signing key; after this, `provisioning.sign` rejects. */
	release(): void;
}

export type KeyholderIdentityErrorCode =
	| 'signing-key-missing'
	| 'signing-key-mismatch'
	| 'identity-not-found'
	| 'store-write-failed'
	| 'store-corrupt';

export class KeyholderIdentityError extends Error {
	readonly code: KeyholderIdentityErrorCode;

	constructor(code: KeyholderIdentityErrorCode, message: string) {
		super(message);
		this.name = 'KeyholderIdentityError';
		this.code = code;
	}
}

function resolveStorage(storage?: KeyVaultStorage): KeyVaultStorage {
	return storage ?? (AsyncStorage as unknown as KeyVaultStorage);
}

/** Structural code read only — a property check, never a prototype-chain check (this module, and
 * the vault module it pairs with, are grep-checked to contain neither). */
function codeOf(err: unknown): string | undefined {
	return typeof err === 'object' && err !== null ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

async function readStore(storage: KeyVaultStorage, userId: string): Promise<IdentityStoreShape> {
	const raw = await storage.getItem(KEYHOLDER_IDENTITY_STORAGE_KEY);
	if (raw === null) return { v: 1, identities: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new KeyholderIdentityError('store-corrupt', `keyholder-identity: store is not valid JSON (userId ${userId})`);
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		(parsed as Partial<IdentityStoreShape>).v !== 1 ||
		!Array.isArray((parsed as Partial<IdentityStoreShape>).identities)
	) {
		throw new KeyholderIdentityError('store-corrupt', `keyholder-identity: store has an unrecognized shape (userId ${userId})`);
	}
	return parsed as IdentityStoreShape;
}

/** Module-level promise-chain mutex, keyed per storage instance (the `tid-allocator.ts` idiom),
 * so two overlapping provisions against the SAME storage never interleave their read-modify-write,
 * while provisions against different storages (different test fakes, or different devices in a
 * two-device test) proceed independently. */
const storeMutex = new WeakMap<KeyVaultStorage, Promise<unknown>>();

async function withStoreMutex<T>(storage: KeyVaultStorage, fn: () => Promise<T>): Promise<T> {
	const prior = storeMutex.get(storage) ?? Promise.resolve();
	const tail = prior.then(fn, fn);
	// The tail stored for the NEXT caller must only ever resolve (never reject), so a failed
	// append does not poison every subsequent provision/discard against this storage.
	storeMutex.set(
		storage,
		tail.then(
			() => undefined,
			() => undefined
		)
	);
	return tail;
}

/**
 * Mints a fresh keyholder identity: an app-minted `userId`, a fresh secp256k1 signing key and a
 * fresh DKG receiving key, both stored ONLY in the auth-required vault (never plaintext at rest).
 */
export async function provisionKeyholderIdentity(
	deps: KeyholderIdentityDeps,
	inviteSlotCid: string
): Promise<ProvisionedKeyholderIdentity> {
	const { vault } = deps;
	const storage = resolveStorage(deps.storage);

	const userId = (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID();
	const signingAlias = keyholderSigningKeyAlias(userId);
	const receivingAlias = keyholderDkgReceivingKeyAlias(userId);

	const signingPriv = secp256k1.utils.randomSecretKey();
	const signingPublicKey = bytesToHex(secp256k1.getPublicKey(signingPriv, true));
	const receiving = generateDkgReceivingKey();

	// Everything from the first vault write onward zeroes BOTH private buffers on any throw (a
	// cancelled biometric prompt on the very first write included). Cleanup deletes are
	// allSettled so a rejecting delete never replaces the original error. On success the receiving
	// key is zeroed here and the signing key stays live until `release()` (sign() uses it).
	const record: KeyholderIdentityRecord = {
		v: 1,
		userId,
		inviteSlotCid,
		signingPublicKey,
		signingKeyType: 'M',
		dkgReceivingPublicKey: receiving.publicKey,
		createdAt: new Date().toISOString(),
	};
	const cleanup = async (aliases: string[]): Promise<void> => {
		await Promise.allSettled(aliases.map((alias) => vault.deleteSecret(alias)));
	};
	try {
		// One session for both writes: one prompt on the seat vault (point 3).
		await withKeyholderSession(vault, userId, async () => {
			await vault.putSecret(signingAlias, signingPriv, KEYHOLDER_SIGNING_KEY_POLICY);

			try {
				await vault.putSecret(receivingAlias, receiving.privateKey, KEYHOLDER_DKG_RECEIVING_KEY_POLICY);
			} catch (err) {
				await cleanup([signingAlias]);
				throw err;
			}
		});

		try {
			await withStoreMutex(storage, async () => {
				const current = await readStore(storage, userId);
				const updated: IdentityStoreShape = { v: 1, identities: [...current.identities, record] };
				const serialized = JSON.stringify(updated);
				await storage.setItem(KEYHOLDER_IDENTITY_STORAGE_KEY, serialized);
				const readBack = await storage.getItem(KEYHOLDER_IDENTITY_STORAGE_KEY);
				if (readBack !== serialized) {
					throw new KeyholderIdentityError('store-write-failed', `keyholder-identity: store write for userId ${userId} was not read back correctly`);
				}
			});
		} catch (err) {
			await cleanup([signingAlias, receivingAlias]);
			if (codeOf(err) === 'store-corrupt') {
				throw err;
			}
			throw new KeyholderIdentityError('store-write-failed', `keyholder-identity: store write for userId ${userId} failed`);
		}
	} catch (err) {
		signingPriv.fill(0);
		receiving.privateKey.fill(0);
		throw err;
	}
	receiving.privateKey.fill(0);

	let released = false;
	const provisioning: KeyholderAcceptProvisioning = {
		signingKey: {
			key: signingPublicKey,
			type: UserKeyType.mobile,
			expiration: Date.now() + KEYHOLDER_SIGNING_KEY_LIFETIME_MS,
		} as UserKey,
		dkgPublicKey: receiving.publicKey,
		sign: async (digest: Uint8Array): Promise<Signature> => {
			if (released) {
				throw new KeyholderIdentityError('signing-key-missing', `keyholder-identity: signing key for userId ${userId} was already released`);
			}
			const sig = secp256k1.sign(digest, signingPriv);
			return { signature: bytesToHex(sig), signerKey: signingPublicKey, signerUserId: userId };
		},
	};

	return {
		userId,
		record,
		provisioning,
		release(): void {
			released = true;
			signingPriv.fill(0);
		},
	};
}

/**
 * Idempotent: removes both vault aliases and the identity record. A second call resolves. If either
 * vault delete fails the record is KEPT (so wrapped secrets are never left without an index) and the
 * call rejects with `store-write-failed`; a later discard retries.
 */
export async function discardKeyholderIdentity(deps: KeyholderIdentityDeps, userId: string): Promise<void> {
	const { vault } = deps;
	const storage = resolveStorage(deps.storage);

	const results = await Promise.allSettled([
		vault.deleteSecret(keyholderSigningKeyAlias(userId)),
		vault.deleteSecret(keyholderDkgReceivingKeyAlias(userId)),
	]);
	if (results.some((r) => r.status === 'rejected')) {
		throw new KeyholderIdentityError('store-write-failed', `keyholder-identity: vault delete failed for userId ${userId}; identity record kept`);
	}

	await withStoreMutex(storage, async () => {
		let current: IdentityStoreShape;
		try {
			current = await readStore(storage, userId);
		} catch {
			// A corrupt store cannot be safely rewritten — leave it untouched; the aliases are
			// already gone, which is the load-bearing half of "discard".
			return;
		}
		const next = current.identities.filter((r) => r.userId !== userId);
		if (next.length === current.identities.length) return;
		await storage.setItem(KEYHOLDER_IDENTITY_STORAGE_KEY, JSON.stringify({ v: 1, identities: next }));
	});
}

export async function getKeyholderIdentity(userId: string, storage?: KeyVaultStorage): Promise<KeyholderIdentityRecord | undefined> {
	const store = await readStore(resolveStorage(storage), userId);
	return store.identities.find((r) => r.userId === userId);
}

export async function listKeyholderIdentities(storage?: KeyVaultStorage): Promise<KeyholderIdentityRecord[]> {
	const store = await readStore(resolveStorage(storage), 'list');
	return store.identities;
}

/**
 * Builds a `KeyholderDkgSigner` over an EXISTING identity record: unwraps the signing key (one
 * auth prompt), verifies the derived public key still matches the record before signing, signs,
 * then zeroes the unwrapped key — win or lose.
 */
export function createKeyholderSigner(deps: { vault: IKeyVault }, identity: KeyholderIdentityRecord): KeyholderDkgSigner {
	return {
		userId: identity.userId,
		signingPublicKey: identity.signingPublicKey,
		sign: async (digest: Uint8Array): Promise<Signature> => {
			const alias = keyholderSigningKeyAlias(identity.userId);
			const signingPriv = await deps.vault.getSecret(alias);
			if (signingPriv === null) {
				throw new KeyholderIdentityError('signing-key-missing', `keyholder-identity: no signing key for userId ${identity.userId}`);
			}
			try {
				const derivedPublicKey = bytesToHex(secp256k1.getPublicKey(signingPriv, true));
				if (derivedPublicKey !== identity.signingPublicKey) {
					throw new KeyholderIdentityError('signing-key-mismatch', `keyholder-identity: signing key for userId ${identity.userId} does not match its record`);
				}
				const sig = secp256k1.sign(digest, signingPriv);
				return { signature: bytesToHex(sig), signerKey: identity.signingPublicKey, signerUserId: identity.userId };
			} finally {
				signingPriv.fill(0);
			}
		},
	};
}
