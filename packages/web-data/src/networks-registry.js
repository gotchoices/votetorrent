/**
 * networks-registry.js -- outline contract 4: the localStorage inventory of
 * networks this browser holds a local copy of.
 *
 * This is the switcher's ONLY source of truth (50-09) and it deliberately
 * NEVER duplicates snapshot content -- no row counts, no digests, no table
 * data. Those live in 50-05's separate contract-C5 row-count record
 * (`votetorrent.dashboard.rowcounts.${networkHash}`, a DIFFERENT web-storage
 * key -- neither plan edits the other's storage shape.
 *
 * Per D-16's honesty rule: this is an INVENTORY, not a security control.
 * Anyone who can edit this origin's web storage can edit its IndexedDB too.
 *
 * LIVE ENTRIES (contract C-8). A paired network's entry also holds the
 * pairing record: the signed pairing statement's fields (including the
 * requesting phone's identity peer id, which the signature covers, so the
 * per-pass re-check can rebuild the signed digest), the code's relay
 * addresses and the strand id. It NEVER holds the pairing code, the join
 * code, the invitation or any key material beyond the statement's public
 * `keyPub`: the exact-key validation below rejects any other key, naming
 * the key and never its value, and that is what enforces it. `officerUserId`
 * must be the VERIFIED user id; its writer (the pairing flow) guarantees
 * that, and this file cannot check it. `officerName` is display text only.
 *
 * A legacy (snapshot-era) entry has `bootstrappedAt` and no pairing record;
 * it reads back with `pairing: null`, and `isLegacyEntry` is true for it.
 * Upserting a paired entry for the same hash replaces it in place.
 *
 * `lastPassAt` (optional, epoch ms) records the last completed replication
 * pass so an offline reload can say when the copy was last updated.
 * `recordLastPassAt` only moves it forward and only on an existing paired
 * entry: a pass that completes after the network was forgotten must not
 * re-create the entry. Throttling those writes is the caller's job.
 *
 * Deliberately SYNCHRONOUS (unlike 50-05's reattach.js, whose read/write
 * functions are async): `src/main.tsx` needs a synchronous "does this
 * browser hold any network" check at render time, and `localStorage` access
 * is inherently synchronous. `src/lifecycle/bootstrap.js` calls these
 * directly from inside its own async orchestration -- calling a sync
 * function from async code needs no `await`.
 */

/** @type {'votetorrent.dashboard.networks'} */
export const NETWORKS_REGISTRY_KEY = 'votetorrent.dashboard.networks';

/** A stored registry entry, or the whole registry blob, failed shape validation.
 * Names the offending FIELD NAME only -- `authorityName`/`domain` are snapshot
 * content and must never be interpolated into a thrown message. */
export class InvalidNetworkRegistryError extends Error {
	/**
	 * @param {string} field
	 * @param {string} reason
	 */
	constructor(field, reason) {
		super(`networks-registry: field "${field}" is invalid -- ${reason}`);
		this.name = 'InvalidNetworkRegistryError';
		this.field = field;
	}
}

/**
 * @typedef {{ getItem(key: string): string | null | undefined, setItem(key: string, value: string): void, removeItem(key: string): void }} StorageAdapter
 */

/**
 * The pairing record a live (paired) entry carries (contract C-8): the signed
 * pairing statement's fields, the code's relay addresses and the strand id.
 * Never the join code, the invitation or any key material beyond the
 * statement's public `keyPub`.
 *
 * @typedef {object} PairingRecord
 * @property {1} v
 * @property {string} requesterPeerId - the requesting officer phone's identity peer id, verbatim from the statement
 * @property {string} nonce
 * @property {string} expiresAt - 19-char canonical datetime
 * @property {string} keyPub - hex, 66 or 130 chars, letter case preserved
 * @property {string} sig - hex signature
 * @property {string} pairedAt - 19-char canonical datetime
 * @property {string[]} relayAddrs - 1..PAIRING_RELAY_ADDRS_MAX multiaddr strings
 * @property {string} strandId
 */

/**
 * @typedef {object} NetworkRegistryEntry
 * @property {string} networkHash
 * @property {string} authorityName
 * @property {string} domain
 * @property {string} officerUserId - the VERIFIED user id; its writer guarantees that, this file cannot
 * @property {string} [officerName] - display text only, never an identity
 * @property {string} [bootstrappedAt] - legacy (snapshot-era) entries only
 * @property {PairingRecord | null} pairing - null for a legacy entry
 * @property {number} [lastPassAt] - epoch ms of the last completed replication pass
 */

/** The allowed top-level keys. Any other key is rejected, naming it. */
const ENTRY_FIELDS = /** @type {const} */ ([
	'networkHash',
	'authorityName',
	'domain',
	'officerUserId',
	'officerName',
	'bootstrappedAt',
	'pairing',
	'lastPassAt',
]);

/** The four identity strings every entry must carry. */
const IDENTITY_FIELDS = /** @type {const} */ (['networkHash', 'authorityName', 'domain', 'officerUserId']);

/** The pairing record's exact keys, all required. */
const PAIRING_FIELDS = /** @type {const} */ ([
	'v',
	'requesterPeerId',
	'nonce',
	'expiresAt',
	'keyPub',
	'sig',
	'pairedAt',
	'relayAddrs',
	'strandId',
]);

/** The most relay addresses a pairing record keeps. */
export const PAIRING_RELAY_ADDRS_MAX = 16;

const OFFICER_NAME_MAX = 200;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const PEER_ID_RE = /^[\x21-\x7e]+$/;
const PEER_ID_MAX = 128;
const NONCE_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_MAX = 64;
const HEX_RE = /^[0-9a-fA-F]+$/;
const SIG_MIN = 2;
const SIG_MAX = 160;
const RELAY_ADDR_MAX = 1024;
const STRAND_ID_RE = /^[^\s\u0000-\u001f]+$/;
const STRAND_ID_MAX = 256;

/**
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter | undefined}
 */
function resolveStorage(storage) {
	if (storage) return storage;
	return typeof globalThis !== 'undefined' ? /** @type {StorageAdapter | undefined} */ (globalThis.localStorage) : undefined;
}

/**
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter}
 */
function requireStorage(storage) {
	const s = resolveStorage(storage);
	if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') {
		throw new TypeError(
			'networks-registry.js: no storage adapter available -- pass one explicitly (e.g. a Map-backed fake in a Node test) or run in an environment with localStorage',
		);
	}
	return s;
}

/**
 * A canonical datetime: a string of exactly 19 characters with no "Z".
 * Never interpolates the value itself.
 *
 * @param {string} field
 * @param {unknown} value
 * @returns {string}
 */
function assertCanonical(field, value) {
	if (typeof value !== 'string') {
		throw new InvalidNetworkRegistryError(field, 'must be a string');
	}
	if (value.length !== 19) {
		throw new InvalidNetworkRegistryError(field, `must be exactly 19 characters, got ${value.length}`);
	}
	if (value.includes('Z')) {
		throw new InvalidNetworkRegistryError(field, 'must not contain "Z" -- canonical datetimes carry no timezone suffix');
	}
	return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isEpochMs(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the pairing record against its exact keys. Every failure names the
 * field as `pairing.<name>` with a fixed reason; no value is ever put in a
 * message.
 *
 * @param {unknown} candidate
 * @returns {PairingRecord}
 */
function validatePairing(candidate) {
	if (!isPlainObject(candidate)) {
		throw new InvalidNetworkRegistryError('pairing', 'must be null or an object');
	}
	const p = /** @type {Record<string, unknown>} */ (candidate);

	for (const key of Object.keys(p)) {
		if (!PAIRING_FIELDS.includes(/** @type {typeof PAIRING_FIELDS[number]} */ (key))) {
			throw new InvalidNetworkRegistryError('pairing.' + key, 'is not a recognized pairing field');
		}
	}

	if (p.v !== 1) {
		throw new InvalidNetworkRegistryError('pairing.v', 'must be 1');
	}

	const requesterPeerId = p.requesterPeerId;
	if (
		typeof requesterPeerId !== 'string' ||
		requesterPeerId.length === 0 ||
		requesterPeerId.length > PEER_ID_MAX ||
		!PEER_ID_RE.test(requesterPeerId)
	) {
		throw new InvalidNetworkRegistryError(
			'pairing.requesterPeerId',
			'must be 1 to 128 printable ASCII characters with no space',
		);
	}

	const nonce = p.nonce;
	if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > NONCE_MAX || !NONCE_RE.test(nonce)) {
		throw new InvalidNetworkRegistryError('pairing.nonce', 'must be 1 to 64 base64url characters');
	}

	const expiresAt = assertCanonical('pairing.expiresAt', p.expiresAt);
	const pairedAt = assertCanonical('pairing.pairedAt', p.pairedAt);

	const keyPub = p.keyPub;
	if (typeof keyPub !== 'string' || !HEX_RE.test(keyPub) || (keyPub.length !== 66 && keyPub.length !== 130)) {
		throw new InvalidNetworkRegistryError('pairing.keyPub', 'must be hex of 66 or 130 characters');
	}

	const sig = p.sig;
	if (
		typeof sig !== 'string' ||
		!HEX_RE.test(sig) ||
		sig.length % 2 !== 0 ||
		sig.length < SIG_MIN ||
		sig.length > SIG_MAX
	) {
		throw new InvalidNetworkRegistryError('pairing.sig', 'must be even-length hex of 2 to 160 characters');
	}

	const relayAddrs = p.relayAddrs;
	if (!Array.isArray(relayAddrs) || relayAddrs.length === 0 || relayAddrs.length > PAIRING_RELAY_ADDRS_MAX) {
		throw new InvalidNetworkRegistryError('pairing.relayAddrs', 'must be an array of 1 to 16 addresses');
	}
	for (const addr of relayAddrs) {
		if (typeof addr !== 'string' || !addr.startsWith('/') || addr.length > RELAY_ADDR_MAX) {
			throw new InvalidNetworkRegistryError(
				'pairing.relayAddrs',
				'each address must be a string starting with "/" of at most 1024 characters',
			);
		}
	}

	const strandId = p.strandId;
	if (
		typeof strandId !== 'string' ||
		strandId.length === 0 ||
		strandId.length > STRAND_ID_MAX ||
		!STRAND_ID_RE.test(strandId)
	) {
		throw new InvalidNetworkRegistryError(
			'pairing.strandId',
			'must be 1 to 256 characters with no whitespace or control character',
		);
	}

	return {
		v: 1,
		requesterPeerId,
		nonce,
		expiresAt,
		keyPub,
		sig,
		pairedAt,
		relayAddrs: [.../** @type {string[]} */ (relayAddrs)],
		strandId,
	};
}

/**
 * Validate one candidate entry against the allowed keys -- used on BOTH read
 * and write, so a hand-mangled stored blob is caught the same way a bad write
 * would be. Never interpolates a value into the thrown message. Returns a NEW
 * normalized object.
 *
 * @param {unknown} candidate
 * @returns {NetworkRegistryEntry}
 */
function validateEntry(candidate) {
	if (!isPlainObject(candidate)) {
		throw new InvalidNetworkRegistryError('(entry)', 'must be an object');
	}
	const entry = /** @type {Record<string, unknown>} */ (candidate);

	for (const key of Object.keys(entry)) {
		if (!ENTRY_FIELDS.includes(/** @type {typeof ENTRY_FIELDS[number]} */ (key))) {
			throw new InvalidNetworkRegistryError(key, 'is not a recognized registry field');
		}
	}
	for (const field of IDENTITY_FIELDS) {
		if (typeof entry[field] !== 'string') {
			throw new InvalidNetworkRegistryError(field, 'must be a string');
		}
	}

	const rawPairing = entry.pairing === undefined ? null : entry.pairing;
	/** @type {PairingRecord | null} */
	const pairing = rawPairing === null ? null : validatePairing(rawPairing);

	/** @type {string | undefined} */
	let bootstrappedAt;
	if (entry.bootstrappedAt !== undefined) {
		bootstrappedAt = assertCanonical('bootstrappedAt', entry.bootstrappedAt);
	} else if (pairing === null) {
		throw new InvalidNetworkRegistryError('bootstrappedAt', 'must be a string');
	}

	/** @type {string | undefined} */
	let officerName;
	if (entry.officerName !== undefined) {
		if (typeof entry.officerName !== 'string') {
			throw new InvalidNetworkRegistryError('officerName', 'must be a string');
		}
		const trimmed = entry.officerName.trim();
		if (trimmed.length === 0 || trimmed.length > OFFICER_NAME_MAX || CONTROL_CHAR_RE.test(trimmed)) {
			throw new InvalidNetworkRegistryError(
				'officerName',
				'must be 1 to 200 characters after trimming, with no control character',
			);
		}
		officerName = trimmed;
	}

	/** @type {number | undefined} */
	let lastPassAt;
	if (entry.lastPassAt !== undefined) {
		if (!isEpochMs(entry.lastPassAt)) {
			throw new InvalidNetworkRegistryError('lastPassAt', 'must be a non-negative safe integer');
		}
		lastPassAt = entry.lastPassAt;
	}

	/** @type {NetworkRegistryEntry} */
	const normalized = {
		networkHash: /** @type {string} */ (entry.networkHash),
		authorityName: /** @type {string} */ (entry.authorityName),
		domain: /** @type {string} */ (entry.domain),
		officerUserId: /** @type {string} */ (entry.officerUserId),
		...(officerName !== undefined ? { officerName } : {}),
		...(bootstrappedAt !== undefined ? { bootstrappedAt } : {}),
		pairing,
		...(lastPassAt !== undefined ? { lastPassAt } : {}),
	};
	return normalized;
}

/**
 * True iff `entry` is a registry entry with no pairing record: a legacy
 * (snapshot-era) entry. Such a network goes through pairing before its store
 * is opened live.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isLegacyEntry(entry) {
	return (
		entry !== null &&
		typeof entry === 'object' &&
		(/** @type {any} */ (entry).pairing === null || /** @type {any} */ (entry).pairing === undefined)
	);
}

/**
 * Read the whole registry. Fails SOFT (returns `[]`) on absent, empty-string
 * or non-array storage content -- a first visit and a cleared origin are
 * both normal. Fails HARD (throws, naming the field) on a parseable array
 * whose ENTRIES are structurally wrong -- that is corruption, and silently
 * dropping it would strand the officer's networks with no explanation. This
 * asymmetry is deliberate.
 *
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry[]}
 */
export function listNetworks(storage) {
	const s = requireStorage(storage);
	const raw = s.getItem(NETWORKS_REGISTRY_KEY);
	if (raw === null || raw === undefined || raw === '') return [];

	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	return parsed.map((entry) => validateEntry(entry));
}

/**
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry | undefined}
 */
export function findNetwork(networkHash, storage) {
	return listNetworks(storage).find((entry) => entry.networkHash === networkHash);
}

/**
 * Append a new `networkHash`, or REPLACE an existing one IN PLACE (preserving
 * the order of every other entry) -- two different hashes coexist (D-08).
 *
 * @param {unknown} entry
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry}
 */
export function upsertNetwork(entry, storage) {
	const s = requireStorage(storage);
	const validated = validateEntry(entry);
	const all = listNetworks(storage);
	const index = all.findIndex((e) => e.networkHash === validated.networkHash);
	if (index === -1) {
		all.push(validated);
	} else {
		all[index] = validated;
	}
	s.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify(all));
	return validated;
}

/**
 * Remove one entry. A no-op on an unknown hash -- leaves every other entry
 * untouched.
 *
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {void}
 */
export function removeNetwork(networkHash, storage) {
	const s = requireStorage(storage);
	const all = listNetworks(storage);
	const filtered = all.filter((e) => e.networkHash !== networkHash);
	s.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify(filtered));
}

/**
 * Record the time of the last completed replication pass on a paired entry.
 *
 * Writes only to an existing PAIRED entry and only forward: a value at or
 * below the stored one returns the entry unchanged with no write. An absent
 * or legacy entry returns `undefined` with no write at all, so a pass that
 * completes after a forget never re-adds the network. Throttling is the
 * caller's job.
 *
 * @param {string} networkHash
 * @param {number} lastPassAt epoch ms
 * @param {StorageAdapter} [storage]
 * @returns {NetworkRegistryEntry | undefined}
 */
export function recordLastPassAt(networkHash, lastPassAt, storage) {
	if (!isEpochMs(lastPassAt)) {
		throw new InvalidNetworkRegistryError('lastPassAt', 'must be a non-negative safe integer');
	}
	const s = requireStorage(storage);
	const all = listNetworks(storage);
	const index = all.findIndex((e) => e.networkHash === networkHash);
	if (index === -1) return undefined;
	const current = all[index];
	if (isLegacyEntry(current)) return undefined;
	if (current.lastPassAt !== undefined && lastPassAt <= current.lastPassAt) return current;

	const updated = validateEntry({ ...current, lastPassAt });
	all[index] = updated;
	s.setItem(NETWORKS_REGISTRY_KEY, JSON.stringify(all));
	return updated;
}
