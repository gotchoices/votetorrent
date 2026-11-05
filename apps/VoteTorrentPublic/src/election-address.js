/**
 * election-address.js — the pure, never-throwing URL election-address
 * parser (D-14, ASVS V5). No React, no DOM, no import of anything under
 * `test/`.
 *
 * Six things a later reader cannot infer:
 *
 * 1. `'missing'` is not `'malformed'`. The shipped root URL — the one every
 *    real visitor lands on first — carries no `election` parameter at all,
 *    and that is the page's ordinary, honest state, not a broken one. Only
 *    a parameter that IS present and fails validation is `'malformed'`.
 * 2. A repeated `election` parameter is `'malformed'`, never "first wins".
 *    This page's entire purpose is that its claims can be checked; an
 *    address that could mean two different elections must refuse rather
 *    than silently pick one, because the visitor and the page could
 *    silently disagree about which id "the" address means.
 * 3. `electionId` is `null` in the `'malformed'` case, on purpose. The
 *    offending value is never returned to a caller, so nobody can later
 *    "improve" the not-found message by interpolating the rejected value
 *    back into the page — there is nothing to interpolate.
 * 4. The lifecycle comparison instant this app renders against is
 *    deliberately NOT a URL parameter (see `ElectionShell.tsx`'s `at`
 *    prop). If it were readable from the query string, a link author could
 *    choose which lifecycle phase any visitor is shown — a false claim
 *    about an election's state, on a page whose only value is that its
 *    claims can be checked. That threat is named in this plan's own
 *    threat model as T-53-07-04; naming it here too so a reader of this
 *    file does not have to go looking for why `at` is not parsed alongside
 *    `election`.
 * 5. There are TWO parameters, not one, and that is forced rather than
 *    stylistic (D-33). A browser holds one IndexedDB per network
 *    (`votetorrent-<networkHash>`, tracked in a localStorage registry) and a
 *    network holds SEVERAL elections, so an election id alone cannot resolve
 *    unambiguously: the page would have to walk the registry and take the
 *    first network that happened to hold a matching id, making the answer a
 *    function of registry ORDER. On a page whose entire value is that its
 *    claims can be checked, an answer that depends on the order of a local
 *    inventory is not checkable. So the address names both, in the same
 *    module, read by `URLSearchParams` — a second parameter alongside
 *    `election`, never a second module and never a router library (53-D14).
 * 6. `'incomplete'` is the fourth status, and it is NOT a synonym for
 *    `'malformed'`. Nothing is wrong with the value; the address is merely
 *    under-specified, naming one identifier where two are required. The
 *    honest response to that is D-34's index of what this browser holds, not
 *    an "unreadable address" error for a link whose only fault is that it is
 *    half an address. `'malformed'` ALWAYS WINS over `'incomplete'`, because
 *    a present-but-rejected value is a refusal regardless of what the other
 *    parameter says — and on `'malformed'` BOTH `electionId` and
 *    `networkHash` go `null`, extending point 3 across the whole address, so
 *    a crafted `network` beside a valid `election` leaves nothing anywhere
 *    for a later "improvement" to interpolate back into the page.
 *
 * Validate the DECODED value, never the raw query string — validating
 * before decoding is the classic ASVS V5 bypass (a value that looks benign
 * percent-encoded can decode into something the pattern would reject, and
 * the reverse: a value that looks like it fails could decode into
 * something that passes). `URLSearchParams` performs WHATWG percent-
 * decoding and `+` → space conversion for us; this module never touches
 * the raw string itself.
 *
 * This function must NEVER throw. A public verifiability page that
 * white-screens on a hand-edited URL has failed at exactly the moment
 * someone was checking its work — so `typeof search !== 'string'` is
 * guarded up front, and the parse itself is wrapped so any unexpected
 * `URLSearchParams` behaviour degrades to `'missing'` rather than an
 * uncaught exception.
 */

/** The one URL query parameter this app ever reads (T-53-07-04). @type {string} */
export const ELECTION_ADDRESS_PARAM = 'election';

/**
 * Deliberately looser than the repo's existing 43-character base64url digest
 * idiom (`apps/VoteTorrentDashboard/src/transport/bootstrap-transport-client.js`'s
 * `DIGEST_PATTERN`) — `Election.Id` (`packages/vote-core/schema/votetorrent.qsql:828`)
 * is documented only as a "32 byte random id" with no encoding constraint and
 * no CHECK, so pinning the 43-character base64url form here would reject a
 * real id in Phase 54. This pattern is purely syntactic: 1-128 characters of
 * unreserved URL-safe text, applied to the PERCENT-DECODED value.
 * @type {RegExp}
 */
export const ELECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The second URL query parameter, and the last one this app ever reads
 * (D-33; header point 5). @type {string} */
export const NETWORK_ADDRESS_PARAM = 'network';

/**
 * Its OWN RegExp literal, deliberately NOT an alias of `ELECTION_ID_PATTERN`:
 * the two subjects are independent, and a later tightening of one must not
 * silently tighten the other.
 *
 * Where this pattern comes from, since it cannot be derived from the schema:
 * `networkHash` originates in a bootstrap envelope and carries NO CHECK
 * constraint anywhere in `packages/vote-core/schema/votetorrent.qsql` — unlike
 * `Election.Id`, whose own looseness at least has a documented column to point
 * at. What it CAN be derived from is the value's DESTINATION.
 * `dbNameFor` in `@votetorrent/web-data/public` concatenates this value into
 * the IndexedDB store name `votetorrent-<networkHash>`, and `openStoreHandle`
 * CREATES an absent store rather than refusing one. So a value that reaches
 * that boundary chooses which local store is opened, and an unconstrained one
 * would let a link author plant an empty database in a stranger's browser — a
 * WRITE, on a page whose whole premise is anonymous read-only viewing. Every
 * character that is not unreserved-URL-safe is therefore rejected here, before
 * the value can travel any further (T-54-11-02's syntactic half; the
 * structural half is `election-index-source.js`, which only ever passes a hash
 * it read out of the browser's own networks registry).
 * @type {RegExp}
 */
export const NETWORK_HASH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @typedef {object} ElectionAddress
 * @property {'missing' | 'incomplete' | 'malformed' | 'ok'} status
 * @property {string | null} electionId
 * @property {string | null} networkHash
 */

/** One parameter was absent, or present with an empty value (which is absence,
 * not corruption — header point 1). @type {symbol} */
const ABSENT = Symbol('absent');

/** One parameter was present and refused: repeated, or failing its pattern.
 * @type {symbol} */
const INVALID = Symbol('invalid');

/**
 * The per-parameter half of the parse, factored out so the two parameters
 * CANNOT DRIFT APART in their validation discipline — which is the entire
 * reason this helper exists rather than two inline blocks. Internal on
 * purpose: it is not part of this module's contract.
 *
 * It takes the ALREADY-READ value list rather than the `URLSearchParams` and a
 * parameter name, so that every `getAll` call site in this file still names its
 * parameter through the exported constant. `election-shell.test.mjs`'s
 * one-parameter-set scan resolves a call site's argument back to a literal, and
 * a name arriving as a function argument would resolve to nothing — turning a
 * live tier-1 gate into an unresolved-name failure. The factoring is kept; only
 * the seam moves one call outwards.
 *
 * @param {ReadonlyArray<string>} values every decoded value under one parameter name.
 * @param {RegExp} pattern
 * @returns {symbol | string} `ABSENT`, `INVALID`, or the DECODED value.
 */
function readParam(values, pattern) {
	if (values.length === 0) return ABSENT;
	// An ambiguous address on a page whose purpose is verifiability must
	// refuse rather than pick — see header point 2, for EACH parameter
	// independently.
	if (values.length > 1) return INVALID;
	const decoded = values[0];
	if (decoded === '') return ABSENT;
	if (!pattern.test(decoded)) return INVALID;
	return decoded;
}

/** The one shape with no variable part at all. Frozen once; the function
 * returns this exact object for every `'missing'` path. @type {Readonly<ElectionAddress>} */
const MISSING = Object.freeze({ status: 'missing', electionId: null, networkHash: null });

/**
 * Parse a `location.search`-shaped string into an `ElectionAddress`. Never
 * throws — the parameter type is deliberately `unknown`, not `string`,
 * because a hand-edited URL or a caller passing the wrong prop shape is
 * exactly the hostile input this function must survive without an
 * uncaught exception; the `typeof` guard below is this function's real
 * boundary, not its JSDoc type. The returned object is frozen.
 *
 * @param {unknown} search
 * @returns {Readonly<ElectionAddress>}
 */
export function parseElectionAddress(search) {
	if (typeof search !== 'string') {
		return MISSING;
	}

	try {
		const params = new URLSearchParams(search);
		const network = readParam(params.getAll(NETWORK_ADDRESS_PARAM), NETWORK_HASH_PATTERN);
		const election = readParam(params.getAll(ELECTION_ADDRESS_PARAM), ELECTION_ID_PATTERN);

		// 'malformed' ALWAYS wins, and takes BOTH fields down with it — header
		// point 6. A crafted value beside a valid one is still a refusal, and
		// the valid one must not survive as something renderable.
		if (network === INVALID || election === INVALID) {
			return Object.freeze({ status: 'malformed', electionId: null, networkHash: null });
		}
		if (network === ABSENT && election === ABSENT) {
			return MISSING;
		}
		if (network === ABSENT) {
			return Object.freeze({ status: 'incomplete', electionId: /** @type {string} */ (election), networkHash: null });
		}
		if (election === ABSENT) {
			return Object.freeze({ status: 'incomplete', electionId: null, networkHash: /** @type {string} */ (network) });
		}
		return Object.freeze({
			status: 'ok',
			electionId: /** @type {string} */ (election),
			networkHash: /** @type {string} */ (network),
		});
	} catch {
		return MISSING;
	}
}
