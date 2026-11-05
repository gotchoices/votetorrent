/**
 * identity.js — Ephemeral per-tab libp2p identity over `sessionStorage`
 * (D-08, D-09).
 *
 * Three things a later reader cannot infer:
 *
 * (a) WHY `loadOrCreateBrowserPeerKey` (shipped by
 *     `@optimystic/db-p2p-storage-web`) IS FORBIDDEN HERE, per D-08. Its own
 *     docstring sells exactly what an anonymous public reader must never be
 *     handed: "a stable, reload-surviving identity." A libp2p peerId that
 *     survives a reload is a durable tracking identifier for a visitor who
 *     was never asked to identify themselves, let alone be tracked across
 *     visits.
 * (b) THE FORBIDDEN PATH AND THIS MODULE'S PATH SHARE A DATABASE HANDLE. The
 *     forbidden helper writes raw protobuf key bytes under the literal key
 *     `peer-private-key` into the `kv` object store of the database
 *     `openOptimysticWebDb` creates — the SAME database `edge-node.js` (this
 *     plan's other module) opens per strand for block storage. Keeping the
 *     two apart is a discipline enforced by never importing the forbidden
 *     helper from this file, not a structural accident that any refactor is
 *     safe to erode.
 * (c) D-09's ACCEPTED COST, STATED PLAINLY: key material sits briefly at
 *     rest in `sessionStorage`, a store any script running on the page
 *     origin can read (see threat T-56-05-01 in `56-05-PLAN.md`). Low
 *     stakes for a throwaway transport key that signs no VoteTorrent record
 *     and grants no read an anonymous peer does not already have — but
 *     real, and chosen deliberately over a memory-only key, which would pay
 *     a full reconnect-and-resubscribe cost on every same-tab reload.
 *
 * NOTE for a later reader: this module deliberately does NOT add an
 * import-closure scan for `loadOrCreateBrowserPeerKey`, a runtime assertion
 * that the `kv` store holds no `peer-private-key`, or a negative control on
 * such a scan. Those three mechanism-level controls were considered and
 * declined under D-11 — the owner chose one property-level control instead,
 * proved at the gateway in `56-13` (two page loads see different peerIds; a
 * reload within one tab reuses the same one). Do not resurrect the declined
 * controls here; keep the peerId dependent on nothing but the session slot.
 *
 * This module touches no store other than the one its caller passes in.
 */

import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';

/**
 * The one sessionStorage slot this module ever reads or writes. Named once,
 * here, and referenced everywhere else by this constant.
 * @type {string}
 */
export const SESSION_PEER_KEY_STORAGE_KEY = 'vt-public-peer-key';

/**
 * The `sessionStorage`-shaped subset this module actually uses. Typed as a
 * parameter (rather than reading `globalThis.sessionStorage` directly) is
 * what makes `loadOrCreateSessionPeerKey` testable under `node --test`,
 * which has no real `sessionStorage`. The browser call site passes
 * `globalThis.sessionStorage` itself.
 * @typedef {object} SessionLikeStorage
 * @property {(key: string) => (string | null)} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/** @type {Record<'+' | '/', string>} */
const BASE64_TO_URL_SAFE = { '+': '-', '/': '_' };

/**
 * Encodes raw key bytes as base64url text — the one place this module must
 * diverge from the forbidden helper, since `sessionStorage` holds strings
 * only while IndexedDB stores a `Uint8Array` natively. Pure; exported for
 * the round-trip test.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodePeerKeyBytes(bytes) {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError('encodePeerKeyBytes: expected a Uint8Array');
	}
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	return base64.replace(/[+/]/g, (ch) => BASE64_TO_URL_SAFE[/** @type {'+' | '/'} */ (ch)]).replace(/=+$/, '');
}

/**
 * Decodes base64url text back to raw bytes. Pure; exported for the
 * round-trip test. Throws on malformed input rather than returning partial
 * bytes — a caller that ignores the throw must never silently proceed with
 * garbage key material.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function decodePeerKeyBytes(text) {
	if (typeof text !== 'string' || text.length === 0) {
		throw new TypeError('decodePeerKeyBytes: expected a non-empty string');
	}
	if (!/^[A-Za-z0-9_-]+$/.test(text)) {
		throw new TypeError('decodePeerKeyBytes: input is not base64url text');
	}
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Loads this tab's ephemeral libp2p identity from `storage`, or generates
 * and persists a fresh Ed25519 key on first call. See the module header for
 * what this deliberately does NOT do, and why.
 *
 * Behaviour, in order:
 * 1. Read the slot. Any throw from `getItem` (private-mode / storage
 *    disabled) is treated as "no storage available at all" — proceed
 *    straight to generation and skip the write in step 4 entirely; retrying
 *    into another store would restore the persisted identity D-08 forbids
 *    by way of an error path.
 * 2. If a value is present, decode it and hand it to `privateKeyFromProtobuf`.
 *    If either step throws, discard the slot (`removeItem`) and fall through
 *    to generation. The raw stored bytes are never logged or surfaced.
 * 3. Generate a fresh key with `generateKeyPair('Ed25519')`.
 * 4. Serialise and store it under `SESSION_PEER_KEY_STORAGE_KEY`, unless
 *    step 1 already found storage unavailable. A throw from `setItem`
 *    (quota exceeded, storage disabled) is swallowed — this tab simply runs
 *    memory-only for the rest of this page load.
 *
 * @param {SessionLikeStorage} storage required — no default, so a caller
 *   must always be explicit about which store it means.
 * @returns {Promise<import('@libp2p/interface').PrivateKey>}
 */
export async function loadOrCreateSessionPeerKey(storage) {
	let storageAvailable = true;
	let stored = /** @type {string | null} */ (null);
	try {
		stored = storage.getItem(SESSION_PEER_KEY_STORAGE_KEY);
	} catch {
		storageAvailable = false;
	}

	if (storageAvailable && stored !== null) {
		try {
			return privateKeyFromProtobuf(decodePeerKeyBytes(stored));
		} catch {
			try {
				storage.removeItem(SESSION_PEER_KEY_STORAGE_KEY);
			} catch {
				// Storage is already unusable; fall through to generation regardless.
			}
		}
	}

	const key = await generateKeyPair('Ed25519');

	if (storageAvailable) {
		try {
			storage.setItem(SESSION_PEER_KEY_STORAGE_KEY, encodePeerKeyBytes(privateKeyToProtobuf(key)));
		} catch {
			// Quota exceeded / storage disabled mid-write — memory-only for this
			// load. Never retry into another store.
		}
	}

	return key;
}
