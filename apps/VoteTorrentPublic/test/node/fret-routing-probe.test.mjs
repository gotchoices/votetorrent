/**
 * fret-routing-probe.test.mjs — behaviour contract for
 * `src/peer/fret-routing-probe.js` (`56-20` Task 1).
 *
 * The fakes below fake only the SEAM this module reads (`node.services.fret`,
 * `node.cohortTopicHost`, `node.getConnections`, `node.peerId`) — never
 * `createTierAddressing`/`RingHash`/`hashKey`, which are the REAL, pure,
 * no-I/O functions the probe imports directly from `@optimystic/db-core` and
 * `p2p-fret`. Using the real ring-coordinate math is simpler than
 * reimplementing it and is exactly what lets this suite pin the strict `<`
 * comparison and the window-floor arithmetic against the substrate's own
 * behaviour, not a stand-in for it — the same "fake the seam, not the
 * substrate" discipline `peer-reactivity-bridge.test.mjs` documents for
 * itself.
 *
 * Every `fret.neighborDistance`/`fret.assembleCohort` fake below deliberately
 * IGNORES the coordinate arguments it is called with and returns a
 * caller-configured fixed value — the point of this suite is to pin how the
 * probe INTERPRETS those return values (the strict-`<` branch, the window
 * floor, the `.length` reads), not to re-derive the ring math a real
 * `FretService` would produce for arbitrary fixture bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeFretRouting, FRET_ROUTING_PROBE_PREFIX, WIDE_COHORT_WANTS } from '../../src/peer/fret-routing-probe.js';

const TOPIC_ID = new TextEncoder().encode('vt-fixture-topic-id-0123456789abcdef');
const PARTICIPANT_ID = new TextEncoder().encode('12D3KooWFixtureParticipantId0123456789');

/**
 * A fake `node.services.fret`. `neighborDistanceImpl`/`assembleCohortImpl` default to values that
 * would make every behaviour assertion below vacuous if a test forgot to override them, so a
 * missing override fails loudly rather than passing by accident.
 * @param {{ neighborDistanceImpl?: (...args: any[]) => any, assembleCohortImpl?: (...args: any[]) => any, listPeersImpl?: () => any, networkSizeEstimateImpl?: () => any, getDiagnosticsImpl?: () => any }} [opts]
 */
function makeFakeFret(opts = {}) {
	return {
		neighborDistance: opts.neighborDistanceImpl ?? (() => Number.POSITIVE_INFINITY),
		assembleCohort: opts.assembleCohortImpl ?? (() => []),
		listPeers: opts.listPeersImpl ?? (() => []),
		getNetworkSizeEstimate: opts.networkSizeEstimateImpl ?? (() => ({ size_estimate: 1, confidence: 0, sources: 1 })),
		// 56-24: defaults to a plausible `diag` shape (field names pinned from
		// `p2p-fret`'s own resolved `fret-service.js`) so tests that do not
		// override this still exercise `fretDiagnostics` rather than falling
		// into its `read-failed:` branch by accident.
		getDiagnostics:
			opts.getDiagnosticsImpl ??
			(() => ({
				peersDiscovered: 0,
				snapshotsFetched: 0,
				announcementsSent: 0,
				pingsSent: 0,
				pingsOk: 0,
				pingsFail: 0,
				streamLimit: 0,
				maybeActForwarded: 0,
				evictions: 0,
			})),
	};
}

/**
 * A fake `OptimysticNode`, exposing only the attachments this module reads.
 * @param {{ fret?: any, omitCohortTopicHost?: boolean, registryAll?: () => any[], connections?: any[], peerIdStr?: string }} [opts]
 */
function makeFakeNode(opts = {}) {
	const fret = opts.fret ?? makeFakeFret();
	/** @type {any} */
	const node = {
		peerId: { toString: () => opts.peerIdStr ?? 'self-peer-id' },
		services: { fret },
		getConnections: () => opts.connections ?? [],
	};
	if (!opts.omitCohortTopicHost) {
		node.cohortTopicHost = { registry: { all: opts.registryAll ?? (() => []) } };
	}
	return node;
}

// ---------------------------------------------------------------------------
// Availability gates
// ---------------------------------------------------------------------------

test('probeFretRouting returns available:false reason:fret-service-absent when node.services.fret is undefined, and never throws', async () => {
	const node = { services: {}, cohortTopicHost: {} };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'fret-service-absent' });
});

test('probeFretRouting returns available:false reason:fret-service-absent when node.services is entirely absent, and never throws', async () => {
	const node = { cohortTopicHost: {} };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'fret-service-absent' });
});

test('probeFretRouting returns available:false reason:cohort-host-absent when node.cohortTopicHost is undefined, and never throws', async () => {
	const node = { services: { fret: makeFakeFret() } };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'cohort-host-absent' });
});

// ---------------------------------------------------------------------------
// inCluster branch — both outcomes, plus the strict-< boundary
// ---------------------------------------------------------------------------

test('probeFretRouting: neighborDistance returning 0 carries selfIndex:0 and inCluster:true', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 0 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.selfIndex, 0);
	assert.equal(result.inCluster, true);
});

test('probeFretRouting: neighborDistance returning Number.POSITIVE_INFINITY carries inCluster:false (not permanently true)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => Number.POSITIVE_INFINITY }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.selfIndex, 'Infinity');
	assert.equal(result.inCluster, false);
});

test('probeFretRouting: wantK:4 with neighborDistance returning 4 carries clusterWindow:4 and inCluster:false (strict <, not <=)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 4 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	assert.equal(result.clusterWindow, 4);
	assert.equal(result.selfIndex, 4);
	assert.equal(result.inCluster, false);
});

test('probeFretRouting: wantK:4 with neighborDistance returning 3 carries inCluster:true (one below the window is still in-cluster)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 3 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	assert.equal(result.clusterWindow, 4);
	assert.equal(result.inCluster, true);
});

test('probeFretRouting: wantK:1 carries clusterWindow:2 (the floor of 2 is reproduced)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 0 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 1 });
	assert.equal(result.clusterWindow, 2);
});

// ---------------------------------------------------------------------------
// Length reads — never .size
// ---------------------------------------------------------------------------

test('probeFretRouting: cohortSize equals the .length of the array the fake assembleCohort returns', async () => {
	const cohort = ['peer-a', 'peer-b', 'peer-c'];
	const node = makeFakeNode({ fret: makeFakeFret({ assembleCohortImpl: () => cohort }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.cohortSize, 3);
	assert.deepEqual(result.cohortIds, cohort);
});

test('probeFretRouting: registrySize equals the .length of the array the fake registry.all() returns', async () => {
	const node = makeFakeNode({ registryAll: () => ['coord-engine-a'] });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.registrySize, 1);
});

test('probeFretRouting: registrySize is 0 when the fake registry.all() returns an empty array', async () => {
	const node = makeFakeNode({ registryAll: () => [] });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.registrySize, 0);
});

test('probeFretRouting: fretPeerIds reads the .id field off each listPeers() record, never String(record) (which would carry through as the literal "[object Object]")', async () => {
	const node = makeFakeNode({
		fret: makeFakeFret({
			listPeersImpl: () => [
				{ id: '12D3KooWFixturePeerA', metadata: { foo: 'bar' } },
				{ id: '12D3KooWFixturePeerB', metadata: {} },
			],
		}),
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result.fretPeerIds, ['12D3KooWFixturePeerA', '12D3KooWFixturePeerB']);
	assert.equal(result.fretPeerCount, 2);
	assert.ok(!result.fretPeerIds.some((id) => id.includes('[object Object]')), 'fretPeerIds carried through the discrimination-destroying "[object Object]" stringification');
});

// ---------------------------------------------------------------------------
// Structural-facts-only shape
// ---------------------------------------------------------------------------

test('probeFretRouting: every value in the result is a string, a number, a boolean, or an array of strings', async () => {
	const node = makeFakeNode({
		fret: makeFakeFret({
			neighborDistanceImpl: () => 2,
			assembleCohortImpl: () => ['peer-x', 'peer-y'],
			listPeersImpl: () => [
				{ id: 'peer-x', metadata: {} },
				{ id: 'peer-y', metadata: {} },
				{ id: 'peer-z', metadata: {} },
			],
		}),
		registryAll: () => ['coord-engine-a'],
		connections: [{ remotePeer: { toString: () => 'peer-x' } }],
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	for (const [key, value] of Object.entries(result)) {
		if (key === 'fretDiagnostics') {
			// 56-24: the one exception to the flat shape below -- a fresh object
			// of NAMED scalar counters, never a spread of the live `diag` handle.
			// Its own shape is pinned separately (`assembleCohort at WIDE_COHORT_WANTS ...` below).
			assert.equal(typeof value, 'object');
			for (const [counterKey, counterValue] of Object.entries(/** @type {object} */ (value))) {
				assert.equal(typeof counterValue, 'number', `fretDiagnostics.${counterKey} must be a number, got ${typeof counterValue}`);
			}
			continue;
		}
		const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
		const isStringArray = Array.isArray(value) && value.every((v) => typeof v === 'string');
		assert.ok(isPrimitive || isStringArray, `key "${key}" carries a non-primitive, non-string-array value: ${JSON.stringify(value)}`);
	}
	// Round-trips through JSON with no loss for a downstream `JSON.stringify` consumer (the wiring
	// site emits `FRET_ROUTING_PROBE_PREFIX + JSON.stringify(result)`).
	const roundTripped = JSON.parse(JSON.stringify(result));
	assert.deepEqual(roundTripped, result);
});

test('probeFretRouting: connectionCount and connectedPeerIds are read from node.getConnections(), de-duplicated', async () => {
	const node = makeFakeNode({
		connections: [
			{ remotePeer: { toString: () => 'peer-a' } },
			{ remotePeer: { toString: () => 'peer-a' } },
			{ remotePeer: { toString: () => 'peer-b' } },
		],
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.connectionCount, 2);
	assert.deepEqual(result.connectedPeerIds.slice().sort(), ['peer-a', 'peer-b']);
});

// ---------------------------------------------------------------------------
// 56-24: cohortIdsWide / cohortSizeWide -- the SAME ring coordinate,
// re-assembled at WIDE_COHORT_WANTS, never redefining cohortIds/cohortSize.
// ---------------------------------------------------------------------------

test('probeFretRouting: cohortIdsWide/cohortSizeWide are present and computed by a SECOND assembleCohort call made at WIDE_COHORT_WANTS, never at the measured wantK', async () => {
	/** @type {any[]} */
	const assembleCohortCalls = [];
	const node = makeFakeNode({
		fret: makeFakeFret({
			assembleCohortImpl: (/** @type {any} */ _ringCoord, /** @type {any} */ wants) => {
				assembleCohortCalls.push(wants);
				return wants === WIDE_COHORT_WANTS ? ['peer-a', 'peer-b', 'peer-c'] : ['peer-a'];
			},
		}),
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });

	assert.ok(assembleCohortCalls.includes(WIDE_COHORT_WANTS), `assembleCohort was never called with WIDE_COHORT_WANTS (${WIDE_COHORT_WANTS}); calls: ${JSON.stringify(assembleCohortCalls)}`);
	assert.deepEqual(result.cohortIdsWide, ['peer-a', 'peer-b', 'peer-c']);
	assert.equal(result.cohortSizeWide, 3);

	// The MEASURED field, at the caller's own wantK-derived window, is
	// unchanged by the wide re-assembly -- the whole point of this
	// corroboration is that the two coexist without redefining each other.
	assert.deepEqual(result.cohortIds, ['peer-a']);
	assert.equal(result.cohortSize, 1);
});

test('probeFretRouting: cohortIdsWide reports a named unavailable reason, never throws, when ringCoord could not be computed', async () => {
	const node = makeFakeNode();
	// participantId omitted entirely -- `createTierAddressing(...).coord(0, undefined, topicId)`
	// still resolves in practice, so drive the unavailable path the same way the module's own
	// `hasRingCoord` guard is reached: by omitting topicId, which the addressing call needs.
	const result = await probeFretRouting(node, { topicId: /** @type {any} */ (undefined), participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(typeof result.cohortIdsWide, 'string');
	assert.ok(result.cohortIdsWide.startsWith('unavailable:'));
	assert.equal(result.cohortSizeWide, 0);
});

// ---------------------------------------------------------------------------
// 56-24: fretDiagnostics -- a FRESH object, never the live diag handle
// ---------------------------------------------------------------------------

test('probeFretRouting: fretDiagnostics copies the named scalar counters field by field into a FRESH object -- mutating the result does not mutate the source', async () => {
	const sourceDiag = {
		peersDiscovered: 5,
		snapshotsFetched: 3,
		announcementsSent: 2,
		pingsSent: 7,
		pingsOk: 6,
		pingsFail: 1,
		streamLimit: 0,
		maybeActForwarded: 4,
		evictions: 0,
	};
	const node = makeFakeNode({ fret: makeFakeFret({ getDiagnosticsImpl: () => sourceDiag }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });

	assert.deepEqual(result.fretDiagnostics, sourceDiag);
	assert.notEqual(result.fretDiagnostics, sourceDiag, 'fretDiagnostics must be a FRESH object, never the live diag handle by reference');

	result.fretDiagnostics.peersDiscovered = 999;
	assert.equal(sourceDiag.peersDiscovered, 5, 'mutating the returned fretDiagnostics must not mutate the source diag object');
});

test('probeFretRouting: fretDiagnostics carries a named reason string, never throws, when getDiagnostics() itself throws', async () => {
	const node = makeFakeNode({
		fret: makeFakeFret({
			getDiagnosticsImpl: () => {
				throw new Error('synthetic getDiagnostics failure');
			},
		}),
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(typeof result.fretDiagnostics, 'string');
	assert.ok(result.fretDiagnostics.startsWith('read-failed:'));
});

// ---------------------------------------------------------------------------
// Module constant
// ---------------------------------------------------------------------------

test('FRET_ROUTING_PROBE_PREFIX is the exact literal the driver greps for', () => {
	assert.equal(FRET_ROUTING_PROBE_PREFIX, 'FRET_ROUTING_PROBE=');
});

test('WIDE_COHORT_WANTS is at least two orders of magnitude past every measured clusterWindow this probe family has recorded (16)', () => {
	assert.ok(WIDE_COHORT_WANTS >= 1600, `WIDE_COHORT_WANTS (${WIDE_COHORT_WANTS}) must be >= 1600 (100x the measured window of 16)`);
});
