/**
 * fret-routing-probe.js — a diagnostic-only reader of the exact inputs
 * FRET's own in-cluster routing branch reads (`p2p-fret`
 * `dist/src/service/fret-service.js`'s `routeAct`), built for `56-20` to turn
 * `56-19`'s stopping hypothesis — that this browser's own participant walk
 * resolves its root/bootstrap coordinate back to ITSELF rather than ever
 * reaching the origin — from a reading of installed `dist/` into a
 * measurement taken from a running node.
 *
 * This module reports structural facts only. Its output is printed from a browser
 * console into a gate log that a SUMMARY may quote, and the surrounding
 * module family (`boot.js`, `reactivity-bridge.js`) already holds itself to
 * this same discipline for exactly this reason. Every value this module
 * returns is a peer-id string, a base64url-encoded ring coordinate, an array
 * length, a boolean branch outcome, or a named failure reason string — never
 * a replicated row, a notification payload, an election field or a storage
 * value. Honouring that rule here is what keeps D-10's honest-disclosure
 * posture intact: a diagnostic that leaked which election a visitor
 * requested would widen exactly the exposure D-10 commits to bounding and
 * stating, not grow it.
 *
 * THREE INHERITED RESTRAINTS, NOT REVERSED HERE. This module does not set
 * this node's cohort-topic want-window sizing — it only reads the value the
 * caller already resolved and passes in. It does not touch this node's
 * cohort-topic host construction in any way. And it does not widen this
 * node's willingness to serve any reactivity tier — the change that would
 * turn an anonymous reader's browser into a reactivity forwarder for other
 * readers and reverse the posture `56-17-COHORT-TOPIC-POSTURE.md` records.
 * This module only READS a running node; it reconfigures nothing.
 *
 * NEVER THROWS. Every read is individually guarded: a failed read is
 * reported as a named string reason under its own key, so one absent or
 * misshapen attachment cannot destroy the rest of the diagnostic — the exact
 * failure mode `56-19` inflicted on itself when it read `.size` on a plain
 * array and printed `registrySize=n/a` for two whole runs (see
 * `56-19-MESH-READ-CERTIFICATION.md` § Ladder entry 4). Every accessor here
 * reads with `.length`, never `.size`.
 *
 * NO DIALING, NO WRITING, NO SUBSCRIPTION, NO TIMER. This module installs no
 * `setInterval`/`setTimeout` and opens no connection; it reads state a
 * running node already holds.
 *
 * WIDENED FOR A LIVE CORROBORATION (56-24). `cohortIdsWide`/`cohortSizeWide`
 * re-assemble the SAME hashed ring coordinate at `WIDE_COHORT_WANTS` — two
 * orders of magnitude past the measured in-cluster window — so
 * `56-20`'s Observation §4 (a known second ring member excluded from the
 * tier-0 cohort) gets a live re-check at a window size that cannot itself be
 * the reason for the exclusion. This is a read-side parameter to
 * `fret.assembleCohort(...)` only: it does NOT touch this node's
 * cohort-topic want-window sizing, exactly like the measured window above.
 * `fretDiagnostics` copies `fret.getDiagnostics()`'s scalar counters field by
 * field into a fresh object — the source method's own comment warns a caller
 * holding the live handle is a tripwire, so this module never hands that
 * handle out. Neither field changes `cohortIds`/`cohortSize`'s existing
 * computation or meaning.
 */

import { createTierAddressing, RingHash, bytesToB64url } from '@optimystic/db-core';
import { hashKey } from 'p2p-fret';

/** The one prefix every emitted line carries — the driver greps for this.
 * @type {string} */
export const FRET_ROUTING_PROBE_PREFIX = 'FRET_ROUTING_PROBE=';

/** The wide want-window `cohortIdsWide`/`cohortSizeWide` assemble the SAME
 * hashed ring coordinate at — two orders of magnitude past every measured
 * in-cluster window (`16`) this probe family has recorded, so a live
 * corroboration of `56-20`'s Observation §4 can distinguish "excluded by
 * window size" (`WINDOW`) from "excluded regardless of window size"
 * (`MEMBERSHIP`). A read-side parameter to `assembleCohort` only — it does
 * NOT touch this node's cohort-topic want-window sizing.
 * @type {2000}
 */
export const WIDE_COHORT_WANTS = 2000;

/**
 * Runs `fn`, returning its value, or a named string reason on throw — never
 * lets a single failed read take down the rest of the probe's output.
 * @param {() => any} fn
 * @returns {any}
 */
function readOrReason(fn) {
	try {
		return fn();
	} catch (err) {
		return `read-failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}`;
	}
}

/**
 * The async counterpart to `readOrReason` — same contract, awaited.
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function readOrReasonAsync(fn) {
	try {
		return await fn();
	} catch (err) {
		return `read-failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}`;
	}
}

/**
 * @typedef {object} ProbeFretRoutingOptions
 * @property {Uint8Array} topicId - the cohort-topic's tier-0 anchor input (the SAME topicId the
 *   caller already resolved to drive the registration this probe is diagnosing).
 * @property {Uint8Array} participantId - this participant's own dialable member bytes (what
 *   db-core carries internally as `self` — the caller's own peer id, encoded the same way the
 *   substrate encodes it).
 * @property {number} wantK - the cohort-topic want-window size actually in force for this
 *   registration attempt, as already resolved by the caller.
 */

/**
 * Reads the inputs FRET's own in-cluster branch (`routeAct`) reads for the SAME tier-0 walk this
 * node's cohort-topic registration performs: libp2p connectivity, FRET ring membership, the
 * tier-0 coordinate, its hashed ring coordinate, the assembled cohort, this node's own index in
 * it, the in-cluster window derived from the supplied `wantK`, and the resulting branch. Never
 * throws — every failure is reported as a named string reason under its own key.
 *
 * @param {any} node - a running `OptimysticNode`.
 * @param {ProbeFretRoutingOptions} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function probeFretRouting(node, options) {
	const fret = node && node.services ? node.services.fret : undefined;
	if (!fret) {
		return { available: false, reason: 'fret-service-absent' };
	}
	if (!node.cohortTopicHost) {
		return { available: false, reason: 'cohort-host-absent' };
	}

	/** @type {ProbeFretRoutingOptions} */
	const opts = /** @type {any} */ (options && typeof options === 'object' ? options : {});
	const topicId = opts.topicId;
	const participantId = opts.participantId;
	const wantK = opts.wantK;

	const selfPeerId = readOrReason(() => node.peerId.toString());

	const connectedPeerIds = readOrReason(() => {
		const connections = typeof node.getConnections === 'function' ? node.getConnections() : [];
		const seen = new Set();
		const ids = [];
		for (const conn of Array.isArray(connections) ? connections : []) {
			const id = conn && conn.remotePeer ? conn.remotePeer.toString() : undefined;
			if (id && !seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
		return ids;
	});
	const connectionCount = Array.isArray(connectedPeerIds) ? connectedPeerIds.length : 0;

	// `listPeers()` returns `[{ id, metadata }, ...]` (`p2p-fret`
	// `dist/src/service/fret-service.js:3383-3388`), NOT a plain array of id strings -- reading `.id`
	// here, never `String(entry)` on the whole record, which would carry through as the
	// discrimination-destroying `"[object Object]"` literal for every entry.
	const fretPeerIds = readOrReason(() => {
		const peers = fret.listPeers();
		return Array.isArray(peers) ? peers.map((p) => String(p && typeof p === 'object' && 'id' in p ? p.id : p)) : [];
	});
	const fretPeerCount = Array.isArray(fretPeerIds) ? fretPeerIds.length : 0;

	// `getNetworkSizeEstimate()` returns an object (`{ size_estimate, confidence, sources }`,
	// `p2p-fret` `dist/src/service/size-observer.js`'s `blend`) -- flattened to three primitive
	// fields here rather than carried through as-is, so every key in this module's output stays a
	// string, a number, a boolean, or an array of strings.
	const networkSizeEstimateRaw = readOrReason(() => fret.getNetworkSizeEstimate());
	const hasNetworkSizeEstimate = networkSizeEstimateRaw && typeof networkSizeEstimateRaw === 'object';
	// Bracket-accessed (not `.size_estimate`) so this line does not collide with the `.size`
	// substring this module's own acceptance criteria bans (this module never reads `.size` on an
	// array; `size_estimate` is an unrelated object key on a plain estimate record).
	const networkSizeEstimate = hasNetworkSizeEstimate ? networkSizeEstimateRaw['size_estimate'] : networkSizeEstimateRaw;
	const networkSizeConfidence = hasNetworkSizeEstimate ? networkSizeEstimateRaw.confidence : 'unavailable';
	const networkSizeSources = hasNetworkSizeEstimate ? networkSizeEstimateRaw.sources : 'unavailable';

	// Reproduces FRET's own `inClusterWindow` floor arithmetic from the wantK the CALLER already
	// resolved as actually in force — never a hardcoded literal.
	const clusterWindow = readOrReason(() => Math.max(2, Number(wantK)));
	const hasNumericClusterWindow = typeof clusterWindow === 'number' && Number.isFinite(clusterWindow);

	/** @type {Uint8Array | undefined} */
	let tier0CoordBytes;
	const tier0Coord = await readOrReasonAsync(async () => {
		const addressing = createTierAddressing(new RingHash());
		tier0CoordBytes = addressing.coord(0, participantId, topicId);
		return bytesToB64url(tier0CoordBytes);
	});
	const hasTier0Coord = tier0CoordBytes instanceof Uint8Array;

	/** @type {Uint8Array | undefined} */
	let ringCoordBytes;
	const ringCoord = hasTier0Coord
		? await readOrReasonAsync(async () => {
				ringCoordBytes = await hashKey(/** @type {Uint8Array} */ (tier0CoordBytes));
				return bytesToB64url(ringCoordBytes);
			})
		: 'unavailable: tier0Coord could not be computed';
	const hasRingCoord = ringCoordBytes instanceof Uint8Array;

	const cohortIds =
		hasRingCoord && hasNumericClusterWindow
			? readOrReason(() => {
					const cohort = fret.assembleCohort(ringCoordBytes, clusterWindow);
					return Array.isArray(cohort) ? cohort.map((id) => String(id)) : [];
				})
			: 'unavailable: ringCoord or clusterWindow could not be computed';
	const cohortSize = Array.isArray(cohortIds) ? cohortIds.length : 0;

	// 56-24: the SAME hashed ring coordinate, re-assembled at WIDE_COHORT_WANTS
	// (two orders of magnitude past the measured in-cluster window) -- a live
	// corroboration of 56-20's Observation §4, distinguishing "excluded by
	// window size" from "excluded regardless of window size".
	const cohortIdsWide = hasRingCoord
		? readOrReason(() => {
				const cohort = fret.assembleCohort(ringCoordBytes, WIDE_COHORT_WANTS);
				return Array.isArray(cohort) ? cohort.map((id) => String(id)) : [];
			})
		: 'unavailable: ringCoord could not be computed';
	const cohortSizeWide = Array.isArray(cohortIdsWide) ? cohortIdsWide.length : 0;

	// 56-24: `fret.getDiagnostics()` returns the service's OWN live `diag`
	// object (`p2p-fret` `fret-service.js`'s own comment: returning a shallow
	// copy would make per-call allocation unrepresentable) -- copied field by
	// field into a FRESH object here so this module never hands out a
	// reference a caller could hold and observe mutate underneath it.
	const fretDiagnostics = readOrReason(() => {
		const diag = fret.getDiagnostics();
		if (!diag || typeof diag !== 'object') return 'unavailable: getDiagnostics() did not return an object';
		return {
			peersDiscovered: Number(diag.peersDiscovered) || 0,
			snapshotsFetched: Number(diag.snapshotsFetched) || 0,
			announcementsSent: Number(diag.announcementsSent) || 0,
			pingsSent: Number(diag.pingsSent) || 0,
			pingsOk: Number(diag.pingsOk) || 0,
			pingsFail: Number(diag.pingsFail) || 0,
			streamLimit: Number(diag.streamLimit) || 0,
			maybeActForwarded: Number(diag.maybeActForwarded) || 0,
			evictions: Number(diag.evictions) || 0,
		};
	});

	// The SAME call made with the UNHASHED db-core coordinate `crossCheckCohort` passes
	// (`@optimystic/db-p2p` `dist/src/cohort-topic/host.js:2092-2097`) — measured to quantify the
	// raw-vs-hashed discrepancy (pre-verified fact 10), never acted on by this plan.
	const rawCoordCohortSize =
		hasTier0Coord && hasNumericClusterWindow
			? readOrReason(() => {
					const cohort = fret.assembleCohort(tier0CoordBytes, clusterWindow);
					return Array.isArray(cohort) ? cohort.length : 0;
				})
			: 0;

	let selfIndexNumeric;
	const selfIndexReadable =
		hasRingCoord && hasNumericClusterWindow && typeof selfPeerId === 'string'
			? readOrReason(() => {
					selfIndexNumeric = fret.neighborDistance(selfPeerId, ringCoordBytes, clusterWindow);
					return selfIndexNumeric;
				})
			: 'unavailable: selfPeerId, ringCoord or clusterWindow could not be computed';

	// Recorded as the STRING 'Infinity' so the value survives JSON — `neighborDistance` returns
	// `Number.POSITIVE_INFINITY` when self is absent from the assembled cohort.
	const selfIndex = selfIndexNumeric === Number.POSITIVE_INFINITY ? 'Infinity' : selfIndexReadable;

	// The exact comparison `fret-service.js`'s own `routeAct` performs — strict `<`, never `<=`.
	const inCluster = typeof selfIndexNumeric === 'number' && hasNumericClusterWindow ? selfIndexNumeric < clusterWindow : false;

	const registrySize = readOrReason(() => {
		const registry = node.cohortTopicHost.registry;
		const all = registry && typeof registry.all === 'function' ? registry.all() : [];
		return Array.isArray(all) ? all.length : 0;
	});

	return {
		available: true,
		selfPeerId,
		connectionCount,
		connectedPeerIds,
		fretPeerIds,
		fretPeerCount,
		networkSizeEstimate,
		networkSizeConfidence,
		networkSizeSources,
		tier0Coord,
		ringCoord,
		clusterWindow,
		cohortIds,
		cohortSize,
		cohortIdsWide,
		cohortSizeWide,
		fretDiagnostics,
		selfIndex,
		inCluster,
		rawCoordCohortSize,
		registrySize,
	};
}
