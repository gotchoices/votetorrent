/**
 * PROBE (exploratory, not a gate): can rapid successive writes to ONE collection produce
 * `pending conflict: block(s) held by unresolved rival action(s)` and exhaust the retry budget?
 *
 * Observed on-device (VoteTorrent n=4 replication proof, 2026-09-03): three successive
 * `acceptPhone` writes to `default/CadrePeer` each failed with
 *
 *   sync for collection default/CadrePeer exhausted 10 retries:
 *   pending conflict: block(s) held by unresolved rival action(s) <id>
 *
 * and one of them surfaced as a TORN multi-tree commit — `default/CadrePeer` durably persisted
 * while its `default/CadrePeer/index/_uniq_7.stampid` index did not, explicitly unrollbackable.
 *
 * This probe asks the narrowest version of that question in db-p2p alone: no cadre-core, no
 * sockets. Run:  node repro/probe-rival-conflict.mjs
 */
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import { Diary } from '@optimystic/db-core';

const COLLECTION = 'rival-probe';

const L = (...a) => console.log('[probe]', ...a);

/** Sequential appends with `gapMs` between them, reporting the first failure. */
async function run({ nodeCount, writes, gapMs, concurrent }) {
	const mesh = await createMesh(nodeCount, {
		responsibilityK: nodeCount,
		clusterSize: nodeCount,
		clusterPolicy: { assumedClusterSize: nodeCount },
	});
	const diary = await Diary.createOrOpen(buildNetworkTransactor(mesh), COLLECTION);

	const results = [];
	if (concurrent) {
		// All writes in flight at once — the strongest form of the on-device shape, where the
		// watcher's accepts overlapped.
		const settled = await Promise.allSettled(
			Array.from({ length: writes }, (_, i) => diary.append({ n: i })),
		);
		settled.forEach((s, i) =>
			results.push({ i, ok: s.status === 'fulfilled', err: s.reason?.message }),
		);
	} else {
		for (let i = 0; i < writes; i++) {
			try {
				await diary.append({ n: i });
				results.push({ i, ok: true });
			} catch (e) {
				results.push({ i, ok: false, err: e?.message });
			}
			if (gapMs) await new Promise(r => setTimeout(r, gapMs));
		}
	}

	const failures = results.filter(r => !r.ok);
	const rival = failures.filter(r => /unresolved rival action|pending conflict/i.test(r.err ?? ''));
	L(
		`nodes=${nodeCount} writes=${writes} gap=${gapMs}ms ${concurrent ? 'CONCURRENT' : 'sequential'} ` +
			`→ ok=${results.length - failures.length} failed=${failures.length} rivalConflicts=${rival.length}`,
	);
	for (const f of failures.slice(0, 3)) L(`   fail#${f.i}: ${String(f.err).slice(0, 200)}`);
	return { failures: failures.length, rival: rival.length };
}

const scenarios = [
	{ nodeCount: 1, writes: 5, gapMs: 0, concurrent: false },
	{ nodeCount: 3, writes: 5, gapMs: 0, concurrent: false },
	{ nodeCount: 3, writes: 5, gapMs: 0, concurrent: true },
	{ nodeCount: 3, writes: 3, gapMs: 4000, concurrent: false },
];

let anyRival = 0;
for (const s of scenarios) {
	try {
		const r = await run(s);
		anyRival += r.rival;
	} catch (e) {
		L(`scenario ${JSON.stringify(s)} threw during setup: ${e?.message}`);
	}
}
L(anyRival > 0 ? `REPRODUCED — ${anyRival} rival conflict(s)` : 'NOT reproduced at this level');
process.exit(0);
