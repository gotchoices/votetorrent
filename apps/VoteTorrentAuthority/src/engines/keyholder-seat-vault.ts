/**
 * keyholder-seat-vault.ts — one biometric prompt per keyholder ceremony step (prompt batching, Tier 1).
 *
 * Before this file every auth-required keyholder secret was its own native wrap, and the native wrap key is
 * per-use, so every read, every write and every signature was its own fingerprint / Face ID prompt: about 2 at
 * accept, 2-4 per DKG round (13-14 per key generation, measured 13 on the Redmi 8 on 2026-10-16) and 2 per release.
 *
 * Six points:
 *  1. A SEAT is one keyholder identity (one `userId`). Each seat has one random 32-byte seat key, protected ONCE
 *     by a per-use, biometric-only, enrolment-invalidated hardware key. Every secret of that seat (signing key,
 *     DKG receiving key, round secrets, final share) is AES-256-GCM-encrypted in software under the seat key,
 *     with the seat's userId and the vault alias in the AAD, so a record cannot be moved to another alias/seat.
 *  1b. How the seat key is protected. Preferred (seat key record v2): SEALED to the public half of a hardware key
 *     pair (`sealSecret`: Android RSA-2048 Keystore, iOS Secure Enclave P-256), alias
 *     `VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1`. Sealing uses only the public key, so CREATING a seat
 *     costs no prompt (accept: 0 prompts); unsealing costs one. The sealed plaintext is
 *     sha256(seat context incl. userId) || seat key, so a sealed blob cannot be moved to another seat. Fallback
 *     (record v1): when no sealer is configured, the binary predates `sealSecret` (NATIVE_UNAVAILABLE) or the
 *     device has no secure hardware for it (SEAL_UNAVAILABLE), the seat key is wrapped under the per-use AES
 *     wrap key `VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1` instead (accept: 1 prompt). Both record
 *     versions stay readable forever.
 *  2. A SESSION (`withKeyholderSession(userId, fn)`) spans one user action: one accept, one DKG drive, one
 *     release. The seat key is unwrapped LAZILY on the first seat read/write inside the session (one prompt),
 *     held for the session and zeroed when the last nested session ends. A session that touches no seat secret
 *     prompts zero times, so every existing "nothing due prompts zero" gate still holds.
 *  3. Outside a session every seat operation opens and closes its own session, i.e. one prompt per operation,
 *     exactly the old behaviour. Batching only happens where a caller asks for it.
 *  4. `hasSecret` and `deleteSecret` never prompt (the `IKeyVault` contract), because seat records are separate
 *     storage entries: a delete really removes the ciphertext, nothing is tombstoned.
 *  5. Legacy seats keep the legacy path. An identity whose signing or receiving key already sits in the inner
 *     vault (accepted before this file existed, e.g. an election mid-DKG) never gets a seat key; its secrets keep
 *     going through the inner per-alias vault, one prompt each, so nothing already stored is re-encrypted or lost.
 *  6. Trade-off (user decision 2026-11-03, "perform Tier 1"): one biometric now authorizes every secret of ONE
 *     seat for the length of ONE engine call, instead of one secret for one operation. The seat key lives in JS
 *     memory for that call only. Re-enrolling a biometric still destroys the native wrap key and so every seat
 *     key, as before. Non-keyholder secrets (`requireUserAuth: false`) never enter this file's path.
 *
 * Error messages carry an alias and a native code only, never key bytes.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { KeyVaultError, assertKeyVaultAlias } from '@votetorrent/vote-engine/rn';
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SealedSecret, SecretSealer, SecretWrapper, SecretWrapPrompt, WrappedSecret } from '@votetorrent/attestation-native';
import { mapWrapError } from './key-vault';
import type { KeyVaultStorage } from './key-vault';
import { dismissKeyboardForSystemPrompt } from '../utils/dismissKeyboardForSystemPrompt';
import type { KeyholderSessionVault } from './keyholder-session';

/** Storage key of a seat's wrapped seat key = this prefix + userId. */
export const KEYHOLDER_SEAT_KEY_STORAGE_PREFIX = 'vt.keyholder-seat-key.v1.';
/** Storage key of one seat secret = this prefix + vault alias. */
export const KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX = 'vt.keyholder-seat-secret.v1.';

/** The auth-required keyholder alias families. Every one ends in `.<userId>` (see `vote-engine`'s
 * `crypto/vault.ts`, `keyholder/dkg-vault.ts` and `keyholder-identity.ts`). */
const SEAT_ALIAS_PREFIXES = ['vt.keyholder-signing.', 'vt.keyholder-dkg-recv.', 'vt.keyholder-share.', 'vt.keyholder-dkg-round.'] as const;

const SEAT_KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_SECRET_BYTES = 4096;

/** The seat (userId) an auth-required keyholder alias belongs to, or undefined for any other alias. */
export function seatUserIdOfAlias(alias: string): string | undefined {
	if (!SEAT_ALIAS_PREFIXES.some((p) => alias.startsWith(p))) return undefined;
	const userId = alias.slice(alias.lastIndexOf('.') + 1);
	return userId.length > 0 ? userId : undefined;
}

// The session seam lives in the leaf module `./keyholder-session` (Node-loadable, see its header); re-exported
// here so existing imports of it from this file keep working.
export { withKeyholderSession } from './keyholder-session';
export type { KeyholderSessionVault } from './keyholder-session';

/** Native alias of the hardware key pair new seat keys are sealed to (point 1b). */
export const VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1 = 'VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1';

export interface KeyholderSeatVaultOptions {
	/** The per-alias vault: every non-seat secret, and every legacy seat (point 5). */
	inner: IKeyVault;
	wrapper: SecretWrapper;
	storage: KeyVaultStorage;
	/** The auth-required native wrap alias of the v1 fallback (point 1b). */
	wrapKeyAlias: string;
	prompt: () => SecretWrapPrompt;
	/** Point 1b's preferred path. Absent: every new seat key takes the v1 wrap. */
	sealer?: SecretSealer;
	sealKeyAlias?: string;
}

type SeatKeyRecord = { v: 1; userId: string; wrapped: WrappedSecret } | { v: 2; userId: string; sealed: SealedSecret };

/** Codes on which a seal falls back to the v1 wrap: the capability is absent or the native seal failed, and
 * nothing was stored. Both paths are hardware-protected, so falling back only costs the accept one prompt.
 * INVALID_ARGUMENT and SEAL_KEY_POLICY_MISMATCH are bugs or a misconfigured alias and still reject. */
const SEAL_FALLBACK_CODES: ReadonlySet<string> = new Set(['NATIVE_UNAVAILABLE', 'SEAL_UNAVAILABLE', 'SEAL_FAILED']);

function seatSealContext(userId: string): Uint8Array {
	return sha256(utf8ToBytes(`votetorrent/authority-keyholder-seat-key/v2|${userId}`));
}

function codeOf(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | undefined)?.code;
	return typeof code === 'string' ? code : undefined;
}

interface SeatSecretRecord {
	v: 1;
	alias: string;
	userId: string;
	ivHex: string;
	ciphertextHex: string;
}

interface Session {
	refs: number;
	key: Uint8Array | null;
	pending: Promise<Uint8Array> | null;
}

function seatKeyAad(userId: string): Uint8Array {
	return utf8ToBytes(`votetorrent/authority-keyholder-seat-key/v1|${userId}`);
}

function seatSecretAad(userId: string, alias: string): Uint8Array {
	return utf8ToBytes(`votetorrent/authority-keyholder-seat-secret/v1|${userId}|${alias}`);
}

function parseJson(raw: string, what: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		throw new KeyVaultError('unavailable', `keyholder-seat-vault: ${what} is not valid JSON`);
	}
}

function parseSeatKeyRecord(raw: string, userId: string): SeatKeyRecord {
	const p = parseJson(raw, `seat key record for seat '${userId}'`) as { v?: unknown; userId?: unknown; wrapped?: Partial<WrappedSecret>; sealed?: Partial<SealedSecret> } | null;
	const bad = () => new KeyVaultError('unavailable', `keyholder-seat-vault: seat key record for seat '${userId}' has an unrecognized shape`);
	if (p === null || typeof p !== 'object' || p.userId !== userId) throw bad();
	if (p.v === 1) {
		const w = p.wrapped;
		if (typeof w?.keyAlias !== 'string' || typeof w.ivBase64 !== 'string' || typeof w.ciphertextBase64 !== 'string') throw bad();
		return p as SeatKeyRecord;
	}
	if (p.v === 2) {
		const z = p.sealed;
		if (z?.v !== 1 || typeof z.keyAlias !== 'string' || typeof z.alg !== 'string' || typeof z.ciphertextBase64 !== 'string') throw bad();
		return p as SeatKeyRecord;
	}
	throw bad();
}

function parseSeatSecretRecord(raw: string, alias: string): SeatSecretRecord {
	const p = parseJson(raw, `seat record for alias '${alias}'`) as Partial<SeatSecretRecord> | null;
	if (
		p === null ||
		typeof p !== 'object' ||
		p.v !== 1 ||
		p.alias !== alias ||
		p.userId === undefined ||
		p.userId !== seatUserIdOfAlias(alias) ||
		typeof p.ivHex !== 'string' ||
		typeof p.ciphertextHex !== 'string'
	) {
		throw new KeyVaultError('unavailable', `keyholder-seat-vault: seat record for alias '${alias}' has an unrecognized shape`);
	}
	return p as SeatSecretRecord;
}

/**
 * Wraps `options.inner` (the per-alias Authority vault) so every NEW keyholder seat stores its secrets under
 * one seat key, unlocked at most once per session.
 */
export function createKeyholderSeatVault(options: KeyholderSeatVaultOptions): KeyholderSessionVault {
	const { inner, wrapper, storage, wrapKeyAlias, prompt, sealer } = options;
	const sealKeyAlias = options.sealKeyAlias ?? VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1;
	const sessions = new Map<string, Session>();

	const seatKeyStorageKey = (userId: string) => KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + userId;
	const seatSecretStorageKey = (alias: string) => KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX + alias;

	async function setAndReadBack(key: string, serialized: string, what: string): Promise<void> {
		await storage.setItem(key, serialized);
		if ((await storage.getItem(key)) !== serialized) {
			await storage.removeItem(key);
			throw new KeyVaultError('unavailable', `keyholder-seat-vault: write of ${what} was not read back correctly`);
		}
	}

	async function inSession<T>(userId: string, fn: (s: Session) => Promise<T>): Promise<T> {
		let s = sessions.get(userId);
		if (s === undefined) {
			s = { refs: 0, key: null, pending: null };
			sessions.set(userId, s);
		}
		s.refs++;
		try {
			return await fn(s);
		} finally {
			s.refs--;
			if (s.refs === 0) {
				s.key?.fill(0);
				s.key = null;
				if (sessions.get(userId) === s) sessions.delete(userId);
			}
		}
	}

	/** Point 1b preferred path: zero prompts. Returns null when the capability is absent (fall back). */
	async function sealSeatKey(userId: string, alias: string, key: Uint8Array): Promise<SeatKeyRecord | null> {
		if (sealer === undefined) return null;
		const payload = new Uint8Array(64);
		payload.set(seatSealContext(userId), 0);
		payload.set(key, 32);
		try {
			const sealed = await sealer.sealSecret(sealKeyAlias, payload);
			return { v: 2, userId, sealed };
		} catch (err) {
			if (SEAL_FALLBACK_CODES.has(codeOf(err) ?? '')) return null;
			throw mapWrapError(err, alias, 'put');
		} finally {
			payload.fill(0);
		}
	}

	/** A fresh seat key: sealed (no prompt) when possible, else wrapped (exactly one prompt). */
	async function createSeatKey(userId: string, alias: string): Promise<Uint8Array> {
		const key = randomBytes(SEAT_KEY_BYTES);
		let sealedRecord: SeatKeyRecord | null;
		try {
			sealedRecord = await sealSeatKey(userId, alias, key);
		} catch (err) {
			key.fill(0);
			throw err;
		}
		if (sealedRecord !== null) {
			try {
				await setAndReadBack(seatKeyStorageKey(userId), JSON.stringify(sealedRecord), `the seat key for alias '${alias}'`);
			} catch (err) {
				key.fill(0);
				throw err;
			}
			return key;
		}
		const keyCopy = Uint8Array.from(key);
		await dismissKeyboardForSystemPrompt();
		let wrapped: WrappedSecret;
		try {
			wrapped = await wrapper.wrapSecret(wrapKeyAlias, keyCopy, { requireAuth: true, aad: seatKeyAad(userId), prompt: prompt() });
		} catch (err) {
			key.fill(0);
			throw mapWrapError(err, alias, 'put');
		} finally {
			keyCopy.fill(0);
		}
		const record: SeatKeyRecord = { v: 1, userId, wrapped };
		try {
			await setAndReadBack(seatKeyStorageKey(userId), JSON.stringify(record), `the seat key for alias '${alias}'`);
		} catch (err) {
			key.fill(0);
			throw err;
		}
		return key;
	}

	/** Exactly one prompt: unseals (v2) or unwraps (v1) the seat key. */
	async function unlockSeatKey(userId: string, alias: string): Promise<Uint8Array> {
		const raw = await storage.getItem(seatKeyStorageKey(userId));
		if (raw === null) {
			throw new KeyVaultError('unavailable', `keyholder-seat-vault: no seat key for alias '${alias}'`);
		}
		const record = parseSeatKeyRecord(raw, userId);
		if (record.v === 2) return unsealSeatKey(userId, alias, record.sealed);
		await dismissKeyboardForSystemPrompt();
		let key: Uint8Array;
		try {
			key = await wrapper.unwrapSecret(record.wrapped, { requireAuth: true, aad: seatKeyAad(userId), prompt: prompt() });
		} catch (err) {
			throw mapWrapError(err, alias, 'get');
		}
		const out = Uint8Array.from(key);
		key.fill(0);
		if (out.length !== SEAT_KEY_BYTES) {
			out.fill(0);
			throw new KeyVaultError('unavailable', `keyholder-seat-vault: seat key for alias '${alias}' has the wrong length`);
		}
		return out;
	}

	async function unsealSeatKey(userId: string, alias: string, sealed: SealedSecret): Promise<Uint8Array> {
		if (sealer === undefined) {
			throw new KeyVaultError('unavailable', `keyholder-seat-vault: seat key for alias '${alias}' is sealed but no sealer is configured`);
		}
		await dismissKeyboardForSystemPrompt();
		let payload: Uint8Array;
		try {
			payload = await sealer.unsealSecret(sealed, prompt());
		} catch (err) {
			throw mapWrapError(err, alias, 'get');
		}
		try {
			const context = seatSealContext(userId);
			let same = payload.length === 64 ? 0 : 1;
			for (let i = 0; i < 32 && same === 0; i++) same |= payload[i]! ^ context[i]!;
			if (same !== 0) {
				throw new KeyVaultError('unavailable', `keyholder-seat-vault: sealed seat key for alias '${alias}' belongs to another seat`);
			}
			return payload.slice(32);
		} finally {
			payload.fill(0);
		}
	}

	/** The session's seat key; concurrent callers in one session share one prompt. */
	async function seatKey(s: Session, userId: string, alias: string, create: boolean): Promise<Uint8Array> {
		if (s.key !== null) return s.key;
		if (s.pending === null) {
			s.pending = create ? createSeatKey(userId, alias) : unlockSeatKey(userId, alias);
		}
		const pending = s.pending;
		try {
			const key = await pending;
			if (s.key === null) s.key = key;
			return s.key;
		} finally {
			if (s.pending === pending) s.pending = null;
		}
	}

	/** Point 5: the identity's keys already live in the inner vault. Never prompts. */
	async function isLegacySeat(userId: string): Promise<boolean> {
		for (const prefix of ['vt.keyholder-signing.', 'vt.keyholder-dkg-recv.']) {
			const alias = prefix + userId;
			try {
				assertKeyVaultAlias(alias);
			} catch {
				continue;
			}
			if (await inner.hasSecret(alias)) return true;
		}
		return false;
	}

	return {
		withKeyholderSession<T>(userId: string, fn: () => Promise<T>): Promise<T> {
			return inSession(userId, () => fn());
		},

		async putSecret(alias: string, secret: Uint8Array, policy: KeyVaultPolicy): Promise<void> {
			assertKeyVaultAlias(alias);
			if ((await storage.getItem(seatSecretStorageKey(alias))) !== null) {
				throw new KeyVaultError('alias-exists', `keyholder-seat-vault: alias '${alias}' already holds a secret`);
			}
			const userId = policy.requireUserAuth === true ? seatUserIdOfAlias(alias) : undefined;
			if (userId === undefined) return inner.putSecret(alias, secret, policy);

			if (!(secret instanceof Uint8Array) || secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
				throw new KeyVaultError('invalid-secret', `keyholder-seat-vault: secret must be 1..${MAX_SECRET_BYTES} bytes`);
			}
			if (await inner.hasSecret(alias)) {
				throw new KeyVaultError('alias-exists', `keyholder-seat-vault: alias '${alias}' already holds a secret`);
			}
			const hasSeatKey = (await storage.getItem(seatKeyStorageKey(userId))) !== null;
			if (!hasSeatKey && (await isLegacySeat(userId))) return inner.putSecret(alias, secret, policy);

			await inSession(userId, async (s) => {
				const key = await seatKey(s, userId, alias, !hasSeatKey);
				const iv = randomBytes(IV_BYTES);
				const plaintext = Uint8Array.from(secret);
				let ciphertext: Uint8Array;
				try {
					ciphertext = gcm(key, iv, seatSecretAad(userId, alias)).encrypt(plaintext);
				} finally {
					plaintext.fill(0);
				}
				const record: SeatSecretRecord = { v: 1, alias, userId, ivHex: bytesToHex(iv), ciphertextHex: bytesToHex(ciphertext) };
				await setAndReadBack(seatSecretStorageKey(alias), JSON.stringify(record), `alias '${alias}'`);
			});
		},

		async getSecret(alias: string): Promise<Uint8Array | null> {
			assertKeyVaultAlias(alias);
			const raw = await storage.getItem(seatSecretStorageKey(alias));
			if (raw === null) return inner.getSecret(alias);
			const record = parseSeatSecretRecord(raw, alias);
			return inSession(record.userId, async (s) => {
				const key = await seatKey(s, record.userId, alias, false);
				let plaintext: Uint8Array;
				try {
					plaintext = gcm(key, hexToBytes(record.ivHex), seatSecretAad(record.userId, alias)).decrypt(hexToBytes(record.ciphertextHex));
				} catch {
					throw new KeyVaultError('unavailable', `keyholder-seat-vault: seat record for alias '${alias}' failed authentication`);
				}
				const out = Uint8Array.from(plaintext);
				plaintext.fill(0);
				return out;
			});
		},

		async hasSecret(alias: string): Promise<boolean> {
			assertKeyVaultAlias(alias);
			if ((await storage.getItem(seatSecretStorageKey(alias))) !== null) return true;
			return inner.hasSecret(alias);
		},

		async deleteSecret(alias: string): Promise<boolean> {
			assertKeyVaultAlias(alias);
			let removed = false;
			if ((await storage.getItem(seatSecretStorageKey(alias))) !== null) {
				await storage.removeItem(seatSecretStorageKey(alias));
				removed = true;
			}
			if (await inner.deleteSecret(alias)) removed = true;
			return removed;
		},
	};
}
