/**
 * bootstrap-config.test.mjs — the unit contract for `src/peer/config.js`
 * (56-06, D-13). Written BEFORE the module (TDD RED), against the seam
 * fixed in the plan's own `<interfaces>` block: five named exports,
 * `validateBootstrapConfig` pure/synchronous, `loadBootstrapConfig` never
 * throwing and never rejecting.
 *
 * This file's SUBJECT is `src/peer/config.js` itself, imported directly by
 * relative path — the same idiom `election-address.test.mjs` uses for a
 * module it executes rather than merely scans.
 *
 * `node:fetch`/DOM are never mocked globally: `fetchImpl` is injected on
 * every call, so this whole module is exercisable under `node --test` with
 * no browser at all — the same rationale `resolveBootstrapNodes`'s own doc
 * comment states for its RN counterpart (preserved deliberately for
 * `56-10`'s benefit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	BOOTSTRAP_CONFIG_URL,
	MAX_BOOTSTRAP_NODES,
	CONFIG_FAULT,
	validateBootstrapConfig,
	loadBootstrapConfig,
} from '../../src/peer/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');

/** A realistic-length, alphanumeric peerId — 46 characters, matching the >=40 rule. */
const PEER_ID = 'QmZ9x7WbK3vDNyoUyquNfz1DFtAWDBQ1JMkVwGqDXaTbuF';
const SHORT_PEER_ID = 'QmZ9x7WbK3vDNyoUyquNfz1DFtAWDB'; // 30 chars, under the 40-char floor

/**
 * Build a minimal fake `Response` — only the surface `loadBootstrapConfig`
 * is documented to touch (`ok`, `status`, `text()`).
 * @param {{ ok: boolean, status: number, body: string }} shape
 * @returns {{ ok: boolean, status: number, text: () => Promise<string> }}
 */
function fakeResponse({ ok, status, body }) {
	return { ok, status, text: async () => body };
}

/**
 * A `fetchImpl` spy that records its call arguments and resolves with a
 * fixed response (or rejects with a fixed error).
 * @param {{ response?: ReturnType<typeof fakeResponse>, rejectWith?: Error }} behavior
 */
function spyFetch(behavior) {
	/** @type {Array<[string, any]>} */
	const calls = [];
	/**
	 * @param {string} url
	 * @param {{ credentials: string, cache: string, redirect: string }} init
	 * @returns {Promise<{ ok: boolean, status: number, text: () => Promise<string> }>}
	 */
	const fn = async (url, init) => {
		calls.push([url, init]);
		if (behavior.rejectWith) throw behavior.rejectWith;
		return /** @type {ReturnType<typeof fakeResponse>} */ (behavior.response);
	};
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test('happy path: a well-formed config yields ok: true with addresses in file order', async () => {
	const addrs = [`/dns4/gw-a.example.invalid/tcp/443/wss/p2p/${PEER_ID}`, `/dns4/gw-b.example.invalid/tcp/443/wss/p2p/${PEER_ID}`];
	const fetchImpl = spyFetch({ response: fakeResponse({ ok: true, status: 200, body: JSON.stringify({ bootstrapNodes: addrs }) }) });
	const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
	assert.deepEqual(result, { ok: true, bootstrapNodes: addrs });
});

test('validateBootstrapConfig alone: a well-formed value yields ok: true, synchronously, in file order', () => {
	const addrs = [`/dns4/gw-a.example.invalid/tcp/443/wss/p2p/${PEER_ID}`];
	const result = validateBootstrapConfig({ bootstrapNodes: addrs }, { pageProtocol: 'https:' });
	assert.deepEqual(result, { ok: true, bootstrapNodes: addrs });
});

// ---------------------------------------------------------------------------
// Fault: missing — the fetch did not deliver a config
// ---------------------------------------------------------------------------
test('missing: fetchImpl rejecting (network error / DNS / CORS) yields fault: missing', async () => {
	const fetchImpl = spyFetch({ rejectWith: new TypeError('Failed to fetch') });
	const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MISSING);
});

for (const status of [404, 500, 403]) {
	test(`missing: a response with ok:false and status ${status} yields fault: missing`, async () => {
		const fetchImpl = spyFetch({ response: fakeResponse({ ok: false, status, body: '' }) });
		const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
		assert.equal(result.ok, false);
		assert.equal(result.fault, CONFIG_FAULT.MISSING);
	});
}

test('missing: a refused redirect (redirect: "error" causing a rejection) yields fault: missing', async () => {
	const fetchImpl = spyFetch({ rejectWith: new TypeError('Failed to fetch: redirect mode is "error" and a redirect occurred') });
	const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MISSING);
});

// ---------------------------------------------------------------------------
// Fault: malformed — a config arrived and cannot be used
// ---------------------------------------------------------------------------
test('malformed: a 200 response whose body is HTML (the SPA-fallback case) yields fault: malformed, never missing', async () => {
	const fetchImpl = spyFetch({ response: fakeResponse({ ok: true, status: 200, body: '<!doctype html><html><body>not json</body></html>' }) });
	const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

for (const [label, parsed] of [
	['an array', [1, 2, 3]],
	['a string', 'just a string'],
	['null', null],
]) {
	test(`malformed: a body that parses but is ${label}, not a plain object`, () => {
		const result = validateBootstrapConfig(parsed, { pageProtocol: 'https:' });
		assert.equal(result.ok, false);
		assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
	});
}

test('malformed: bootstrapNodes absent', () => {
	const result = validateBootstrapConfig({}, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: bootstrapNodes present but not an array', () => {
	const result = validateBootstrapConfig({ bootstrapNodes: 'nope' }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: bootstrapNodes is [] — the no-fallback property, asserted explicitly (must NOT be ok: true)', () => {
	const result = validateBootstrapConfig({ bootstrapNodes: [] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false, 'an empty bootstrapNodes list must never be accepted as ok: true');
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: an entry that is not a string', () => {
	const result = validateBootstrapConfig({ bootstrapNodes: [42] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: an entry that does not start with "/"', () => {
	const result = validateBootstrapConfig({ bootstrapNodes: [`dns4/gw.example.invalid/tcp/443/wss/p2p/${PEER_ID}`] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: an entry with no /p2p/<peerId> component', () => {
	const result = validateBootstrapConfig({ bootstrapNodes: ['/dns4/gw.example.invalid/tcp/443/wss'] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test("malformed: an entry whose peerId component is shorter than 40 characters", () => {
	const result = validateBootstrapConfig({ bootstrapNodes: [`/dns4/gw.example.invalid/tcp/443/wss/p2p/${SHORT_PEER_ID}`] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: an entry whose peerId component is non-alphanumeric', () => {
	const badPeerId = `${PEER_ID.slice(0, -1)}!`;
	const result = validateBootstrapConfig({ bootstrapNodes: [`/dns4/gw.example.invalid/tcp/443/wss/p2p/${badPeerId}`] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('transport downgrade: a bare /ws (not preceded by /tls) is malformed on an https: page, ok on an http: page', () => {
	const entry = `/dns4/gw.example.invalid/tcp/80/ws/p2p/${PEER_ID}`;
	const httpsResult = validateBootstrapConfig({ bootstrapNodes: [entry] }, { pageProtocol: 'https:' });
	assert.equal(httpsResult.ok, false);
	assert.equal(httpsResult.fault, CONFIG_FAULT.MALFORMED);

	const httpResult = validateBootstrapConfig({ bootstrapNodes: [entry] }, { pageProtocol: 'http:' });
	assert.deepEqual(httpResult, { ok: true, bootstrapNodes: [entry] });
});

test('transport: /wss and /tls/ws entries are both ok on an https: page', () => {
	const wssEntry = `/dns4/gw.example.invalid/tcp/443/wss/p2p/${PEER_ID}`;
	const tlsWsEntry = `/dns4/gw.example.invalid/tcp/443/tls/ws/p2p/${PEER_ID}`;
	assert.deepEqual(validateBootstrapConfig({ bootstrapNodes: [wssEntry] }, { pageProtocol: 'https:' }), { ok: true, bootstrapNodes: [wssEntry] });
	assert.deepEqual(validateBootstrapConfig({ bootstrapNodes: [tlsWsEntry] }, { pageProtocol: 'https:' }), { ok: true, bootstrapNodes: [tlsWsEntry] });
});

test(`malformed: more than MAX_BOOTSTRAP_NODES (${MAX_BOOTSTRAP_NODES}) entries`, () => {
	const addrs = Array.from({ length: MAX_BOOTSTRAP_NODES + 1 }, (_, i) => `/dns4/gw-${i}.example.invalid/tcp/443/wss/p2p/${PEER_ID}`);
	const result = validateBootstrapConfig({ bootstrapNodes: addrs }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test('malformed: an entry longer than 256 characters', () => {
	const longHost = 'gw.' + 'x'.repeat(260) + '.example.invalid';
	const entry = `/dns4/${longHost}/tcp/443/wss/p2p/${PEER_ID}`;
	assert.ok(entry.length > 256);
	const result = validateBootstrapConfig({ bootstrapNodes: [entry] }, { pageProtocol: 'https:' });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

// ---------------------------------------------------------------------------
// Structural properties
// ---------------------------------------------------------------------------
test('loadBootstrapConfig never throws and never rejects, even for a fetchImpl that throws synchronously', async () => {
	const fetchImpl = () => {
		throw new Error('synchronous throw, not a rejected promise');
	};
	await assert.doesNotReject(async () => {
		const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
		assert.equal(result.ok, false);
	});
});

test('loadBootstrapConfig never throws for a response whose .text() itself rejects', async () => {
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		text: async () => {
			throw new Error('body stream errored');
		},
	});
	await assert.doesNotReject(async () => {
		const result = await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
		assert.equal(result.ok, false);
	});
});

test('the fetchImpl spy is called with credentials: "omit", cache: "no-store", redirect: "error", and the exact BOOTSTRAP_CONFIG_URL', async () => {
	const fetchImpl = spyFetch({ response: fakeResponse({ ok: true, status: 200, body: JSON.stringify({ bootstrapNodes: [`/dns4/gw.example.invalid/tcp/443/wss/p2p/${PEER_ID}`] }) }) });
	await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:' });
	assert.equal(fetchImpl.calls.length, 1);
	const [calledUrl, calledInit] = fetchImpl.calls[0];
	assert.equal(calledUrl, BOOTSTRAP_CONFIG_URL);
	assert.equal(calledInit.credentials, 'omit');
	assert.equal(calledInit.cache, 'no-store');
	assert.equal(calledInit.redirect, 'error');
});

test('the URL passed to fetchImpl is unaffected by a location.search-shaped value supplied anywhere', async () => {
	const fetchImpl = spyFetch({ response: fakeResponse({ ok: true, status: 200, body: JSON.stringify({ bootstrapNodes: [`/dns4/gw.example.invalid/tcp/443/wss/p2p/${PEER_ID}`] }) }) });
	// A location.search-shaped string handed in through every plausible slot
	// this call could accept one — none of them may reach the fetched URL.
	await loadBootstrapConfig({ fetchImpl, pageProtocol: 'https:?election=abc&network=def' });
	const [calledUrl] = fetchImpl.calls[0];
	assert.equal(calledUrl, BOOTSTRAP_CONFIG_URL);
});

test('BOOTSTRAP_CONFIG_URL is the frozen relative path "/config.json"', () => {
	assert.equal(BOOTSTRAP_CONFIG_URL, '/config.json');
});

test('MAX_BOOTSTRAP_NODES is the frozen number 8', () => {
	assert.equal(MAX_BOOTSTRAP_NODES, 8);
});

test('CONFIG_FAULT is frozen and exposes exactly MISSING/MALFORMED', () => {
	assert.ok(Object.isFrozen(CONFIG_FAULT));
	assert.deepEqual(Object.keys(CONFIG_FAULT).sort(), ['MALFORMED', 'MISSING']);
	assert.equal(CONFIG_FAULT.MISSING, 'missing');
	assert.equal(CONFIG_FAULT.MALFORMED, 'malformed');
});

// ---------------------------------------------------------------------------
// public/config.example.json — the operator-facing template.
// ---------------------------------------------------------------------------
test('public/config.example.json validates green through validateBootstrapConfig under pageProtocol: "https:"', () => {
	const raw = readFileSync(path.join(APP_ROOT, 'public', 'config.example.json'), 'utf8');
	const parsed = JSON.parse(raw);
	const result = validateBootstrapConfig(parsed, { pageProtocol: 'https:' });
	assert.equal(result.ok, true, `expected the shipped template to validate green, got: ${JSON.stringify(result)}`);
});

test("public/config.example.json's host component is a reserved, non-resolvable name (contains .invalid)", () => {
	const raw = readFileSync(path.join(APP_ROOT, 'public', 'config.example.json'), 'utf8');
	const parsed = JSON.parse(raw);
	assert.ok(Array.isArray(parsed.bootstrapNodes) && parsed.bootstrapNodes.length > 0);
	assert.match(parsed.bootstrapNodes[0], /\.invalid/, 'a template someone copies verbatim must fail to dial loudly, never silently become the next sentinel');
});

// ---------------------------------------------------------------------------
// No-compiled-in-address property, comment-stripped.
// ---------------------------------------------------------------------------
test('src/peer/config.js contains zero /dns4/, /ip4/ or /dnsaddr/ literals (comment-stripped)', async () => {
	const { stripComments } = await import('../../../../scripts/lib/strip-comments.mjs');
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'config.js'), 'utf8');
	const stripped = stripComments(source);
	assert.doesNotMatch(stripped, /\/(dns4|dnsaddr|ip4)\//);
});

test('src/peer/config.js contains zero import statements (comment-stripped)', async () => {
	const { stripComments } = await import('../../../../scripts/lib/strip-comments.mjs');
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'config.js'), 'utf8');
	const stripped = stripComments(source);
	const importLines = stripped.split('\n').filter((line) => /^\s*import\b/.test(line));
	assert.deepEqual(importLines, []);
});

test('src/peer/config.js contains no UPDATE_AFTER_DRONE_RESTART or BOOTSTRAP_PLACEHOLDER sentinel', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'config.js'), 'utf8');
	assert.doesNotMatch(source, /UPDATE_AFTER_DRONE_RESTART|BOOTSTRAP_PLACEHOLDER/);
});
