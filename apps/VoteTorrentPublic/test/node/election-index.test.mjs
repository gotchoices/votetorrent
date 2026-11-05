/**
 * election-index.test.mjs — tier-1 proof of D-34's registry-walking read seam,
 * driven entirely through INJECTED dependencies: no browser, no IndexedDB, no
 * localStorage. The subject is `src/election-index-source.js`, imported
 * directly by relative path (the D-25 idiom for a module this file EXECUTES
 * rather than merely scans).
 *
 * THE ONE THING TO READ BEFORE EDITING ANY GATE IN THIS FILE (I-15).
 * `attachNetworkDb` calls `openStoreHandle`, which calls `indexedDB.open`,
 * which CREATES an absent store rather than refusing one. On a page that takes
 * its network identifier from the URL (D-33), an unguarded attach therefore
 * lets a link author plant an empty database in a stranger's browser — a
 * WRITE, on a page whose entire premise is anonymous read-only viewing. The
 * mitigation is structural and is asserted below by a ZERO-CALL SPY over
 * `attachNetworkDb`, paired with a control proving that same spy does fire
 * when the registry legitimately holds something. A zero-call assertion with
 * no proof the spy can count is not evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { COPY, t } from '../../../../packages/ui-web/src/index.js';
import { loadHeldElections, mergeHeldElections, DEFAULT_INDEX_DEPS } from '../../src/election-index-source.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

// ---------------------------------------------------------------------------
// The injected dependency double. Deliberately a hand-rolled recorder rather
// than a mocking library: the counts it keeps (attach calls, close calls, the
// exact hash arguments) ARE the evidence several assertions below rest on.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FakeSpec
 * @property {ReadonlyArray<string>} [networks]        registry entry hashes, in registry order
 * @property {boolean} [registryThrows]                the HARD registry failure (a corrupt stored entry)
 * @property {Record<string, ReadonlyArray<{ Id: string, Title?: string | null, Date: string }>>} [rows]
 * @property {ReadonlyArray<string>} [attachFails]     hashes whose attach throws
 * @property {ReadonlyArray<string>} [listFails]       hashes whose listPublicElections throws
 */

/**
 * @param {FakeSpec} spec
 */
function makeDeps(spec) {
	const networks = spec.networks ?? [];
	const rows = spec.rows ?? {};
	const attachFails = new Set(spec.attachFails ?? []);
	const listFails = new Set(spec.listFails ?? []);

	/** @type {{ attachArgs: string[], closeCount: number, listNetworksCalls: number }} */
	const record = { attachArgs: [], closeCount: 0, listNetworksCalls: 0 };

	const deps = {
		/** @param {unknown} _storage */
		listNetworks(_storage) {
			record.listNetworksCalls += 1;
			if (spec.registryThrows) {
				// The shape `networks-registry.js` really throws: a structurally
				// corrupt stored ENTRY, naming the offending FIELD only.
				const err = new Error('networks-registry: field "bootstrappedAt" is invalid -- must be a string');
				err.name = 'InvalidNetworkRegistryError';
				throw err;
			}
			return networks.map((networkHash) => ({
				networkHash,
				authorityName: 'A',
				domain: 'd',
				officerUserId: 'u',
				bootstrappedAt: '2026-01-01T00:00:00',
			}));
		},
		/** @param {string} networkHash @param {unknown} _options */
		async attachNetworkDb(networkHash, _options) {
			record.attachArgs.push(networkHash);
			if (attachFails.has(networkHash)) {
				// attachNetworkDb closes its own handle before throwing, so a
				// failed attach contributes NO open handle for the caller to
				// close — mirrored here so the attach/close balance assertion
				// measures the real contract rather than a friendlier one.
				throw new Error('attach failed');
			}
			return { __handleFor: networkHash };
		},
		/** @param {unknown} _db */
		async closeNetworkDb(_db) {
			record.closeCount += 1;
		},
		/** @param {{ __handleFor: string }} db */
		async listPublicElections(db) {
			const hash = db.__handleFor;
			if (listFails.has(hash)) throw new Error('list failed');
			return [...(rows[hash] ?? [])];
		},
	};

	return { deps, record };
}

/** @param {string} id @param {string} date @param {string | null} [title] */
function row(id, date, title = `Title of ${id}`) {
	return { Id: id, Title: title, Date: date };
}

// ---------------------------------------------------------------------------
// INERTNESS CONTROL, FIRST. A loader that always returned an empty,
// incomplete result cannot pass this suite.
// ---------------------------------------------------------------------------

test('inertness control: two registry entries, both attaching, each holding one election -> 2 elections, complete, nothing unreadable', async () => {
	const { deps } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({}, deps);
	assert.equal(result.elections.length, 2, 'the loader returned nothing from a registry that holds two readable networks');
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 0);
	assert.equal(result.complete, true);
	assert.ok(Object.isFrozen(result), 'the result must be frozen');
});

// ---------------------------------------------------------------------------
// The empty-registry path — I-01's first-time visitor, and the ONE case that
// licenses an UNQUALIFIED "no elections" statement.
// ---------------------------------------------------------------------------

test('an empty registry is COMPLETE: nothing held is a settled finding, not an incomplete one', async () => {
	const { deps, record } = makeDeps({ networks: [] });
	const result = await loadHeldElections({}, deps);
	assert.deepEqual([...result.elections], []);
	assert.equal(result.networksAttempted, 0);
	assert.equal(result.networksUnreadable, 0);
	assert.equal(result.complete, true, 'an empty registry is the ordinary first-visit state and licenses the unqualified claim');
	assert.equal(record.attachArgs.length, 0);
});

// ---------------------------------------------------------------------------
// A FAULT IS NOT A FACT (D-28). A registry the browser cannot parse must map
// to "unreadable", NEVER to "holds nothing" — telling a reader "no elections"
// because the registry threw is a FALSE STATEMENT.
// ---------------------------------------------------------------------------

test('a corrupt registry maps to UNREADABLE, never to notHeld: the loader does not throw, and reports complete === false', async () => {
	const { deps, record } = makeDeps({ registryThrows: true });
	/** @type {unknown} */
	let thrown = null;
	let result;
	try {
		result = await loadHeldElections({}, deps);
	} catch (err) {
		thrown = err;
	}
	assert.equal(thrown, null, 'loadHeldElections must never throw — an anonymous page has no operator to surface a failure to');
	assert.ok(result);
	assert.deepEqual([...result.elections], []);
	assert.equal(result.complete, false, 'a registry that could not be parsed is NOT the same answer as "this browser holds nothing"');
	assert.equal(record.attachArgs.length, 0);
});

test('THE SHAPE THAT DECIDES THE RENDER GUARD: a corrupt registry leaves networksUnreadable at 0 while complete is false', async () => {
	const { deps } = makeDeps({ registryThrows: true });
	const result = await loadHeldElections({}, deps);
	assert.equal(result.networksAttempted, 0);
	assert.equal(result.networksUnreadable, 0, 'nothing was attempted, so nothing can be counted unreadable');
	assert.equal(result.complete, false);
	// Stated as an assertion rather than as a comment, because this is exactly
	// the reasoning a later "simplification" would discard: a render layer
	// gating its qualifier on the COUNTER would leave this case unqualified.
	assert.equal(
		result.networksUnreadable > 0,
		false,
		'a counter-based qualifier gate would let precisely the corrupt-registry case render an unqualified "no elections"',
	);
});

// ---------------------------------------------------------------------------
// A held network that could not be attached.
// ---------------------------------------------------------------------------

test('one of two networks fails to attach: the other network\'s elections still come back, unreadable === 1, complete === false', async () => {
	const { deps } = makeDeps({
		networks: ['nw-good', 'nw-bad'],
		rows: { 'nw-good': [row('e-good', '2026-05-01')] },
		attachFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-good'],
	);
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false);
});

test('listPublicElections throwing for one network has the same shape as an attach failure', async () => {
	const { deps } = makeDeps({
		networks: ['nw-good', 'nw-bad'],
		rows: { 'nw-good': [row('e-good', '2026-05-01')] },
		listFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-good'],
	);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false);
});

// ---------------------------------------------------------------------------
// THE CO-OCCURRENCE CASE — the one the qualifier exists for. The list is
// empty AND the answer is incomplete, both at once.
// ---------------------------------------------------------------------------

test('co-occurrence: one network reads fine and holds NOTHING while a second cannot be attached -> empty list AND complete === false', async () => {
	const { deps } = makeDeps({
		networks: ['nw-empty', 'nw-bad'],
		rows: { 'nw-empty': [] },
		attachFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual([...result.elections], [], 'the list is empty');
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false, 'and the answer is incomplete — emptiness and completeness are independent axes');
});

// ---------------------------------------------------------------------------
// Handle hygiene. A live handle is what resurrects a deleted IndexedDB as an
// empty shell, so a failing network must not strand one.
// ---------------------------------------------------------------------------

test('every handle the loader opened is closed, on the success path', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	await loadHeldElections({}, deps);
	assert.equal(record.attachArgs.length, 2);
	assert.equal(record.closeCount, 2, 'attachCount !== closeCount — a handle was left holding a database');
});

test('every handle the loader opened is closed, on the THROWING path too (a read that throws after the handle is open)', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')] },
		listFails: ['nw-two'],
	});
	await loadHeldElections({}, deps);
	assert.equal(record.attachArgs.length, 2);
	assert.equal(record.closeCount, 2, 'a network whose read threw left its handle open');
});

// ---------------------------------------------------------------------------
// ORDER IS A FUNCTION OF THE ELECTION DATA, NEVER OF THE REGISTRY'S ORDER —
// which is the exact ambiguity D-33 cites as its reason for naming both
// identifiers in the address.
// ---------------------------------------------------------------------------

test('reversing the registry order produces a deepEqual election list', async () => {
	const rows = {
		'nw-one': [row('e-alpha', '2026-05-01'), row('e-beta', '2026-09-01')],
		'nw-two': [row('e-gamma', '2026-07-01')],
	};
	const forward = await loadHeldElections({}, makeDeps({ networks: ['nw-one', 'nw-two'], rows }).deps);
	const reverse = await loadHeldElections({}, makeDeps({ networks: ['nw-two', 'nw-one'], rows }).deps);
	assert.deepEqual(
		forward.elections.map((e) => ({ ...e })),
		reverse.elections.map((e) => ({ ...e })),
		'the merged order depends on the registry order — the exact ambiguity D-33 exists to remove',
	);
	assert.deepEqual(
		forward.elections.map((e) => e.electionId),
		['e-beta', 'e-gamma', 'e-alpha'],
		'expected Date descending',
	);
});

test('mergeHeldElections sorts by Date descending then electionId ascending, and is pure', () => {
	const merged = mergeHeldElections([
		[
			{ networkHash: 'nw-a', electionId: 'z-late', title: 'Z', date: '2026-01-01' },
			{ networkHash: 'nw-a', electionId: 'a-late', title: 'A', date: '2026-01-01' },
		],
		[{ networkHash: 'nw-b', electionId: 'm-early', title: 'M', date: '2026-09-09' }],
	]);
	assert.deepEqual(
		merged.map((e) => e.electionId),
		['m-early', 'a-late', 'z-late'],
	);
	assert.ok(Object.isFrozen(merged));
	assert.ok(merged.every((e) => !('date' in e)), 'the Date column must not survive into the rendered shape (D-26 owns instant display)');
});

// ---------------------------------------------------------------------------
// T-54-11-02 / I-15 — THE ZERO-CALL SPY, AND THE CONTROL THAT PROVES IT
// DISCRIMINATES.
// ---------------------------------------------------------------------------

const ATTACKER_HASH = 'nw-attacker-controlled-0001';

test('I-15 ZERO-CALL SPY: a URL-supplied networkHash the registry does not hold reaches NO database call at all', async () => {
	const { deps, record } = makeDeps({ networks: [] });
	const result = await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(
		record.attachArgs.length,
		0,
		'a URL-supplied hash reached attachNetworkDb. openStoreHandle CREATES an absent store, so this is a link author ' +
			'planting an empty database in a stranger\'s browser (I-15).',
	);
	assert.equal(result.complete, true, 'an empty registry is still a settled finding');
});

test('I-15 CONTROL: the SAME spy DOES fire when the registry legitimately holds a network — the zero above is a refusal, not a dead wire', async () => {
	const { deps, record } = makeDeps({ networks: ['nw-held'], rows: { 'nw-held': [row('e-held', '2026-05-01')] } });
	await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(record.attachArgs.length, 1, 'the attach spy never fires at all — the zero-call assertion above proves nothing');
	assert.deepEqual(record.attachArgs, ['nw-held'], 'the spy fired with a REGISTRY hash, never with the URL-supplied one');
});

test('I-15 CONTROL: the spy is also silent when the registry itself threw, and that silence is likewise proven discriminating by the case above', async () => {
	const { deps, record } = makeDeps({ registryThrows: true });
	await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(record.attachArgs.length, 0, 'a corrupt registry must not license an attach of a URL-supplied hash');
});

test('I-15 PROVENANCE: across every shape, every hash ever handed to attachNetworkDb came OUT of the registry — registry membership, not the URL, authorises a database name', async () => {
	/** @type {ReadonlyArray<{ label: string, networks: string[], networkHash: string | null }>} */
	const shapes = [
		{ label: 'empty registry + hostile hash', networks: [], networkHash: ATTACKER_HASH },
		{ label: 'held networks + hostile hash', networks: ['nw-one', 'nw-two'], networkHash: ATTACKER_HASH },
		{ label: 'held networks + a held hash', networks: ['nw-one', 'nw-two'], networkHash: 'nw-two' },
		{ label: 'held networks + no hash', networks: ['nw-one', 'nw-two'], networkHash: null },
		{ label: 'held networks + empty-string hash', networks: ['nw-one'], networkHash: '' },
	];
	let totalAttaches = 0;
	for (const shape of shapes) {
		const { deps, record } = makeDeps({ networks: shape.networks });
		await loadHeldElections({ networkHash: shape.networkHash }, deps);
		totalAttaches += record.attachArgs.length;
		for (const arg of record.attachArgs) {
			assert.ok(shape.networks.includes(arg), `[${shape.label}] attachNetworkDb was handed "${arg}", which is not a registry member`);
		}
		assert.ok(!record.attachArgs.includes(ATTACKER_HASH), `[${shape.label}] the URL-supplied hash reached attachNetworkDb`);
	}
	assert.ok(totalAttaches > 0, 'no shape attached anything — this whole scan would be vacuous');
});

// ---------------------------------------------------------------------------
// Scoping and fallback.
// ---------------------------------------------------------------------------

test('scoping: a networkHash the registry DOES hold attaches only that network', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({ networkHash: 'nw-two' }, deps);
	assert.deepEqual(record.attachArgs, ['nw-two']);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-two'],
	);
	assert.equal(result.networksAttempted, 1);
	assert.equal(result.complete, true);
});

test('fallback: a networkHash the registry does NOT hold still shows everything the browser does hold', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.deepEqual(record.attachArgs, ['nw-one', 'nw-two']);
	assert.equal(result.elections.length, 2);
});

// ---------------------------------------------------------------------------
// Row shape.
// ---------------------------------------------------------------------------

test('a row with a null or absent Title yields title: null and is STILL LISTED', async () => {
	const { deps } = makeDeps({
		networks: ['nw-one'],
		rows: { 'nw-one': [row('e-null', '2026-05-01', null), { Id: 'e-absent', Date: '2026-04-01' }] },
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => [e.electionId, e.title]),
		[
			['e-null', null],
			['e-absent', null],
		],
	);
});

test('each element carries the networkHash it was read from, so the index can address it with both parameters', async () => {
	const { deps } = makeDeps({ networks: ['nw-one'], rows: { 'nw-one': [row('e-one', '2026-05-01')] } });
	const result = await loadHeldElections({}, deps);
	assert.equal(result.elections[0].networkHash, 'nw-one');
	assert.equal(result.elections[0].title, 'Title of e-one');
});

test('loadHeldElections never throws across every option shape, including hostile ones', async () => {
	/** @type {unknown[]} */
	const optionShapes = [undefined, {}, { networkHash: null }, { networkHash: '' }, { networkHash: ATTACKER_HASH }, { networkHash: 'a'.repeat(10000) }];
	for (const options of optionShapes) {
		const { deps } = makeDeps({ networks: ['nw-one'], rows: { 'nw-one': [row('e-one', '2026-05-01')] } });
		const result = await loadHeldElections(/** @type {never} */ (options), deps);
		assert.ok(Object.isFrozen(result), `result not frozen for options ${JSON.stringify(options)}`);
	}
});

test('DEFAULT_INDEX_DEPS is frozen and holds the four real functions — the deps parameter is a test SEAM over the real modules, never a fixture that ships', () => {
	assert.ok(Object.isFrozen(DEFAULT_INDEX_DEPS));
	for (const name of ['listNetworks', 'attachNetworkDb', 'closeNetworkDb', 'listPublicElections']) {
		assert.equal(typeof (/** @type {Record<string, unknown>} */ (DEFAULT_INDEX_DEPS)[name]), 'function', `DEFAULT_INDEX_DEPS.${name} is not a function`);
	}
});

// ---------------------------------------------------------------------------
// Import discipline (T-54-11-03) — over COMMENT-STRIPPED source, with a
// positive control for each matcher first.
// ---------------------------------------------------------------------------

const SEAM_SOURCE = readFileSync(publicSrc('election-index-source.js'), 'utf8');
const SEAM_STRIPPED = stripComments(SEAM_SOURCE);

/** Assembled rather than written whole, so this file's own source never
 * contains the literal it hunts — the self-tripping-checker failure this repo
 * has manufactured repeatedly. @type {RegExp} */
const OFFICER_SUBPATH_RE = new RegExp(['@votetorrent', 'web-data', 'officer'].join('\\/'));
/** @type {RegExp} */
const DEEP_WEB_DATA_PATH_RE = new RegExp(`from ['"][^'"]*${['packages', 'web-data'].join('\\/')}`);

test('positive control: both import-discipline matchers fire on planted violations (the planted literals are ASSEMBLED, never written whole)', () => {
	const officerPlant = `import { x } from '${['@votetorrent', 'web-data', 'officer'].join('/')}';`;
	const deepPlant = `import { y } from '../../../${['packages', 'web-data'].join('/')}/src/open-db.js';`;
	assert.ok(officerPlant.includes('officer'), 'fixture sanity: the planted line must really name the officer subpath');
	assert.match(officerPlant, OFFICER_SUBPATH_RE, 'the officer-subpath matcher is inert');
	assert.match(deepPlant, DEEP_WEB_DATA_PATH_RE, 'the deep-path matcher is inert');
});

test('benign control: neither matcher fires on the bare public subpath specifier the seam is allowed to use', () => {
	const benign = "import { listNetworks } from '@votetorrent/web-data/public';";
	assert.doesNotMatch(benign, OFFICER_SUBPATH_RE);
	assert.doesNotMatch(benign, DEEP_WEB_DATA_PATH_RE);
});

test('the seam reaches the shared package ONLY through its bare public subpath — never the officer half, never a deep path', () => {
	assert.doesNotMatch(SEAM_STRIPPED, OFFICER_SUBPATH_RE, 'the index seam reaches the officer subpath (D-04)');
	assert.doesNotMatch(SEAM_STRIPPED, DEEP_WEB_DATA_PATH_RE, 'the index seam reaches the shared data package by a deep source path rather than by its bare public subpath');
	assert.ok(SEAM_STRIPPED.includes("'@votetorrent/web-data/public'"), 'sanity: the seam must actually import the public subpath, or this scan is vacuous');
});

test('this test file\'s own RAW source contains zero occurrences of EITHER hunted literal — a checker whose own source quotes its pattern is permanently green (this has recurred repeatedly in this repo)', () => {
	const own = readFileSync(new URL(import.meta.url), 'utf8');
	for (const literal of [['@votetorrent', 'web-data', 'officer'].join('/'), ['packages', 'web-data'].join('/')]) {
		assert.equal(own.split(literal).length - 1, 0, `this file names the hunted literal "${literal}" in its own source`);
	}
});

// ===========================================================================
// SOURCE ASSERTIONS OVER ElectionIndex.tsx AND THE SHELL MOUNT POINT.
//
// Every one runs against COMMENT-STRIPPED source and is preceded by a planted
// positive control, because a checker whose own comment quotes its pattern is
// permanently green and an assertion never seen refusing anything is not
// evidence.
// ===========================================================================

const INDEX_TSX_SOURCE = readFileSync(publicSrc('screens', 'ElectionIndex.tsx'), 'utf8');
const INDEX_TSX_STRIPPED = stripComments(INDEX_TSX_SOURCE);
const SHELL_TSX_STRIPPED = stripComments(readFileSync(publicSrc('screens', 'ElectionShell.tsx'), 'utf8'));

// -- The mounted copy keys, and TOTALITY in both directions -----------------
//
// This is the mechanism that binds 54-09's final key names without
// transcribing a guess: a rename, an added key nobody mounts, or a mounted key
// nobody declared all fail HERE, in the file that owns the mounting. `t()`
// throws on an unknown key, so a guessed name is a hard render failure at
// first paint rather than a quiet fallback.

/** @type {RegExp} */
const INDEX_KEY_LITERAL_RE = /['"`](public\.index\.[\w.]+)['"`]/g;

/** @param {string} source @returns {Set<string>} */
function indexKeysIn(source) {
	/** @type {Set<string>} */
	const out = new Set();
	const re = new RegExp(INDEX_KEY_LITERAL_RE.source, 'g');
	let m;
	while ((m = re.exec(source))) out.add(m[1]);
	return out;
}

test('positive control: the index-key extractor finds a planted key literal and ignores an unrelated one', () => {
	const found = indexKeysIn("t('public.index.plantedProbe'); t('public.chrome.appName');");
	assert.deepEqual([...found], ['public.index.plantedProbe'], 'the key extractor is inert or over-broad');
});

test('KEY TOTALITY: the public.index.* key set declared in COPY and the set mounted in ElectionIndex.tsx are EQUAL in both directions', () => {
	const declared = new Set(Object.keys(COPY).filter((k) => k.startsWith('public.index.')));
	assert.ok(declared.size > 0, 'sanity: COPY declares no public.index.* key at all — this assertion would pass vacuously');
	const mounted = indexKeysIn(INDEX_TSX_STRIPPED);

	const declaredNotMounted = [...declared].filter((k) => !mounted.has(k)).sort();
	const mountedNotDeclared = [...mounted].filter((k) => !declared.has(k)).sort();

	assert.deepEqual(declaredNotMounted, [], `declared public.index.* key(s) this screen never mounts: ${declaredNotMounted.join(', ')}`);
	assert.deepEqual(mountedNotDeclared, [], `public.index.* key(s) mounted here but never declared in COPY -- t() throws on an unknown key, so this is a hard render failure at first paint: ${mountedNotDeclared.join(', ')}`);
});

test('every key this screen mounts really resolves through t() -- the copy table answers each one', () => {
	for (const key of indexKeysIn(INDEX_TSX_STRIPPED)) {
		assert.equal(typeof t(key), 'string', `t('${key}') did not resolve to a string`);
		assert.ok(t(key).length > 0, `t('${key}') resolved to an empty string`);
	}
});

// -- The two conditions are INDEPENDENT -------------------------------------
//
// A source-level check, on purpose: a corrupt registry leaves
// networksUnreadable at 0, so a counter-based guard would silently pass every
// DOM test that only ever exercises attach failures.

/** @type {RegExp} */
const COMPLETENESS_GUARD_RE = /\.complete\s*===\s*false|!\s*[\w.]*\bcomplete\b/;
/** @type {RegExp} */
const COUNTER_GUARD_RE = /networksUnreadable/;

/**
 * Mask the counter where it appears as an object-literal PROPERTY KEY or a
 * type-annotation field -- declaring the field is not guarding on it, and the
 * screen's fallback result literal must name every field of the result shape.
 * Everything else -- a comparison, a ternary test, a bare truthiness check,
 * a destructure -- survives the mask and is caught.
 * @param {string} source @returns {string}
 */
function maskDeclaredFields(source) {
	return source.replace(/\bnetworksUnreadable\s*:/g, '__declaredResultField:');
}

test('positive control: the counter-guard matcher fires on the planted counter-based form, and the completeness-guard matcher does NOT accept it', () => {
	const counterForm = '{resolved.networksUnreadable > 0 ? <p>{t(\'public.index.someUnreadable\')}</p> : null}';
	assert.match(counterForm, COUNTER_GUARD_RE, 'the counter matcher is inert — it could not catch the wrong guard');
	assert.doesNotMatch(counterForm, COMPLETENESS_GUARD_RE, 'the completeness matcher accepts the counter-based form — it discriminates nothing');
});

test('positive control: the property-key mask does NOT hide a real guard -- every guard form survives it', () => {
	for (const guardForm of [
		'{resolved.networksUnreadable > 0 ? <p /> : null}',
		'{resolved.networksUnreadable ? <p /> : null}',
		'if (r.networksUnreadable) { render(); }',
		'const { networksUnreadable } = resolved;',
	]) {
		assert.match(maskDeclaredFields(guardForm), COUNTER_GUARD_RE, `the mask swallowed a real guard: ${guardForm}`);
	}
});

test('negative control: the property-key mask DOES excuse a bare field declaration, which is what makes the scan usable at all', () => {
	assert.doesNotMatch(maskDeclaredFields('const fallback = { elections: [], networksUnreadable: 0, complete: false };'), COUNTER_GUARD_RE);
	assert.doesNotMatch(maskDeclaredFields('	networksUnreadable: number;'), COUNTER_GUARD_RE);
});

test('positive control: the completeness-guard matcher fires on the correct planted form', () => {
	assert.match('{resolved !== null && resolved.complete === false ? <p /> : null}', COMPLETENESS_GUARD_RE);
	assert.match('{resolved !== null && !resolved.complete ? <p /> : null}', COMPLETENESS_GUARD_RE);
});

test('the qualifier is gated on the result\'s COMPLETENESS FLAG and never on a count of unreadable networks', () => {
	assert.match(INDEX_TSX_STRIPPED, COMPLETENESS_GUARD_RE, 'ElectionIndex.tsx does not test the completeness flag at all');
	assert.doesNotMatch(
		maskDeclaredFields(INDEX_TSX_STRIPPED),
		COUNTER_GUARD_RE,
		'ElectionIndex.tsx names the unreadable-network counter. A corrupt registry leaves that counter at 0 while the ' +
			'completeness flag is false, so a counter-based gate lets precisely the corrupt-registry case render an ' +
			'unqualified "no elections" with no qualifier at all.',
	);
});

test('the empty label is gated on EMPTINESS ALONE -- both empty-state elements share one condition, and it is not the completeness one', () => {
	const emptyGuards = INDEX_TSX_STRIPPED.match(/indexState === 'empty'/g) ?? [];
	assert.equal(emptyGuards.length, 2, `expected the heading and the body to be gated on emptiness alone, found ${emptyGuards.length} such guard(s)`);
});

// -- What this screen may render --------------------------------------------

const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE, 'matcher is inert');
});

test('ElectionIndex.tsx uses no raw-HTML escape hatch -- titles are authority-supplied text and JSX text-node escaping is the control', () => {
	assert.doesNotMatch(INDEX_TSX_STRIPPED, RAW_HTML_ESCAPE_HATCH_RE);
});

/** @param {string} source @returns {string[]} every class-name token rendered. */
function renderedClassNames(source) {
	/** @type {string[]} */
	const out = [];
	const re = /className="([^"]*)"/g;
	let m;
	while ((m = re.exec(source))) out.push(...m[1].split(/\s+/).filter((token) => token !== ''));
	return out;
}

test('positive control: the class-name extractor finds a planted class', () => {
	assert.deepEqual(renderedClassNames('<p className="planted-class other-planted">x</p>'), ['planted-class', 'other-planted']);
});

test('ElectionIndex.tsx renders ONLY the two class names the stylesheet already declares -- the three sentence-level elements are deliberately unclassed, so this screen requests no new CSS class', () => {
	const rendered = [...new Set(renderedClassNames(INDEX_TSX_STRIPPED))].sort();
	assert.deepEqual(rendered, ['election-index', 'election-index__item'], `unexpected class name(s) rendered: ${rendered.join(', ')}`);
});

// -- Nothing address-shaped or instant-shaped reaches a text node -----------
//
// The row's own identifiers are used to BUILD the link and to key the list;
// neither may be rendered. Nor may a Date: D-26 makes instant display a
// reader-local, zone-labelled concern owned by a later plan, and an unlabelled
// date here would pre-empt it with a different convention.

/** @param {string} source @returns {string[]} the text of every expression container in TEXT position. */
function textPositionExpressions(source) {
	/** @type {string[]} */
	const out = [];
	const re = />\s*\{([^{}]*)\}\s*</g;
	let m;
	while ((m = re.exec(source))) out.push(m[1].trim());
	return out;
}

test('positive control: the text-position extractor finds a planted rendered identifier and a planted copy call', () => {
	const planted = '<div>{election.electionId}</div><p>{t(\'public.index.emptyBody\')}</p>';
	assert.deepEqual(textPositionExpressions(planted), ['election.electionId', "t('public.index.emptyBody')"], 'the text-position extractor is inert');
});

test('the ONLY text-producing expressions in ElectionIndex.tsx are the t() calls and the election title -- no id, no hash, no date reaches a text node', () => {
	const expressions = textPositionExpressions(INDEX_TSX_STRIPPED);
	assert.ok(expressions.length >= 4, `expected at least the four copy calls in text position, found ${expressions.length}`);

	const copyCalls = expressions.filter((expr) => /^t\('public\.index\.[\w.]+'\)$/.test(expr));
	assert.equal(copyCalls.length, 4, `expected exactly four copy calls in text position, found ${copyCalls.length}: ${copyCalls.join(' | ')}`);

	const others = expressions.filter((expr) => !/^t\('public\.index\.[\w.]+'\)$/.test(expr));
	for (const expr of others) {
		assert.ok(/\btitle\b/.test(expr), `a text-producing expression renders something other than a copy call or the title: "${expr}"`);
		for (const forbidden of ['electionId', 'networkHash', 'Date', 'date']) {
			assert.ok(!expr.includes(forbidden), `a text-producing expression renders "${forbidden}": "${expr}"`);
		}
	}
});

// -- The shell mount point, and everything about the shell that must not move

test('ElectionShell.tsx mounts <ElectionIndex exactly once, still has exactly ONE return, and still renders all three labelled skeleton slots (D-02: 53-D18 amended, not reversed)', () => {
	const mounts = SHELL_TSX_STRIPPED.match(/<ElectionIndex\b/g) ?? [];
	assert.equal(mounts.length, 1, `expected exactly one <ElectionIndex mount, found ${mounts.length}`);

	const returns = SHELL_TSX_STRIPPED.match(/(^|[^\w.])return\b/g) ?? [];
	assert.equal(returns.length, 1, `ElectionShell.tsx must keep exactly ONE return statement, found ${returns.length}`);

	const slots = SHELL_TSX_STRIPPED.match(/data-slot="[\w-]+"/g) ?? [];
	assert.equal(slots.length, 3, `expected all three data-slot skeletons to survive, found ${slots.length}: ${slots.join(', ')}`);
});

test('the shell forwards the addressed network to the index for SCOPING, and the index never renders it', () => {
	assert.match(SHELL_TSX_STRIPPED, /<ElectionIndex\s+networkHash=\{address\.networkHash\}/, 'the shell does not forward the addressed network hash');
});

test('the index mount is gated on the address NOT resolving to one election, by positive enumeration of the two statuses -- never on a condition that can never be false', () => {
	assert.match(
		SHELL_TSX_STRIPPED,
		/address\.status === 'missing' \|\| address\.status === 'incomplete'/,
		"the mount guard drifted. Inside the shell's non-malformed branch the status can only be 'ok', 'missing' or " +
			"'incomplete', so a negated guard naming 'malformed' would carry a clause that can never be false.",
	);
});
