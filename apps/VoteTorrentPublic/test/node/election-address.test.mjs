/**
 * election-address.test.mjs — total coverage of `parseElectionAddress` over
 * all FOUR statuses (D-14/D-33, ASVS V5). 54-11 adds the second address
 * parameter and the fourth status: `'incomplete'`, an address that names one
 * identifier where two are required. This file's SUBJECT is
 * `src/election-address.js` itself, imported directly by relative path —
 * the same D-25 idiom `packages/ui-web/test/election-phase.test.mjs` uses
 * for a module it executes rather than merely scans.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ELECTION_ADDRESS_PARAM,
	ELECTION_ID_PATTERN,
	NETWORK_ADDRESS_PARAM,
	NETWORK_HASH_PATTERN,
	parseElectionAddress,
} from '../../src/election-address.js';

test('ELECTION_ADDRESS_PARAM is the single query parameter name', () => {
	assert.equal(ELECTION_ADDRESS_PARAM, 'election');
});

test('ELECTION_ID_PATTERN is the deliberately loose 1-128 char unreserved-URL-safe form, not the 43-char base64url digest idiom', () => {
	assert.match('a'.repeat(128), ELECTION_ID_PATTERN);
	assert.doesNotMatch('a'.repeat(129), ELECTION_ID_PATTERN);
	assert.doesNotMatch('', ELECTION_ID_PATTERN);
});

// ---------------------------------------------------------------------------
// D-33: the SECOND address parameter. A browser holds one store per network
// and a network holds several elections, so an election id alone cannot
// resolve without making the answer depend on registry order.
// ---------------------------------------------------------------------------
test('NETWORK_ADDRESS_PARAM is the second query parameter name', () => {
	assert.equal(NETWORK_ADDRESS_PARAM, 'network');
});

test('NETWORK_HASH_PATTERN accepts 128 unreserved-URL-safe characters, rejects 129 and rejects the empty string', () => {
	assert.match('a'.repeat(128), NETWORK_HASH_PATTERN);
	assert.doesNotMatch('a'.repeat(129), NETWORK_HASH_PATTERN);
	assert.doesNotMatch('', NETWORK_HASH_PATTERN);
});

test('the two patterns are INDEPENDENT RegExp literals, not one aliased to the other -- so tightening one subject cannot silently tighten the other', () => {
	assert.notEqual(NETWORK_HASH_PATTERN, ELECTION_ID_PATTERN, 'the two patterns are the same object');
	assert.ok(NETWORK_HASH_PATTERN instanceof RegExp);
	assert.ok(ELECTION_ID_PATTERN instanceof RegExp);
});

/** A valid value of each kind, reused across the tables below. */
const OK_NETWORK = 'nw-Ab3_9';
const OK_ELECTION = 'vtx-Ab3_9';

/**
 * Every hostile shape, held ONCE and applied to BOTH parameters, so the two
 * can never drift apart in which shapes they refuse. `%s` is the injection
 * point for the crafted value; the repeated-parameter shape is handled
 * separately below because it needs the parameter name twice.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const HOSTILE_VALUES = Object.freeze([
	['leading percent-encoded whitespace', '%20abc'],
	['trailing percent-encoded whitespace', 'abc%20'],
	['a "+" decoding to an embedded space', 'a+b'],
	['an embedded slash', 'a/b'],
	['an embedded dot', 'a.b'],
	['a script-shaped payload', '%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
	['a path-traversal-shaped payload', '..%2F..%2Fetc%2Fpasswd'],
	['a percent-encoded NUL byte', '%00'],
	['a 129-character value (one over the limit)', 'a'.repeat(129)],
]);

// ---------------------------------------------------------------------------
// Inertness control — a parser that returned 'malformed' for everything
// (or 'missing' for everything) must not be able to pass this suite.
// ---------------------------------------------------------------------------
test('inertness control: a well-formed two-parameter address is "ok" (proves the suite can discriminate)', () => {
	const result = parseElectionAddress('?network=nw-Ab3_9&election=abc');
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, 'abc');
	assert.equal(result.networkHash, 'nw-Ab3_9');
	assert.ok(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// 'missing' cases — never an error, never echoes a value.
// ---------------------------------------------------------------------------
const MISSING_CASES = [
	['no search string at all', ''],
	['a bare question mark', '?'],
	['an empty election value', '?election='],
	['a different, unrelated parameter', '?other=x'],
	['both parameters present but empty', '?network=&election='],
	['an empty network value alone', '?network='],
];
for (const [label, input] of MISSING_CASES) {
	test(`'missing': ${label}`, () => {
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'missing');
		assert.equal(result.electionId, null);
		assert.equal(result.networkHash, null);
		assert.ok(Object.isFrozen(result));
	});
}

const MISSING_NON_STRING_CASES = [
	['undefined', undefined],
	['null', null],
	['a number', 42],
];
for (const [label, input] of MISSING_NON_STRING_CASES) {
	test(`'missing', non-string input never throws: ${label}`, () => {
		assert.doesNotThrow(() => parseElectionAddress(input));
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'missing');
		assert.equal(result.electionId, null);
		assert.equal(result.networkHash, null);
	});
}

// ---------------------------------------------------------------------------
// 'malformed' cases — the offending value is NEVER returned.
// ---------------------------------------------------------------------------
const MALFORMED_CASES = [
	['a duplicated parameter', '?election=a&election=b'],
	['leading percent-encoded whitespace', '?election=%20abc'],
	['trailing percent-encoded whitespace', '?election=abc%20'],
	['a "+" decoding to an embedded space', '?election=a+b'],
	['an embedded slash', '?election=a/b'],
	['an embedded dot', '?election=a.b'],
	['a script-shaped payload', '?election=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
	['a path-traversal-shaped payload', '?election=..%2F..%2Fetc%2Fpasswd'],
	['a percent-encoded NUL byte', '?election=%00'],
	['a 129-character value (one over the limit)', '?election=' + 'a'.repeat(129)],
];
for (const [label, input] of MALFORMED_CASES) {
	test(`'malformed': ${label}`, () => {
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'malformed', `expected 'malformed' for ${JSON.stringify(input)}`);
		assert.equal(result.electionId, null, 'a malformed value must never be echoed back');
		assert.equal(result.networkHash, null, 'a rejected address must leave no renderable value of EITHER kind');
		assert.ok(Object.isFrozen(result));
	});
}

// ---------------------------------------------------------------------------
// 'malformed' via the NETWORK parameter — the same hostile shapes, applied to
// the second subject. This is the half that matters most for T-54-11-02: the
// network value's destination is an IndexedDB store name, so a shape this
// pattern lets through is a shape that reaches `dbNameFor`.
// ---------------------------------------------------------------------------
for (const [label, value] of HOSTILE_VALUES) {
	test(`'malformed', crafted network: ${label}`, () => {
		const result = parseElectionAddress(`?network=${value}`);
		assert.equal(result.status, 'malformed', `expected 'malformed' for a crafted network: ${label}`);
		assert.equal(result.networkHash, null, 'a malformed network value must never be echoed back');
		assert.equal(result.electionId, null);
		assert.ok(Object.isFrozen(result));
	});
}

test(`'malformed': a repeated network parameter refuses rather than picking one`, () => {
	const result = parseElectionAddress('?network=a&network=b');
	assert.equal(result.status, 'malformed');
	assert.equal(result.networkHash, null);
	assert.equal(result.electionId, null);
});

test(`'malformed': a repeated network parameter alongside a perfectly valid election still refuses`, () => {
	const result = parseElectionAddress(`?network=a&network=b&election=${OK_ELECTION}`);
	assert.equal(result.status, 'malformed');
	assert.equal(result.networkHash, null);
	assert.equal(result.electionId, null);
});

// ---------------------------------------------------------------------------
// NEVER-ECHO, BOTH DIRECTIONS. A crafted value in either parameter must not
// leave the OTHER, valid, parameter renderable — otherwise a hostile link
// with one good half still puts a value on the page. 'malformed' always wins.
// ---------------------------------------------------------------------------
for (const [label, value] of HOSTILE_VALUES) {
	test(`never-echo: a crafted network beside a valid election is 'malformed' with BOTH fields null (${label})`, () => {
		const result = parseElectionAddress(`?network=${value}&election=${OK_ELECTION}`);
		assert.equal(result.status, 'malformed');
		assert.equal(result.networkHash, null);
		assert.equal(result.electionId, null, 'the valid election survived a rejected address');
	});

	test(`never-echo: a crafted election beside a valid network is 'malformed' with BOTH fields null (${label})`, () => {
		const result = parseElectionAddress(`?network=${OK_NETWORK}&election=${value}`);
		assert.equal(result.status, 'malformed');
		assert.equal(result.networkHash, null, 'the valid network survived a rejected address');
		assert.equal(result.electionId, null);
	});
}

// ---------------------------------------------------------------------------
// 'incomplete' — the fourth status D-33 forces into existence. NOT a synonym
// for 'malformed': nothing is wrong with the value, the address merely names
// one identifier where two are needed, and D-34's index is the honest answer.
// ---------------------------------------------------------------------------
test(`'incomplete': a network alone yields the decoded networkHash and a null electionId`, () => {
	const result = parseElectionAddress(`?network=${OK_NETWORK}`);
	assert.equal(result.status, 'incomplete');
	assert.equal(result.networkHash, OK_NETWORK);
	assert.equal(result.electionId, null);
	assert.ok(Object.isFrozen(result));
});

test(`'incomplete': an election alone yields the decoded electionId and a null networkHash`, () => {
	const result = parseElectionAddress(`?election=${OK_ELECTION}`);
	assert.equal(result.status, 'incomplete');
	assert.equal(result.electionId, OK_ELECTION);
	assert.equal(result.networkHash, null);
	assert.ok(Object.isFrozen(result));
});

test(`'incomplete': an under-specified address is NOT 'malformed' -- the two are different answers`, () => {
	assert.notEqual(parseElectionAddress(`?election=${OK_ELECTION}`).status, 'malformed');
	assert.notEqual(parseElectionAddress(`?network=${OK_NETWORK}`).status, 'malformed');
});

test(`'incomplete': an empty value on one side is absence, not corruption -- it degrades to 'incomplete', never 'malformed'`, () => {
	const result = parseElectionAddress(`?network=&election=${OK_ELECTION}`);
	assert.equal(result.status, 'incomplete');
	assert.equal(result.electionId, OK_ELECTION);
	assert.equal(result.networkHash, null);
});

// ---------------------------------------------------------------------------
// 'ok' cases.
// ---------------------------------------------------------------------------
test(`'ok': a 128-character value in each parameter (exactly at the limit)`, () => {
	const value = 'a'.repeat(128);
	const result = parseElectionAddress(`?network=${value}&election=${value}`);
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, value);
	assert.equal(result.networkHash, value);
});

test(`'ok': an ordinary mixed-charset pair, frozen, with both values decoded`, () => {
	const result = parseElectionAddress(`?network=${OK_NETWORK}&election=${OK_ELECTION}`);
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, OK_ELECTION);
	assert.equal(result.networkHash, OK_NETWORK);
	assert.ok(Object.isFrozen(result));
});

test(`'ok': PARAMETER ORDER IS IRRELEVANT -- the resolution is a function of the values, not of their position`, () => {
	const a = parseElectionAddress(`?network=${OK_NETWORK}&election=${OK_ELECTION}`);
	const b = parseElectionAddress(`?election=${OK_ELECTION}&network=${OK_NETWORK}`);
	assert.deepEqual({ ...a }, { ...b });
	assert.equal(b.status, 'ok');
});

// ---------------------------------------------------------------------------
// The four-status inertness control, stated explicitly: a parser stuck on any
// ONE status cannot pass this file, because every status is producible from
// this file's own inputs.
// ---------------------------------------------------------------------------
test('inertness control: all FOUR statuses are producible from this file\'s own inputs', () => {
	const produced = new Set(
		[
			'?other=x',
			`?network=${OK_NETWORK}`,
			`?election=${OK_ELECTION}`,
			'?network=a/b',
			`?network=${OK_NETWORK}&election=${OK_ELECTION}`,
		].map((input) => String(parseElectionAddress(input).status)),
	);
	for (const status of ['missing', 'incomplete', 'malformed', 'ok']) {
		assert.ok(produced.has(status), `status "${status}" is not producible -- the parser is stuck`);
	}
});

// ---------------------------------------------------------------------------
// Never throws, over every case above plus a few more hostile inputs.
// ---------------------------------------------------------------------------
test('parseElectionAddress never throws, over every case in this file', () => {
	const inputs = [
		...MISSING_CASES.map(([, input]) => input),
		...MISSING_NON_STRING_CASES.map(([, input]) => input),
		...MALFORMED_CASES.map(([, input]) => input),
		...HOSTILE_VALUES.map(([, value]) => `?network=${value}`),
		...HOSTILE_VALUES.map(([, value]) => `?network=${value}&election=${OK_ELECTION}`),
		'?election=abc',
		`?network=${OK_NETWORK}`,
		`?network=${OK_NETWORK}&election=${OK_ELECTION}`,
		'not-even-a-query-string',
		'?election=' + 'a'.repeat(10000),
		'?network=' + 'a'.repeat(10000),
		'?network=' + 'a'.repeat(10000) + '&election=' + 'a'.repeat(10000),
	];
	for (const input of inputs) {
		assert.doesNotThrow(() => parseElectionAddress(input), `threw on ${JSON.stringify(input)}`);
	}
});
