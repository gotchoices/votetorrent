/**
 * offline-surfaces.test.mjs — the tier-1 contract for BOTH surfaces this plan
 * (56-12) builds: D-17's staleness banner and D-13's config-fault box.
 *
 * Built on `election-shell.test.mjs`'s own shape (D-25/53-01 paths, every
 * matcher proven against a planted violation before it runs against real
 * source, comment-stripped scans throughout) — see that file's own header
 * for the standing rules this one inherits rather than re-derives.
 *
 * WHY THIS FILE CANNOT IMPORT `PublicApp.tsx` OR RUN `useBootstrapConfigFault`
 * DIRECTLY. `node --test` cannot parse a `.tsx` module — no JSX transform is
 * wired into this workspace's runner, the identical constraint
 * `use-public-election.ts`'s own header states for `.ts` (a lesser case: no
 * JSX, only types). Calling a React hook outside a render cycle would also
 * throw "Invalid hook call" even if the file COULD be imported. So this
 * suite proves the hook's BEHAVIOUR in two complementary halves instead of
 * one direct call:
 *   (a) it drives the REAL `loadBootstrapConfig`/`validateBootstrapConfig`
 *       (plain JS, genuinely importable) through all four results the union
 *       permits, and
 *   (b) it source-scans `PublicApp.tsx`'s comment-stripped text for the
 *       exact, unconditional passthrough (`result.ok ? null : result.fault`)
 *       that is the hook's entire mapping from (a)'s result to the rendered
 *       `configFault` value — no `try`/`catch`, no third branch, nothing
 *       else that could turn a tested loader result into an untested one.
 * Together the two halves cover the same ground a direct hook call would.
 *
 * SEAM-FENCE COVERAGE, LANDED IN TWO STAGES (recorded here rather than
 * silently): Task 2 shipped the PRODUCTION half of the seam fence (no .tsx
 * under src/ passes a `source` prop; main.tsx passes no props). The
 * discrimination pairing that proves that scan is live — `test/offline/`
 * DOES pass a `source` prop — could not be written honestly until Task 3
 * landed that directory, so it was added in the same file once Task 3
 * completed, rather than faked or left vacuous in the interim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { publicSrc, publicRoot } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { CONFIG_FAULT, loadBootstrapConfig, validateBootstrapConfig } from '../../src/peer/config.js';

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkAll(full));
		else out.push(full);
	}
	return out;
}

const SHELL_PATH = publicSrc('screens', 'ElectionShell.tsx');
const SHELL_SOURCE = stripComments(readFileSync(SHELL_PATH, 'utf8'));
const PUBLIC_APP_PATH = publicSrc('screens', 'PublicApp.tsx');
const PUBLIC_APP_RAW = readFileSync(PUBLIC_APP_PATH, 'utf8');
const PUBLIC_APP_SOURCE = stripComments(PUBLIC_APP_RAW);
const MAIN_SOURCE = stripComments(readFileSync(publicSrc('main.tsx'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Ordering — the source half of "before any address-branch logic".
// ---------------------------------------------------------------------------

test('positive control: the ordering matcher fires on a planted reversed fixture (malformed-address branch before the fault branch)', () => {
	const reversed = "if (address.status === 'malformed') { x } else if (configFault !== null) { y } else { <section className=\"election\">";
	const faultIdx = reversed.indexOf('configFault !== null');
	const malformedIdx = reversed.indexOf("address.status === 'malformed'");
	assert.ok(faultIdx > malformedIdx, 'the planted fixture must genuinely have the fault check AFTER the malformed check for this control to mean anything');
});

test('D-13: in stripped ElectionShell.tsx, the configFault branch precedes the malformed-address branch, which precedes the .election section', () => {
	const faultIdx = SHELL_SOURCE.indexOf('configFault !== null');
	const malformedIdx = SHELL_SOURCE.indexOf("address.status === 'malformed'");
	const electionIdx = SHELL_SOURCE.indexOf('className="election"');
	assert.ok(faultIdx !== -1, 'the configFault branch guard is not present in ElectionShell.tsx');
	assert.ok(malformedIdx !== -1, 'the malformed-address branch guard is not present in ElectionShell.tsx');
	assert.ok(electionIdx !== -1, 'the .election section is not present in ElectionShell.tsx');
	assert.ok(faultIdx < malformedIdx, 'the configFault branch does not precede the malformed-address branch');
	assert.ok(malformedIdx < electionIdx, 'the malformed-address branch does not precede the .election section');
});

// ---------------------------------------------------------------------------
// 2. No echo — the loader's developer-facing `reason` never reaches
//    PublicApp.tsx, and the only public.config.* literals it names are the
//    frozen map's own four values.
// ---------------------------------------------------------------------------

const REASON_FIELD_RE = /\breason\b/;
const CONFIG_KEY_LITERAL_RE = /'(public\.config\.[\w.]+)'/g;

test('positive control: the reason-field matcher fires on a planted occurrence', () => {
	assert.match('console.log(result.reason)', REASON_FIELD_RE);
});

test("D-13: PublicApp.tsx contains no occurrence of the loader's diagnostic field name (\"reason\")", () => {
	assert.doesNotMatch(PUBLIC_APP_SOURCE, REASON_FIELD_RE, 'PublicApp.tsx names the loader\'s developer-facing reason field — it must never reach the render path');
});

test('D-13: every public.config.* literal in PublicApp.tsx is one of exactly the four keys the UI-SPEC fixes, no more and no fewer', () => {
	const found = new Set();
	let m;
	const re = new RegExp(CONFIG_KEY_LITERAL_RE.source, 'g');
	while ((m = re.exec(PUBLIC_APP_SOURCE))) found.add(m[1]);
	const expected = new Set([
		'public.config.missing.title',
		'public.config.missing.body',
		'public.config.malformed.title',
		'public.config.malformed.body',
	]);
	assert.deepEqual([...found].sort(), [...expected].sort());
});

test("D-13: the frozen fault map's keys are exactly the two CONFIG_FAULT values, compared against the imported frozen object rather than transcribed literals", () => {
	const configFaultValues = Object.values(CONFIG_FAULT).sort();
	assert.equal(configFaultValues.length, 2, 'sanity: CONFIG_FAULT must publish exactly two values for this comparison to be meaningful');
	for (const value of configFaultValues) {
		assert.match(PUBLIC_APP_SOURCE, new RegExp(`\\[CONFIG_FAULT\\.${value === CONFIG_FAULT.MISSING ? 'MISSING' : 'MALFORMED'}\\]`), `PublicApp.tsx's fault map does not key off CONFIG_FAULT.${value}`);
	}
});

// ---------------------------------------------------------------------------
// 3. No fallback leaked upward.
// ---------------------------------------------------------------------------

const MULTIADDR_LITERAL_RE = /\/(?:dns4|dns6|dnsaddr|ip4|ip6)\/[^"'`]*\/p2p\//;

test('positive control: the multiaddr-literal matcher fires on a planted default address', () => {
	assert.match("const FALLBACK = '/dns4/example.invalid/tcp/443/wss/p2p/12D3KooWabc';", MULTIADDR_LITERAL_RE);
});

test('D-13: PublicApp.tsx names no multiaddr-shaped literal and no default address of its own', () => {
	assert.doesNotMatch(PUBLIC_APP_SOURCE, MULTIADDR_LITERAL_RE, 'PublicApp.tsx names a multiaddr-shaped literal — no fallback address may exist anywhere in this plan\'s files');
});

test('D-13: PublicApp.tsx imports loadBootstrapConfig and CONFIG_FAULT from ../peer/config.js, never reimplementing any part of it', () => {
	assert.match(PUBLIC_APP_SOURCE, /import\s*\{[^}]*\bCONFIG_FAULT\b[^}]*\bloadBootstrapConfig\b[^}]*\}\s*from\s*'\.\.\/peer\/config\.js'|import\s*\{[^}]*\bloadBootstrapConfig\b[^}]*\bCONFIG_FAULT\b[^}]*\}\s*from\s*'\.\.\/peer\/config\.js'/);
});

// ---------------------------------------------------------------------------
// 4. Behaviour of the hook — driven in two complementary halves; see this
//    file's own header for why neither half alone is a direct hook call.
// ---------------------------------------------------------------------------

/**
 * A fetchImpl that always resolves the given body with the given ok/status.
 * @param {string} body
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
function fixedFetch(body, { ok = true, status = 200 } = {}) {
	return async () => ({ ok, status, text: async () => body });
}

test('loadBootstrapConfig + validateBootstrapConfig: an ok, well-formed body resolves { ok: true }', async () => {
	const result = await loadBootstrapConfig({
		fetchImpl: fixedFetch(JSON.stringify({ bootstrapNodes: ['/dns4/gw.invalid/tcp/443/wss/p2p/12D3KooWabcdefghijklmnopqrstuvwxyzABCDEFGH'] })),
	});
	assert.equal(result.ok, true);
});

test("loadBootstrapConfig: a non-2xx response resolves fault: 'missing'", async () => {
	const result = await loadBootstrapConfig({ fetchImpl: fixedFetch('', { ok: false, status: 404 }) });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MISSING);
});

test("loadBootstrapConfig: an ok response carrying unparseable JSON resolves fault: 'malformed'", async () => {
	const result = await loadBootstrapConfig({ fetchImpl: fixedFetch('not json') });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
});

test("validateBootstrapConfig: an ok body carrying an EMPTY bootstrapNodes list resolves fault: 'malformed', never null — the no-fallback property 56-06 asked this plan not to reconcile away", () => {
	const result = validateBootstrapConfig({ bootstrapNodes: [] });
	assert.equal(result.ok, false);
	assert.equal(result.fault, CONFIG_FAULT.MALFORMED);
	assert.notEqual(result.fault, null);
});

const PASSTHROUGH_RE = /result\.ok\s*\?\s*null\s*:\s*result\.fault\s*[;)]/;

test('positive control: the passthrough matcher fires on a planted verbatim occurrence and not on a fixture that adds a third branch', () => {
	assert.match('setFault(result.ok ? null : result.fault);', PASSTHROUGH_RE);
	assert.doesNotMatch('setFault(result.ok ? null : result.fault === "missing" ? "missing" : "other");', PASSTHROUGH_RE, 'a matcher that fires on a widened ternary would not prove the mapping stayed a straight passthrough');
});

test("D-13: useBootstrapConfigFault's hook body maps the loader's result with the exact unconditional passthrough this suite's four cases above cover — no try/catch, no third state, no fallback", () => {
	assert.match(PUBLIC_APP_SOURCE, PASSTHROUGH_RE, 'PublicApp.tsx no longer performs the straight ok/fault passthrough this suite\'s four loader cases were written against');
	assert.doesNotMatch(PUBLIC_APP_SOURCE, /\btry\s*\{/, 'PublicApp.tsx contains a try block — loadBootstrapConfig never throws, so a catch here would invent a fourth state nothing upstream can produce');
});

// ---------------------------------------------------------------------------
// 5. Staleness predicate (D-17) — names the ready state, the down
//    connection and the formatted instant; names none of reading/notHeld/
//    unreadable; resolves through the copy table with an asOf argument.
// ---------------------------------------------------------------------------

test('positive control: the staleness-predicate line matcher fires on the real declaration shape and a mismatched fixture is caught by the reading/notHeld/unreadable absence check', () => {
	const real = "const showStaleness = addressed && read.state === 'ready' && read.connection === 'down' && formattedInstant !== null;";
	assert.match(real, /showStaleness\s*=/);
	assert.match(real, /'ready'/);
	assert.match(real, /'down'/);
	assert.match(real, /formattedInstant\s*!==\s*null/);
	const contaminated = "const showStaleness = read.state === 'reading' || read.state === 'notHeld';";
	assert.match(contaminated, /'reading'|'notHeld'/, 'the contamination fixture itself must contain a forbidden state for the absence check below to mean anything');
});

test('D-17: the showStaleness declaration names the ready state, the down connection and the formatted instant, and names none of reading, notHeld or unreadable', () => {
	const line = SHELL_SOURCE.split('\n').find((l) => l.includes('showStaleness ='));
	assert.ok(line, 'no source line declares showStaleness');
	assert.match(line, /read\.state === 'ready'/);
	assert.match(line, /read\.connection === 'down'/);
	assert.match(line, /formattedInstant\s*!==\s*null/);
	assert.doesNotMatch(line, /'reading'|'notHeld'|'unreadable'/);
});

test('D-17: the staleness sentence resolves through the copy table with an asOf argument, never a literal English sentence', () => {
	assert.match(SHELL_SOURCE, /t\('public\.staleness\.body',\s*\{\s*asOf:/, 'the staleness body is not resolved through t() with an asOf param');
});

// ---------------------------------------------------------------------------
// 6. Seam fences — the production half, PLUS the discrimination pairing
//    (Task 3 has now landed test/offline/, closing the staged gap this
//    file's own header recorded at Task 2).
// ---------------------------------------------------------------------------

const SOURCE_PROP_MOUNT_RE = /(?<![\w$.-])source\s*=\s*\{/;

test('positive control: the source-prop mount matcher fires on a planted <ElectionShell source={x} /> and does not fire on the interface field or the destructured parameter inside ElectionShell.tsx itself', () => {
	assert.match('<ElectionShell source={FIXTURE_SOURCE} />', SOURCE_PROP_MOUNT_RE);
	assert.doesNotMatch('\tsource?: Parameters<typeof usePublicElection>[0][\'source\'];', SOURCE_PROP_MOUNT_RE);
	assert.doesNotMatch('export function ElectionShell({ search, at = null, election = null, source, configFault = null }: ElectionShellProps) {', SOURCE_PROP_MOUNT_RE);
});

test('D-17: no .tsx file under src/ passes a source prop to a mount site', () => {
	const tsxFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.tsx'));
	assert.ok(tsxFiles.length > 0, 'sanity: expected at least one .tsx file under src/');
	const offenders = [];
	for (const file of tsxFiles) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (SOURCE_PROP_MOUNT_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these production .tsx files pass a source prop at a mount site: ${offenders.join(', ')}`);
});

test('D-13/D-17: src/main.tsx mounts PublicApp with no props at all', () => {
	assert.match(MAIN_SOURCE, /<PublicApp\s*\/>/, 'main.tsx does not mount <PublicApp /> with no props');
});

test('discrimination: test/offline/ DOES pass a source prop, so the production scan above is measuring a real absence rather than running an inert matcher', () => {
	const harnessDir = publicRoot('test', 'offline');
	const files = walkAll(harnessDir);
	assert.ok(files.length > 0, `sanity: expected at least one file under ${harnessDir}`);
	const sourceMounters = files.filter((file) => file.endsWith('.tsx') && SOURCE_PROP_MOUNT_RE.test(stripComments(readFileSync(file, 'utf8'))));
	assert.ok(
		sourceMounters.length > 0,
		`no .tsx file under ${harnessDir} passes a source prop. The offline harness is the only sanctioned consumer of the ` +
			'injectable read seam; if it has stopped exercising it, the src/ scan above is no longer proving anything.',
	);
});

// ---------------------------------------------------------------------------
// 7. Sanity — anti-vacuous over the two files this suite's subject actually
//    is.
// ---------------------------------------------------------------------------

test('sanity: both subject files are non-empty after comment stripping', () => {
	assert.ok(SHELL_SOURCE.trim().length > 0);
	assert.ok(PUBLIC_APP_SOURCE.trim().length > 0);
});

test('sanity: COPY declares all four public.config.* keys this suite is built against', () => {
	for (const key of ['public.config.missing.title', 'public.config.missing.body', 'public.config.malformed.title', 'public.config.malformed.body']) {
		assert.equal(typeof COPY[key], 'string', `COPY.${key} is not declared`);
		assert.ok(COPY[key].length > 0);
	}
});
