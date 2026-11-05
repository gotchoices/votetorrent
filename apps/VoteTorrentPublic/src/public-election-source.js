/**
 * public-election-source.js — the read seam behind D-01: registry gate ->
 * attach -> read the addressed election -> hand back one of four explicit
 * states. It NEVER THROWS and it NEVER LOGS A ROW VALUE.
 *
 * Plain JavaScript with JSDoc, no JSX and no React — the same placement and
 * file-type convention `election-address.js` and `election-index-source.js`
 * already use for this surface.
 *
 * Six things a later reader cannot infer from the code alone:
 *
 * 1. ONE DOOR INTO THE DATA PACKAGE. Every symbol below arrives through the
 *    BARE public subpath `@votetorrent/web-data/public` and through nothing
 *    else — not the package root (which deliberately does not exist), not its
 *    officer half, and not a relative or deep path into that package's own
 *    sources. Two standing controls enforce it from opposite ends:
 *    54-08's tier-1 anonymity scan over the whole public closure (D-05), and
 *    `test/node/engine-reach.test.mjs`'s delegation rule — its subpath
 *    allowlist (3b), its raw-handle import scan (4b) and its direct-primitive
 *    matcher, which is why nothing in the executable body of this file names
 *    a database primitive of its own. This module's own test file adds the
 *    consumer-side half with both forbidden forms planted as controls.
 *
 * 2. WHY THE STATE VOCABULARY IS `reading`/`ready`/`notHeld`/`unreadable`
 *    AND NOT THE OBVIOUS ONE. `ElectionShell.tsx` imports these names, and
 *    `election-shell.test.mjs`'s 53-D18 inertness case asserts that the
 *    identifiers `spinner`, `shimmer`, `pulse`, `loading` and `pending` never
 *    appear anywhere in that file. So the two names a reader would reach for
 *    first are unavailable BY CONSTRAINT, not by preference. Renaming
 *    `reading` to the obvious word turns that case red for a reason the diff
 *    would not explain — hence this paragraph.
 *
 * 3. THE REGISTRY GATE IS A SECURITY CONTROL, NOT AN OPTIMISATION
 *    (T-54-12-02). `attachNetworkDb` reaches the data package's store-opening
 *    helper, and that helper CREATES a browser store it cannot find rather
 *    than refusing one. The network hash on this page comes out of the URL
 *    (D-33), so an unguarded attach would let any link author plant an empty
 *    database in a stranger's browser — a WRITE, once per crafted link, on a
 *    page whose entire premise is anonymous read-only viewing. The networks
 *    registry is the only record of the networks this browser was
 *    legitimately bootstrapped into, so registry membership — never the URL —
 *    is what authorises a store name. The gate therefore runs BEFORE any
 *    database call, and `attachNetworkDb` is unreachable without it.
 *
 * 4. A FAULT IS NOT A FACT. `findNetwork` walks `listNetworks`, which fails
 *    SOFT (an empty registry) on an absent or cleared origin and fails HARD
 *    (throws, naming the offending field) on a structurally corrupt stored
 *    entry — a real input on a shared origin. Those are DIFFERENT ANSWERS.
 *    An absent entry is `notHeld`: a settled finding, and D-02's sentence. A
 *    throw is `unreadable`: this browser's holdings could not be established.
 *    Telling a reader "this browser doesn't hold that election" because a
 *    read threw is a false statement, which is the D-28 failure class this
 *    whole phase exists to correct.
 *
 * 5. FAILURES ARE DISCRIMINATED BY THE CONSTRUCTOR `name` STRING, NEVER BY
 *    `instanceof`. `.yarnrc.yml` sets `nmHoistingLimits: workspaces`, so a
 *    lapse in the `resolve.dedupe` contract would give this app and the data
 *    package two physical copies of the engine — two class identities — in a
 *    build that still exits 0. An `instanceof` here would be a second place
 *    that mismatch could silently mis-route a failure into the wrong rendered
 *    state. Comparing the `name` string cannot.
 *
 * 6. THE HANDLE IS RETURNED OPEN ON `ready`, AND THE CALLER OWNS CLOSING IT.
 *    D-27 (54-15) subscribes to this handle's change feed; a seam that closed
 *    it here would force that plan to re-open and re-attach. Every FAILURE
 *    path closes it. This page never deletes a database, so holding a
 *    connection blocks nothing. `use-public-election.ts`'s effect cleanup is
 *    the single place that closes a successful handle.
 *
 * ERROR HYGIENE, at every catch: the error's `.name` and nothing else. The
 * engine embeds offending row and column values in constraint-failure text,
 * and this page's downstream subject matter is registrant names — the same
 * house rule `apps/VoteTorrentDashboard/src/screens/panels/ElectionsPanel.tsx`
 * already follows. Nothing derived from an error ever reaches the returned
 * result either: the shell renders copy keys, never diagnostics.
 *
 * 7. WHY D-14'S KEY-RELEASE AGGREGATE IS READ HERE AND NOT IN THE SHELL.
 *    `election-shell.test.mjs` case 12b asserts that `ElectionShell.tsx`
 *    contains ZERO `useEffect`, ZERO `await ` and zero read call, because a
 *    second `return` in that file is the cheapest way to make
 *    `AdvisoryDisclosure` conditional by accident. So the shell cannot own an
 *    async read, and a SECOND hook beside `use-public-election.ts` would be
 *    worse than no seam at all: this module hands the handle back OPEN and the
 *    hook's cleanup closes it, so a second effect reading from that same
 *    handle would race that close. The aggregate is therefore read here,
 *    inside the one read that already owns the handle's lifetime, and only
 *    THREE NUMBERS ever leave — never a work-item row, never a user
 *    identifier, never a signing nonce (D-14; `read-keyrelease.js` header
 *    point 3 is the upstream half).
 *
 *    ITS FAILURE IS CARD-LOCAL, deliberately. A key-release read that throws
 *    yields `keyRelease: null` and leaves the state `ready`: the election IS
 *    readable, and downgrading the whole page to `unreadable` because one
 *    aggregate failed would be a false statement of the same class point 4
 *    rejects. The render layer then says so on that card rather than dropping
 *    it (D-23) — a silent omission would make the fault indistinguishable
 *    from a deliberate withholding.
 *
 * 8. THE PUBLISHED VOTER ROLL IS READ HERE FOR THE SAME REASON, AND ITS ROWS
 *    ARE REBUILT RATHER THAN FORWARDED. Point 7's whole argument applies
 *    unchanged -- the shell can own no effect and no await, and a second hook
 *    would race this handle's close -- so the roll joins the reads that
 *    already own the handle's lifetime. What is NEW here is the field fence:
 *    each returned row is rebuilt from `ROLL_FIELDS` and nothing else, so a
 *    widened upstream select list cannot reach the render layer even if the
 *    query's own import-time assertion were ever softened. That is the second
 *    of two independent layers; the first is the select list itself. A
 *    non-string value becomes null rather than being carried through: all
 *    three published columns are nullable text with no content constraints,
 *    and the render layer refuses a non-string child.
 *
 *    ITS FAILURE IS ALSO CARD-LOCAL. A roll read that throws yields
 *    `roll: null` and leaves the state `ready`, and the card renders its
 *    honest empty state. Downgrading the whole page because one card's read
 *    failed would be the same false statement point 4 rejects.
 *
 * WHAT THE `deps` SEAM IS NOT LICENSED TO BECOME. Its default IS the real
 * import surface. A seam whose production default is a stub is precisely
 * 53-D07's failure mode — clean imports, every gate green, false words on the
 * page. Task 3's sourcemap assertion is what keeps that honest: a stubbed
 * default would put zero engine sources into the built artefact, and that
 * check fails on anti-vacuity rather than passing.
 */

import {
	findNetwork,
	attachNetworkDb,
	closeNetworkDb,
	readPublicElection,
	readPublicElectionRevision,
	readKeyReleaseProgress,
	readRegistrantRoll,
} from '@votetorrent/web-data/public';
import { ROLL_FIELDS } from './roll-disclosure.js';

/**
 * The four states this seam can report, and the whole vocabulary the shell
 * branches on. See header point 2 for why these names and not the obvious
 * ones.
 *
 * - `reading`   — no answer yet. Owned by the hook, never returned from here.
 * - `ready`     — an election row was read; `election` and `db` are populated.
 * - `notHeld`   — this browser holds no usable copy of the addressed
 *                 election. A FINDING, not a failure.
 * - `unreadable`— the finding could not be established. A FAULT.
 *
 * @type {Readonly<{ READING: 'reading', READY: 'ready', NOT_HELD: 'notHeld', UNREADABLE: 'unreadable' }>}
 */
export const PUBLIC_ELECTION_STATE = Object.freeze({
	READING: 'reading',
	READY: 'ready',
	NOT_HELD: 'notHeld',
	UNREADABLE: 'unreadable',
});

/**
 * @typedef {'reading' | 'ready' | 'notHeld' | 'unreadable'} PublicElectionState
 */

/**
 * The facts the shell renders. `timeline` is the RAW, uninterpreted column
 * value: this module reads, it does not interpret, and `derivePhase` is the
 * only thing in this app permitted to read a timeline field.
 * @typedef {object} AddressedElectionFacts
 * @property {string | null} title
 * @property {unknown} timeline
 */

/**
 * @typedef {object} AddressedElectionResult
 * @property {PublicElectionState} state
 * @property {AddressedElectionFacts | null} election
 * @property {any} db  the OPEN handle on `ready`, else null — header point 6.
 * @property {KeyReleaseProgressCounts | null} keyRelease  D-14's three numbers, or null when they could not be read — header point 7.
 * @property {ReadonlyArray<Readonly<Record<string, string | null>>> | null} roll  the published voter roll, or null when it could not be read — header point 8.
 */

/**
 * The ONLY thing D-14 permits to cross out of the key-release read. Declared
 * structurally here rather than imported, so this module's contract is
 * readable without opening the data package.
 * @typedef {object} KeyReleaseProgressCounts
 * @property {number} released
 * @property {number} total
 * @property {number} keyholderCount
 */

/**
 * @typedef {object} PublicSourceDeps
 * @property {(networkHash: string, storage?: any) => any} findNetwork
 * @property {(networkHash: string, options?: any) => Promise<any>} attachNetworkDb
 * @property {(db: any) => any} closeNetworkDb
 * @property {(db: any, electionId: string) => Promise<any>} readPublicElection
 * @property {(db: any, electionId: string) => Promise<any>} readPublicElectionRevision
 * @property {(db: any, electionId: string, revision: number) => Promise<any>} readKeyReleaseProgress
 * @property {(db: any, electionId: string) => Promise<any>} readRegistrantRoll
 * @property {() => string} nowCanonical  56-12/D-17's OBSERVATION clock -- see
 *   `nowCanonical`'s own header comment below for why this is a third,
 *   distinct clock from `resolveComparisonInstant` and `formatReaderInstant`.
 */

/**
 * The current instant, as a canonical 19-character zoneless UTC string.
 *
 * This is the OBSERVATION clock, and it is deliberately a third function
 * rather than a reuse of either of this app's other two clocks:
 * `resolveComparisonInstant` (`@votetorrent/ui-web/lifecycle`) is the
 * COMPARISON clock a phase is derived against, and `formatReaderInstant`
 * (`reader-instant.js`) is the DISPLAY formatter. This one exists so the
 * moment `use-public-election.ts` observes the connection state can be
 * captured through the same injectable `source` seam as every other read in
 * this module, without a harness reaching for either of the other two
 * clocks. `Date.prototype.toISOString()` always renders UTC with a trailing
 * `Z` and millisecond precision; slicing to 19 characters keeps the `T`
 * separator and drops both the milliseconds and the `Z`, producing exactly
 * the canonical shape `formatReaderInstant` accepts.
 * @returns {string}
 */
function nowCanonical() {
	return new Date().toISOString().slice(0, 19);
}

/**
 * The real import surface, and the production default. Never a fixture — see
 * the header's closing paragraph.
 * @type {Readonly<PublicSourceDeps>}
 */
export const DEFAULT_PUBLIC_SOURCE = Object.freeze({
	findNetwork,
	attachNetworkDb,
	closeNetworkDb,
	readPublicElection,
	readPublicElectionRevision,
	readKeyReleaseProgress,
	readRegistrantRoll,
	nowCanonical,
});

/**
 * The three typed failures `attachNetworkDb` raises that each mean exactly
 * "this browser has no usable copy of that network" — D-02's sentence, not an
 * error. Matched by the constructor `name` STRING (header point 5).
 * @type {ReadonlyArray<string>}
 */
const NOT_HELD_ERROR_NAMES = Object.freeze([
	'NotBootstrappedError',
	'MissingRowCountsError',
	'RowCountMismatchError',
]);

/**
 * Does this pair of inputs warrant a read at all?
 *
 * `false` whenever an election was INJECTED: 53-D17 requires that production
 * renders the shell with no `election` prop, so that no election fact exists
 * anywhere in the production import graph, and that the browser harness is the
 * only supplier of one. A hook that read a database anyway whenever a prop
 * happened to be present would make every existing browser rung a liar about
 * what it was measuring. `false` also for any address that does not name BOTH
 * a network and an election — `readAddressedElection` answers `notHeld` for
 * those anyway, and not calling it at all is what makes "no database call"
 * structural rather than incidental.
 *
 * Lives here, beside the read it gates, rather than in the hook that consumes
 * it, for one measured reason: the hook is TypeScript and `node --test` cannot
 * import a `.ts` module without a type-stripping flag this workspace's runner
 * does not pass. A predicate that can only be asserted by matching source text
 * is a predicate that is not really asserted, and this repo has shipped that
 * mistake. `use-public-election.ts` re-exports this binding, so the hook's
 * public surface is unchanged.
 *
 * @param {{ title?: string | null, timeline?: unknown } | null | undefined} election
 * @param {{ status?: string, electionId?: string | null, networkHash?: string | null } | null | undefined} address
 * @returns {boolean}
 */
export function shouldReadFor(election, address) {
	if (election !== null && election !== undefined) return false;
	if (!address || address.status !== 'ok') return false;
	return (
		typeof address.networkHash === 'string' &&
		address.networkHash !== '' &&
		typeof address.electionId === 'string' &&
		address.electionId !== ''
	);
}

/** The one prefix every log line in this module carries. @type {string} */
const LOG_PREFIX = 'public-election-source: a read failed:';

/**
 * The only place an error reaches a console. The error's `.name` and nothing
 * else — never its text, never the object, never the address value.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * @param {PublicElectionState} state
 * @param {AddressedElectionFacts | null} election
 * @param {any} db
 * @param {KeyReleaseProgressCounts | null} [keyRelease]
 * @param {ReadonlyArray<Readonly<Record<string, string | null>>> | null} [roll]
 * @returns {Readonly<AddressedElectionResult>}
 */
function freezeResult(state, election, db, keyRelease = null, roll = null) {
	return Object.freeze({ state, election, db, keyRelease, roll });
}

/**
 * Rebuild one roll row from the published field set and nothing else. The
 * upstream object is never forwarded — see header point 8 — and a value that
 * is not a string becomes null rather than reaching the render layer as a
 * number or an object.
 * @param {any} row
 * @returns {Readonly<Record<string, string | null>>}
 */
function publishedRollRow(row) {
	/** @type {Record<string, string | null>} */
	const out = {};
	for (const field of ROLL_FIELDS) {
		const value = row === null || row === undefined ? null : row[field];
		out[field] = typeof value === 'string' ? value : null;
	}
	return Object.freeze(out);
}

/**
 * Best-effort close. Tolerates a nullish handle and an already-closed one; a
 * close failure is never itself a reported state.
 * @param {PublicSourceDeps} deps
 * @param {any} db
 * @returns {Promise<void>}
 */
async function closeQuietly(deps, db) {
	if (db === null || db === undefined) return;
	try {
		await deps.closeNetworkDb(db);
	} catch (err) {
		logFailure(err);
	}
}

/**
 * Read the election a link ADDRESSES, out of the store this browser already
 * holds. NEVER THROWS — an anonymous verifiability page that white-screens
 * while someone is checking its work has failed at exactly the wrong moment,
 * and has no operator to surface the failure to anyway.
 *
 * The order of the steps is load-bearing; see header points 3 and 4.
 *
 * @param {{ status?: string, electionId?: string | null, networkHash?: string | null } | null} address
 * @param {PublicSourceDeps} [deps] the test seam over the real modules.
 * @returns {Promise<Readonly<AddressedElectionResult>>}
 */
export async function readAddressedElection(address, deps = DEFAULT_PUBLIC_SOURCE) {
	/** @type {any} */
	let db = null;
	try {
		// -- 1. Guard the address. Anything that does not name BOTH a network
		//       and an election in the 'ok' shape 54-11 defined resolves as a
		//       finding, not a fault: there is no addressed election to hold.
		//       The malformed-address case is the shell's own existing branch
		//       and never reaches here.
		const networkHash = address && typeof address.networkHash === 'string' ? address.networkHash : '';
		const electionId = address && typeof address.electionId === 'string' ? address.electionId : '';
		if (!address || address.status !== 'ok' || networkHash === '' || electionId === '') {
			return freezeResult(PUBLIC_ELECTION_STATE.NOT_HELD, null, null);
		}

		// -- 2. THE REGISTRY GATE (header point 3, T-54-12-02, I-15). Runs
		//       BEFORE any database call, so an unregistered hash reaches none
		//       at all. A THROW here is a corrupt registry, which is a fault
		//       (header point 4) and must never be reported as an absence.
		/** @type {any} */
		let entry;
		try {
			entry = deps.findNetwork(networkHash);
		} catch (err) {
			logFailure(err);
			return freezeResult(PUBLIC_ELECTION_STATE.UNREADABLE, null, null);
		}
		if (entry === undefined || entry === null) {
			return freezeResult(PUBLIC_ELECTION_STATE.NOT_HELD, null, null);
		}

		// -- 3. Attach. The three typed failures each mean "no usable copy";
		//       anything else means the finding could not be established. A
		//       failed attach closes its own handle before throwing and hands
		//       back nothing, which is why `db` is still null in that branch.
		try {
			db = await deps.attachNetworkDb(networkHash);
		} catch (err) {
			logFailure(err);
			const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : '';
			const state = NOT_HELD_ERROR_NAMES.includes(name)
				? PUBLIC_ELECTION_STATE.NOT_HELD
				: PUBLIC_ELECTION_STATE.UNREADABLE;
			return freezeResult(state, null, null);
		}

		// -- 4. Read. A null row is a FINDING: the network is held, the
		//       election is not. A throw is a fault.
		/** @type {any} */
		let row;
		/** @type {any} */
		let revision;
		try {
			row = await deps.readPublicElection(db, electionId);
			if (row === null || row === undefined) {
				await closeQuietly(deps, db);
				return freezeResult(PUBLIC_ELECTION_STATE.NOT_HELD, null, null);
			}
			revision = await deps.readPublicElectionRevision(db, electionId);
		} catch (err) {
			logFailure(err);
			await closeQuietly(deps, db);
			return freezeResult(PUBLIC_ELECTION_STATE.UNREADABLE, null, null);
		}

		// -- 4b. D-14's counts-only aggregate, in its OWN try/catch (header
		//        point 7). A failure here is CARD-LOCAL: it yields null and
		//        leaves the state `ready`, because the election itself is
		//        readable and saying otherwise would be a false statement.
		//        Only the three numbers are copied out; the returned object is
		//        never forwarded wholesale, so a future field added upstream
		//        cannot silently reach the render layer.
		/** @type {KeyReleaseProgressCounts | null} */
		let keyRelease = null;
		const revisionNumber = revision && typeof revision.Revision === 'number' ? revision.Revision : null;
		if (revisionNumber !== null && typeof deps.readKeyReleaseProgress === 'function') {
			try {
				const counts = await deps.readKeyReleaseProgress(db, electionId, revisionNumber);
				if (counts) {
					keyRelease = Object.freeze({
						released: Number(counts.released) || 0,
						total: Number(counts.total) || 0,
						keyholderCount: Number(counts.keyholderCount) || 0,
					});
				}
			} catch (err) {
				logFailure(err);
				keyRelease = null;
			}
		}

		// -- 4c. The published voter roll (D-18/D-19), in its OWN try/catch and
		//        subject to the same card-local rule as 4b: a failure yields
		//        null and leaves the state `ready`. Every row is REBUILT from
		//        the published field set, so the render layer receives exactly
		//        three keys per row no matter what the query returns — header
		//        point 8.
		/** @type {ReadonlyArray<Readonly<Record<string, string | null>>> | null} */
		let roll = null;
		if (typeof deps.readRegistrantRoll === 'function') {
			try {
				const rows = await deps.readRegistrantRoll(db, electionId);
				roll = Array.isArray(rows) ? Object.freeze(rows.map(publishedRollRow)) : null;
			} catch (err) {
				logFailure(err);
				roll = null;
			}
		}

		// -- 5. Shape the result. `Title` normalised to null when it is not a
		//       string, so an absent column still reports the election rather
		//       than dropping it. `Timeline` is passed through UNTOUCHED --
		//       not parsed, not normalised, not re-serialised.
		const facts = Object.freeze({
			title: row && typeof row.Title === 'string' ? row.Title : null,
			timeline: revision === null || revision === undefined ? null : revision.Timeline,
		});

		// -- 6. The handle stays OPEN here (header point 6). The caller owns
		//       closing it.
		return freezeResult(PUBLIC_ELECTION_STATE.READY, facts, db, keyRelease, roll);
	} catch (err) {
		// Unreachable by construction today: every step above is already
		// guarded. It exists because a future edit could reintroduce a throw,
		// and the failure mode then would be a blank page rather than an
		// honest one. It degrades to the FAULT state, never to the finding.
		logFailure(err);
		await closeQuietly(deps, db);
		return freezeResult(PUBLIC_ELECTION_STATE.UNREADABLE, null, null);
	}
}
