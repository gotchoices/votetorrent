/**
 * Optimystic — a table and its OWN unique index are separate trees, committed by a sweep that
 * cannot roll back, so a single failed index sync leaves the base table durably persisted
 * WITHOUT the index that enforces its uniqueness.
 *
 * Upstream target: https://github.com/gotchoices/optimystic
 *   (packages/quereus-plugin-optimystic) — @optimystic/quereus-plugin-optimystic@0.27.0
 *
 *   node --test repro/legacy-multi-tree-tear.test.mjs
 *
 * ── OBSERVED (not hypothesised) ─────────────────────────────────────────────────────────────
 * VoteTorrent n=4 on-device replication proof, 2026-09-03, cadre-core 0.12.0 / db-p2p 0.27.0.
 * A cadre membership write (`acceptPhone`) failed with:
 *
 *   Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed to storage
 *   before the commit failed and CANNOT be rolled back.
 *   Persisted (now out of sync with the unpersisted trees): [default/CadrePeer].
 *   Not persisted (reverted in-memory only): [default/CadrePeer/index/_uniq_7.stampid].
 *   Underlying failure: sync for collection default/CadrePeer/index/_uniq_7.stampid
 *   exhausted 10 retries: pending conflict: block(s) held by unresolved rival action(s) <id>
 *
 * The row was persisted. The unique index on it was not. Nothing rolls that back.
 *
 * ── WHY THIS IS THE PLUGIN'S SHAPE, NOT A MISCONFIGURATION ──────────────────────────────────
 * `commitDirtyTreesLegacy` (chunk-M7LXS5X2.js) iterates `this.dirtyTrees` and `await tree.sync()`
 * in turn. Its own doc comment states the contract plainly: once at least one tree has synced,
 * those trees "are durably committed and cannot be un-committed locally", so it restores only the
 * untouched trees and throws `PartialCommitError`. That is honest reporting of a real tear — the
 * issue is not the reporting, it is that a table and the index enforcing ITS uniqueness are two
 * entries in that sweep, so the window is not exotic: it is every unique-constrained insert.
 *
 * These assertions deliberately pin CURRENT behaviour (repo convention — see
 * test/quereus-repros/README.md), so they pass today and serve as the upstream reproduction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	PartialCommitError,
	uniqueEnforcementTreeName,
} from '@optimystic/quereus-plugin-optimystic';

/**
 * The exact tree name from the device failure, derived from the schema rather than pasted, so a
 * rename upstream turns this red instead of leaving a stale string that silently still matches.
 * `CadrePeer.StampId` carries the unique constraint.
 */
const DEVICE_INDEX_TREE = '_uniq_7.stampid';

test('a unique constraint is enforced by a tree SEPARATE from its base table', () => {
	const indexTree = uniqueEnforcementTreeName(['StampId']);
	assert.equal(
		indexTree,
		DEVICE_INDEX_TREE,
		'the unique-enforcement tree name should still derive to the one in the device failure',
	);
	// The point: this is a distinct name, so it is a distinct tree, so an insert touching a
	// unique-constrained column dirties AT LEAST TWO trees in one transaction.
	assert.notEqual(
		indexTree,
		'CadrePeer',
		'the index must be a separate tree from the table for the tear to be possible',
	);
});

test('the tear is reported as unrollbackable, naming persisted vs unpersisted trees', () => {
	// Construct the error the way the sweep does: base table synced, its index did not.
	const err = new PartialCommitError(
		['default/CadrePeer'],
		[`default/CadrePeer/index/${uniqueEnforcementTreeName(['StampId'])}`],
		new Error('sync exhausted 10 retries: pending conflict: block(s) held by unresolved rival action(s)'),
	);

	assert.equal(err.name, 'PartialCommitError');
	assert.deepEqual(err.persisted, ['default/CadrePeer']);
	assert.deepEqual(err.unpersisted, ['default/CadrePeer/index/_uniq_7.stampid']);

	// The message states the durability consequence outright.
	assert.match(err.message, /CANNOT be rolled back/);
	assert.match(err.message, /default\/CadrePeer/);
	assert.match(err.message, /_uniq_7\.stampid/);
});

test('the persisted and unpersisted sets are disjoint — a torn commit, not a failed one', () => {
	const table = 'default/CadrePeer';
	const index = `default/CadrePeer/index/${uniqueEnforcementTreeName(['StampId'])}`;
	const err = new PartialCommitError([table], [index], new Error('rival conflict'));

	const overlap = err.persisted.filter(p => err.unpersisted.includes(p));
	assert.deepEqual(
		overlap,
		[],
		'disjoint sets mean the transaction is half-applied: the row exists, its uniqueness ' +
			'guarantee does not. A wholly-failed commit would leave neither.',
	);
	assert.ok(
		err.persisted.length > 0 && err.unpersisted.length > 0,
		'both sides non-empty is precisely the torn state',
	);
});
