/**
 * Tier-1 proof of the dashboard's device identity at rest (`src/peer/device-key.js`,
 * `src/peer/idb-key-store.js`): AES-GCM records under one non-extractable origin wrap key,
 * slot-bound, per network, and never turned into a fresh identity when unreadable.
 *
 * Honesty note: `fake-indexeddb` is an in-process reimplementation of the IndexedDB API, and
 * Node's WebCrypto is not a browser's. This tier proves the modules' use of both APIs within one
 * process: round-trips, a close-and-reopen, corrupt/swapped/keyless records, the race between two
 * stores, and that cadre-core's real `identityPeerId()` refuses instead of regenerating. It proves
 * nothing about a real browser persisting a CryptoKey across a page reload, quota or eviction;
 * that belongs to the browser gates.
 *
 * Sequential by design (`--test-concurrency=1`); each test uses its own database name.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { createEdgeNode } from '@serfab/cadre-core/edge-node';
import { DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import {
	DEVICE_KEYS_DB_NAME,
	DeviceKeyCorruptError,
	DeviceKeyStorageUnavailableError,
} from '../../src/peer/device-key.js';
import { createIdbKeyStore, deleteDeviceKeys } from '../../src/peer/idb-key-store.js';

const HASH_A = 'netA-9f2c41d0b7e6';
const HASH_B = 'netB-41aa07c3de58';
const PLAINTEXT = Uint8Array.from({ length: 68 }, (_, i) => (i * 37 + 11) & 0xff);
const OTHER_PLAINTEXT = Uint8Array.from({ length: 40 }, (_, i) => (i * 13 + 200) & 0xff);

/** Every error thrown by the failure cases, for the message-hygiene test. @type {Error[]} */
const collectedErrors = [];

let dbCounter = 0;
function freshDbName() {
	dbCounter += 1;
	return `vt-dashboard-keys-test-${dbCounter}-${Date.now()}`;
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<Error>}
 */
async function rejection(promise) {
	try {
		await promise;
	} catch (err) {
		collectedErrors.push(/** @type {Error} */ (err));
		return /** @type {Error} */ (err);
	}
	assert.fail('expected a rejection');
}

/** @param {string} name @returns {Promise<IDBDatabase>} */
function rawOpen(name) {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * @param {string} dbName
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} issue
 * @returns {Promise<any>}
 */
async function rawRun(dbName, storeName, mode, issue) {
	const db = await rawOpen(dbName);
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, mode);
			const request = issue(tx.objectStore(storeName));
			/** @type {any} */
			let result;
			request.onsuccess = () => {
				result = request.result;
			};
			tx.oncomplete = () => resolve(result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** @param {string} dbName @param {string} hash @param {string} keyId */
function rawGetRecord(dbName, hash, keyId) {
	return rawRun(dbName, 'keys', 'readonly', (s) => s.get([hash, keyId]));
}
/** @param {string} dbName @param {string} hash @param {string} keyId @param {unknown} value */
function rawPutRecord(dbName, hash, keyId, value) {
	return rawRun(dbName, 'keys', 'readwrite', (s) => s.put(value, [hash, keyId]));
}
/** @param {string} dbName */
function rawWrapAll(dbName) {
	return rawRun(dbName, 'wrap', 'readonly', (s) => s.getAll());
}

/** @param {Uint8Array} hay @param {Uint8Array} needle */
function containsRun(hay, needle) {
	outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1) {
			if (hay[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

/** @param {Uint8Array} bytes */
function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
	return globalThis.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('1 round trip: set then get returns the exact bytes, list names the key id, and a reopened store reads the same bytes', async () => {
	const dbName = freshDbName();
	const first = createIdbKeyStore({ networkHash: HASH_A, dbName });
	await first.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	assert.deepEqual(await first.get(DEFAULT_IDENTITY_KEY_ID), PLAINTEXT);
	assert.deepEqual(await first.list(), [DEFAULT_IDENTITY_KEY_ID]);
	first.close();

	const reopened = createIdbKeyStore({ networkHash: HASH_A, dbName });
	assert.deepEqual(await reopened.get(DEFAULT_IDENTITY_KEY_ID), PLAINTEXT);
	reopened.close();
	assert.equal(DEVICE_KEYS_DB_NAME, 'vt-dashboard-keys');
});

test('2 at rest: the record is { v:1, iv, ct } with no plaintext run, and the wrap key is a non-extractable CryptoKey that exportKey refuses', async () => {
	const dbName = freshDbName();
	const store = createIdbKeyStore({ networkHash: HASH_A, dbName });
	await store.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	store.close();

	const record = await rawGetRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID);
	assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
	assert.equal(record.v, 1);
	assert.ok(record.iv instanceof Uint8Array && record.iv.length === 12);
	assert.ok(record.ct instanceof Uint8Array && record.ct.length === PLAINTEXT.length + 16);
	assert.equal(containsRun(record.ct, PLAINTEXT.subarray(0, 8)), false, 'ciphertext must not carry a plaintext run');

	const wraps = await rawWrapAll(dbName);
	assert.equal(wraps.length, 1);
	const wrapKey = wraps[0];
	assert.ok(wrapKey instanceof CryptoKey);
	assert.equal(wrapKey.extractable, false);
	assert.equal(wrapKey.algorithm.name, 'AES-GCM');
	await assert.rejects(crypto.subtle.exportKey('raw', wrapKey));
});

test('3 an absent slot reads undefined and creates no wrap key', async () => {
	const dbName = freshDbName();
	const store = createIdbKeyStore({ networkHash: HASH_A, dbName });
	assert.equal(await store.get(DEFAULT_IDENTITY_KEY_ID), undefined);
	assert.deepEqual(await store.list(), []);
	store.close();
	assert.equal((await rawWrapAll(dbName)).length, 0);
});

test('4 corrupt: a flipped ciphertext byte, a malformed record and a missing wrap key each throw, and no wrap key is minted over records', async () => {
	const dbName = freshDbName();
	const store = createIdbKeyStore({ networkHash: HASH_A, dbName });
	await store.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	const record = await rawGetRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID);

	const flipped = { v: 1, iv: record.iv, ct: Uint8Array.from(record.ct) };
	flipped.ct[3] ^= 0x01;
	await rawPutRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID, flipped);
	let err = await rejection(store.get(DEFAULT_IDENTITY_KEY_ID));
	assert.ok(err instanceof DeviceKeyCorruptError);
	assert.equal(/** @type {DeviceKeyCorruptError} */ (err).subject, 'ciphertext');

	await rawPutRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID, {});
	err = await rejection(store.get(DEFAULT_IDENTITY_KEY_ID));
	assert.ok(err instanceof DeviceKeyCorruptError);
	assert.equal(/** @type {DeviceKeyCorruptError} */ (err).subject, 'record');

	await rawPutRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID, record);
	assert.deepEqual(await store.get(DEFAULT_IDENTITY_KEY_ID), PLAINTEXT, 'the restored record opens again');
	await rawRun(dbName, 'wrap', 'readwrite', (s) => s.delete('origin'));
	err = await rejection(store.get(DEFAULT_IDENTITY_KEY_ID));
	assert.ok(err instanceof DeviceKeyCorruptError);
	assert.equal(/** @type {DeviceKeyCorruptError} */ (err).subject, 'wrap-key');

	err = await rejection(store.set('cadre/other', OTHER_PLAINTEXT));
	assert.ok(err instanceof DeviceKeyCorruptError);
	assert.equal(/** @type {DeviceKeyCorruptError} */ (err).subject, 'wrap-key');
	store.close();
	assert.equal((await rawWrapAll(dbName)).length, 0, 'no wrap key was minted over existing records');
	assert.equal(await rawGetRecord(dbName, HASH_A, 'cadre/other'), undefined);
});

test('5 swap: a record copied into another slot of the same network, or into another network, does not open', async () => {
	const dbName = freshDbName();
	const storeA = createIdbKeyStore({ networkHash: HASH_A, dbName });
	const storeB = createIdbKeyStore({ networkHash: HASH_B, dbName });
	await storeA.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	const record = await rawGetRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID);

	await rawPutRecord(dbName, HASH_A, 'cadre/other', record);
	await rawPutRecord(dbName, HASH_B, DEFAULT_IDENTITY_KEY_ID, record);
	const sameNetwork = await rejection(storeA.get('cadre/other'));
	const otherNetwork = await rejection(storeB.get(DEFAULT_IDENTITY_KEY_ID));
	for (const err of [sameNetwork, otherNetwork]) {
		assert.ok(err instanceof DeviceKeyCorruptError);
		assert.equal(/** @type {DeviceKeyCorruptError} */ (err).subject, 'ciphertext');
	}
	assert.deepEqual(await storeA.get(DEFAULT_IDENTITY_KEY_ID), PLAINTEXT, 'the original slot still opens');
	storeA.close();
	storeB.close();
});

test('6 isolation: list shows only its own network, deleteDeviceKeys removes one network and keeps the wrap key and the other, twice over', async () => {
	const dbName = freshDbName();
	const storeA = createIdbKeyStore({ networkHash: HASH_A, dbName });
	const storeB = createIdbKeyStore({ networkHash: HASH_B, dbName });
	await storeA.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	await storeA.set('cadre/joined-strand/s1', OTHER_PLAINTEXT);
	await storeB.set(DEFAULT_IDENTITY_KEY_ID, OTHER_PLAINTEXT);
	assert.deepEqual((await storeA.list()).sort(), [DEFAULT_IDENTITY_KEY_ID, 'cadre/joined-strand/s1'].sort());
	assert.deepEqual(await storeB.list(), [DEFAULT_IDENTITY_KEY_ID]);

	await deleteDeviceKeys(HASH_A, { dbName });
	assert.deepEqual(await storeA.list(), []);
	assert.equal(await storeA.get(DEFAULT_IDENTITY_KEY_ID), undefined);
	assert.deepEqual(await storeB.get(DEFAULT_IDENTITY_KEY_ID), OTHER_PLAINTEXT);
	assert.equal((await rawWrapAll(dbName)).length, 1, 'the origin wrap key stays');
	await deleteDeviceKeys(HASH_A, { dbName });
	await storeA.delete(DEFAULT_IDENTITY_KEY_ID);
	storeA.close();
	storeB.close();
});

test('7 race: two stores setting at once on an empty database end with exactly one wrap key and both values readable by each', async () => {
	const dbName = freshDbName();
	const one = createIdbKeyStore({ networkHash: HASH_A, dbName });
	const two = createIdbKeyStore({ networkHash: HASH_A, dbName });
	await Promise.all([one.set('cadre/one', PLAINTEXT), two.set('cadre/two', OTHER_PLAINTEXT)]);
	assert.equal((await rawWrapAll(dbName)).length, 1);
	for (const store of [one, two]) {
		assert.deepEqual(await store.get('cadre/one'), PLAINTEXT);
		assert.deepEqual(await store.get('cadre/two'), OTHER_PLAINTEXT);
	}
	one.close();
	two.close();
});

test('8 unavailable: no indexedDB, no WebCrypto beside a record, and a failing open each reject DeviceKeyStorageUnavailableError', async () => {
	const noIdb = createIdbKeyStore({ networkHash: HASH_A, dbName: freshDbName(), deps: { indexedDB: undefined } });
	for (const promise of [noIdb.get(DEFAULT_IDENTITY_KEY_ID), noIdb.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT)]) {
		const err = await rejection(promise);
		assert.ok(err instanceof DeviceKeyStorageUnavailableError);
		assert.equal(/** @type {DeviceKeyStorageUnavailableError} */ (err).subject, 'indexeddb');
	}

	const dbName = freshDbName();
	const seeded = createIdbKeyStore({ networkHash: HASH_A, dbName });
	await seeded.set(DEFAULT_IDENTITY_KEY_ID, PLAINTEXT);
	seeded.close();
	const noCrypto = createIdbKeyStore({ networkHash: HASH_A, dbName, deps: { subtle: undefined } });
	let err = await rejection(noCrypto.get(DEFAULT_IDENTITY_KEY_ID));
	assert.ok(err instanceof DeviceKeyStorageUnavailableError);
	assert.equal(/** @type {DeviceKeyStorageUnavailableError} */ (err).subject, 'webcrypto');
	noCrypto.close();

	/** @type {any} */
	const failingIdb = {
		open() {
			/** @type {any} */
			const request = {};
			queueMicrotask(() => request.onerror?.());
			return request;
		},
	};
	const failing = createIdbKeyStore({ networkHash: HASH_A, dbName: freshDbName(), deps: { indexedDB: failingIdb } });
	err = await rejection(failing.get(DEFAULT_IDENTITY_KEY_ID));
	assert.ok(err instanceof DeviceKeyStorageUnavailableError);
	assert.equal(/** @type {DeviceKeyStorageUnavailableError} */ (err).subject, 'indexeddb');
	err = await rejection(failing.list());
	assert.ok(err instanceof DeviceKeyStorageUnavailableError, 'a rejected open is forgotten and retried, and fails the same way');
});

/**
 * A minimal edge-node storage stub: no node is ever started over it.
 * @param {string} id
 */
function stubStorage(id) {
	const local = new Map();
	return {
		id,
		rawStorage() {
			throw new Error('rawStorage must not be called: no node is started in this test');
		},
		async destroyScope() {},
		nodeLocal() {
			return {
				get: async (/** @type {string} */ key) => local.get(key),
				set: async (/** @type {string} */ key, /** @type {string} */ value) => {
					local.set(key, value);
				},
				delete: async (/** @type {string} */ key) => {
					local.delete(key);
				},
				flush: async () => {},
			};
		},
		async close() {},
	};
}

test('9 never regenerated through the real stack: cadre-core identityPeerId creates the identity, then refuses a corrupted one and writes nothing', async () => {
	const dbName = freshDbName();
	const keyStore = createIdbKeyStore({ networkHash: HASH_A, dbName });
	const stamp = Date.now();
	const first = createEdgeNode(/** @type {any} */ ({ keyStore, storage: stubStorage(`device-key-test-a-${stamp}`) }));
	const peerId = await first.identityPeerId();
	assert.equal(typeof peerId, 'string');
	assert.ok(peerId.length > 20);
	assert.deepEqual(await keyStore.list(), [DEFAULT_IDENTITY_KEY_ID]);

	const record = await rawGetRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID);
	const corrupted = { v: 1, iv: Uint8Array.from(record.iv), ct: Uint8Array.from(record.ct) };
	corrupted.ct[corrupted.ct.length - 1] ^= 0x80;
	await rawPutRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID, corrupted);

	const second = createEdgeNode(/** @type {any} */ ({ keyStore, storage: stubStorage(`device-key-test-b-${stamp}`) }));
	const err = await rejection(second.identityPeerId());
	assert.ok(err instanceof DeviceKeyCorruptError);

	const after = await rawGetRecord(dbName, HASH_A, DEFAULT_IDENTITY_KEY_ID);
	assert.deepEqual(after.iv, corrupted.iv);
	assert.deepEqual(after.ct, corrupted.ct, 'the corrupted record is byte-identical: nothing regenerated it');
	assert.deepEqual(await keyStore.list(), [DEFAULT_IDENTITY_KEY_ID]);
	keyStore.close();
});

test('10 messages: no error from the failure cases names a key id, a network hash or a plaintext byte run', () => {
	assert.ok(collectedErrors.length >= 10, `expected the failure cases to have collected errors, got ${collectedErrors.length}`);
	const banned = [
		DEFAULT_IDENTITY_KEY_ID,
		'cadre/other',
		'cadre/one',
		HASH_A,
		HASH_B,
		toHex(PLAINTEXT.subarray(0, 6)),
		toBase64Url(PLAINTEXT.subarray(0, 6)),
		toHex(OTHER_PLAINTEXT.subarray(0, 6)),
		toBase64Url(OTHER_PLAINTEXT.subarray(0, 6)),
	];
	for (const err of collectedErrors) {
		for (const token of banned) {
			assert.equal(String(err.message).includes(token), false, `an error message carries a banned token (${err.name})`);
		}
	}
});

test('11 source scan: no console, no Buffer, no node: import, no import.meta.env, no libp2p key generation, and the one generateKey call passes extractable false', () => {
	const files = [dashboardSrc('peer', 'device-key.js'), dashboardSrc('peer', 'idb-key-store.js')];
	const bannedTokens = [
		'con' + 'sole.',
		'Buf' + 'fer',
		"from 'no" + "de:",
		'import.me' + 'ta.env',
		'generate' + 'KeyPair',
	];
	const callToken = 'generate' + 'Key(';
	/** @type {Record<string, number>} */
	const callCounts = {};
	for (const file of files) {
		const code = stripComments(readFileSync(file, 'utf8'));
		for (const token of bannedTokens) {
			assert.equal(code.includes(token), false, `${file} contains a banned token`);
		}
		callCounts[file] = code.split(callToken).length - 1;
		if (callCounts[file] > 0) {
			const pattern = new RegExp('generate' + 'Key\\(\\s*\\{[^}]*\\}\\s*,\\s*false\\s*,');
			assert.match(code, pattern, 'the wrap key is generated with extractable false');
			assert.doesNotMatch(code, new RegExp('generate' + 'Key\\(\\s*\\{[^}]*\\}\\s*,\\s*true'));
		}
	}
	assert.equal(callCounts[files[0]], 1, 'device-key.js has exactly one key generation call');
	assert.equal(callCounts[files[1]], 0, 'idb-key-store.js generates no key');
	// Positive control: the scan's tokens do fire on text that carries them.
	assert.ok(stripComments(`const x = ${bannedTokens[1]}.from([]);`).includes(bannedTokens[1]));
});
