/**
 * idb-key-store.js -- cadre-core's `KeyStore` over IndexedDB, one view per network, for the
 * dashboard's member node.
 *
 * Every record is sealed by `device-key.js`: an AES-GCM ciphertext under one non-extractable
 * wrap key per origin. See that module's header for the full threat statement. In one line: the
 * wrap protects a copied IndexedDB dump only; it does NOT protect against script running in the
 * page (XSS) and NOT against a running tab, which can decrypt exactly as this code does.
 *
 * THE NEVER-REGENERATE INVARIANT. `get` resolves `undefined` ONLY when the `[networkHash, keyId]`
 * record is definitely absent. Every other outcome -- an unreadable store, a record of the wrong
 * shape, a ciphertext that does not open, a missing wrap key beside a record, no WebCrypto --
 * throws. cadre-core's `identityPeerId()` and every start read the identity slot through `get`,
 * and treat `undefined` as "create a key"; an error that came back as `undefined` would mint a
 * new identity, burn the single-use invitation the old one redeemed and silently change who this
 * browser is. Nothing in this module catches an error and answers "empty".
 *
 * Records of different networks share the database and the wrap key but never a slot: the key
 * is `[networkHash, keyId]` and `list()` returns this network's key ids only. Key ids are
 * cadre-core's own (`cadre/identity`, `cadre/joined-strand/...`): any non-empty string, `/`
 * included. No log line, no key byte, no hash and no key id in any error message.
 */

import {
	DEVICE_KEYS_DB_NAME,
	KEYS_STORE,
	DeviceKeyCorruptError,
	DeviceKeyStorageUnavailableError,
	keyRecordAad,
	loadWrapKey,
	openDeviceKeysDb,
	openKeyMaterial,
	sealKeyMaterial,
} from './device-key.js';

/**
 * @typedef {object} IdbKeyStoreDeps
 * @property {IDBFactory | undefined} [indexedDB] Default `globalThis.indexedDB`. An explicit `undefined` means "none".
 * @property {typeof IDBKeyRange | undefined} [IDBKeyRange] Default `globalThis.IDBKeyRange`.
 * @property {SubtleCrypto | undefined} [subtle] Default `globalThis.crypto.subtle`. An explicit `undefined` means "none".
 * @property {((array: Uint8Array) => Uint8Array) | undefined} [getRandomValues] Default `crypto.getRandomValues`.
 */

/**
 * @typedef {import('@serfab/cadre-core').KeyStore & { close(): void }} IdbKeyStore
 */

/**
 * @param {IdbKeyStoreDeps} deps
 */
function resolveDeps(deps) {
	const cryptoApi = globalThis.crypto;
	return {
		indexedDB: 'indexedDB' in deps ? deps.indexedDB : globalThis.indexedDB,
		IDBKeyRange: 'IDBKeyRange' in deps ? deps.IDBKeyRange : globalThis.IDBKeyRange,
		subtle: 'subtle' in deps ? deps.subtle : cryptoApi?.subtle,
		getRandomValues:
			'getRandomValues' in deps
				? deps.getRandomValues
				: cryptoApi && typeof cryptoApi.getRandomValues === 'function'
					? cryptoApi.getRandomValues.bind(cryptoApi)
					: undefined,
	};
}

/** @param {unknown} networkHash */
function requireNetworkHash(networkHash) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('idb-key-store: networkHash must be a non-empty string');
	}
}

/** @param {unknown} keyId */
function requireKeyId(keyId) {
	if (typeof keyId !== 'string' || keyId.length === 0) {
		throw new TypeError('idb-key-store: a key id must be a non-empty string');
	}
}

/**
 * The key range covering every record of one network: `[hash, '']` up to `[hash, []]` (an array
 * sorts after every string in IndexedDB's key order).
 *
 * @param {typeof IDBKeyRange | undefined} keyRange
 * @param {string} networkHash
 * @returns {IDBKeyRange}
 */
function networkRange(keyRange, networkHash) {
	if (!keyRange || typeof keyRange.bound !== 'function') {
		throw new DeviceKeyStorageUnavailableError('indexeddb');
	}
	return keyRange.bound([networkHash, ''], [networkHash, []]);
}

/**
 * Run one request in its own transaction and resolve with its result once the transaction
 * completes (so a write is committed, not merely queued, when this resolves).
 *
 * @template T
 * @param {IDBDatabase} db
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<T>} issue
 * @param {'read'|'write'} failure
 * @returns {Promise<T>}
 */
function runRequest(db, mode, issue, failure) {
	return new Promise((resolve, reject) => {
		let settled = false;
		/** @type {T} */
		let result;
		const fail = () => {
			if (settled) return;
			settled = true;
			reject(new DeviceKeyStorageUnavailableError(failure));
		};
		try {
			const tx =
				mode === 'readwrite'
					? db.transaction(KEYS_STORE, mode, { durability: 'strict' })
					: db.transaction(KEYS_STORE, mode);
			const request = issue(tx.objectStore(KEYS_STORE));
			request.onsuccess = () => {
				result = request.result;
			};
			request.onerror = fail;
			tx.onerror = fail;
			tx.onabort = fail;
			tx.oncomplete = () => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
		} catch {
			fail();
		}
	});
}

/**
 * cadre-core's `KeyStore` over the device-key database, scoped to one network.
 *
 * The database opens lazily, once; a rejected open is forgotten so the next call retries. The
 * connection closes itself when another context asks to upgrade or delete the database.
 * `close()` (an addition to the `KeyStore` interface) drops the connection; the next call reopens.
 *
 * @param {{ networkHash: string, dbName?: string, deps?: IdbKeyStoreDeps }} options
 * @returns {IdbKeyStore}
 */
export function createIdbKeyStore({ networkHash, dbName = DEVICE_KEYS_DB_NAME, deps = {} }) {
	requireNetworkHash(networkHash);
	const resolved = resolveDeps(deps);

	/** @type {Promise<IDBDatabase> | null} */
	let opening = null;

	/** @returns {Promise<IDBDatabase>} */
	function openDb() {
		if (opening) return opening;
		const attempt = openDeviceKeysDb({ dbName, indexedDB: resolved.indexedDB }).then((db) => {
			db.onversionchange = () => {
				db.close();
				if (opening === attempt) opening = null;
			};
			return db;
		});
		opening = attempt;
		attempt.catch(() => {
			if (opening === attempt) opening = null;
		});
		return attempt;
	}

	return {
		async get(keyId) {
			requireKeyId(keyId);
			const db = await openDb();
			/** @type {unknown} */
			const record = await runRequest(db, 'readonly', (store) => store.get([networkHash, keyId]), 'read');
			if (record === undefined) return undefined;
			const wrapKey = await loadWrapKey(db, { create: false, subtle: resolved.subtle });
			if (wrapKey === null) throw new DeviceKeyCorruptError('wrap-key');
			return openKeyMaterial({ subtle: resolved.subtle }, wrapKey, record, keyRecordAad(networkHash, keyId));
		},

		async set(keyId, keyMaterial) {
			requireKeyId(keyId);
			if (!(keyMaterial instanceof Uint8Array)) {
				throw new TypeError('idb-key-store: key material must be a Uint8Array');
			}
			const db = await openDb();
			const wrapKey = await loadWrapKey(db, { create: true, subtle: resolved.subtle });
			if (wrapKey === null) throw new DeviceKeyCorruptError('wrap-key');
			if (!resolved.subtle || typeof resolved.getRandomValues !== 'function') {
				throw new DeviceKeyStorageUnavailableError('webcrypto');
			}
			const sealed = await sealKeyMaterial(
				{ subtle: resolved.subtle, getRandomValues: resolved.getRandomValues },
				wrapKey,
				keyMaterial,
				keyRecordAad(networkHash, keyId),
			);
			await runRequest(db, 'readwrite', (store) => store.put(sealed, [networkHash, keyId]), 'write');
		},

		async delete(keyId) {
			requireKeyId(keyId);
			const db = await openDb();
			await runRequest(db, 'readwrite', (store) => store.delete([networkHash, keyId]), 'write');
		},

		async list() {
			const db = await openDb();
			const range = networkRange(resolved.IDBKeyRange, networkHash);
			const keys = await runRequest(db, 'readonly', (store) => store.getAllKeys(range), 'read');
			/** @type {string[]} */
			const ids = [];
			for (const key of keys) {
				if (Array.isArray(key) && key.length === 2 && key[0] === networkHash && typeof key[1] === 'string') {
					ids.push(key[1]);
				}
			}
			return ids;
		},

		close() {
			const pending = opening;
			opening = null;
			if (pending) {
				pending.then(
					(db) => db.close(),
					() => undefined,
				);
			}
		},
	};
}

/**
 * Delete every key record of `networkHash` in one transaction. The origin wrap key and other
 * networks' records stay. Idempotent; a database that did not exist is created empty, which is
 * harmless.
 *
 * @param {string} networkHash
 * @param {{ dbName?: string, deps?: IdbKeyStoreDeps }} [options]
 * @returns {Promise<void>}
 */
export async function deleteDeviceKeys(networkHash, { dbName = DEVICE_KEYS_DB_NAME, deps = {} } = {}) {
	requireNetworkHash(networkHash);
	const resolved = resolveDeps(deps);
	const db = await openDeviceKeysDb({ dbName, indexedDB: resolved.indexedDB });
	try {
		const range = networkRange(resolved.IDBKeyRange, networkHash);
		await runRequest(db, 'readwrite', (store) => store.delete(range), 'write');
	} finally {
		db.close();
	}
}
