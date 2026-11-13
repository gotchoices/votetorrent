/**
 * public-turnout.test.mjs -- 56-31: ballots cast so far, counted on the network.
 * The statement runs against the real schema, returns two numbers, selects
 * aggregates only, and its tables are never replicated to the page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';
import { readNetworkTurnout, PUBLIC_TURNOUT_SQL, TABLES_READ } from '../src/public/read-turnout.js';
import { classOf, CLASS, selectListOf } from '../src/classification.js';
import { PUBLIC_SUBSCRIBED_TABLES } from '../src/public/subscribe.js';
import { selectItemsOf } from './lib/source-scan.mjs';

test('T1: the statement parses and runs on the real schema; no blocks reads as zero and zero', async () => {
	const db = new Database();
	try {
		await prepareDb(db);
		assert.deepEqual({ ...(await readNetworkTurnout(db, 'no-such-election')) }, { blocks: 0, votes: 0 });
	} finally {
		await db.close();
	}
});

test('T2: the two aggregates come back as numbers; a null sum or junk is zero, never NaN', async () => {
	/** @param {any} row */
	const fake = (row) => ({
		async *eval(/** @type {string} */ sql) {
			assert.equal(sql, PUBLIC_TURNOUT_SQL);
			if (row !== undefined) yield row;
		},
	});
	assert.deepEqual({ ...(await readNetworkTurnout(fake({ blocks: 2, votes: 7 }), 'el')) }, { blocks: 2, votes: 7 });
	assert.deepEqual({ ...(await readNetworkTurnout(fake({ blocks: 0, votes: null }), 'el')) }, { blocks: 0, votes: 0 });
	assert.deepEqual({ ...(await readNetworkTurnout(fake({ blocks: 'x', votes: -3 }), 'el')) }, { blocks: 0, votes: 0 });
	assert.deepEqual({ ...(await readNetworkTurnout(fake(undefined), 'el')) }, { blocks: 0, votes: 0 });
});

test('T3: the select list is aggregates only (counts yes, rows no), and the AGGREGATE table is never replicated to the page', () => {
	const items = selectItemsOf(PUBLIC_TURNOUT_SQL, selectListOf);
	assert.ok(items.length === 2);
	for (const item of items) assert.match(item, /^(count|sum)\s*\(/i, `a non-aggregate select item: ${item}`);
	// Control: the same check rejects a bare column.
	const mutant = PUBLIC_TURNOUT_SQL.replace('count(*) as blocks', 'VoterRegistrantIds');
	assert.ok(selectItemsOf(mutant, selectListOf).some((i) => !/^(count|sum)\s*\(/i.test(i)));
	assert.equal(classOf('VoteBlock'), CLASS.AGGREGATE);
	for (const t of ['VoteBlock', 'VoteBlockVoter']) assert.ok(!PUBLIC_SUBSCRIBED_TABLES.includes(t), `${t} is replicated to the page`);
	assert.deepEqual([...TABLES_READ], ['VoteBlock', 'ElectionRevision']);
});
