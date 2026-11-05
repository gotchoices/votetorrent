/**
 * public-election-source.test.mjs — the contract of D-01's read seam
 * (`src/public-election-source.js`) and of D-26's display half
 * (`src/reader-instant.js`).
 *
 * Every path is resolved through `scripts/lib/source-paths.mjs`'s
 * `publicSrc()` (D-25/53-01) — never re-derived from `import.meta.url`. Every
 * source matcher gets a planted-fixture positive control BEFORE it runs
 * against real source, and every behavioural absence assertion (a spy with
 * zero calls) gets a CONTROL CASE proving the same spy can record one — an
 * absence measured by an instrument that has never been seen to fire is not
 * an absence.
 *
 * The `deps` argument is a plain object literal of recording spies. It is a
 * seam over the real modules, never a fixture that ships: the production
 * default is asserted to be the real import surface in case 1, and Task 3's
 * sourcemap assertion measures the same thing against the built artefact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import {
	PUBLIC_ELECTION_STATE,
	DEFAULT_PUBLIC_SOURCE,
	readAddressedElection,
} from '../../src/public-election-source.js';
import { formatReaderInstant } from '../../src/reader-instant.js';

/** @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkAll(full));
		else out.push(full);
	}
	return out;
}

/**
 * A call-recording spy. `calls` is the ARGUMENT LISTS, so a zero-call
 * assertion and a one-call assertion read the same way.
 * @param {(...args: any[]) => any} [impl]
 */
function spy(impl = () => undefined) {
	/** @type {any[][]} */
	const calls = [];
	/** @type {any} */
	const fn = (/** @type {any[]} */ ...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	return fn;
}

/** A handle stand-in with a recognisable identity, so "the same handle came
 * back" is measurable rather than merely truthy. */
const HANDLE = Object.freeze({ __handle: 'public-election-source-test-handle' });

const OK_ADDRESS = Object.freeze({
	status: 'ok',
	networkHash: 'aBcDeF0123456789aBcDeF0123456789',
	electionId: 'election-0123456789abcdef',
});

/**
 * The rows the roll read hands back. PRODUCTION-LENGTH by mandate (54-UI-SPEC
 * Fixture Requirements item 2): first and last each >= 12 characters, district
 * >= 20. A short stand-in is exactly the blindness this repo has shipped twice.
 * The second row carries a non-string District so the value-level coercion has
 * something real to act on.
 * @type {ReadonlyArray<Readonly<Record<string, unknown>>>}
 */
const ROLL_ROWS = Object.freeze([
	Object.freeze({
		LastName: 'Vandersteenhoven',
		FirstName: 'Wilhelmina-Rose',
		District: 'North Riverbend Ward 7 Precinct 12 (vtx-fixture)',
	}),
	Object.freeze({ LastName: 'Okonkwo-Barrington', FirstName: 'Bartholomeus', District: 4207 }),
]);

/** @param {Partial<Record<string, any>>} [over] */
function makeDeps(over = {}) {
	return {
		findNetwork: spy(() => ({ networkHash: OK_ADDRESS.networkHash })),
		attachNetworkDb: spy(async () => HANDLE),
		closeNetworkDb: spy(() => undefined),
		readPublicElection: spy(async () => ({ Id: OK_ADDRESS.electionId, Title: 'A Real Stored Title' })),
		readPublicElectionRevision: spy(async () => ({ Revision: 1, Timeline: '{"votingStarts":"2026-03-01T00:00:00"}' })),
		readKeyReleaseProgress: spy(async () => ({ released: 3, total: 4, keyholderCount: 5 })),
		readRegistrantRoll: spy(async () => ROLL_ROWS.map((r) => ({ ...r }))),
		// 56-12/D-17: unused by readAddressedElection itself (only
		// use-public-election.ts calls it), but part of PublicSourceDeps'
		// shape -- included here so every readAddressedElection(address, deps)
		// call site in this file type-checks against the widened typedef.
		nowCanonical: spy(() => '2026-01-01T00:00:00'),
		...over,
	};
}

/** @param {string} name */
function namedError(name, message = 'synthetic') {
	const err = new Error(message);
	err.name = name;
	return err;
}

// ---------------------------------------------------------------------------
// 1. Sanity, anti-vacuous.
// ---------------------------------------------------------------------------

test('PUBLIC_ELECTION_STATE is frozen and carries exactly the four state strings the shell branches on', () => {
	assert.ok(Object.isFrozen(PUBLIC_ELECTION_STATE));
	assert.deepEqual([...Object.values(PUBLIC_ELECTION_STATE)].sort(), ['notHeld', 'reading', 'ready', 'unreadable']);
});

test('DEFAULT_PUBLIC_SOURCE is frozen, has all eight members, and every one is a real function (a stub default is 53-D07 failure mode)', () => {
	assert.ok(Object.isFrozen(DEFAULT_PUBLIC_SOURCE));
	// 54-13 added the sixth: D-14's counts-only aggregate is read HERE rather
	// than in a second hook, because this module owns the handle's lifetime
	// and the shell is held to zero effects (see the module header, point 7).
	const expected = [
		'attachNetworkDb',
		'closeNetworkDb',
		'findNetwork',
		// 56-12/D-17 added the seventh: the OBSERVATION clock, injectable
		// through this same seam so a harness can capture a fixed instant
		// rather than the real one.
		'nowCanonical',
		'readKeyReleaseProgress',
		'readPublicElection',
		'readPublicElectionRevision',
		// 54-14 added the eighth, for the reason recorded at module header
		// point 8: the published roll joins the reads that already own the
		// handle's lifetime rather than becoming a second hook.
		'readRegistrantRoll',
	];
	assert.deepEqual(Object.keys(DEFAULT_PUBLIC_SOURCE).sort(), expected);
	for (const key of expected) {
		assert.equal(typeof (/** @type {any} */ (DEFAULT_PUBLIC_SOURCE)[key]), 'function', `${key} is not a function`);
	}
});

// ---------------------------------------------------------------------------
// 2. THE REGISTRY GATE — T-54-12-02. The load-bearing assertion in this file.
// ---------------------------------------------------------------------------

test('T-54-12-02: an unregistered network hash resolves notHeld and NEVER reaches attachNetworkDb — the URL cannot name a store this browser was not already holding', () => {
	return readAddressedElection(OK_ADDRESS, makeDeps({ findNetwork: spy(() => undefined) })).then((result) => {
		assert.equal(result.state, 'notHeld');
		assert.equal(result.db, null);
	});
});

test('T-54-12-02, measured on the spy: zero attachNetworkDb calls for an unregistered hash', async () => {
	const deps = makeDeps({ findNetwork: spy(() => undefined) });
	await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(deps.attachNetworkDb.calls.length, 0, 'an unregistered hash reached a database call — the gate is not gating');
});

test('control: the SAME spy records exactly one call when the registry DOES hold the hash — so the zero-call assertion above discriminates rather than passing because nothing ever attaches', async () => {
	const deps = makeDeps();
	await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(deps.attachNetworkDb.calls.length, 1);
	assert.equal(deps.attachNetworkDb.calls[0][0], OK_ADDRESS.networkHash);
});

test('an address that does not name BOTH a network and an election resolves notHeld and reaches neither the registry nor a database', async () => {
	for (const address of [
		null,
		{ status: 'missing', networkHash: null, electionId: null },
		{ status: 'incomplete', networkHash: OK_ADDRESS.networkHash, electionId: null },
		{ status: 'incomplete', networkHash: null, electionId: OK_ADDRESS.electionId },
		{ status: 'ok', networkHash: '', electionId: OK_ADDRESS.electionId },
	]) {
		const deps = makeDeps();
		const result = await readAddressedElection(address, deps);
		assert.equal(result.state, 'notHeld', `expected notHeld for ${JSON.stringify(address)}`);
		assert.equal(deps.findNetwork.calls.length, 0);
		assert.equal(deps.attachNetworkDb.calls.length, 0);
	}
});

// ---------------------------------------------------------------------------
// 3. A fault is not a fact.
// ---------------------------------------------------------------------------

test('a corrupt registry (findNetwork throws) is unreadable, NEVER notHeld — a fault and an absence are different answers', async () => {
	const deps = makeDeps({
		findNetwork: spy(() => {
			throw namedError('InvalidNetworkRegistryError');
		}),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'unreadable');
	assert.equal(deps.attachNetworkDb.calls.length, 0, 'a corrupt registry must not be followed by a database call either');
});

// ---------------------------------------------------------------------------
// 4. Attach-failure discrimination, by constructor name.
// ---------------------------------------------------------------------------

test('each of the three typed attach errors resolves notHeld — each one means "this browser has no usable copy", which is D-02 sentence, not an error', async () => {
	for (const name of ['NotBootstrappedError', 'MissingRowCountsError', 'RowCountMismatchError']) {
		const deps = makeDeps({
			attachNetworkDb: spy(async () => {
				throw namedError(name);
			}),
		});
		const result = await readAddressedElection(OK_ADDRESS, deps);
		assert.equal(result.state, 'notHeld', `${name} did not map to notHeld`);
		assert.equal(result.db, null);
	}
});

test('an unrelated attach failure (TypeError) resolves unreadable — the mapping is a closed list, not a catch-all', async () => {
	const deps = makeDeps({
		attachNetworkDb: spy(async () => {
			throw new TypeError('cannot read properties of undefined');
		}),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'unreadable');
});

// ---------------------------------------------------------------------------
// 5. A held network with an unknown election.
// ---------------------------------------------------------------------------

test('a held network whose store has no such election row resolves notHeld and CLOSES the handle it opened', async () => {
	const deps = makeDeps({ readPublicElection: spy(async () => null) });
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'notHeld');
	assert.equal(result.db, null);
	assert.equal(deps.closeNetworkDb.calls.length, 1);
	assert.equal(deps.closeNetworkDb.calls[0][0], HANDLE);
});

// ---------------------------------------------------------------------------
// 6. The happy path — the timeline is passed through UNINTERPRETED.
// ---------------------------------------------------------------------------

test('on ready the raw Timeline comes back byte-identical, the handle comes back OPEN, and closeNetworkDb is not called', async () => {
	// A JSON STRING, deliberately: if this module ever parses, normalises or
	// re-serialises a timeline it stops being a read and starts being an
	// interpretation, and `derivePhase` is the only thing permitted to
	// interpret one.
	const RAW_TIMELINE = '{"registrationEnds":"2026-02-01T00:00:00","votingStarts":"2026-03-01T00:00:00"}';
	const deps = makeDeps({
		readPublicElectionRevision: spy(async () => ({ Timeline: RAW_TIMELINE })),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'ready');
	assert.equal(result.election?.title, 'A Real Stored Title');
	assert.equal(result.election?.timeline, RAW_TIMELINE);
	assert.equal(typeof result.election?.timeline, 'string', 'the timeline was converted — this module must not interpret it');
	assert.equal(result.db, HANDLE, 'the handle must come back OPEN (D-27/54-15 subscribes to it)');
	assert.equal(deps.closeNetworkDb.calls.length, 0, 'the success path must not close the handle it returns');
});

test('a non-string Title is normalised to null rather than dropping the election, and a missing revision yields a null timeline rather than a throw', async () => {
	const deps = makeDeps({
		readPublicElection: spy(async () => ({ Id: OK_ADDRESS.electionId, Title: null })),
		readPublicElectionRevision: spy(async () => null),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'ready');
	assert.equal(result.election?.title, null);
	assert.equal(result.election?.timeline, null);
});

// ---------------------------------------------------------------------------
// 6b. D-14 (54-13) — the key-release aggregate: three numbers, card-local
//     failure, and no work-item row anywhere near the result.
// ---------------------------------------------------------------------------

test('D-14: the key-release aggregate is read with the election revision NUMBER and only its three counts reach the result', async () => {
	const deps = makeDeps();
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'ready');
	assert.equal(deps.readKeyReleaseProgress.calls.length, 1, 'the aggregate was not read alongside the election read');
	assert.equal(deps.readKeyReleaseProgress.calls[0][0], HANDLE, 'the aggregate must reuse the handle this read already owns');
	assert.equal(deps.readKeyReleaseProgress.calls[0][1], OK_ADDRESS.electionId);
	assert.equal(deps.readKeyReleaseProgress.calls[0][2], 1, 'the revision must be bound as the NUMBER the revision row carries');
	assert.deepEqual(Object.keys(/** @type {any} */ (result.keyRelease)).sort(), ['keyholderCount', 'released', 'total']);
	assert.deepEqual({ ...(/** @type {any} */ (result.keyRelease)) }, { released: 3, total: 4, keyholderCount: 5 });
	assert.ok(Object.isFrozen(result.keyRelease));
});

test('D-14: an extra field the upstream read might grow NEVER reaches the result — the three counts are copied out, never forwarded wholesale', async () => {
	// The planted field is a work-item identifier of exactly the kind D-14
	// forbids the render layer from ever seeing. If this module forwarded the
	// upstream object, it would be sitting on the result.
	const deps = makeDeps({
		readKeyReleaseProgress: spy(async () => ({ released: 2, total: 2, keyholderCount: 7, taskUserIdentifier: 'user-0123456789abcdef' })),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.deepEqual(Object.keys(/** @type {any} */ (result.keyRelease)).sort(), ['keyholderCount', 'released', 'total']);
	assert.ok(!JSON.stringify(result).includes('taskUserIdentifier'), 'an upstream field was forwarded wholesale into the result');
});

test('D-23 applied to D-14: a THROWING key-release read leaves the election ready with a null aggregate — the fault is card-local, never a page-wide unreadable', async () => {
	const deps = makeDeps({
		readKeyReleaseProgress: spy(async () => {
			throw namedError('QuereusError', 'synthetic aggregate failure');
		}),
	});
	const original = console.error;
	console.error = () => undefined;
	/** @type {any} */
	let result;
	try {
		result = await readAddressedElection(OK_ADDRESS, deps);
	} finally {
		console.error = original;
	}
	assert.equal(result.state, 'ready', 'one failed aggregate must not downgrade a readable election to unreadable');
	assert.equal(result.keyRelease, null, 'a failed aggregate must be null, so the render layer can SAY the count could not be read');
	assert.equal(result.election?.title, 'A Real Stored Title', 'the election facts must survive the aggregate failure');
});

test('a revision row carrying no numeric Revision yields a null aggregate and reaches no aggregate read at all', async () => {
	const deps = makeDeps({
		readPublicElectionRevision: spy(async () => ({ Timeline: null })),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'ready');
	assert.equal(result.keyRelease, null);
	assert.equal(deps.readKeyReleaseProgress.calls.length, 0, 'the aggregate was read with a non-numeric revision');
});

test('T-54-12-02 extended: an unregistered hash reaches the key-release read no more than it reaches attachNetworkDb', async () => {
	const deps = makeDeps({ findNetwork: spy(() => undefined) });
	await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(deps.readKeyReleaseProgress.calls.length, 0, 'the registry gate does not cover the aggregate read');
});

// ---------------------------------------------------------------------------
// 6c. D-18/D-19 (54-14) — the published roll: rebuilt row by row against the
//     published field set, card-local on failure, and behind the same registry
//     gate as everything else this module reads.
// ---------------------------------------------------------------------------

test('D-18: the roll is read with the handle this read already owns and the addressed election id, and the rows reach the result in order', async () => {
	const deps = makeDeps();
	const result = await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(result.state, 'ready');
	assert.equal(deps.readRegistrantRoll.calls.length, 1, 'the roll was not read alongside the election read');
	assert.equal(deps.readRegistrantRoll.calls[0][0], HANDLE, 'the roll must reuse the handle this read already owns');
	assert.equal(deps.readRegistrantRoll.calls[0][1], OK_ADDRESS.electionId);
	assert.equal(/** @type {any} */ (result.roll).length, 2);
	assert.equal(/** @type {any} */ (result.roll)[0].LastName, ROLL_ROWS[0].LastName, 'the roll rows arrived out of order or altered');
	assert.ok(Object.isFrozen(result.roll));
	assert.ok(Object.isFrozen(/** @type {any} */ (result.roll)[0]));
});

test('D-19: every roll row is REBUILT from the published field set — an extra upstream column never reaches the result, and a non-string value becomes null', async () => {
	// The planted columns are exactly the ones D-19 forbids: an unconstrained
	// authority-supplied blob, and a correlation handle back into the
	// registrant tables. If this module forwarded the upstream row, both would
	// be sitting on the result.
	const plantedBlob = 'PLANTED-BLOB-MUST-NOT-REACH-THE-RESULT';
	const plantedHandle = 'PLANTED-HANDLE-MUST-NOT-REACH-THE-RESULT';
	const deps = makeDeps({
		readRegistrantRoll: spy(async () => [
			{
				LastName: 'Pemberton-Ashdown',
				FirstName: 'Marguerite-Annelise',
				District: 'New Millrace Ward 8 Precinct 31 (vtx-fixture)',
				ExtraFields: plantedBlob,
				RegistrantId: plantedHandle,
			},
		]),
	});
	const result = await readAddressedElection(OK_ADDRESS, deps);
	const row = /** @type {any} */ (result.roll)[0];
	assert.deepEqual(Object.keys(row).sort(), ['District', 'FirstName', 'LastName']);
	const serialised = JSON.stringify(result);
	assert.ok(!serialised.includes(plantedBlob), 'an unconstrained authority-supplied column was forwarded into the result');
	assert.ok(!serialised.includes(plantedHandle), 'a correlation handle was forwarded into the result');
});

test('D-19: a non-string cell becomes null rather than reaching the render layer as a number', async () => {
	const result = await readAddressedElection(OK_ADDRESS, makeDeps());
	assert.equal(/** @type {any} */ (result.roll)[1].District, null, 'a non-string value was carried through unchanged');
	assert.equal(/** @type {any} */ (result.roll)[1].LastName, ROLL_ROWS[1].LastName);
});

test('D-23 applied to the roll: a THROWING roll read leaves the election ready with a null roll — the fault is card-local, never a page-wide unreadable', async () => {
	const deps = makeDeps({
		readRegistrantRoll: spy(async () => {
			throw namedError('QuereusError', 'synthetic roll failure');
		}),
	});
	const original = console.error;
	console.error = () => undefined;
	/** @type {any} */
	let result;
	try {
		result = await readAddressedElection(OK_ADDRESS, deps);
	} finally {
		console.error = original;
	}
	assert.equal(result.state, 'ready', 'one failed card read must not downgrade a readable election to unreadable');
	assert.equal(result.roll, null, 'a failed roll read must be null, so the card can render its honest empty state');
	assert.equal(result.election?.title, 'A Real Stored Title', 'the election facts must survive the roll failure');
	assert.deepEqual({ ...result.keyRelease }, { released: 3, total: 4, keyholderCount: 5 }, 'the other card read must be unaffected');
});

test('T-54-12-02 extended again: an unregistered hash reaches the roll read no more than it reaches attachNetworkDb', async () => {
	const deps = makeDeps({ findNetwork: spy(() => undefined) });
	await readAddressedElection(OK_ADDRESS, deps);
	assert.equal(deps.readRegistrantRoll.calls.length, 0, 'the registry gate does not cover the roll read');
	assert.equal(deps.attachNetworkDb.calls.length, 0, 'sanity: the gate is not covering the attach either');
});

// ---------------------------------------------------------------------------
// 7. T-54-12-03 — no error content escapes, into the result OR into a log.
// ---------------------------------------------------------------------------

// PRODUCTION-LENGTH by 54-UI-SPEC's Fixture Requirements: first and last each
// >= 12 characters. This repo has twice shipped a defect a short fixture was
// blind to, so a three-letter placeholder is not an acceptable stand-in for a
// registrant name here.
const SYNTHETIC_REGISTRANT = 'Bartholomewe Fitzgeraldson';
const SYNTHETIC_FIRST = 'Bartholomewe';
const SYNTHETIC_LAST = 'Fitzgeraldson';

test('fixture sanity: the synthetic registrant name is production-length (both parts >= 12 characters)', () => {
	assert.ok(SYNTHETIC_FIRST.length >= 12, `first name is only ${SYNTHETIC_FIRST.length} characters`);
	assert.ok(SYNTHETIC_LAST.length >= 12, `last name is only ${SYNTHETIC_LAST.length} characters`);
	assert.ok(SYNTHETIC_REGISTRANT.includes(SYNTHETIC_FIRST) && SYNTHETIC_REGISTRANT.includes(SYNTHETIC_LAST));
});

test('T-54-12-03: a thrown read error carrying a registrant name in its message leaks it neither into the returned result nor into any console.error argument', async () => {
	const message = `CHECK constraint failed on Registrant.Name: offending value "${SYNTHETIC_REGISTRANT}"`;
	const deps = makeDeps({
		readPublicElection: spy(async () => {
			throw namedError('ConstraintError', message);
		}),
	});

	const original = console.error;
	/** @type {any[][]} */
	const recorded = [];
	console.error = (/** @type {any[]} */ ...args) => {
		recorded.push(args);
	};
	/** @type {any} */
	let result;
	try {
		result = await readAddressedElection(OK_ADDRESS, deps);
	} finally {
		console.error = original;
	}

	assert.equal(result.state, 'unreadable');

	const serialized = JSON.stringify(result);
	assert.ok(!serialized.includes(message), 'the error message reached the returned result');
	for (const fragment of [SYNTHETIC_REGISTRANT, SYNTHETIC_FIRST, SYNTHETIC_LAST]) {
		assert.ok(!serialized.includes(fragment), `"${fragment}" reached the returned result`);
	}

	assert.ok(recorded.length > 0, 'sanity: the failure must have been logged at all, or this case proves nothing');
	const ALLOWED = new Set(['public-election-source: a read failed:', 'ConstraintError']);
	for (const args of recorded) {
		for (const arg of args) {
			assert.equal(typeof arg, 'string', `a non-string argument reached console.error: ${String(arg)}`);
			assert.ok(
				ALLOWED.has(arg),
				`console.error received an argument that is neither the fixed prefix nor the error name: ${JSON.stringify(arg)}`,
			);
		}
	}
});

test('control: the leak matcher above is live — the same fragments ARE found in a result that deliberately carries them', () => {
	const leaky = JSON.stringify({ state: 'unreadable', detail: `boom ${SYNTHETIC_REGISTRANT}` });
	for (const fragment of [SYNTHETIC_REGISTRANT, SYNTHETIC_FIRST, SYNTHETIC_LAST]) {
		assert.ok(leaky.includes(fragment), `the containment check cannot see "${fragment}" even when it is present`);
	}
});

// ---------------------------------------------------------------------------
// 8. D-26's display half.
// ---------------------------------------------------------------------------

const CANONICAL_SAMPLE = '2026-03-01T02:30:00';

/**
 * Runs `fn` with `process.env.TZ` set to `zone`, restoring whatever was there
 * before. Node re-reads TZ when an `Intl.DateTimeFormat` is CONSTRUCTED, which
 * is why `formatReaderInstant` constructs one per call rather than hoisting a
 * module-level formatter.
 * @template T @param {string} zone @param {() => T} fn @returns {T}
 */
function withTimeZone(zone, fn) {
	const had = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		return fn();
	} finally {
		if (had) process.env.TZ = previous;
		else delete process.env.TZ;
	}
}

test('D-26 display: the same canonical instant formats DIFFERENTLY, and reports a different zone, for a UTC reader and a UTC+14 reader', () => {
	const utc = withTimeZone('UTC', () => formatReaderInstant(CANONICAL_SAMPLE));
	const kiritimati = withTimeZone('Pacific/Kiritimati', () => formatReaderInstant(CANONICAL_SAMPLE));

	assert.ok(utc !== null && kiritimati !== null, 'a canonical value must format for both readers');
	// Vacuity guard: if the host stopped honouring a runtime TZ change, both
	// halves would be identical and the discrimination below would pass for
	// the wrong reason. Fail loudly instead.
	assert.notEqual(utc.zone, kiritimati.zone, 'the host did not honour the runtime TZ change — this case is measuring nothing');
	assert.equal(utc.zone, 'UTC');
	assert.equal(kiritimati.zone, 'Pacific/Kiritimati');
	assert.notEqual(utc.text, kiritimati.text, 'the formatter ignores the reader zone — it is not reader-local at all');
});

test('D-26 display: the parse is UTC-explicit — a UTC reader sees the canonical wall-clock time back unchanged, so the value was never re-interpreted in the host zone', () => {
	const utc = withTimeZone('UTC', () => formatReaderInstant(CANONICAL_SAMPLE));
	assert.ok(utc !== null);
	// 02:30 UTC in, 02:30 UTC out. An implicit parse under a non-UTC host TZ
	// would shift this.
	assert.match(utc.text, /2:30/, `expected the 02:30 wall clock back for a UTC reader, got "${utc.text}"`);
});

test('formatReaderInstant returns null, without throwing, for every unusable input', () => {
	for (const bad of [null, undefined, '', '   ', 'not-a-date', '2026-03-01', '2026-03-01T02:30:00Z', 42, {}, [], true, NaN]) {
		let out;
		assert.doesNotThrow(() => {
			out = formatReaderInstant(bad);
		}, `formatReaderInstant threw for ${JSON.stringify(bad) ?? String(bad)}`);
		assert.equal(out, null, `expected null for ${JSON.stringify(bad) ?? String(bad)}`);
	}
});

// ---------------------------------------------------------------------------
// 9. Import boundary, consumer side (T-54-12-01 / D-04).
// ---------------------------------------------------------------------------

const PUBLIC_SUBPATH = '@votetorrent/web-data/public';
const OFFICER_SUBPATH_RE = /@votetorrent\/web-data\/officer/;
const DEEP_WEB_DATA_PATH_RE = /['"][^'"]*packages\/web-data\/src[^'"]*['"]/;

test('positive control: both forbidden import forms are detected by the matchers used below', () => {
	const plantedOfficer = "import { readKeyholders } from '@votetorrent/web-data/officer';";
	const plantedDeep = "import { openStoreHandle } from '../../../packages/web-data/src/open-db.js';";
	assert.match(plantedOfficer, OFFICER_SUBPATH_RE, 'the officer-subpath matcher is inert');
	assert.match(plantedDeep, DEEP_WEB_DATA_PATH_RE, 'the deep-path matcher is inert');
	// And they discriminate: neither fires on the sanctioned form.
	const sanctioned = `import { findNetwork } from '${PUBLIC_SUBPATH}';`;
	assert.doesNotMatch(sanctioned, OFFICER_SUBPATH_RE);
	assert.doesNotMatch(sanctioned, DEEP_WEB_DATA_PATH_RE);
});

test('public-election-source.js reaches the shared data package by its public subpath and by no other specifier', () => {
	const stripped = stripCommentLines(readFileSync(publicSrc('public-election-source.js'), 'utf8'));
	assert.ok(stripped.includes(PUBLIC_SUBPATH), `expected a static import of ${PUBLIC_SUBPATH}`);
	assert.doesNotMatch(stripped, OFFICER_SUBPATH_RE, 'the read seam reaches the officer half of the audience split');
	assert.doesNotMatch(stripped, DEEP_WEB_DATA_PATH_RE, 'the read seam reaches around the package into its own sources');
});

test('public-election-source.js logs no error message text — a comment-stripped grep for .message returns nothing', () => {
	const stripped = stripCommentLines(readFileSync(publicSrc('public-election-source.js'), 'utf8'));
	assert.doesNotMatch(stripped, /\b(?:err|error|e)\s*\??\.\s*message\b/, 'an error message text reached the executable body');
});

// ---------------------------------------------------------------------------
// 10. Drift fence — reader-instant.js is the ONLY instant formatter (D-26).
// ---------------------------------------------------------------------------

const LOCALE_FORMATTER_RE = /Intl\.DateTimeFormat|toLocaleString|toLocaleDateString|toLocaleTimeString/;

test('positive control: the locale-formatter matcher fires on a planted toLocaleDateString( fixture and on a planted Intl.DateTimeFormat fixture', () => {
	assert.match('const s = d.toLocaleDateString();', LOCALE_FORMATTER_RE, 'matcher is inert against a planted toLocale form');
	assert.match('const f = new Intl.DateTimeFormat();', LOCALE_FORMATTER_RE, 'matcher is inert against a planted Intl form');
	assert.doesNotMatch('const s = d.toISOString();', LOCALE_FORMATTER_RE, 'matcher fires on an ordinary UTC formatter');
});

test('D-26 drift fence: reader-instant.js is the only file under src/ that formats an instant for the reader locale', () => {
	const expected = publicSrc('reader-instant.js');
	/** @type {string[]} */
	const formatters = [];
	for (const file of walkAll(publicSrc())) {
		if (LOCALE_FORMATTER_RE.test(stripCommentLines(readFileSync(file, 'utf8')))) formatters.push(file);
	}
	assert.deepEqual(
		formatters,
		[expected],
		'D-26 has ONE sanctioned reader-local formatter so the zone label and the explicit-UTC parse cannot drift apart ' +
			`across four render plans. Route the displayed instant through formatReaderInstant instead. Found: ${formatters.join(', ')}`,
	);
});
