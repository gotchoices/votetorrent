/**
 * session-peer-identity.test.mjs — unit contract for
 * `src/peer/identity.js`'s ephemeral per-tab libp2p identity (D-08, D-09).
 *
 * HONESTY NOTE. "Fresh per storage" below is a unit contract of this module
 * — two different storage objects produce two different public keys — and
 * is NOT the D-11 gateway unlinkability proof. That property (two page
 * loads see different peerIds; a reload within one tab reuses the same one)
 * is observed at the gateway and belongs to `56-13`. Do not read a green
 * run here as retiring that rung.
 *
 * Runs under plain `node --test` — no real `sessionStorage` exists in Node,
 * which is exactly why `loadOrCreateSessionPeerKey` takes a storage object
 * as a parameter rather than reading `globalThis.sessionStorage` itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	SESSION_PEER_KEY_STORAGE_KEY,
	loadOrCreateSessionPeerKey,
	encodePeerKeyBytes,
	decodePeerKeyBytes,
} from '../../src/peer/identity.js';

/**
 * A `Map`-backed fake `sessionStorage` that also records every call made to
 * it, so a test can assert exact call counts and not just end state.
 * @returns {{
 *   getItem: (key: string) => string | null,
 *   setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void,
 *   calls: { setItem: string[], removeItem: string[] },
 * }}
 */
function makeFakeStorage() {
	const backing = new Map();
	const calls = { setItem: /** @type {string[]} */ ([]), removeItem: /** @type {string[]} */ ([]) };
	return {
		getItem(key) {
			return backing.has(key) ? backing.get(key) : null;
		},
		setItem(key, value) {
			calls.setItem.push(key);
			backing.set(key, value);
		},
		removeItem(key) {
			calls.removeItem.push(key);
			backing.delete(key);
		},
		calls,
	};
}

/**
 * A storage whose every method throws — the private-mode / storage-disabled
 * case.
 * @returns {{ getItem: () => never, setItem: () => never, removeItem: () => never }}
 */
function makeThrowingStorage() {
	return {
		getItem() {
			throw new Error('storage disabled');
		},
		setItem() {
			throw new Error('storage disabled');
		},
		removeItem() {
			throw new Error('storage disabled');
		},
	};
}

test('reload reuse: two calls against the SAME storage return byte-identical public keys', async () => {
	const storage = makeFakeStorage();
	const first = await loadOrCreateSessionPeerKey(storage);
	const second = await loadOrCreateSessionPeerKey(storage);
	assert.deepStrictEqual(second.publicKey.raw, first.publicKey.raw);
});

test('fresh per storage: two DIFFERENT storage objects return different public keys', async () => {
	const key1 = await loadOrCreateSessionPeerKey(makeFakeStorage());
	const key2 = await loadOrCreateSessionPeerKey(makeFakeStorage());
	assert.notDeepStrictEqual(key1.publicKey.raw, key2.publicKey.raw);
});

test('exactly one slot written: a create against a fresh storage results in exactly one setItem call under the declared key', async () => {
	const storage = makeFakeStorage();
	await loadOrCreateSessionPeerKey(storage);
	assert.strictEqual(storage.calls.setItem.length, 1);
	assert.strictEqual(storage.calls.setItem[0], SESSION_PEER_KEY_STORAGE_KEY);
});

test('round-trip: the stored string decodes to a key whose public bytes match the returned key', async () => {
	const storage = makeFakeStorage();
	const key = await loadOrCreateSessionPeerKey(storage);
	const stored = storage.getItem(SESSION_PEER_KEY_STORAGE_KEY);
	assert.notStrictEqual(stored, null);
	const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
	const decoded = privateKeyFromProtobuf(decodePeerKeyBytes(/** @type {string} */ (stored)));
	assert.deepStrictEqual(decoded.publicKey.raw, key.publicKey.raw);
});

test('encodePeerKeyBytes / decodePeerKeyBytes are exact inverses', () => {
	const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32, 64, 128]);
	const encoded = encodePeerKeyBytes(bytes);
	assert.deepStrictEqual(decodePeerKeyBytes(encoded), bytes);
});

test('decodePeerKeyBytes rejects malformed input by throwing, never by returning partial bytes', () => {
	assert.throws(() => decodePeerKeyBytes('not valid base64url!!'));
	assert.throws(() => decodePeerKeyBytes(''));
});

test('corruption recovery: a non-decodable slot value is discarded and replaced with a fresh, cleanly-decodable key', async () => {
	const storage = makeFakeStorage();
	storage.setItem(SESSION_PEER_KEY_STORAGE_KEY, 'not-a-valid-protobuf-key!!');
	storage.calls.setItem.length = 0; // the seed write above isn't part of what we're counting

	const key = await loadOrCreateSessionPeerKey(storage);
	assert.ok(key);

	const stored = storage.getItem(SESSION_PEER_KEY_STORAGE_KEY);
	assert.notStrictEqual(stored, null);
	const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
	const decoded = privateKeyFromProtobuf(decodePeerKeyBytes(/** @type {string} */ (stored)));
	assert.deepStrictEqual(decoded.publicKey.raw, key.publicKey.raw);
});

test('no storage at all: a throwing storage still resolves with a usable key and never rejects', async () => {
	const storage = makeThrowingStorage();
	const key = await loadOrCreateSessionPeerKey(storage);
	assert.ok(key.publicKey.raw.length > 0);
});
