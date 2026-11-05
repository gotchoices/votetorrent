/**
 * election-index-source.js — the registry-walking read seam behind D-34's
 * index: registry -> attach -> list -> close, never throwing, reporting both
 * WHAT it found and WHETHER the finding is complete.
 *
 * Plain JavaScript with JSDoc, no JSX and no React — a pure module beside the
 * screens, the same placement `election-address.js` uses.
 *
 * Five things a later reader cannot infer:
 *
 * 1. THE URL NEVER NAMES A DATABASE. `attachNetworkDb` calls
 *    `openStoreHandle`, which CREATES an absent store rather than refusing
 *    one. On a page that takes its network identifier from the URL (D-33), an
 *    unguarded attach would let a link author plant an empty database in a
 *    stranger's browser — a WRITE, on a page whose entire premise is anonymous
 *    read-only viewing. So a requested hash is only ever used to SELECT AMONG
 *    the entries this browser's own networks registry already holds; the value
 *    handed to `attachNetworkDb` always comes out of the registry, never out
 *    of `options`. Registry membership, not the URL, is what authorises a
 *    store name. That is the structural half of T-54-11-02; the syntactic half
 *    is `NETWORK_HASH_PATTERN` in `election-address.js`.
 * 2. A FAULT IS NOT A FACT. `listNetworks` fails SOFT (`[]`) for an absent or
 *    cleared origin — the ordinary first-visit state — and fails HARD (throws)
 *    for a structurally corrupt stored entry. Those two are DIFFERENT ANSWERS
 *    and this module keeps them apart: the soft one is "this browser holds
 *    nothing", a settled finding; the hard one is "this browser's holdings
 *    could not be established", which is `complete: false`. Collapsing the
 *    second into the first would put a false sentence on the page — precisely
 *    the D-28 failure class this phase exists to correct.
 * 3. `complete` IS THE LOAD-BEARING FIELD, and it is what the render layer
 *    uses to decide whether the "no elections" sentence ships QUALIFIED. It
 *    deliberately covers TWO faults: a registry that could not be parsed
 *    (where `networksUnreadable` stays `0`, because nothing was attempted) and
 *    a held network that could not be attached (where it is nonzero). A render
 *    layer gating its qualifier on the COUNTER rather than on this flag would
 *    let exactly the corrupt-registry case render an unqualified claim.
 * 4. THE MERGED ORDER IS A FUNCTION OF THE ELECTION DATA, never of the
 *    registry's order. That is the same ambiguity D-33 cites as its reason for
 *    naming both identifiers in the address: an answer that depends on the
 *    order of a local inventory is not checkable, on a page whose only value
 *    is that its claims can be checked.
 * 5. THE `deps` PARAMETER IS A TEST SEAM OVER THE REAL MODULES, NOT A FIXTURE.
 *    Its default IS the real import surface (`DEFAULT_INDEX_DEPS`), and no
 *    alternative implementation ships anywhere under `src/`. 53-D17 forbids a
 *    fixture in production code and a reader must be able to tell the two
 *    apart at a glance — hence this paragraph rather than a bare parameter.
 *
 * This module LOGS NOTHING and THROWS NOTHING, so the standing rule that an
 * error message must never interpolate a row value or a registry value is
 * discharged by construction. A later `console.error(entry)` here is visibly a
 * regression against this sentence, not a judgement call.
 *
 * Reaches the shared data package by its BARE public subpath only — never a
 * deep path into the package's own sources, and never its officer half. D-04's
 * audience split is structural, and this module is the public app's first
 * consumer of the package; it must not be the one that collapses it.
 */

import { listNetworks, attachNetworkDb, closeNetworkDb, listPublicElections } from '@votetorrent/web-data/public';

/**
 * @typedef {object} HeldElection
 * @property {string} networkHash
 * @property {string} electionId
 * @property {string | null} title
 */

/**
 * The internal, pre-merge row. Carries the election day ONLY so the merge can
 * order by it; it is dropped before anything is returned, because D-26 makes
 * instant display a reader-local, zone-labelled concern owned by a later plan,
 * and an unlabelled date on the index would pre-empt it with a different
 * convention.
 * @typedef {object} IndexRow
 * @property {string} networkHash
 * @property {string} electionId
 * @property {string | null} title
 * @property {string} date
 */

/**
 * @typedef {object} HeldElectionsResult
 * @property {ReadonlyArray<HeldElection>} elections
 * @property {number} networksAttempted
 * @property {number} networksUnreadable
 * @property {boolean} complete  true iff the registry read AND every attempted network succeeded
 */

/**
 * @typedef {object} IndexDeps
 * @property {(storage?: any) => any} listNetworks
 * @property {(networkHash: string, options?: any) => Promise<any>} attachNetworkDb
 * @property {(db: any) => any} closeNetworkDb
 * @property {(db: any) => Promise<any>} listPublicElections
 */

/**
 * @typedef {object} LoadHeldElectionsOptions
 * @property {string | null} [networkHash] the address's network, used ONLY to select among held entries.
 * @property {any} [storage] the `StorageAdapter` injection idiom `networks-registry.js` established.
 */

/** The real import surface, and the default. @type {Readonly<IndexDeps>} */
export const DEFAULT_INDEX_DEPS = Object.freeze({
	listNetworks,
	attachNetworkDb,
	closeNetworkDb,
	listPublicElections,
});

/**
 * Merge every network's rows into one deterministic list: election day
 * DESCENDING, ties broken by election id ASCENDING, and — only if those two
 * are identical — by network hash, so the ordering is TOTAL and two runs can
 * never disagree. Every key is a property of the data; none is a position in
 * the registry (header point 4).
 *
 * `Date` is used here and dropped here: the returned shape carries no instant.
 *
 * Pure: it reads nothing, opens nothing, and returns a frozen array of frozen
 * objects.
 *
 * @param {ReadonlyArray<ReadonlyArray<IndexRow>>} perNetworkRows
 * @returns {ReadonlyArray<HeldElection>}
 */
export function mergeHeldElections(perNetworkRows) {
	/** @type {IndexRow[]} */
	const flat = [];
	for (const rows of perNetworkRows ?? []) {
		for (const r of rows ?? []) flat.push(r);
	}

	flat.sort((a, b) => {
		const ad = String(a.date ?? '');
		const bd = String(b.date ?? '');
		if (ad !== bd) return ad < bd ? 1 : -1;
		const ae = String(a.electionId ?? '');
		const be = String(b.electionId ?? '');
		if (ae !== be) return ae < be ? -1 : 1;
		const an = String(a.networkHash ?? '');
		const bn = String(b.networkHash ?? '');
		if (an !== bn) return an < bn ? -1 : 1;
		return 0;
	});

	return Object.freeze(
		flat.map((r) => Object.freeze({ networkHash: r.networkHash, electionId: r.electionId, title: r.title })),
	);
}

/**
 * @param {number} networksAttempted
 * @param {number} networksUnreadable
 * @param {boolean} registryRead
 * @param {ReadonlyArray<HeldElection>} elections
 * @returns {Readonly<HeldElectionsResult>}
 */
function freezeResult(elections, networksAttempted, networksUnreadable, registryRead) {
	return Object.freeze({
		elections,
		networksAttempted,
		networksUnreadable,
		// The one place `complete` is computed. Both faults, one flag —
		// header point 3.
		complete: registryRead && networksUnreadable === 0,
	});
}

/**
 * Every election this browser holds, and whether that finding is complete.
 *
 * NEVER THROWS. A public verifiability page that white-screens while someone
 * is checking its work has failed at exactly the wrong moment, and an
 * anonymous page has no operator to surface a failure to anyway. Any
 * unexpected error inside the per-network loop degrades that ONE network to
 * unreadable; any unexpected error outside it degrades the whole result to
 * `complete: false`.
 *
 * @param {LoadHeldElectionsOptions} [options]
 * @param {IndexDeps} [deps] the test seam over the real modules — header point 5.
 * @returns {Promise<Readonly<HeldElectionsResult>>}
 */
export async function loadHeldElections(options = {}, deps = DEFAULT_INDEX_DEPS) {
	try {
		const opts = options ?? {};
		const storage = opts.storage;
		const requested = typeof opts.networkHash === 'string' && opts.networkHash !== '' ? opts.networkHash : null;

		// -- 1. The registry read, and the soft/hard asymmetry (header point 2).
		/** @type {Array<{ networkHash: string }>} */
		let entries = [];
		let registryRead = true;
		try {
			const listed = deps.listNetworks(storage);
			entries = Array.isArray(listed) ? listed : [];
		} catch {
			entries = [];
			registryRead = false;
		}

		const held = entries.filter((e) => e && typeof e.networkHash === 'string' && e.networkHash !== '');

		// -- 2. THE GATE (header point 1, T-54-11-02, I-15). The requested hash
		//       selects among entries the registry already holds. It is compared
		//       against registry membership — the same predicate `findNetwork`
		//       applies — and is NEVER itself forwarded to the attach below. A
		//       hash the registry does not hold falls back to every held entry,
		//       so a link naming a network this browser does not hold still
		//       shows what it does hold, without ever naming a new store.
		//
		//       Note the ordering: this runs BEFORE any database call, and the
		//       empty-registry case therefore reaches none at all.
		let attempted = held;
		if (requested !== null) {
			const scoped = held.filter((e) => e.networkHash === requested);
			if (scoped.length > 0) attempted = scoped;
		}

		// -- 3. Attach, read, close. Bounded by the registry's own length; each
		//       attach is attempted at most once and never retried.
		/** @type {IndexRow[][]} */
		const perNetworkRows = [];
		let networksUnreadable = 0;

		for (const entry of attempted) {
			const hash = entry.networkHash;
			/** @type {any} */
			let db = null;
			try {
				db = await deps.attachNetworkDb(hash, { storage });
				const rows = await deps.listPublicElections(db);
				perNetworkRows.push(toIndexRows(hash, rows));
			} catch {
				// A failing network contributes no elections and leaves the
				// finding incomplete. It never takes the page down with it.
				networksUnreadable += 1;
			} finally {
				// A live handle is what resurrects a deleted store as an empty
				// shell, so a handle is never left holding a database. A failed
				// `attachNetworkDb` closes its own handle before throwing and
				// hands back nothing, which is why this is guarded on `db`.
				if (db !== null && db !== undefined) {
					try {
						await deps.closeNetworkDb(db);
					} catch {
						// Closing is best-effort; a close failure is not a
						// second unreadable network and must not be counted
						// twice.
					}
				}
			}
		}

		return freezeResult(mergeHeldElections(perNetworkRows), attempted.length, networksUnreadable, registryRead);
	} catch {
		// Header point 3's outer half: an unexpected failure outside the loop
		// leaves the holdings unestablished, which is `complete: false`, not
		// "this browser holds nothing".
		return freezeResult(Object.freeze([]), 0, 0, false);
	}
}

/**
 * Map one network's rows into the internal pre-merge shape. `Title` is
 * normalised to `null` when it is not a string, so an absent or null column
 * still LISTS the election rather than dropping it — an omitted row would be
 * indistinguishable from a deliberate withholding, which is the failure class
 * this whole phase is built against.
 *
 * @param {string} networkHash
 * @param {any} rows
 * @returns {IndexRow[]}
 */
function toIndexRows(networkHash, rows) {
	/** @type {IndexRow[]} */
	const out = [];
	for (const r of Array.isArray(rows) ? rows : []) {
		if (!r || typeof r.Id !== 'string' || r.Id === '') continue;
		out.push({
			networkHash,
			electionId: r.Id,
			title: typeof r.Title === 'string' ? r.Title : null,
			date: typeof r.Date === 'string' ? r.Date : '',
		});
	}
	return out;
}
