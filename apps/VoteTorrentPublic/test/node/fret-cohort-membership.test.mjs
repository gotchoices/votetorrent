/**
 * fret-cohort-membership.test.mjs — 56-23 Task 1.
 *
 * Makes runnable, over the app's OWN resolved `p2p-fret@1.0.0-beta.4` bytes, the arithmetic
 * `56-23-PLAN.md` states in prose: a bootstrap-seeded FRET ring entry — carrying
 * `DigitreeStore.upsert`'s NEW-id defaults (`membership: 'unknown'`, `state: 'disconnected'`),
 * exactly what `seedFromBootstraps` produces for every configured bootstrap — is excluded from
 * the FRET service class's `assembleCohort` method, whose `isLiveMember` filter is hard-wired,
 * at ANY `wants`, and is included once — and only once — that same entry is classified `member`.
 * `56-21`'s own forward-target rule (`cohort.find(id => id !== selfId)`) finds no target in the
 * excluded case and finds the gateway in the classified case, which is the exact refutation
 * `56-23-ORIGIN-FORWARD-SUPERSEDED.md` cites as arithmetic over measured numbers.
 *
 * Fixtures: the two real peer-id strings from `56-20-SELF-DISPATCH-MEASUREMENT.md` § Run 1 —
 * `selfPeerId` and the gateway's own reported `ORIGIN_CONTROL_ADDR` peerId — so the fixture
 * length and alphabet match production rather than being a too-short stand-in
 * (`project_ui_defects_invisible_to_every_tier`).
 *
 * This test starts nothing: no FRET service instance, no libp2p node, no socket, no write to
 * `.yarn/patches/`, `patches/` or any `package.json`. It drives `DigitreeStore` and the pure
 * `assembleCohort(store, hashedCoord, wants, exclude, filter)` directly, with the REAL
 * `isLiveMember` predicate imported from the shipped bytes — never a locally re-declared copy,
 * which would prove nothing about the bytes the browser actually loads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DigitreeStore, assembleCohort, hashKey } from 'p2p-fret';

// -------------------------------------------------------------------------------------------
// Resolve the app's OWN installed p2p-fret, never an arbitrary one. SIX resolved copies of the
// p2p stack exist in this repo (project_spike_node_modules_drop_yarn_patches) and a version
// skew is never verified from a convenient path — this test states which copy it exercised.
// -------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);

/**
 * `p2p-fret`'s own `package.json` `exports` map exposes ONLY the `"import"` condition for `"."`
 * (no `"require"`/`"default"`), so `require.resolve('p2p-fret')` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` ("No \"exports\" main defined") against it — measured directly
 * while authoring this test, not assumed from a reading. That is a property of the installed
 * package, not a defect in this test's resolution strategy: `import.meta.resolve` is the
 * resolver that actually honours the `"import"` condition, so it is the fallback engaged on
 * exactly that one error code. Both calls below are real and load-bearing — `require.resolve`
 * runs first and genuinely fails against this ESM-only package, then `import.meta.resolve`
 * genuinely succeeds and is what this test actually uses.
 */
let resolvedIndexPath;
try {
	resolvedIndexPath = require.resolve('p2p-fret');
} catch (/** @type {any} */ err) {
	if (err?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err;
	resolvedIndexPath = fileURLToPath(import.meta.resolve('p2p-fret'));
}

assert.ok(
	resolvedIndexPath.includes('node_modules/p2p-fret/'),
	`resolved p2p-fret path does not lie under a node_modules/p2p-fret segment: ${resolvedIndexPath}`,
);
assert.ok(
	resolvedIndexPath.endsWith('dist/src/index.js'),
	`expected the package's declared entry point, got: ${resolvedIndexPath}`,
);

// This line IS the provenance record `56-23-PLAN.md` requires: the run's own output names the
// resolved p2p-fret path it exercised, quoted verbatim in the SUMMARY.
console.log(`[fret-cohort-membership] resolved p2p-fret at: ${resolvedIndexPath}`);

const PACKAGE_ROOT = resolvedIndexPath.slice(0, -'dist/src/index.js'.length);
const LIVE_MEMBER_PATH = `${PACKAGE_ROOT}dist/src/service/live-member.js`;
const FRET_SERVICE_PATH = `${PACKAGE_ROOT}dist/src/service/fret-service.js`;

// `isLiveMember` is NOT a root export and the `exports` map refuses a deep BARE specifier — a
// deep FILE path built from the resolved package root is not constrained by that map at all.
// Import the REAL predicate; a local re-declaration would prove nothing about the shipped bytes.
const { isLiveMember } = await import(pathToFileURL(LIVE_MEMBER_PATH).href);

// -------------------------------------------------------------------------------------------
// Pin the two source facts the whole argument rests on. Both greps read the DEPENDENCY file,
// never this test's own source, and assert a POSITIVE match rather than an absence, so this
// test cannot become permanently green by quoting its own subject
// (project_self_tripping_checker_headers).
// -------------------------------------------------------------------------------------------
const LIVE_MEMBER_SRC = readFileSync(LIVE_MEMBER_PATH, 'utf8');
const FRET_SERVICE_SRC = readFileSync(FRET_SERVICE_PATH, 'utf8');

// Assembled from fragments at runtime rather than written as one contiguous literal, so this
// test's own source never contains a re-declaration-shaped "const" + "isLiveMember" + "="
// substring run together (acceptance criterion 4 asserts zero such occurrences in THIS file)
// while still asserting the dependency's exact combined text
// (project_self_tripping_checker_headers).
const PIN_PREDICATE_EXPECTED_LINE =
	'export const isLiveMember' +
	" = (e) => e.membership === 'member' && e.state !== 'dead';";

test('PIN-PREDICATE: the resolved live-member.js contains the predicate source line verbatim', () => {
	assert.ok(
		LIVE_MEMBER_SRC.includes(PIN_PREDICATE_EXPECTED_LINE),
		"a dependency bump changed isLiveMember's exact source — the whole refutation must be re-verified against the new bytes before it is trusted again",
	);
});

test('PIN-SEED: seedFromBootstraps reaches noteDiscovered and carries its own "not a peer we contacted" comment', () => {
	const seedStart = FRET_SERVICE_SRC.indexOf('async seedFromBootstraps()');
	assert.ok(seedStart >= 0, 'seedFromBootstraps method not found under its expected name — dependency shape changed');
	// Scoped to the method body only (it spans well under 1500 chars in the resolved bytes as of
	// this writing), never the whole file — a narrow window that still fully covers the method.
	const seedBody = FRET_SERVICE_SRC.slice(seedStart, seedStart + 1500);
	assert.ok(seedBody.includes('noteDiscovered'), 'seedFromBootstraps no longer reaches noteDiscovered');
	assert.ok(
		seedBody.includes('not a peer we contacted'),
		"seedFromBootstraps lost its \"not a peer we contacted\" hearsay-baseline comment",
	);
});

// -------------------------------------------------------------------------------------------
// Build the store the way FRET builds it. Coordinates derive from the package's own hashKey
// over each peer-id string's UTF-8 bytes (put() asserts the coordinate width, so a hand-built
// byte array is not a valid substitute), and the query coordinate derives the same way from a
// third, distinct label.
//
// Fixtures quoted from 56-20-SELF-DISPATCH-MEASUREMENT.md § Run 1: `selfPeerId` and the
// gateway's own reported ORIGIN_CONTROL_ADDR peerId, byte-identical to that run's second
// `fretPeerIds` entry.
// -------------------------------------------------------------------------------------------
const SELF_ID = '12D3KooWAkPWhgPRvV6g9aF8ghhftJNuz7KWUdp3WUTZt2SwpXXz';
const GATEWAY_ID = '12D3KooWJ9KmRHj6vTxbPYdi1G4Q2eGogmogXWG6p3zsvi3ab7KZ';

const enc = new TextEncoder();
const selfCoord = await hashKey(enc.encode(SELF_ID));
const gatewayCoord = await hashKey(enc.encode(GATEWAY_ID));
const queryCoord = await hashKey(enc.encode('fret-cohort-membership-test-query-coordinate'));

/** A store holding self + the bootstrap-seeded gateway, both at upsert's NEW-id defaults. */
function buildSeededStore() {
	const store = new DigitreeStore();
	store.upsert(SELF_ID, selfCoord);
	store.upsert(GATEWAY_ID, gatewayCoord);
	return store;
}

/** The state 56-20 measured: self classified `member`, the gateway left unclassified. */
function buildExcludedStore() {
	const store = buildSeededStore();
	store.update(SELF_ID, { membership: 'member', state: 'connected' });
	return store;
}

/** The positive control: the SAME store, with the gateway now classified `member` too. */
function buildClassifiedStore() {
	const store = buildExcludedStore();
	store.update(GATEWAY_ID, { membership: 'member', state: 'connected' });
	return store;
}

/**
 * 56-21's own forward-target selection rule, reproduced verbatim for this refutation.
 * @param {string[]} cohort
 * @param {string} selfId
 */
function findForwardTarget(cohort, selfId) {
	return cohort.find((id) => id !== selfId);
}

test('DEFAULTS: DigitreeStore.upsert on a NEW id yields membership "unknown" and state "disconnected"', () => {
	const store = buildSeededStore();
	const gatewayEntry = store.getById(GATEWAY_ID);
	assert.ok(gatewayEntry, 'gateway entry missing immediately after upsert');
	assert.equal(gatewayEntry.membership, 'unknown');
	assert.equal(gatewayEntry.state, 'disconnected');
	// Self starts at the same defaults in this synthetic store — production seeds self
	// differently, but this test's own store construction has not yet promoted anyone.
	const selfEntry = store.getById(SELF_ID);
	assert.ok(selfEntry, 'self entry missing immediately after upsert');
	assert.equal(selfEntry.membership, 'unknown');
	assert.equal(selfEntry.state, 'disconnected');
	assert.equal(store.size(), 2);
});

test('EXCLUDED-AT-MEASURED-WINDOW: a bootstrap-seeded gateway is excluded from assembleCohort at the measured clusterWindow of 16', () => {
	const store = buildExcludedStore();
	const cohort = assembleCohort(store, queryCoord, 16, undefined, isLiveMember);
	assert.deepEqual(cohort, [SELF_ID]);
	assert.equal(cohort.length, 1);
	assert.equal(store.size(), 2);
});

test('EXCLUDED-AT-ANY-WINDOW: the SAME store returns exactly [self] at wants = 1000 — the window is not why the gateway is missing', () => {
	const store = buildExcludedStore();
	const cohort = assembleCohort(store, queryCoord, 1000, undefined, isLiveMember);
	assert.deepEqual(cohort, [SELF_ID]);
	assert.equal(cohort.length, 1);
	assert.equal(store.size(), 2);
});

test('INCLUDED-ONCE-CLASSIFIED (positive control): the SAME call at wants = 16 returns BOTH ids once the gateway is classified member', () => {
	const store = buildClassifiedStore();
	const cohort = assembleCohort(store, queryCoord, 16, undefined, isLiveMember);
	assert.equal(cohort.length, 2);
	assert.deepEqual([...cohort].sort(), [GATEWAY_ID, SELF_ID].sort());
	assert.equal(store.size(), 2);
});

test('NO-FORWARD-TARGET: 56-21\'s own forward-target rule finds no target on the excluded store, at either wants value, and finds the gateway once classified', () => {
	const excluded = buildExcludedStore();
	const cohortAt16 = assembleCohort(excluded, queryCoord, 16, undefined, isLiveMember);
	assert.equal(findForwardTarget(cohortAt16, SELF_ID), undefined);
	const cohortAt1000 = assembleCohort(excluded, queryCoord, 1000, undefined, isLiveMember);
	assert.equal(findForwardTarget(cohortAt1000, SELF_ID), undefined);

	const classified = buildClassifiedStore();
	const cohortClassified = assembleCohort(classified, queryCoord, 16, undefined, isLiveMember);
	assert.equal(findForwardTarget(cohortClassified, SELF_ID), GATEWAY_ID);
});

test('STORE-SIZE-INVARIANT: no case above passes because an entry silently vanished from the store rather than from the walk', () => {
	assert.equal(buildSeededStore().size(), 2);
	assert.equal(buildExcludedStore().size(), 2);
	assert.equal(buildClassifiedStore().size(), 2);
});
