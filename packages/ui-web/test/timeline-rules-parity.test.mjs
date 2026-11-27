/**
 * timeline-rules-parity.test.mjs -- the engine's timeline check and the Voter's
 * timeline rules must agree (todo 2026-10-29-engine-timeline-validation).
 *
 * vote-engine refuses, before any write, a timeline the Voter would treat as
 * blocking (`packages/vote-engine/src/election/timeline-rules.ts`). It restates
 * timeline-core.js's rules because vote-engine cannot import ui-web (ui-web
 * already depends on vote-engine). This file is what keeps the two copies equal:
 *
 *   1. Same constants: event order, strict chain, preparation set.
 *   2. Same conflicts, in the same order, for ~4000 generated timelines (seeded,
 *      so a failure reproduces): reordered events, missing events, unparseable
 *      values, canonical strings and epoch ms, with and without Election.Date /
 *      BallotDeadline cross-checks.
 *   3. Same blocking set as the Voter: read from the Voter's derive-timeline.ts
 *      source, because the Voter app is not importable from here.
 *
 * Needs a built vote-engine (`yarn workspace @votetorrent/vote-engine build`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	ELECTION_EVENT_ORDER,
	STRICT_CHAIN,
	PREPARATION,
	CONFLICT,
	parseTimeline,
} from '../src/lifecycle/timeline-core.js';
import {
	TIMELINE_EVENT_ORDER,
	TIMELINE_STRICT_CHAIN,
	TIMELINE_PREPARATION,
	BLOCKING_TIMELINE_CONFLICT_CODES,
	findTimelineConflicts,
	findBlockingTimelineConflicts,
} from '@votetorrent/vote-engine';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOTER_DERIVE_TIMELINE = path.join(HERE, '..', '..', '..', 'apps', 'VoteTorrentVoter', 'src', 'timeline', 'derive-timeline.ts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2027, 2, 10, 0, 0, 0);

/** mulberry32: small seeded PRNG so a failing case reproduces from its index. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function canonical(ms) {
	return new Date(ms).toISOString().slice(0, 19);
}

/** A well-ordered ten-event timeline around `date`, then perturbed by `r`. */
function generate(r) {
	const date = BASE + Math.floor(r() * 60) * DAY;
	const ordered = {
		registrationEnds: date - 5 * DAY,
		ballotsFinal: date - 16 * DAY,
		votingStarts: date - 2 * DAY,
		accruingVotes: date - 2 * DAY + 6 * HOUR,
		hashingVotes: date - 2 * DAY + 12 * HOUR,
		releasingKeys: date - 2 * DAY + 18 * HOUR,
		tallyingStarts: date,
		validation: date + DAY,
		certificationStarts: date + 2 * DAY,
		closed: date + 3 * DAY,
	};
	const timeline = {};
	for (const event of ELECTION_EVENT_ORDER) {
		let value = ordered[event];
		const roll = r();
		if (roll < 0.04) continue; // missing
		if (roll < 0.05) {
			timeline[event] = ['', 'soon', '2027-13-45T99:00:00', null, true][Math.floor(r() * 5)];
			continue;
		}
		if (roll < 0.12) value += Math.round((r() - 0.5) * 40 * DAY); // may break order
		else if (roll < 0.17) value = r() < 0.5 ? ordered.votingStarts : ordered[ELECTION_EVENT_ORDER[Math.max(0, ELECTION_EVENT_ORDER.indexOf(event) - 1)]]; // exact ties: the boundaries
		if (r() < 0.02) value = Number.NaN;
		timeline[event] = r() < 0.4 && Number.isFinite(value) ? canonical(value) : value;
	}
	const election = {};
	if (r() < 0.75) election.date = r() < 0.5 ? canonical(date) : date;
	if (r() < 0.75) election.ballotDeadline = date - Math.floor(r() * (r() < 0.8 ? 16 : 30)) * DAY;
	return { timeline: r() < 0.1 ? JSON.stringify(timeline) : timeline, election };
}

const key = (c) => `${c.code}(${c.event})`;

test('the engine restates the same event order, strict chain and preparation set', () => {
	assert.deepEqual([...TIMELINE_EVENT_ORDER], [...ELECTION_EVENT_ORDER]);
	assert.deepEqual([...TIMELINE_STRICT_CHAIN], [...STRICT_CHAIN]);
	assert.deepEqual([...TIMELINE_PREPARATION], [...PREPARATION]);
});

test('the engine reports exactly the conflicts parseTimeline reports, over 4000 generated timelines', () => {
	const r = rng(20261106);
	let withBlocking = 0;
	for (let i = 0; i < 4000; i++) {
		const { timeline, election } = generate(r);
		const voter = parseTimeline(timeline, election).conflicts.map(key);
		const engine = findTimelineConflicts(timeline, election).map(key);
		assert.deepEqual(engine, voter, `case ${i}: ${JSON.stringify({ timeline, election })}`);
		if (findBlockingTimelineConflicts(timeline, election).length > 0) withBlocking++;
	}
	// Control: the generator must produce both kinds, or the loop above proves nothing.
	assert.ok(withBlocking > 400 && withBlocking < 3600, `blocking cases: ${withBlocking} of 4000`);
});

test('the engine and parseTimeline agree on inputs that are not timelines at all', () => {
	for (const input of [undefined, null, 42, 'not json', '[]', '{}', [], { votingStarts: {} }]) {
		assert.deepEqual(findTimelineConflicts(input).map(key), parseTimeline(input).conflicts.map(key), JSON.stringify(input));
	}
});

test("the engine's blocking codes are the Voter's INDETERMINATE_CONFLICT_CODES", () => {
	const source = readFileSync(VOTER_DERIVE_TIMELINE, 'utf8');
	const block = source.match(/INDETERMINATE_CONFLICT_CODES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
	assert.ok(block, 'INDETERMINATE_CONFLICT_CODES not found in derive-timeline.ts');
	const voterCodes = [...block[1].matchAll(/CONFLICT\.([A-Z_]+)/g)].map((m) => CONFLICT[m[1]]);
	assert.ok(voterCodes.length >= 1 && voterCodes.every(Boolean), `unreadable codes: ${block[1]}`);
	assert.deepEqual([...BLOCKING_TIMELINE_CONFLICT_CODES].sort(), [...voterCodes].sort());
});

test('control: the 2026-10-29 phone4 timeline is refused, and the fixed one is not', () => {
	const votingStarts = BASE + 90 * 60_000;
	const phone4 = {
		registrationEnds: BASE + 25 * DAY,
		ballotsFinal: BASE + 14 * DAY,
		votingStarts,
		accruingVotes: votingStarts + HOUR,
		hashingVotes: votingStarts + 2 * HOUR,
		releasingKeys: votingStarts + 3 * HOUR,
		tallyingStarts: votingStarts + 4 * HOUR,
		validation: votingStarts + 5 * HOUR,
		certificationStarts: votingStarts + 6 * HOUR,
		closed: votingStarts + 7 * HOUR,
	};
	const refused = findBlockingTimelineConflicts(phone4).map(key);
	assert.deepEqual(refused, ['OUT_OF_ORDER(registrationEnds)', 'OUT_OF_ORDER(ballotsFinal)']);
	const fixed = { ...phone4, registrationEnds: BASE + 30 * 60_000, ballotsFinal: BASE + 60 * 60_000 };
	assert.deepEqual(findBlockingTimelineConflicts(fixed), []);
});

test('the two copies agree exactly on every boundary instant (ties are where copies drift)', () => {
	const date = BASE; // midnight UTC
	const dayEnd = date + DAY;
	const ordered = {
		registrationEnds: date - 5 * DAY, ballotsFinal: date - 16 * DAY, votingStarts: date - 2 * DAY,
		accruingVotes: date - DAY, hashingVotes: date - 20 * HOUR, releasingKeys: date - 10 * HOUR,
		tallyingStarts: date, validation: date + DAY, certificationStarts: date + 2 * DAY, closed: date + 3 * DAY,
	};
	const cases = [];
	for (const ms of [dayEnd - 1, dayEnd, dayEnd + 1]) {
		for (const event of ['registrationEnds', 'ballotsFinal', 'votingStarts']) {
			cases.push([{ ...ordered, votingStarts: Math.max(ordered.votingStarts, ms), [event]: ms }, { date }]);
		}
	}
	for (const ms of [date - 1, date, date + 1]) cases.push([{ ...ordered, closed: ms }, { date }]);
	for (const ms of [-1, 0, 1]) cases.push([ordered, { ballotDeadline: ordered.ballotsFinal + ms }]);
	for (const ms of [-1, 0, 1]) cases.push([{ ...ordered, registrationEnds: ordered.votingStarts + ms }, {}]);
	for (const ms of [-1, 0, 1]) cases.push([{ ...ordered, validation: ordered.tallyingStarts + ms }, {}]);
	for (const [timeline, election] of cases) {
		assert.deepEqual(
			findTimelineConflicts(timeline, election).map(key),
			parseTimeline(timeline, election).conflicts.map(key),
			JSON.stringify({ timeline, election }),
		);
	}
	// Control: the boundary cases include both outcomes for the election-day rules.
	const outcomes = cases.map(([t, e]) => parseTimeline(t, e).conflicts.some((c) => c.code === 'EVENT_AFTER_ELECTION_DATE' || c.code === 'CLOSED_BEFORE_ELECTION_DATE'));
	assert.ok(outcomes.includes(true) && outcomes.includes(false));
});
