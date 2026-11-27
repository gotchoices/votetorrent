/**
 * public-results.test.mjs -- 56-30: the public results read (`read-tally.js`).
 *
 * Two halves. (1) A fake handle with canned rows proves the shaping rules:
 * totals per ballot/question/option, labels with code fallback, order, what is
 * dropped, and the refusal on a malformed tally. (2) A real in-memory Quereus
 * database with the full schema proves every statement PARSES AND RUNS against
 * the real tables (an empty table yields `null`, not a throw), which a canned
 * fake cannot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';
import {
	readPublishedResults,
	TallyUnreadableError,
	TABLES_READ,
	PUBLIC_TALLY_SQL,
	PUBLIC_BALLOT_LABELS_SQL,
	PUBLIC_QUESTION_LABELS_SQL,
	PUBLIC_OPTION_LABELS_SQL,
} from '../src/public/read-tally.js';
import { classOf, CLASS } from '../src/classification.js';
import { PUBLIC_SUBSCRIBED_TABLES } from '../src/public/subscribe.js';

const SENTINEL_LEAF = 'LEAF-SENTINEL';

/** The 2026-11-03 iPhone election's real outcome (todo fixture), plus a second question and an unsupported one. */
function tallyJson(overrides = {}) {
	return JSON.stringify({
		format: 'vt-tally-tree/1',
		electionId: 'el-1',
		electionRevision: 1,
		blockRoot: 'b'.repeat(64),
		root: 'a'.repeat(64),
		size: 1,
		histogram: {
			ballots: {
				'ballot-1': {
					votes: 4,
					invalid: 1,
					excluded: 0,
					questions: {
						'hr5-q1': { answered: 3, options: { 'opt-a': 2, 'hr5-opt-b': 1 } },
						'q0-first': { answered: 2, options: { yes: 2, no: 0 } },
					},
					unsupported: { 'q-rank': 3 },
				},
			},
		},
		leaves: [{ index: 0, blockCid: SENTINEL_LEAF, ballotId: 'ballot-1', entryCount: 4, leafData: SENTINEL_LEAF, disposition: 'tallied', excludedFor: [] }],
		nodes: [{ index: 0, merkleHash: SENTINEL_LEAF, histogram: {}, hash: SENTINEL_LEAF }],
		...overrides,
	});
}

/** @param {{ tally?: any, ballots?: any[], questions?: any[], options?: any[] }} spec */
function fakeDb(spec) {
	const bySql = new Map([
		[PUBLIC_BALLOT_LABELS_SQL, spec.ballots ?? []],
		[PUBLIC_QUESTION_LABELS_SQL, spec.questions ?? []],
		[PUBLIC_OPTION_LABELS_SQL, spec.options ?? []],
	]);
	return {
		/** @param {string} sql */
		prepare(sql) {
			assert.equal(sql, PUBLIC_TALLY_SQL);
			return { get: async () => spec.tally };
		},
		/** @param {string} sql */
		async *eval(sql) {
			assert.ok(bySql.has(sql), `unexpected statement: ${sql}`);
			for (const r of /** @type {any[]} */ (bySql.get(sql))) yield r;
		},
	};
}

const TALLY_ROW = {
	ElectionRevision: 1,
	BlockRoot: 'b'.repeat(64),
	TallyRoot: 'a'.repeat(64),
	BlockCount: 1,
	TallyJson: tallyJson(),
	PublishedAt: '2026-11-03T12:17:00.000Z',
};

const LABELS = {
	ballots: [{ Id: 'ballot-1', Description: 'Ward 5' }],
	questions: [
		{ BallotId: 'ballot-1', Code: 'hr5-q1', Title: 'Which option?', Sequence: 2 },
		{ BallotId: 'ballot-1', Code: 'q0-first', Title: 'Approve?', Sequence: 1 },
		{ BallotId: 'ballot-1', Code: 'q-rank', Title: 'Rank these', Sequence: 3 },
	],
	options: [
		{ BallotId: 'ballot-1', QuestionCode: 'hr5-q1', Code: 'opt-a', Title: 'hr5 option one', Sequence: 1 },
		{ BallotId: 'ballot-1', QuestionCode: 'q0-first', Code: 'yes', Title: 'Yes', Sequence: 1 },
		{ BallotId: 'ballot-1', QuestionCode: 'q0-first', Code: 'no', Title: 'No', Sequence: 2 },
	],
};

test('R1: no tally row is a finding: null, and no label read happens', async () => {
	const db = fakeDb({ tally: undefined });
	assert.equal(await readPublishedResults(db, 'el-1', 1), null);
});

test('R2: totals per ballot, questions in Sequence order, options in Sequence order with the code as the fallback title, valid = votes - invalid - excluded, blank = valid - answered', async () => {
	const r = await readPublishedResults(fakeDb({ tally: TALLY_ROW, ...LABELS }), 'el-1', 1);
	assert.ok(r);
	assert.equal(r.revision, 1);
	assert.equal(r.blockCount, 1);
	assert.equal(r.publishedAt, '2026-11-03T12:17:00.000Z');
	assert.equal(r.ballots.length, 1);
	const b = r.ballots[0];
	assert.equal(b.description, 'Ward 5');
	assert.deepEqual([b.votes, b.valid, b.invalid, b.excluded], [4, 3, 1, 0]);
	assert.deepEqual(b.questions.map((q) => q.code), ['q0-first', 'hr5-q1']);
	const q1 = b.questions[1];
	assert.equal(q1.title, 'Which option?');
	assert.equal(q1.answered, 3);
	assert.equal(q1.blank, 0);
	assert.deepEqual(q1.options, [
		{ code: 'opt-a', title: 'hr5 option one', count: 2 },
		{ code: 'hr5-opt-b', title: 'hr5-opt-b', count: 1 },
	]);
	assert.deepEqual(b.questions[0].options.map((o) => [o.title, o.count]), [['Yes', 2], ['No', 0]], 'a zero-count option is still listed');
	assert.equal(b.questions[0].blank, 1);
	assert.deepEqual(b.unsupported, [{ code: 'q-rank', title: 'Rank these', answered: 3 }]);
});

test('R3: only totals leave the module -- no leaf, node, root-of-a-block or per-block value, no publisher field', async () => {
	const r = await readPublishedResults(fakeDb({ tally: TALLY_ROW, ...LABELS }), 'el-1', 1);
	const text = JSON.stringify(r);
	assert.ok(!text.includes(SENTINEL_LEAF), 'a per-block leaf or node value left the module');
	assert.ok(!/publisher|signature|leaves|nodes/i.test(text), `an unexpected field left the module: ${text}`);
	assert.deepEqual(Object.keys(/** @type {any} */ (r)).sort(), ['ballots', 'blockCount', 'blockRoot', 'publishedAt', 'revision', 'tallyRoot']);
});

test('R4: a malformed tally throws TallyUnreadableError (name only), never a partial result', async () => {
	const bad = [
		'not json',
		JSON.stringify({ histogram: null }),
		tallyJson({ histogram: { ballots: { b: { votes: -1, invalid: 0, excluded: 0, questions: {} } } } }),
		tallyJson({ histogram: { ballots: { b: { votes: 1, invalid: 2, excluded: 0, questions: {} } } } }),
		tallyJson({ histogram: { ballots: { b: { votes: 1, invalid: 0, excluded: 0, questions: { q: { answered: 1, options: 'x' } } } } } }),
	];
	for (const json of bad) {
		await assert.rejects(
			readPublishedResults(fakeDb({ tally: { ...TALLY_ROW, TallyJson: json } }), 'el-1', 1),
			(err) => err instanceof TallyUnreadableError && !String(/** @type {any} */ (err).message).includes(json.slice(0, 8)),
		);
	}
});

test('R5: a question or option code spelled __proto__ is an ordinary entry, not a prototype write', async () => {
	const json = tallyJson({
		histogram: { ballots: { 'ballot-1': { votes: 1, invalid: 0, excluded: 0, questions: JSON.parse('{"__proto__":{"answered":1,"options":{"__proto__":1}}}') } } },
	});
	const r = await readPublishedResults(fakeDb({ tally: { ...TALLY_ROW, TallyJson: json } }), 'el-1', 1);
	assert.deepEqual(r?.ballots[0].questions.map((q) => [q.code, q.options.map((o) => [o.code, o.count])]), [['__proto__', [['__proto__', 1]]]]);
	assert.equal(/** @type {any} */ ({}).answered, undefined);
});

test('R6: ElectionTally is PUBLIC for settling and closed, every table read is public-safe, and the module adds them to the replicated set', () => {
	assert.equal(classOf('ElectionTally'), CLASS.PUBLIC);
	for (const t of TABLES_READ) assert.equal(classOf(t), CLASS.PUBLIC, `${t} is not PUBLIC`);
	for (const t of TABLES_READ) assert.ok(PUBLIC_SUBSCRIBED_TABLES.includes(t), `${t} is not replicated to the page`);
	assert.ok(!/UserId/.test(PUBLIC_TALLY_SQL), 'the tally read names a user id');
});

test('R7: every statement parses and runs against the real schema; an empty ElectionTally reads as null', async () => {
	const db = new Database();
	try {
		await prepareDb(db);
		assert.equal(await readPublishedResults(db, 'no-such-election', 1), null);
		for (const sql of [PUBLIC_BALLOT_LABELS_SQL, PUBLIC_QUESTION_LABELS_SQL, PUBLIC_OPTION_LABELS_SQL]) {
			const rows = [];
			for await (const r of db.eval(sql, { electionId: 'no-such-election' })) rows.push(r);
			assert.deepEqual(rows, []);
		}
	} finally {
		await db.close();
	}
});
