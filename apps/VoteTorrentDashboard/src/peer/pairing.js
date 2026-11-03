/**
 * pairing.js -- the browser half of pairing: a pasted or scanned pairing code becomes a verified,
 * admitted member device of the network's cadre, and every completed replication pass re-checks
 * that the pairing still stands.
 *
 * WHAT PAIRING IS (D-06, D-26). An officer's phone shows a single-use code. It carries two things:
 * an invitation that an OWNER of the network's cadre minted for this one pairing (single use, so
 * a copied code cannot admit a second browser), and a statement the OFFICER signed with their own
 * device key, naming the network, the officer, a nonce, an expiry and the phone that asked for
 * the code. The invitation admits the browser as a member DEVICE (D-01, D-04): it never holds an
 * officer key, and this file calls no signing API. The statement tells the browser which officer
 * it is working for; the browser verifies it against the network's own rows.
 *
 * THE ORDER, WHICH IS THE SECURITY PROPERTY. Decode; classify and verify against the held copy;
 * confirm; remove the old pairing; new device key PERSISTED; redeem; first sync; founding anchor;
 * statement; store; registry LAST. Nothing is deleted before the incoming officer verified against
 * the copy this browser already holds and the user confirmed a swap. The device key exists before
 * the single-use invitation is spent, so a lost reply is retried with the same identity rather than
 * burning the invitation on a second key.
 *
 * WHY THE ANCHOR PRECEDES THE STATEMENT. The statement is verified against Officer and UserKey rows
 * that arrived from strand peers. Those rows mean something only once the strand is proven to be
 * the network the code names: the founding rows must hash to the code's digest, derive the code's
 * network hash, name the code's authority as primary, and the code's Admin generation must be the
 * earliest one in the replica. Until that passes, a hostile peer could have served any rows.
 *
 * BEARER HYGIENE (R-9, R-10). The code, the invitation inside it and the statement are bearer
 * material. This file never logs, echoes or returns them, and never puts them in an error message.
 * Every log line is a fixed prefix and an error name; errors carry closed reasons only.
 *
 * THE PER-PASS CHECK (D-27). `checkPairingStillValid` runs after every completed replication pass.
 * It reads the revocation row for this pairing and re-verifies the statement's key and signature
 * (never its 15-minute expiry). The revocation row is trusted because the strand applied the
 * schema's CHECK when it was written; the row carries no signature the browser could re-verify.
 * Enforcement is cooperative, which is why owners also remove the browser's machine from the
 * cadre. Per R-B the check reads no Admin rows: an officer's removal from the administration does
 * not by itself unpair their browsers; revocation does.
 */

import { isPairingRevoked, verifyPairingStatement, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { isLegacyEntry } from '@votetorrent/web-data/officer';

/** The fixed prefix of every log line this module writes. */
const LOG_PREFIX = 'peer/pairing:';

/**
 * Log a failure by its error name and nothing else.
 *
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

// ── Closed sets and constants ───────────────────────────────────────────────

/** Every way `pairBrowser` can fail, in contract order. */
export const PAIR_FAILURES = Object.freeze(
	/** @type {const} */ ([
		'malformed',
		'old-style',
		'expired',
		'spent',
		'unreachable',
		'digest-mismatch',
		'officer-not-valid',
		'no-storage',
		'unsupported',
		'cancelled',
		'swap-declined',
	]),
);

/** The progress phases `pairBrowser` reports, each at most once and in this order. */
export const PAIR_PROGRESS_PHASES = Object.freeze(
	/** @type {const} */ (['verifying', 'connecting', 'joining', 'first-sync']),
);

/** The member node's join refusals mapped to pairing failures. */
export const JOIN_FAILURE_TO_PAIR_FAILURE = Object.freeze(
	/** @type {const} */ ({
		malformed: 'malformed',
		'not-invitation': 'malformed',
		'party-mismatch': 'malformed',
		invalid: 'malformed',
		'owner-key': 'malformed',
		spent: 'spent',
		removed: 'spent',
		unreachable: 'unreachable',
		cancelled: 'cancelled',
	}),
);

/** How many times one invitation is redeemed (the second only after an `unreachable`). */
export const PAIR_REDEEM_ATTEMPTS = 2;
/** The wait before the second redemption. */
export const PAIR_REDEEM_RETRY_DELAY_MS = 3_000;
/** The deadline, from the pairing instant, for the first sync, the founding check and the statement. */
export const PAIR_FIRST_SYNC_TIMEOUT_MS = 180_000;
/** The interval between reads while waiting for replicated rows. */
export const PAIR_SYNC_POLL_MS = 500;

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * The per-pass check could not read what it needs. NOT a signal to unpair: the caller keeps the
 * pairing and checks again on the next pass.
 */
export class PairingCheckUnavailableError extends Error {
	/** @param {'revocation' | 'statement'} subject */
	constructor(subject) {
		super('The pairing could not be checked right now.');
		this.name = 'PairingCheckUnavailableError';
		/** @type {'revocation' | 'statement'} */
		this.subject = subject;
	}
}

// ── Strand reader access ────────────────────────────────────────────────────

/**
 * The database a strand reader currently serves. `current()` re-resolves, waits for and prepares
 * the strand database (it can be rebuilt between reads), so it is awaited before every read and
 * never cached across reads.
 *
 * @param {{ current: () => Promise<any>, db?: any }} reader
 * @returns {Promise<any>}
 */
async function resolveStrandDb(reader) {
	const resolved = await reader.current();
	if (resolved !== undefined) return resolved;
	return reader.db;
}

/**
 * @param {unknown} db
 * @returns {db is { current: () => Promise<any> }}
 */
function isStrandReader(db) {
	return db !== null && typeof db === 'object' && typeof (/** @type {any} */ (db).current) === 'function';
}

// ── Per-pass check (D-27) ───────────────────────────────────────────────────

/**
 * @typedef {object} PairingCheckDeps
 * @property {typeof isPairingRevoked} [isPairingRevoked]
 * @property {typeof verifyPairingStatement} [verifyPairingStatement]
 * @property {() => string} [nowCanonical]
 */

/**
 * Is this browser's pairing for `networkHash` still valid?
 *
 * Callers wipe only on a resolved `{ ok: false }`. A rejection (`PairingCheckUnavailableError`)
 * means the check could not read its rows; the pairing stands until a later pass decides.
 *
 * `db` is the LOCAL store handle (call after a completed pass, which has just replicated the
 * pairing tables into it), or a strand reader (an object whose `current` is a function), whose
 * database is re-resolved before each read.
 *
 * @param {{ db: any, networkHash: string, entry: import('@votetorrent/web-data/officer').NetworkRegistryEntry, deps?: PairingCheckDeps }} options
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'revoked' | 'key-invalid' }>}
 */
export async function checkPairingStillValid({ db, networkHash, entry, deps = {} }) {
	if (db === null || db === undefined) {
		throw new TypeError('checkPairingStillValid: db is required');
	}
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('checkPairingStillValid: networkHash must be a non-empty string');
	}
	if (entry === null || typeof entry !== 'object' || isLegacyEntry(entry)) {
		throw new TypeError('checkPairingStillValid: entry must be a paired registry entry');
	}
	if (entry.networkHash !== networkHash) {
		throw new TypeError('checkPairingStillValid: entry belongs to a different network');
	}
	const pairing = /** @type {import('@votetorrent/web-data/officer').PairingRecord} */ (entry.pairing);
	const revoked = deps.isPairingRevoked ?? isPairingRevoked;
	const verify = deps.verifyPairingStatement ?? verifyPairingStatement;
	const nowCanonical = deps.nowCanonical ?? nowCanonicalDatetime;
	const reader = isStrandReader(db) ? db : null;

	let isRevoked;
	try {
		const handle = reader ? await resolveStrandDb(reader) : db;
		isRevoked = await revoked(handle, { userId: entry.officerUserId, nonce: pairing.nonce });
	} catch (err) {
		logFailure(err);
		throw new PairingCheckUnavailableError('revocation');
	}
	if (isRevoked === true) return { ok: false, reason: 'revoked' };

	const statement = {
		userId: entry.officerUserId,
		requesterPeerId: pairing.requesterPeerId,
		nonce: pairing.nonce,
		expiresAt: pairing.expiresAt,
		keyPub: pairing.keyPub,
		sig: pairing.sig,
	};
	let result;
	try {
		const handle = reader ? await resolveStrandDb(reader) : db;
		// C-3: a per-pass check never applies the statement's 15-minute expiry.
		result = await verify(handle, { networkHash, statement, nowCanonical: nowCanonical(), checkExpiry: false });
	} catch (err) {
		logFailure(err);
		throw new PairingCheckUnavailableError('statement');
	}
	if (result && result.ok === true) return { ok: true };
	return { ok: false, reason: 'key-invalid' };
}
