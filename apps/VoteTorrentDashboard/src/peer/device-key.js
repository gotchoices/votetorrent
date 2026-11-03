/**
 * device-key.js -- the dashboard's device key material at rest: an AES-GCM wrap under one
 * non-extractable WebCrypto key per origin, both kept in one IndexedDB database.
 *
 * WHAT IS STORED. The browser's network identity is the raw libp2p private key (protobuf bytes
 * holding an Ed25519 seed) that cadre-core reads from its key store under `cadre/identity`. A
 * WebCrypto key cannot BE that identity: libp2p and cadre-core sign with the raw seed, so the
 * seed has to exist as bytes in this page at some point. What this module controls is how those
 * bytes rest on disk: each record is `{ v: 1, iv, ct }`, an AES-GCM-256 ciphertext under ONE
 * wrap key per origin, generated here with `extractable: false` and stored in the same database.
 * The additional data of every record binds it to its slot (network hash and key id), so a
 * ciphertext copied into another slot or another network does not open.
 *
 * WHAT THIS PROTECTS, IN PLAIN WORDS. It protects a copied IndexedDB dump: a copy of the
 * profile's IndexedDB files carries the ciphertext and a key handle that cannot be exported, so
 * the seed does not fall out of the copy as plain bytes. It does NOT protect against script
 * running in the page (XSS), and it does NOT protect against a running tab: anything executing in
 * this origin can call decrypt exactly as this code does and read the seed. A truly
 * non-extractable network identity would need libp2p and cadre-core to sign through WebCrypto;
 * that is an upstream item and it is not filed.
 *
 * NOTHING HERE REGENERATES A KEY. A wrap key is created only when the database holds no wrap key
 * AND no record; a missing wrap key beside existing records is reported as corrupt, never
 * replaced (a new wrap key would orphan every record, and a caller that then treated the slot as
 * empty would mint a new identity). Every unreadable, swapped or damaged record throws.
 *
 * Errors carry a closed `subject` and a fixed message. No key id, network hash, byte or
 * ciphertext ever reaches a message, and this module writes no log line at all.
 */

/** The IndexedDB database holding the wrap key and every network's key records. */
export const DEVICE_KEYS_DB_NAME = 'vt-dashboard-keys';
/** Its schema version: two object stores, out-of-line keys. */
export const DEVICE_KEYS_DB_VERSION = 1;
/** Object store of the origin wrap key, under {@link WRAP_KEY_ID}. */
export const WRAP_STORE = 'wrap';
/** Object store of the key records, under the array key `[networkHash, keyId]`. */
export const KEYS_STORE = 'keys';
/** The one wrap key's slot in {@link WRAP_STORE}. */
export const WRAP_KEY_ID = 'origin';
/** The record format this module writes and reads. */
export const RECORD_VERSION = 1;
/** AES-GCM nonce length, fresh per sealed record. */
export const IV_BYTES = 12;
/** A GCM tag is 16 bytes; a record must hold at least one byte of ciphertext beyond it. */
const MIN_CT_BYTES = 17;

/** @type {Readonly<Record<'wrap-key'|'record'|'ciphertext', string>>} */
const CORRUPT_MESSAGES = Object.freeze({
	'wrap-key': 'The device key store has records but its wrap key is missing or unusable.',
	record: 'A device key record is not in the expected format.',
	ciphertext: 'A device key record did not decrypt under this origin wrap key.',
});

/** @type {Readonly<Record<'indexeddb'|'webcrypto'|'read'|'write', string>>} */
const UNAVAILABLE_MESSAGES = Object.freeze({
	indexeddb: 'IndexedDB is not available for the device key store.',
	webcrypto: 'WebCrypto is not available for the device key store.',
	read: 'The device key store could not be read.',
	write: 'The device key store could not be written.',
});

/**
 * A key record, or the wrap key beside records, exists and cannot be used. The caller must not
 * treat this as "no key": that would mint a new identity over the old one.
 */
export class DeviceKeyCorruptError extends Error {
	/** @param {'wrap-key'|'record'|'ciphertext'} subject */
	constructor(subject) {
		super(CORRUPT_MESSAGES[subject] ?? CORRUPT_MESSAGES.record);
		this.name = 'DeviceKeyCorruptError';
		/** @type {'wrap-key'|'record'|'ciphertext'} */
		this.subject = subject in CORRUPT_MESSAGES ? subject : 'record';
	}
}

/** The browser could not give this module the storage or crypto it needs. */
export class DeviceKeyStorageUnavailableError extends Error {
	/** @param {'indexeddb'|'webcrypto'|'read'|'write'} subject */
	constructor(subject) {
		super(UNAVAILABLE_MESSAGES[subject] ?? UNAVAILABLE_MESSAGES.read);
		this.name = 'DeviceKeyStorageUnavailableError';
		/** @type {'indexeddb'|'webcrypto'|'read'|'write'} */
		this.subject = subject in UNAVAILABLE_MESSAGES ? subject : 'read';
	}
}

/**
 * @typedef {object} SealedKeyRecord
 * @property {1} v
 * @property {Uint8Array} iv
 * @property {Uint8Array} ct
 */

/**
 * Open (creating when absent) the device-key database. An absent `indexedDB`, an open error and
 * a blocked open all reject `DeviceKeyStorageUnavailableError('indexeddb')`.
 *
 * @param {{ dbName?: string, indexedDB?: IDBFactory | undefined }} options
 * @returns {Promise<IDBDatabase>}
 */
export function openDeviceKeysDb({ dbName = DEVICE_KEYS_DB_NAME, indexedDB: idb } = {}) {
	return new Promise((resolve, reject) => {
		if (!idb || typeof idb.open !== 'function') {
			reject(new DeviceKeyStorageUnavailableError('indexeddb'));
			return;
		}
		/** @type {IDBOpenDBRequest} */
		let request;
		try {
			request = idb.open(dbName, DEVICE_KEYS_DB_VERSION);
		} catch {
			reject(new DeviceKeyStorageUnavailableError('indexeddb'));
			return;
		}
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(WRAP_STORE)) db.createObjectStore(WRAP_STORE);
			if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new DeviceKeyStorageUnavailableError('indexeddb'));
		request.onblocked = () => reject(new DeviceKeyStorageUnavailableError('indexeddb'));
	});
}

/**
 * The additional data that binds a record to its slot: UTF-8 of
 * `vt-dashboard-key \0 v1 \0 networkHash \0 keyId`.
 *
 * @param {string} networkHash
 * @param {string} keyId
 * @returns {Uint8Array}
 */
export function keyRecordAad(networkHash, keyId) {
	return new TextEncoder().encode(['vt-dashboard-key', 'v1', networkHash, keyId].join('\u0000'));
}

/**
 * Whether `key` is the wrap key this module expects: an AES-GCM secret key that cannot be
 * exported and may encrypt and decrypt.
 *
 * @param {unknown} key
 * @returns {key is CryptoKey}
 */
function isUsableWrapKey(key) {
	if (typeof key !== 'object' || key === null) return false;
	if (typeof CryptoKey === 'function' && !(key instanceof CryptoKey)) return false;
	const candidate = /** @type {CryptoKey} */ (key);
	return (
		candidate.algorithm?.name === 'AES-GCM' &&
		candidate.extractable === false &&
		Array.isArray(candidate.usages) &&
		candidate.usages.includes('encrypt') &&
		candidate.usages.includes('decrypt')
	);
}

/**
 * Read the origin wrap key; with `create`, put one there when the database holds neither a wrap
 * key nor any record.
 *
 * Without `create`: resolves the stored key, or null when there is none. With `create`: the
 * candidate key is generated FIRST, outside any transaction (a transaction left idle across a
 * WebCrypto await commits on its own), then one readwrite transaction over both stores decides:
 * a stored key wins and the candidate is dropped; no stored key while any record exists aborts
 * with `DeviceKeyCorruptError('wrap-key')`; otherwise the candidate is stored. Two tabs racing
 * here therefore end with exactly one wrap key. Either way the key returned is validated.
 *
 * @param {IDBDatabase} db
 * @param {{ create?: boolean, subtle?: SubtleCrypto | undefined }} options
 * @returns {Promise<CryptoKey | null>}
 */
export async function loadWrapKey(db, { create = false, subtle } = {}) {
	if (!subtle || typeof subtle.generateKey !== 'function') {
		throw new DeviceKeyStorageUnavailableError('webcrypto');
	}
	if (!create) {
		const stored = await new Promise((resolve, reject) => {
			try {
				const tx = db.transaction(WRAP_STORE, 'readonly');
				const request = tx.objectStore(WRAP_STORE).get(WRAP_KEY_ID);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(new DeviceKeyStorageUnavailableError('read'));
				tx.onabort = () => reject(new DeviceKeyStorageUnavailableError('read'));
			} catch {
				reject(new DeviceKeyStorageUnavailableError('read'));
			}
		});
		if (stored === undefined) return null;
		if (!isUsableWrapKey(stored)) throw new DeviceKeyCorruptError('wrap-key');
		return stored;
	}

	/** @type {CryptoKey} */
	let candidate;
	try {
		candidate = /** @type {CryptoKey} */ (
			await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
		);
	} catch {
		throw new DeviceKeyStorageUnavailableError('webcrypto');
	}

	const chosen = await new Promise((resolve, reject) => {
		let settled = false;
		/** @type {unknown} */
		let result;
		let orphanedRecords = false;
		/** @param {Error} err */
		const fail = (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		};
		/** @type {IDBTransaction} */
		let tx;
		try {
			tx = db.transaction([WRAP_STORE, KEYS_STORE], 'readwrite');
		} catch {
			fail(new DeviceKeyStorageUnavailableError('write'));
			return;
		}
		const failure = () =>
			fail(orphanedRecords ? new DeviceKeyCorruptError('wrap-key') : new DeviceKeyStorageUnavailableError('write'));
		tx.oncomplete = () => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		tx.onerror = failure;
		tx.onabort = failure;
		const wrapRequest = tx.objectStore(WRAP_STORE).get(WRAP_KEY_ID);
		wrapRequest.onsuccess = () => {
			if (wrapRequest.result !== undefined) {
				result = wrapRequest.result;
				return;
			}
			const countRequest = tx.objectStore(KEYS_STORE).count();
			countRequest.onsuccess = () => {
				if (countRequest.result > 0) {
					orphanedRecords = true;
					tx.abort();
					return;
				}
				tx.objectStore(WRAP_STORE).put(candidate, WRAP_KEY_ID);
				result = candidate;
			};
		};
	});
	if (!isUsableWrapKey(chosen)) throw new DeviceKeyCorruptError('wrap-key');
	return chosen;
}

/**
 * Seal key material under the wrap key: a fresh 12-byte nonce per call.
 *
 * @param {{ subtle: SubtleCrypto, getRandomValues: (array: Uint8Array) => Uint8Array }} crypto
 * @param {CryptoKey} wrapKey
 * @param {Uint8Array} bytes
 * @param {Uint8Array} aad
 * @returns {Promise<SealedKeyRecord>}
 */
export async function sealKeyMaterial({ subtle, getRandomValues }, wrapKey, bytes, aad) {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError('sealKeyMaterial: key material must be a Uint8Array');
	}
	if (!subtle || typeof subtle.encrypt !== 'function' || typeof getRandomValues !== 'function') {
		throw new DeviceKeyStorageUnavailableError('webcrypto');
	}
	const iv = new Uint8Array(getRandomValues(new Uint8Array(IV_BYTES)));
	let sealed;
	try {
		sealed = await subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: new Uint8Array(aad) },
			wrapKey,
			new Uint8Array(bytes),
		);
	} catch {
		throw new DeviceKeyStorageUnavailableError('webcrypto');
	}
	return { v: RECORD_VERSION, iv, ct: new Uint8Array(sealed) };
}

/**
 * Open a sealed record. A record of the wrong shape is `DeviceKeyCorruptError('record')`; any
 * decrypt failure (wrong slot, wrong key, flipped byte) is `DeviceKeyCorruptError('ciphertext')`,
 * with no cause attached: it could carry nothing useful and must carry no bytes.
 *
 * @param {{ subtle: SubtleCrypto | undefined }} crypto
 * @param {CryptoKey} wrapKey
 * @param {unknown} record
 * @param {Uint8Array} aad
 * @returns {Promise<Uint8Array>}
 */
export async function openKeyMaterial({ subtle }, wrapKey, record, aad) {
	if (!subtle || typeof subtle.decrypt !== 'function') {
		throw new DeviceKeyStorageUnavailableError('webcrypto');
	}
	if (
		typeof record !== 'object' ||
		record === null ||
		Array.isArray(record) ||
		/** @type {{ v?: unknown }} */ (record).v !== RECORD_VERSION
	) {
		throw new DeviceKeyCorruptError('record');
	}
	const { iv, ct } = /** @type {{ iv?: unknown, ct?: unknown }} */ (record);
	if (!(iv instanceof Uint8Array) || iv.length !== IV_BYTES || !(ct instanceof Uint8Array) || ct.length < MIN_CT_BYTES) {
		throw new DeviceKeyCorruptError('record');
	}
	try {
		const opened = await subtle.decrypt(
			{ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(aad) },
			wrapKey,
			new Uint8Array(ct),
		);
		return new Uint8Array(opened);
	} catch {
		throw new DeviceKeyCorruptError('ciphertext');
	}
}
