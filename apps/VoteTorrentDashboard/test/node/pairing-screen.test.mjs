/**
 * pairing-screen.test.mjs -- tier-1 rows for the pairing screen
 * (`src/screens/Pairing.tsx`, `src/screens/pairing.css`).
 *
 * Behaviour runs the REAL pure helpers and the pure views in this process:
 * the .tsx module is loaded through the same module hook as
 * scanner-teardown.test.mjs (TypeScript `transpileModule` with react-jsx, a
 * missing relative `.js` mapped to its `.ts`/`.tsx` sibling, `.css` as an
 * empty module). Views render through react-dom/server. The peer layer is
 * never loaded: `PAIR_FAILURES` is read from `src/peer/pairing.js` as source
 * text, and the pairing run is driven with fakes.
 *
 * Structure rows run over comment-stripped source and CSS, each matcher
 * proven on a planted fixture first. The last two sections read main.tsx (the
 * routing between pairing and the live shell) and index.html (the CSP).
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import viteReact from '@vitejs/plugin-react';
import { COPY } from '@votetorrent/ui-web';
import { dashboardRoot, dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { stripCssComments } from '../../../../scripts/lib/css-class-coverage.mjs';

// --- TSX harness (same loader as scanner-teardown.test.mjs) ----------------------

const tsUrl = pathToFileURL(createRequire(dashboardRoot('package.json')).resolve('typescript')).href;

const LOADER = [
	"import { readFileSync } from 'node:fs';",
	"import { fileURLToPath } from 'node:url';",
	'let ts;',
	'export async function initialize(data) {',
	'\tconst mod = await import(data.tsUrl);',
	'\tts = mod.default ?? mod;',
	'}',
	'const isTs = (url) => typeof url === "string" && /\\.tsx?$/.test(url.split("?")[0]);',
	'export async function resolve(specifier, context, next) {',
	'\ttry {',
	'\t\treturn await next(specifier, context);',
	'\t} catch (err) {',
	"\t\tconst relative = specifier.startsWith('./') || specifier.startsWith('../');",
	"\t\tif (!relative || !isTs(context.parentURL) || !err || err.code !== 'ERR_MODULE_NOT_FOUND') throw err;",
	"\t\tconst base = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;",
	"\t\tfor (const candidate of [base + '.tsx', base + '.ts']) {",
	'\t\t\ttry {',
	'\t\t\t\treturn await next(candidate, context);',
	'\t\t\t} catch {',
	'\t\t\t\t// try the next candidate',
	'\t\t\t}',
	'\t\t}',
	'\t\tthrow err;',
	'\t}',
	'}',
	'export async function load(url, context, next) {',
	"\tconst bare = url.split('?')[0];",
	"\tif (bare.endsWith('.css')) return { format: 'module', source: 'export default undefined;', shortCircuit: true };",
	'\tif (isTs(bare)) {',
	'\t\tconst file = fileURLToPath(bare);',
	"\t\tconst out = ts.transpileModule(readFileSync(file, 'utf8'), {",
	'\t\t\tfileName: file,',
	'\t\t\tcompilerOptions: {',
	'\t\t\t\tjsx: ts.JsxEmit.ReactJSX,',
	'\t\t\t\tmodule: ts.ModuleKind.ESNext,',
	'\t\t\t\ttarget: ts.ScriptTarget.ES2022,',
	'\t\t\t},',
	'\t\t});',
	"\t\treturn { format: 'module', source: out.outputText, shortCircuit: true };",
	'\t}',
	'\treturn next(url, context);',
	'}',
].join('\n');

register('data:text/javascript,' + encodeURIComponent(LOADER), import.meta.url, { data: { tsUrl } });

const PAIRING_PATH = dashboardSrc('screens', 'Pairing.tsx');
const SCANNER_PATH = dashboardSrc('screens', 'QrScanner.tsx');
const CSS_PATH = dashboardSrc('screens', 'pairing.css');
/** @type {any} */
const P = await import(moduleUrl(PAIRING_PATH));

/** `PAIR_FAILURES`, read from the peer module's source text (no cadre-core load). */
const PAIR_FAILURES = (() => {
	const src = readFileSync(dashboardSrc('peer', 'pairing.js'), 'utf8');
	const m = src.match(/export const PAIR_FAILURES = Object\.freeze\(\s*\/\*\*[^*]*\*\/\s*\(\[([\s\S]*?)\]\)/);
	assert.ok(m, 'sanity: PAIR_FAILURES literal found in src/peer/pairing.js');
	return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

/** React's text escaping, for matching copy inside rendered markup. */
const esc = (/** @type {string} */ s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
/** @param {any} props */
const render = (props) =>
	renderToStaticMarkup(createElement(P.PairingStateView, { view: 'idle', code: '', hasPairedNetworks: true, ...props }));
const has = (/** @type {string} */ html, /** @type {string} */ key) => html.includes(esc(COPY[key]));

const CONSUMING = ['old-style', 'expired', 'spent', 'digest-mismatch', 'officer-not-valid', 'unsupported'];
const KEEPING = ['malformed', 'no-storage', 'unreachable'];
const CODE_BAD = ['malformed', 'expired', 'spent', 'digest-mismatch'];

// --- helpers -------------------------------------------------------------------

test('H1 normalizePairingInput removes every whitespace character', () => {
	assert.equal(P.normalizePairingInput(' vtpair1.ab\n cd \t'), 'vtpair1.abcd');
	assert.equal(P.normalizePairingInput('\r\nvtpair1.x y'), 'vtpair1.xy');
	assert.equal(P.normalizePairingInput(undefined), '');
});

test('H2 FAILURE_VIEWS covers PAIR_FAILURES minus cancelled and swap-declined, with the contract CTAs and code rules', () => {
	assert.equal(PAIR_FAILURES.length, 11, 'sanity: the peer module lists eleven failures');
	const expected = PAIR_FAILURES.filter((r) => r !== 'cancelled' && r !== 'swap-declined');
	assert.deepEqual(Object.keys(P.FAILURE_VIEWS).sort(), [...expected].sort());
	assert.equal(Object.isFrozen(P.FAILURE_VIEWS), true);
	const ctas = {
		malformed: 'pairing.action.tryAgain',
		'no-storage': 'pairing.action.tryAgain',
		unreachable: 'pairing.action.retry',
		expired: 'pairing.action.tryAnother',
		spent: 'pairing.action.tryAnother',
		'digest-mismatch': 'pairing.action.tryAnother',
		'old-style': null,
		'officer-not-valid': null,
		unsupported: null,
	};
	for (const [reason, view] of Object.entries(P.FAILURE_VIEWS)) {
		const v = /** @type {any} */ (view);
		assert.ok(v.headingKey in COPY, `${reason} heading key exists`);
		assert.ok(v.bodyKey in COPY, `${reason} body key exists`);
		assert.equal(v.headingKey, `pairing.failed.${reason}.heading`);
		assert.equal(v.ctaKey, /** @type {any} */ (ctas)[reason], `${reason} CTA`);
		if (v.ctaKey !== null) assert.ok(v.ctaKey in COPY);
		assert.equal(v.keepsCode, KEEPING.includes(reason), `${reason} keepsCode`);
		assert.equal(v.codeIsBad, CODE_BAD.includes(reason), `${reason} codeIsBad`);
	}
});

test('H3 keepsCodeAfterFailure: a stop or swap refusal keeps the code only before the join began', () => {
	assert.equal(P.keepsCodeAfterFailure('cancelled', 'connecting'), true);
	assert.equal(P.keepsCodeAfterFailure('swap-declined', 'verifying'), true);
	assert.equal(P.keepsCodeAfterFailure('cancelled', null), true);
	assert.equal(P.keepsCodeAfterFailure('cancelled', 'joining'), false);
	assert.equal(P.keepsCodeAfterFailure('cancelled', 'first-sync'), false);
	for (const r of KEEPING) assert.equal(P.keepsCodeAfterFailure(r, 'first-sync'), true, r);
	for (const r of CONSUMING) assert.equal(P.keepsCodeAfterFailure(r, 'verifying'), false, r);
});

test('H4 stepRows: done, in progress and waiting per the reached phase; a failure marks the current row', () => {
	const rows = P.stepRows('joining', { failed: false });
	assert.deepEqual(
		rows.map((/** @type {any} */ r) => [r.phase, r.labelKey, r.stateKey]),
		[
			['connecting', 'pairing.step.connecting', 'pairing.stepState.done'],
			['joining', 'pairing.step.joining', 'pairing.stepState.inProgress'],
			['first-sync', 'pairing.step.first-sync', 'pairing.stepState.waiting'],
		],
	);
	const failed = P.stepRows('first-sync', { failed: true });
	assert.equal(failed[2].stateKey, 'pairing.stepState.failed');
	assert.equal(failed[0].stateKey, 'pairing.stepState.done');
	assert.ok(P.stepRows(null, { failed: false }).every((/** @type {any} */ r) => r.stateKey === 'pairing.stepState.waiting'));
});

test('H5 unpairedNoticeCopy: the three variants, with "Unnamed officer" for a missing name', () => {
	const revoked = P.unpairedNoticeCopy({ reason: 'revoked', authorityName: 'Nepal Votes', officerName: 'Asha' });
	assert.equal(revoked.heading, COPY['unpaired.heading']);
	assert.equal(revoked.body, "Asha removed it in the Authority app, so its local copy of Nepal Votes's data was deleted from this browser. Pair again with a new code to follow the network.");
	assert.equal(P.unpairedNoticeCopy({ reason: 'removed', authorityName: 'N', officerName: 'A' }).body, COPY['unpaired.body.removed']);
	assert.equal(
		P.unpairedNoticeCopy({ reason: 'key-invalid', authorityName: 'N', officerName: 'Asha' }).body,
		"Asha's key is no longer valid, so this browser was unpaired and its local copy deleted.",
	);
	assert.ok(P.unpairedNoticeCopy({ reason: 'revoked', authorityName: 'N', officerName: null }).body.startsWith('Unnamed officer removed it'));
});

test('H6 routeFromRegistry: pairing for none or legacy only; the shell for a paired entry; a paired preferred hash wins', () => {
	const isLegacy = (/** @type {any} */ e) => e.pairing === null || e.pairing === undefined;
	const legacy = { networkHash: 'L1', pairing: null };
	const paired = { networkHash: 'P1', pairing: { v: 1 } };
	const paired2 = { networkHash: 'P2', pairing: { v: 1 } };
	assert.deepEqual(P.routeFromRegistry([], isLegacy), { kind: 'pairing' });
	assert.deepEqual(P.routeFromRegistry([legacy], isLegacy), { kind: 'pairing' });
	assert.deepEqual(P.routeFromRegistry([legacy, paired], isLegacy), { kind: 'shell', networkHash: 'P1' });
	assert.deepEqual(P.routeFromRegistry([paired, paired2], isLegacy, 'P2'), { kind: 'shell', networkHash: 'P2' });
	assert.deepEqual(P.routeFromRegistry([legacy, paired], isLegacy, 'L1'), { kind: 'shell', networkHash: 'P1' });
	assert.deepEqual(P.routeFromRegistry(null, isLegacy), { kind: 'pairing' });
});

test('H7 detectUnsupportedBrowser: true when any needed browser feature is missing', () => {
	const full = { indexedDB: {}, crypto: { subtle: {} }, WebSocket: function () {}, TextEncoder: function () {} };
	assert.equal(P.detectUnsupportedBrowser(full), false);
	assert.equal(P.detectUnsupportedBrowser({ ...full, indexedDB: undefined }), true);
	assert.equal(P.detectUnsupportedBrowser({ ...full, crypto: {} }), true);
	assert.equal(P.detectUnsupportedBrowser({ ...full, WebSocket: undefined }), true);
	assert.equal(P.detectUnsupportedBrowser({ ...full, TextEncoder: undefined }), true);
	assert.equal(P.detectUnsupportedBrowser(undefined), true);
});

test('H8 abort after an ok result calls nothing and the adopted node stays alive (control: an in-flight run does abort)', async () => {
	/** @param {any} result */
	const makeFake = (result) => {
		const rec = /** @type {{ signal: any, abortFired: number }} */ ({ signal: null, abortFired: 0 });
		/** @param {any} options */
		const fake = (options) => {
			rec.signal = options.signal;
			options.signal.addEventListener('abort', () => {
				rec.abortFired += 1;
			});
			return result;
		};
		return { rec, fake };
	};
	/** @type {any} */
	const memberNode = {
		stops: 0,
		stop() {
			memberNode.stops += 1;
		},
	};
	const ok = makeFake(Promise.resolve({ ok: true, networkHash: 'H', handoff: { memberNode, strandReader: {} } }));
	const run = P.createPairingRun(ok.fake);
	const result = await run.start({ code: 'vtpair1.x' });
	assert.equal(result.ok, true);
	assert.equal(run.inFlight(), false);
	assert.equal(run.abort(), false);
	assert.equal(ok.rec.signal.aborted, false);
	assert.equal(ok.rec.abortFired, 0);
	assert.equal(memberNode.stops, 0);

	// Control: the same matcher sees an abort while a run is pending.
	const pending = makeFake(new Promise(() => {}));
	const run2 = P.createPairingRun(pending.fake);
	void run2.start({ code: 'vtpair1.y' });
	await Promise.resolve();
	assert.equal(run2.inFlight(), true);
	assert.equal(run2.abort(), true);
	assert.equal(pending.rec.signal.aborted, true);
	assert.equal(pending.rec.abortFired, 1);

	const failed = makeFake(Promise.resolve({ ok: false, reason: 'expired' }));
	const run3 = P.createPairingRun(failed.fake);
	await run3.start({ code: 'vtpair1.z' });
	assert.equal(run3.abort(), false);
	assert.equal(failed.rec.signal.aborted, false);
});

// --- rendered states -------------------------------------------------------------

test('R1 idle with an empty field: the textarea attributes, a disabled CTA, NO scan button (R-G16) and the empty-networks block', () => {
	const html = render({ hasPairedNetworks: false });
	const area = html.match(/<textarea[^>]*>/);
	assert.ok(area, 'a textarea renders');
	// HTML attribute names are case-insensitive, and React's server renderer
	// keeps the camelCase spelling (spellCheck="false"), so compare lowercased.
	const areaTag = area[0].toLowerCase();
	for (const attr of ['rows="4"', 'spellcheck="false"', 'autocomplete="off"', 'autocapitalize="off"', 'autocorrect="off"']) {
		assert.ok(areaTag.includes(attr), `textarea has ${attr}`);
	}
	assert.match(html, /<button type="submit" class="pr-cta" disabled="">Pair this browser<\/button>/);
	// R-G16: QR scanning is off for this release, so by default the screen offers paste only.
	assert.ok(!has(html, 'pairing.scanCta'), 'no scan button by default');
	assert.ok(has(html, 'pairing.emptyHeading') && has(html, 'pairing.emptyBody'));
	assert.ok(has(html, 'pairing.title') && has(html, 'pairing.intro') && has(html, 'pairing.fieldLabel') && has(html, 'pairing.fieldHelp'));
	const withCode = render({ code: 'vtpair1.abc' });
	assert.match(withCode, /<button type="submit" class="pr-cta">/, 'the CTA enables once the field has text');
	assert.ok(!has(withCode, 'pairing.emptyHeading'), 'no empty block once a network is paired');
});

/** Every intrinsic element in a returned React tree (function components are not expanded). */
function intrinsicElements(/** @type {any} */ node, /** @type {any[]} */ out = []) {
	if (Array.isArray(node)) {
		for (const child of node) intrinsicElements(child, out);
	} else if (node && typeof node === 'object' && node.props) {
		if (typeof node.type === 'string') out.push(node);
		intrinsicElements(node.props.children, out);
	}
	return out;
}
const SCAN_TEXT = COPY['pairing.scanCta'];
const scanButtons = (/** @type {any} */ tree) =>
	intrinsicElements(tree).filter((el) => el.type === 'button' && el.props.children === SCAN_TEXT);
/** The stateful screen, server-rendered (no effects run, so the peer layer never loads). */
const renderScreen = (/** @type {any} */ extra = {}) =>
	renderToStaticMarkup(
		createElement(P.Pairing, {
			notice: null,
			onDismissNotice: () => undefined,
			hasPairedNetworks: false,
			onPaired: () => undefined,
			...extra,
		}),
	);
const SCANNER_DIALOG = /<dialog[^>]*class="pr-scanner"/;

test('R1b R-G16 default: QR_SCAN_ENABLED is false, and the stateful screen renders no scan button and mounts no scanner', () => {
	assert.equal(P.QR_SCAN_ENABLED, false, 'the capability ships off');
	// Controls: the matchers bite on planted markup.
	assert.match('<dialog class="pr-scanner" aria-labelledby="pr-scanner-heading">', SCANNER_DIALOG);
	assert.equal(scanButtons({ type: 'div', props: { children: [{ type: 'button', props: { children: SCAN_TEXT } }] } }).length, 1);

	const html = renderScreen();
	assert.ok(html.includes('<textarea'), 'sanity: the idle form rendered');
	assert.ok(!has(html, 'pairing.scanCta'), 'no scan button');
	assert.doesNotMatch(html, SCANNER_DIALOG, 'no scanner dialog mounted');
	assert.equal(scanButtons(P.PairingStateView({ view: 'idle', code: '', hasPairedNetworks: false })).length, 0);
	assert.equal(scanButtons(P.PairingStateView({ view: 'idle', code: '', hasPairedNetworks: false, qrScanEnabled: false })).length, 0);
	const off = renderScreen({ qrScanEnabled: false });
	assert.ok(!has(off, 'pairing.scanCta') && !SCANNER_DIALOG.test(off), 'an explicit false is off too');
});

test('R1c R-G16 enabled: the scan button renders, its click calls onScan, and the screen mounts the scanner that onScan opens', () => {
	const html = render({ hasPairedNetworks: false, qrScanEnabled: true });
	assert.ok(has(html, 'pairing.scanCta'), 'the scan button renders when enabled');
	let scans = 0;
	const buttons = scanButtons(P.PairingStateView({ view: 'idle', code: '', hasPairedNetworks: false, qrScanEnabled: true, onScan: () => scans++ }));
	assert.equal(buttons.length, 1, 'exactly one scan button');
	assert.equal(buttons[0].props.type, 'button', 'it is not a submit button');
	buttons[0].props.onClick();
	assert.equal(scans, 1, 'clicking it calls onScan');

	const screen = renderScreen({ qrScanEnabled: true });
	assert.ok(has(screen, 'pairing.scanCta'), 'the stateful screen shows the button');
	assert.match(screen, SCANNER_DIALOG, 'the scanner dialog is mounted (closed until opened)');
	// The wiring that opens it: onScan sets scannerOpen, which is the scanner's open prop.
	const code = stripComments(readFileSync(PAIRING_PATH, 'utf8'));
	assert.match(code, /onScan=\{\(\) => setScannerOpen\(true\)\}/);
	assert.match(code, /<QrScanner\s+open=\{scannerOpen\}/);
});

test('R1d R-G16 production never enables the scanner: main.tsx names neither the prop nor the constant (comment-stripped)', () => {
	const ENABLES = /\bqrScanEnabled\b|\bQR_SCAN_ENABLED\b/;
	assert.match('<Pairing notice={n} qrScanEnabled />', ENABLES, 'control: a planted prop is caught');
	assert.match("import { QR_SCAN_ENABLED } from './screens/Pairing';", ENABLES, 'control: a planted constant is caught');
	assert.doesNotMatch('<Pairing notice={n} onPaired={p} />', ENABLES);
	const main = stripComments(readFileSync(dashboardSrc('main.tsx'), 'utf8'));
	assert.match(main, /<Pairing\b/, 'sanity: main.tsx mounts Pairing');
	assert.doesNotMatch(main, ENABLES);
});

test('R1e R-G16 the live gate opts in: GateApp (and the notice mount) pass qrScanEnabled, so its scanner legs keep running', () => {
	const gate = stripComments(readFileSync(dashboardRoot('test', 'browser', 'live-gate.tsx'), 'utf8'));
	const gateApp = gate.match(/export function GateApp\([\s\S]*?\n\}\n/);
	assert.ok(gateApp, 'sanity: GateApp found');
	const pairing = gateApp[0].match(/<Pairing\b[\s\S]*?\/>/);
	assert.ok(pairing, 'GateApp mounts Pairing');
	const ENABLED = /\bqrScanEnabled(?:=\{true\})?(?=[\s/])/;
	assert.match('<Pairing a={b} qrScanEnabled />', ENABLED, 'control: bare prop');
	assert.match('<Pairing a={b} qrScanEnabled={true} />', ENABLED, 'control: explicit true');
	assert.doesNotMatch('<Pairing a={b} qrScanEnabled={false} />', ENABLED, 'control: false is not enabled');
	assert.match(pairing[0], ENABLED, 'GateApp enables the scanner');
	const notice = gate.match(/<Pairing notice=\{notice\}[\s\S]*?\/>/);
	assert.ok(notice && ENABLED.test(notice[0]), 'the notice mount enables it too, as before');
});

test('R2 verifying and joining replace the field; joining shows the authority, three steps and Stop pairing', () => {
	const verifying = render({ view: 'verifying', code: 'vtpair1.abc' });
	assert.doesNotMatch(verifying, /<textarea|class="pr-cta"/);
	assert.ok(has(verifying, 'pairing.verifying.heading') && has(verifying, 'pairing.verifying.body'));
	assert.match(verifying, /aria-live="polite"/);
	assert.match(verifying, /class="pr-spinner"/);

	const joining = render({ view: 'joining', reachedPhase: 'joining', authorityName: 'Nepal Votes', code: 'vtpair1.abc' });
	assert.doesNotMatch(joining, /<textarea|class="pr-cta"/);
	assert.ok(joining.includes('Joining Nepal Votes'));
	assert.equal((joining.match(/<li class="pr-step">/g) ?? []).length, 3);
	assert.ok(joining.includes(esc(COPY['pairing.step.joiningUnnamed'])), 'no officer name: the unnamed step label');
	assert.ok(joining.includes('pr-step-state pr-step-state--done">Done'));
	assert.ok(joining.includes('pr-step-state pr-step-state--progress">In progress'));
	assert.ok(joining.includes('pr-step-state pr-step-state--waiting">Waiting'));
	assert.ok(has(joining, 'pairing.joining.body'));
	assert.match(joining, /<button type="button" class="pr-text-button">Stop pairing<\/button>/);
	assert.ok(!has(joining, 'pairing.catchingUpSlow'));

	const named = render({ view: 'joining', reachedPhase: 'joining', authorityName: 'N', officerName: 'Asha' });
	assert.ok(named.includes(esc("Joining as Asha's browser")));
	const slow = render({ view: 'joining', reachedPhase: 'first-sync', authorityName: 'N', slow: true });
	assert.ok(has(slow, 'pairing.catchingUpSlow'));
	const stopping = render({ view: 'stopping', reachedPhase: 'joining', authorityName: 'N' });
	assert.match(stopping, /<button type="button" class="pr-text-button" disabled="">Stop pairing<\/button>/);
	const unnamedAuthority = render({ view: 'joining', reachedPhase: 'connecting', authorityName: '' });
	assert.doesNotMatch(unnamedAuthority, /Joining \{\{|Joining <\/h2>/);
});

test('R3 each failure renders its heading, body and CTA inside role=alert; red headings only for a bad code', () => {
	for (const reason of Object.keys(P.FAILURE_VIEWS)) {
		const v = P.FAILURE_VIEWS[reason];
		const html = render({ view: 'failed', failure: reason, code: 'vtpair1.abc' });
		const alert = html.match(/<div class="pr-alert" role="alert">([\s\S]*?)<\/div>/);
		assert.ok(alert, `${reason} renders role=alert`);
		assert.ok(alert[1].includes(esc(COPY[v.headingKey])), `${reason} heading`);
		assert.ok(alert[1].includes(esc(COPY[v.bodyKey])), `${reason} body`);
		if (v.ctaKey) assert.ok(alert[1].includes(esc(COPY[v.ctaKey])), `${reason} CTA`);
		else assert.doesNotMatch(alert[1], /<button/, `${reason} has no CTA`);
		assert.equal(alert[1].includes('pr-heading pr-heading--fail'), CODE_BAD.includes(reason), `${reason} red heading`);
	}
	const other = render({ view: 'failed', failure: 'no-storage', otherTab: true });
	assert.ok(has(other, 'pairing.failed.no-storage.otherTab'));
	assert.ok(!has(render({ view: 'failed', failure: 'no-storage', otherTab: false }), 'pairing.failed.no-storage.otherTab'));
	const late = render({ view: 'failed', failure: 'unreachable', reachedPhase: 'first-sync' });
	assert.ok(late.includes('pr-step-state pr-step-state--failed">Failed'), 'a failure after connecting shows the failed step');
	assert.ok(!render({ view: 'failed', failure: 'expired', reachedPhase: 'verifying' }).includes('pr-steps'));
});

test('R4 bearer: the code appears only as the field value, and never after a consuming failure', () => {
	const SENTINEL = 'vtpair1.SENTINELq7Zx';
	const count = (/** @type {string} */ h) => h.split(SENTINEL).length - 1;
	const idle = render({ code: SENTINEL });
	assert.equal(count(idle), 1);
	assert.match(idle, new RegExp(`<textarea[^>]*>${SENTINEL}</textarea>`));
	for (const reason of KEEPING) {
		const h = render({ view: 'failed', failure: reason, code: SENTINEL });
		assert.equal(count(h), 1, `${reason} keeps the code in the field only`);
		assert.match(h, new RegExp(`<textarea[^>]*>${SENTINEL}</textarea>`));
	}
	for (const reason of CONSUMING) {
		assert.equal(count(render({ view: 'failed', failure: reason, code: SENTINEL })), 0, `${reason} shows no code`);
	}
	for (const view of ['verifying', 'joining', 'stopping']) {
		assert.equal(count(render({ view, code: SENTINEL, reachedPhase: 'joining', authorityName: 'N' })), 0, view);
	}
	for (const h of [idle, render({ view: 'failed', failure: 'malformed', code: SENTINEL })]) {
		assert.doesNotMatch(h, new RegExp(`(title|aria-label)="[^"]*${SENTINEL}`));
	}
});

test('R5 unpaired notice: a focusable heading, the variant body and Dismiss, above the card', () => {
	const html = render({ notice: { reason: 'removed', authorityName: 'N', officerName: null }, hasPairedNetworks: false });
	assert.match(html, /<h2 class="pr-notice-heading" tabindex="-1">This browser was unpaired\.<\/h2>/);
	assert.ok(has(html, 'unpaired.body.removed'));
	assert.match(html, /<button type="button" class="pr-text-button">Dismiss<\/button>/);
	assert.ok(html.indexOf('pr-notice') < html.indexOf('pr-card'), 'the notice sits above the card');
	assert.ok(!has(html, 'pairing.emptyHeading'), 'the notice replaces the empty block');
	const keyInvalid = render({ notice: { reason: 'key-invalid', authorityName: 'N', officerName: 'Asha' } });
	assert.ok(keyInvalid.includes(esc("Asha's key is no longer valid")));
});

test('R6 SwapDialogView names both officers; a missing name reads "Unnamed officer"; confirm carries the accent class', () => {
	const html = renderToStaticMarkup(
		createElement(P.SwapDialogView, { authorityName: 'Nepal Votes', oldOfficer: 'Asha', newOfficer: 'Bikash' }),
	);
	assert.ok(html.includes('Replace Asha with Bikash on this browser?'));
	assert.ok(html.includes(esc('This browser is paired as Asha for Nepal Votes.')));
	assert.ok(html.includes(esc('then pairs it as Bikash.')));
	assert.match(html, /<button type="button" class="pr-cta">Replace and continue<\/button>/);
	assert.match(html, /<button type="button" class="pr-button">Keep Asha<\/button>/);
	const unnamed = renderToStaticMarkup(createElement(P.SwapDialogView, { authorityName: 'N', oldOfficer: null, newOfficer: null }));
	assert.ok(unnamed.includes('Replace Unnamed officer with Unnamed officer on this browser?'));
	assert.ok(unnamed.includes('Keep Unnamed officer'));
});

test('R7 source scans: the peer layer only by import(), the real strand reader wired, no storage or URL use, one console line, literal keys', () => {
	const code = stripComments(readFileSync(PAIRING_PATH, 'utf8'));
	const scanner = stripComments(readFileSync(SCANNER_PATH, 'utf8'));
	const STATIC_PEER = /^\s*import[^(]*from\s*['"]\.\.\/peer\//m;
	const LAZY_PAIRING = /import\(\s*['"]\.\.\/peer\/pairing\.js['"]\s*\)/;
	const LAZY_READER = /import\(\s*['"]\.\.\/peer\/strand-read\.js['"]\s*\)/;
	const BANNED = /localStorage|sessionStorage|\blocation\.|\bhistory\./;
	const CONSOLE = /\bconsole\./g;
	// Positive controls.
	assert.match("import { pairBrowser } from '../peer/pairing.js';", STATIC_PEER);
	assert.match("await import('../peer/pairing.js')", LAZY_PAIRING);
	assert.match('window.location.href', BANNED);
	assert.equal('console.warn(1); console.error(2);'.match(CONSOLE)?.length, 2);
	assert.match('t(`pairing.${x}`)', /t\(`/);

	assert.doesNotMatch(code, STATIC_PEER);
	assert.match(code, LAZY_PAIRING);
	assert.match(code, LAZY_READER);
	assert.match(code, /openStrandReader: /);
	assert.match(code, /openStrandReader: strandRead\.openOfficerStrandReader/);
	assert.doesNotMatch(code, BANNED);
	assert.equal(code.match(CONSOLE)?.length, 1, 'exactly one console call');
	assert.match(code, /console\.warn\('screens\/pairing:'/);
	assert.doesNotMatch(code, /t\(`/);
	assert.equal(code.match(/new AbortController/g)?.length, 1, 'one AbortController, inside createPairingRun');
	const both = code + '\n' + scanner;
	for (const key of Object.keys(COPY).filter((k) => /^(pairing|unpaired|swap)\./.test(k))) {
		assert.ok(both.includes(`'${key}'`), `${key} occurs as a string literal`);
	}
});

// --- 66-29 (DEFECT-66-26-01): new input after any refusal ---------------------------

test('R8 after ANY consuming refusal, new typed or pasted text shows in the field and enables the CTA, with the refusal copy still in role=alert', () => {
	for (const reason of CONSUMING) {
		const v = P.FAILURE_VIEWS[reason];
		const html = render({ view: 'failed', failure: reason, code: 'typed-new-text', freshInput: true });
		assert.match(html, /<textarea[^>]*>typed-new-text<\/textarea>/, `${reason}: the new text shows`);
		const cta = html.match(/<button type="submit" class="pr-cta"[^>]*>/);
		assert.ok(cta, `${reason}: the submit CTA renders`);
		assert.doesNotMatch(cta[0], /disabled/, `${reason}: the CTA is enabled`);
		const alert = html.match(/<div class="pr-alert" role="alert">([\s\S]*?)<\/div>/);
		assert.ok(alert, `${reason}: role=alert stays`);
		assert.ok(alert[1].includes(esc(COPY[v.headingKey])), `${reason}: heading stays`);
		assert.ok(alert[1].includes(esc(COPY[v.bodyKey])), `${reason}: body stays`);
	}
});

test('R8b pairingFieldValue: a consuming failure blanks the field unless the text is fresh input; a keeping failure or none shows the code', () => {
	assert.equal(typeof P.pairingFieldValue, 'function', 'the pure helper is exported');
	for (const failure of CONSUMING) {
		assert.equal(P.pairingFieldValue({ failure, code: 'burned', freshInput: false }), '', `${failure} hides the consumed code`);
		assert.equal(P.pairingFieldValue({ failure, code: 'burned' }), '', `${failure} hides it when freshInput is absent`);
		assert.equal(P.pairingFieldValue({ failure, code: 'new', freshInput: true }), 'new', `${failure} shows fresh input`);
	}
	for (const failure of KEEPING) {
		assert.equal(P.pairingFieldValue({ failure, code: 'kept', freshInput: false }), 'kept', `${failure} keeps the code`);
	}
	assert.equal(P.pairingFieldValue({ failure: null, code: 'idle' }), 'idle');
});

/** The body of `const <name> = ... => {` in the component, up to its closing `\n\t};`. @param {string} code @param {string} name */
function arrowBody(code, name) {
	const start = code.indexOf(`const ${name} = `);
	if (start === -1) return null;
	const end = code.indexOf('\n\t};', start);
	return end === -1 ? null : code.slice(start, end);
}

/** Every R9 matcher over a source text; returns the failed check names. @param {string} code */
function freshInputChecks(code) {
	/** @type {string[]} */
	const failed = [];
	const check = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
		if (!ok) failed.push(name);
	};
	check('wired-onCodeInput', /onCodeChange=\{onCodeInput\}/.test(code));
	check('no-bare-setCode', !/onCodeChange=\{setCode\}/.test(code));
	check('passes-freshInput', /freshInput=\{freshInput\}/.test(code));
	const input = arrowBody(code, 'onCodeInput');
	check('input-sets-code', input !== null && /setCode\(text\)/.test(input));
	check('input-sets-fresh-on-failure', input !== null && /if \(failure !== null\) setFreshInput\(true\)/.test(input));
	const paste = arrowBody(code, 'onCodePaste');
	check('paste-sets-fresh-on-failure', paste !== null && /if \(failure !== null\) setFreshInput\(true\)/.test(paste));
	const fail = arrowBody(code, 'failWith');
	check('failWith-resets', fail !== null && /setFreshInput\(false\)/.test(fail));
	const submit = arrowBody(code, 'submit');
	const resetAt = submit === null ? -1 : submit.indexOf('setFreshInput(false)');
	const setCodeAt = submit === null ? -1 : submit.indexOf('setCode(next)');
	check('submit-resets-before-setCode', resetAt !== -1 && setCodeAt !== -1 && resetAt < setCodeAt);
	const cta = arrowBody(code, 'onCta');
	check('onCta-resets', cta !== null && /setFreshInput\(false\)/.test(cta));
	return failed;
}

const FRESH_FIXTURE_GOOD = [
	'\tconst failWith = (reason: PairFailureReason) => {',
	'\t\tsetFreshInput(false);',
	'\t\tsetFailure(reason);',
	'\t};',
	'\tconst submit = async (raw: string) => {',
	'\t\tsetFreshInput(false);',
	'\t\tsetCode(next);',
	'\t};',
	'\tconst onCta = (ctaKey: string) => {',
	'\t\tsetFreshInput(false);',
	'\t};',
	'\tconst onCodeInput = (text: string) => {',
	'\t\tsetCode(text);',
	'\t\tif (failure !== null) setFreshInput(true);',
	'\t};',
	'\tconst onCodePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {',
	'\t\tsetCode(normalizePairingInput(text));',
	'\t\tif (failure !== null) setFreshInput(true);',
	'\t};',
	'<PairingStateView freshInput={freshInput} onCodeChange={onCodeInput} />',
].join('\n');

test('R9 control: every fresh-input matcher passes a synthetic good fixture and each bites on a planted defect', () => {
	assert.deepEqual(freshInputChecks(FRESH_FIXTURE_GOOD), []);
	const planted = {
		'wired-onCodeInput': FRESH_FIXTURE_GOOD.replace('onCodeChange={onCodeInput}', 'onCodeChange={setCode}'),
		'no-bare-setCode': FRESH_FIXTURE_GOOD + '\n<X onCodeChange={setCode} />',
		'passes-freshInput': FRESH_FIXTURE_GOOD.replace('freshInput={freshInput} ', ''),
		'input-sets-fresh-on-failure': FRESH_FIXTURE_GOOD.replace('\t\tsetCode(text);\n\t\tif (failure !== null) setFreshInput(true);', '\t\tsetCode(text);'),
		'paste-sets-fresh-on-failure': FRESH_FIXTURE_GOOD.replace('setCode(normalizePairingInput(text));\n\t\tif (failure !== null) setFreshInput(true);', 'setCode(normalizePairingInput(text));'),
		'failWith-resets': FRESH_FIXTURE_GOOD.replace('\t\tsetFreshInput(false);\n\t\tsetFailure(reason);', '\t\tsetFailure(reason);'),
		'submit-resets-before-setCode': FRESH_FIXTURE_GOOD.replace('\t\tsetFreshInput(false);\n\t\tsetCode(next);', '\t\tsetCode(next);\n\t\tsetFreshInput(false);'),
		'onCta-resets': FRESH_FIXTURE_GOOD.replace('\tconst onCta = (ctaKey: string) => {\n\t\tsetFreshInput(false);', '\tconst onCta = (ctaKey: string) => {'),
	};
	for (const [name, fixture] of Object.entries(planted)) {
		assert.ok(freshInputChecks(fixture).includes(name), `the ${name} matcher is inert`);
	}
});

test('R9 the screen wires onCodeInput, sets freshInput on typed or pasted text after a failure, and resets it on failWith, submit and onCta', () => {
	assert.deepEqual(freshInputChecks(stripComments(readFileSync(PAIRING_PATH, 'utf8'))), []);
});

// --- stylesheet --------------------------------------------------------------------

test('C1 pairing.css: pr- classes only, one hex literal, the card and field geometry, accent and fail colours where allowed', () => {
	const css = stripCssComments(readFileSync(CSS_PATH, 'utf8'));
	/** @param {string} src */
	const classSelectors = (src) => [...src.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
	/** @param {string} src @param {string} needle */
	const rulesUsing = (src, needle) =>
		[...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2].includes(needle)).map((m) => m[1].trim());
	// Positive controls.
	assert.deepEqual(classSelectors('.pr-a, .other { x: 1 }'), ['pr-a', 'other']);
	assert.deepEqual(rulesUsing('.a { color: var(--fail); } .b { color: red; }', 'var(--fail)'), ['.a']);

	const selectorText = css.replace(/\{[^{}]*\}/g, '{}');
	const nonPr = classSelectors(selectorText).filter((c) => !c.startsWith('pr-'));
	assert.deepEqual(nonPr, [], 'every class selector starts with .pr-');
	assert.deepEqual([...new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])], ['#FFFFFF']);
	const card = css.match(/\.pr-card\s*\{([^}]*)\}/);
	assert.ok(card && /max-width:\s*560px/.test(card[1]));
	assert.match(css, /@media \(max-width: 599px\)\s*\{\s*\.pr-card\s*\{\s*margin-top:\s*var\(--space-lg\)/);
	const field = css.match(/\.pr-code\s*\{([^}]*)\}/);
	assert.ok(field, 'the textarea rule exists');
	for (const decl of ['max-height: 160px', 'overflow-y: auto', 'resize: vertical', 'overflow-wrap: anywhere', 'word-break: break-all']) {
		assert.ok(field[1].includes(decl), `.pr-code has ${decl}`);
	}
	assert.deepEqual(rulesUsing(css, 'var(--fail)').sort(), ['.pr-heading--fail', '.pr-step-state--failed']);
	for (const selector of rulesUsing(css, 'var(--primary)')) {
		const ok = selector === '.pr-cta' || /:focus-visible/.test(selector);
		assert.ok(ok, `var(--primary) used outside the CTA and focus rules: ${selector}`);
	}
	assert.ok(rulesUsing(css, 'var(--primary)').includes('.pr-cta'), 'sanity: the CTA uses the accent');
});

// --- main.tsx routing ------------------------------------------------------------
//
// main.tsx is the entry (it renders into #root at import), so these rows read it
// as comment-stripped source. Every matcher is proven on a planted fixture first.

const MAIN_PATH = dashboardSrc('main.tsx');
const SHELL_PATH = dashboardSrc('screens', 'DashboardShell.tsx');
const MAIN_CODE = stripComments(readFileSync(MAIN_PATH, 'utf8'));

test('M1 main.tsx: imports Pairing, the shell and the registry, routes with routeFromRegistry, and carries none of the retired sign-in path', () => {
	const IMPORTS_PAIRING = /import\s*\{[^}]*\bPairing\b[^}]*\}\s*from\s*'\.\/screens\/Pairing'/;
	const IMPORTS_SHELL = /import\s*\{[^}]*\bDashboardShell\b[^}]*\}\s*from\s*'\.\/screens\/DashboardShell'/;
	const IMPORTS_REGISTRY = /import\s*\{[^}]*\blistNetworks\b[^}]*\}\s*from\s*'@votetorrent\/web-data\/officer'/;
	// The banned names are assembled so this file's own text never matches them.
	const BANNED = new RegExp(
		[
			'\\./peer/',
			'freshness',
			'snapshotFreshness',
			['Boot', 'strap'].join(''),
			'bootstrap-transport',
			'lifecycle/bootstrap',
			'onRedeemAnother',
			'pendingSwapContext',
			'setInterval',
			'setTimeout',
			'localStorage',
		].join('|'),
	);
	// Positive controls.
	assert.match("import { Pairing, routeFromRegistry } from './screens/Pairing';", IMPORTS_PAIRING);
	assert.match("import { DashboardShell } from './screens/DashboardShell';", IMPORTS_SHELL);
	assert.match("import { isLegacyEntry, listNetworks } from '@votetorrent/web-data/officer';", IMPORTS_REGISTRY);
	assert.match("import { x } from './peer/boot.js';", BANNED);
	assert.match('setTimeout(tick, 5)', BANNED);

	assert.match(MAIN_CODE, IMPORTS_PAIRING);
	assert.match(MAIN_CODE, IMPORTS_SHELL);
	assert.match(MAIN_CODE, IMPORTS_REGISTRY);
	assert.match(MAIN_CODE, /\bisLegacyEntry\b/);
	assert.match(MAIN_CODE, /routeFromRegistry\(/);
	const shell = MAIN_CODE.match(/<DashboardShell\b[^>]*\/>/);
	assert.ok(shell, '<DashboardShell ... /> is rendered');
	for (const prop of ['key=', 'initialNetworkHash=', 'adopt=', 'onPairAnother=', 'onUnpaired=', 'onNoNetworks=']) {
		assert.ok(shell[0].includes(prop), `<DashboardShell> receives ${prop}`);
	}
	assert.match(MAIN_CODE, /<Pairing\b/);
	assert.doesNotMatch(MAIN_CODE, BANNED);
	assert.match(MAIN_CODE, /enginePreflight\(\)/, 'the preflight hook is kept');
	assert.match(MAIN_CODE, /window\.__DASHBOARD__ = Object\.freeze\(/, 'the frozen readout hook is kept');
});

test('M2 cross-check: the shell main.tsx mounts has no snapshotFreshness call', () => {
	const CALL = /snapshotFreshness\(/;
	assert.match('const f = snapshotFreshness(entry);', CALL);
	const shell = stripComments(readFileSync(SHELL_PATH, 'utf8'));
	assert.match(shell, /export function DashboardShell\(/, 'sanity: the shell module was read');
	assert.doesNotMatch(shell, CALL);
});

test('M3 onPaired hands the pairing result to the shell as adopt, with its network hash and a fresh mount', () => {
	const HANDLER = /\(result: \{[^}]*\}\s*\}?\)\s*=>\s*\{\s*setRoute\(\{\s*kind: 'shell',\s*networkHash: result\.networkHash,\s*adopt: result\.handoff,\s*mount: \+\+mountSeq\s*\}\)/;
	assert.match(
		"(result: { networkHash: string; handoff: PairingHandoff }) => {\n\t\tsetRoute({ kind: 'shell', networkHash: result.networkHash, adopt: result.handoff, mount: ++mountSeq });",
		HANDLER,
	);
	assert.match(MAIN_CODE, HANDLER);
	assert.match(MAIN_CODE, /onPaired=\{handlePaired\}/);
	assert.match(MAIN_CODE, /const handlePaired = useCallback\(/);
});

test('M4 the retired sign-in screen and its stylesheet are gone and nothing under src or test/node names them', () => {
	const screenName = ['Boot', 'strap.tsx'].join('');
	const sheetName = ['boot', 'strap.css'].join('');
	assert.equal(existsSync(dashboardSrc('screens', 'Pairing.tsx')), true, 'sanity: existsSync sees a real file');
	assert.equal(existsSync(dashboardSrc('screens', screenName)), false);
	assert.equal(existsSync(dashboardSrc('screens', sheetName)), false);
	assert.equal(existsSync(dashboardRoot('test', 'node', 'no-qr-affordance.test.mjs')), false);
	const NEEDLE = new RegExp(`screens/${screenName.replace('.tsx', '')}|${sheetName.replace('.', '\\.')}`);
	assert.match(`import x from './screens/${screenName}';`, NEEDLE);
	/** @param {string} dir @returns {string[]} */
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
			d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
		);
	const files = [...walk(dashboardSrc()), ...walk(dashboardRoot('test', 'node'))];
	assert.ok(files.length > 50, `sanity: the walk visited ${files.length} files`);
	// Code only: a comment that still names the old screen (one remains in a
	// transport module that a later cleanup deletes) is history, not a reader.
	/** @param {string} f */
	const codeOf = (f) => {
		const text = readFileSync(f, 'utf8');
		if (f.endsWith('.css')) return stripCssComments(text);
		return /\.(m?js|tsx?)$/.test(f) ? stripComments(text) : text;
	};
	assert.match(codeOf(dashboardSrc('main.tsx')), /createRoot/, 'sanity: codeOf keeps code');
	const hits = files.filter((f) => NEEDLE.test(codeOf(f)));
	assert.deepEqual(hits, []);
});

// --- CSP --------------------------------------------------------------------------

const INDEX_HTML = readFileSync(dashboardRoot('index.html'), 'utf8');

/** @param {string} policy */
const parseCsp = (policy) =>
	new Map(
		policy
			.split(';')
			.map((d) => d.trim())
			.filter(Boolean)
			.map((d) => {
				const [name, ...values] = d.split(/\s+/);
				return [name, values];
			}),
	);

test('P1 index.html carries one meta CSP: self scripts plus the dev-preamble hash, no inline or eval, no plugins, no base or form targets', () => {
	const META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/g;
	// Positive control.
	assert.equal([...'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />'.matchAll(META)].length, 1);
	const html = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, '');
	const metas = [...html.matchAll(META)];
	assert.equal(metas.length, 1, 'exactly one CSP meta');
	const csp = parseCsp(metas[0][1]);
	assert.deepEqual(parseCsp("a 'x'; b c d").get('b'), ['c', 'd'], 'sanity: the parser splits directives');

	const preamble = viteReact.preambleCode.replace('__BASE__', '/');
	assert.match(preamble, /injectIntoGlobalHook/, 'sanity: plugin-react preamble read');
	const hash = `'sha256-${createHash('sha256').update(preamble).digest('base64')}'`;
	const usesWasm = /import\(\s*'zxing-wasm/.test(stripComments(readFileSync(dashboardSrc('screens', 'QrScanner.tsx'), 'utf8')));
	const expectedScript = ["'self'", hash, ...(usesWasm ? ["'wasm-unsafe-eval'"] : [])];

	assert.deepEqual(csp.get('default-src'), ["'self'"]);
	assert.deepEqual(csp.get('script-src'), expectedScript);
	for (const bad of ["'unsafe-inline'", "'unsafe-eval'"]) {
		assert.ok(!csp.get('script-src')?.includes(bad), `script-src has no ${bad}`);
	}
	assert.deepEqual(csp.get('style-src'), ["'self'", "'unsafe-inline'"]);
	assert.deepEqual(csp.get('connect-src'), ["'self'", 'wss:', 'ws:']);
	assert.deepEqual(csp.get('object-src'), ["'none'"]);
	assert.deepEqual(csp.get('base-uri'), ["'none'"]);
	assert.deepEqual(csp.get('form-action'), ["'none'"]);
	assert.equal(csp.has('frame-ancestors'), false, 'frame-ancestors is ignored in a meta policy');
	assert.deepEqual(
		[...csp.keys()].sort(),
		['base-uri', 'connect-src', 'default-src', 'form-action', 'object-src', 'script-src', 'style-src'],
		'no directive beyond the reviewed set',
	);
});

test('P1b the CSP meta comes before every script and stylesheet, so it governs them all', () => {
	const html = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, '');
	const at = html.indexOf('http-equiv="Content-Security-Policy"');
	assert.ok(at > 0);
	for (const tag of ['<script', '<link']) {
		const first = html.indexOf(tag);
		assert.ok(first === -1 || first > at, `${tag} follows the CSP meta`);
	}
	assert.ok(html.indexOf('<meta charset') < at, 'the charset meta stays first');
});
