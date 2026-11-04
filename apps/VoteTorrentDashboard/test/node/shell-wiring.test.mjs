/**
 * shell-wiring.test.mjs -- the live shell's tier-1 rows.
 *
 * Two halves:
 *   - Behaviour rows for `src/live/shell-live.ts` (the chip model, the 1 s
 *     render debounce, the clock formats, the panel mark gate, the officer
 *     label and the boot controller). They run the REAL `.ts` module in ONE
 *     spawned child under Node's type stripping, with the same `.js` -> `.ts`
 *     resolve hook `live-hooks.test.mjs` uses, and fakes for the boot module.
 *   - Comment-stripped source scans over the shell's wiring. `node --test`
 *     cannot import `.tsx`, so these pin the SHAPE of the wiring, not its
 *     behaviour; the shell itself is mounted only by the browser gate.
 *
 * Every matcher is proven against a synthetic fixture first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY } from '@votetorrent/ui-web';

// --- shell-live behaviour -----------------------------------------------------

const SHELL_LIVE_URL = moduleUrl(dashboardSrc('live', 'shell-live.ts'));

/** Maps `./x.js` imported from a `.ts` file to `./x.ts` when only the `.ts` exists. */
const LOADER = [
	"import { existsSync } from 'node:fs';",
	"import { fileURLToPath } from 'node:url';",
	'export async function resolve(specifier, context, next) {',
	"\tconst relative = specifier.startsWith('./') || specifier.startsWith('../');",
	"\tconst fromTs = typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts');",
	"\tif (relative && fromTs && specifier.endsWith('.js')) {",
	'\t\tconst jsUrl = new URL(specifier, context.parentURL);',
	'\t\tif (!existsSync(fileURLToPath(jsUrl))) {',
	"\t\t\tconst tsUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);",
	'\t\t\tif (existsSync(fileURLToPath(tsUrl))) return next(tsUrl.href, context);',
	'\t\t}',
	'\t}',
	'\treturn next(specifier, context);',
	'}',
].join('\n');

const REGISTER = [
	"import { register } from 'node:module';",
	`register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(LOADER))});`,
].join('\n');

/** 2026-01-02 23:59:07 UTC: the child runs with TZ=UTC. */
const T = Date.UTC(2026, 0, 2, 23, 59, 7);

const HARNESS = [
	`const URL_ = ${JSON.stringify(SHELL_LIVE_URL)};`,
	`const T = ${T};`,
	'const rows = {};',
	'async function row(name, fn) {',
	'\ttry { rows[name] = await fn(); }',
	"\tcatch (err) { rows[name] = { thrown: { name: (err && err.name) || 'Error', message: String((err && err.message) || '') } }; }",
	'}',
	'const L = await import(URL_);',
	'const plain = (m) => (m === null ? null : { ...m, frozen: Object.isFrozen(m) });',
	"const view = (kind, lastPassAt, reconnecting = false, reason) => (reason ? { kind, lastPassAt, reconnecting, reason } : { kind, lastPassAt, reconnecting });",
	// C1-C5
	"await row('C1', () => plain(L.chipModel(view('live', T))));",
	"await row('C2', () => plain(L.chipModel(view('catching-up', T))));",
	"await row('C3', () => ({",
	"\twithTime: plain(L.chipModel(view('offline', T))),",
	"\tfullTitle: L.formatFullDateTime(T),",
	"\tnoUpdate: plain(L.chipModel(view('offline', null))),",
	"\treconnecting: plain(L.chipModel(view('offline', T, true))),",
	'}));',
	"await row('C4', () => ({",
	"\tnotLive: plain(L.chipModel(view('not-live', T))),",
	"\tunpaired: L.chipModel(view('unpaired', T, false, 'revoked')),",
	'\tnone: L.chipModel(null),',
	'}));',
	"await row('C5', () => ({",
	"\tplain: L.splitChipText('Live'),",
	"\tfirstOnly: L.splitChipText('a \\u00B7 b \\u00B7 c'),",
	"\tnoSpaces: L.splitChipText('a\\u00B7b'),",
	'}));',
	// C6
	"await row('C6', () => {",
	'\tconst S = L.stepChipDebounce;',
	"\tconst cu = view('catching-up', 1);",
	"\tconst cu2 = view('catching-up', 5);",
	"\tconst live = view('live', 5);",
	"\tconst off = view('offline', 5);",
	"\tconst offR = view('offline', 5, true);",
	"\tconst kind = (st) => (st.shown === null ? null : st.shown.kind);",
	"\tconst first = S(null, cu, 0, 'k1');",
	"\tconst sameKind = S(first.state, cu2, 10, 'k1');",
	"\tconst toLive = S(sameKind.state, live, 100, 'k1');",
	"\tconst early = S(toLive.state, live, 1099, 'k1');",
	"\tconst due = S(early.state, live, 1100, 'k1');",
	"\tconst offShown = S(null, off, 0, 'k9');",
	"\tconst reconnectFlag = S(offShown.state, offR, 5, 'k9');",
	"\tconst f1 = S(first.state, live, 0, 'k1');",
	"\tconst f2 = S(f1.state, cu, 500, 'k1');",
	"\tconst f3 = S(f2.state, live, 900, 'k1');",
	"\tconst f4 = S(f3.state, live, 1000, 'k1');",
	"\tconst newBoot = S(due.state, cu, 1200, 'k2');",
	"\tconst unpaired = S(due.state, view('unpaired', 5, false, 'removed'), 1200, 'k1');",
	"\tconst cleared = S(due.state, null, 1200, 'k1');",
	'\treturn {',
	'\t\tfirst: { kind: kind(first.state), wakeAt: first.wakeAt, bootKey: first.state.bootKey },',
	'\t\tsameKind: { same: sameKind.state.shown === cu2, wakeAt: sameKind.wakeAt },',
	'\t\ttoLive: { kind: kind(toLive.state), pending: toLive.state.pending && toLive.state.pending.kind, since: toLive.state.pendingSince, wakeAt: toLive.wakeAt },',
	'\t\tearly: { kind: kind(early.state), wakeAt: early.wakeAt },',
	'\t\tdue: { kind: kind(due.state), pending: due.state.pending, wakeAt: due.wakeAt },',
	'\t\treconnectFlag: { same: reconnectFlag.state.shown === offR, wakeAt: reconnectFlag.wakeAt },',
	'\t\tflicker: [f1, f2, f3, f4].map((s) => kind(s.state)),',
	'\t\tflickerPending: f2.state.pending,',
	'\t\tflickerWake: f3.wakeAt,',
	'\t\tnewBoot: { kind: kind(newBoot.state), bootKey: newBoot.state.bootKey, wakeAt: newBoot.wakeAt },',
	'\t\tunpaired: { kind: kind(unpaired.state), wakeAt: unpaired.wakeAt },',
	'\t\tcleared: { shown: cleared.state.shown, wakeAt: cleared.wakeAt },',
	'\t};',
	'});',
	// C7
	"const thrownOf = (fn) => { try { fn(); return null; } catch (err) { return { name: err.name, message: err.message }; } };",
	"await row('C7', () => ({",
	'\tzero: [L.formatClockTime(0, false), L.formatClockTime(0, true)],',
	'\tlate: [L.formatClockTime(T, false), L.formatClockTime(T, true)],',
	'\tfull: L.formatFullDateTime(T),',
	'\tthrows: [',
	'\t\tthrownOf(() => L.formatClockTime(NaN, false)),',
	"\t\tthrownOf(() => L.formatClockTime('12', true)),",
	'\t\tthrownOf(() => L.formatFullDateTime(Infinity)),',
	'\t\tthrownOf(() => L.formatFullDateTime(undefined)),',
	'\t],',
	'}));',
	// C8
	"await row('C8', () => {",
	"\tconst tables = new Set(['Election']);",
	'\tconst off = { version: 3, changedTables: tables, markEligible: false };',
	'\tconst on = { version: 3, changedTables: tables, markEligible: true };',
	'\tconst zero = { version: 0, changedTables: tables, markEligible: true };',
	'\tconst gated = L.panelDataVersion(on, { everLive: false, follower: false });',
	'\tconst zeroGated = L.panelDataVersion(zero, { everLive: true, follower: true });',
	'\treturn {',
	'\t\toffSame: L.panelDataVersion(off, { everLive: false, follower: false }) === off,',
	'\t\tgated: { same: gated === on, frozen: Object.isFrozen(gated), markEligible: gated.markEligible, version: gated.version, tablesSame: gated.changedTables === tables },',
	'\t\teverLiveSame: L.panelDataVersion(on, { everLive: true, follower: false }) === on,',
	'\t\tfollowerSame: L.panelDataVersion(on, { everLive: false, follower: true }) === on,',
	'\t\tzero: { same: zeroGated === zero, markEligible: zeroGated.markEligible },',
	'\t};',
	'});',
	// C9
	"await row('C9', () => ['Ana ', null, undefined, '', '   ', ' Bo B '].map((n) => L.officerLabel(n, 'user-7')));",
	// C10
	"await row('C10', async () => {",
	'\tconst DEPS = { fake: true };',
	'\tconst gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };',
	'\tconst makeWorld = () => {',
	'\t\tconst events = [];',
	'\t\tconst gates = {};',
	'\t\tconst boots = {};',
	'\t\tconst makeBoot = (hash) => {',
	"\t\t\tconst b = { networkHash: hash, db: null, failure: null, role: 'leader', stops: 0,",
	"\t\t\t\tgetStatus() { return { kind: 'catching-up', lastPassAt: null, reconnecting: false }; },",
	'\t\t\t\tsubscribeStatus() { return () => {}; }, getDataVersion() { return { version: 0, changedTables: new Set(), markEligible: false }; },',
	'\t\t\t\tsubscribeData() { return () => {}; }, async reconnect() {}, onUnpaired() { return () => {}; }, onForgotten() { return () => {}; },',
	"\t\t\t\tasync stop() { b.stops += 1; events.push('stop:' + hash); } };",
	'\t\t\tboots[hash] = b;',
	'\t\t\treturn b;',
	'\t\t};',
	'\t\tconst mod = {',
	'\t\t\tasync startDashboardBoot(opts) {',
	"\t\t\t\tevents.push('start:' + opts.networkHash + ':adopt=' + (opts.adopt === undefined ? 'none' : opts.adopt.tag) + ':deps=' + (opts.deps === DEPS));",
	'\t\t\t\tif (gates[opts.networkHash]) await gates[opts.networkHash].p;',
	'\t\t\t\treturn makeBoot(opts.networkHash);',
	'\t\t\t},',
	'\t\t\tasync switchDashboardBoot(current, opts) {',
	"\t\t\t\tevents.push('switch:' + (current ? current.networkHash : 'null') + '->' + opts.networkHash + ':adoptKey=' + ('adopt' in opts) + ':deps=' + (opts.deps === DEPS));",
	'\t\t\t\tif (current) await current.stop();',
	'\t\t\t\tif (gates[opts.networkHash]) await gates[opts.networkHash].p;',
	'\t\t\t\treturn makeBoot(opts.networkHash);',
	'\t\t\t},',
	'\t\t};',
	'\t\tconst ctl = L.createShellBootController({ loadBootModule: async () => mod, bootDeps: DEPS });',
	"\t\tctl.subscribe((b) => events.push('notify:' + (b ? b.networkHash : 'null')));",
	'\t\treturn { events, gates, boots, ctl };',
	'\t};',
	'\tconst seq = makeWorld();',
	"\tconst rA = await seq.ctl.open('A', { adopt: { tag: 'H', memberNode: 'm', strandReader: 's' } });",
	'\tconst afterA = [...seq.events];',
	"\tconst rB = await seq.ctl.open('B');",
	'\tconst afterB = seq.events.slice(afterA.length);',
	'\tconst sequence = { afterA, afterB, rA: { isA: rA.boot === seq.boots.A, stale: rA.stale, loadFailed: rA.loadFailed }, rB: { isB: rB.boot === seq.boots.B, stale: rB.stale }, current: seq.ctl.getBoot() && seq.ctl.getBoot().networkHash, aStops: seq.boots.A.stops };',
	'\tconst ov = makeWorld();',
	"\tawait ov.ctl.open('A');",
	"\tov.gates.B = gate();",
	"\tconst pB = ov.ctl.open('B');",
	"\tconst pC = ov.ctl.open('C');",
	'\tawait new Promise((r) => setTimeout(r, 5));',
	'\tov.gates.B.open();',
	'\tconst [oB, oC] = await Promise.all([pB, pC]);',
	'\tconst overlap = { bStale: oB.stale, bBoot: oB.boot, cIsC: oC.boot === ov.boots.C, cStale: oC.stale, current: ov.ctl.getBoot() && ov.ctl.getBoot().networkHash, aStops: ov.boots.A.stops, bStops: ov.boots.B.stops, cStops: ov.boots.C.stops, bShown: ov.events.includes(\'notify:B\') };',
	'\tconst st = makeWorld();',
	"\tawait st.ctl.open('D');",
	'\tconst beforeStop = st.events.length;',
	'\tawait st.ctl.stopActive();',
	'\tconst stopEvents = st.events.slice(beforeStop);',
	"\tst.gates.E = gate();",
	"\tconst pE = st.ctl.open('E');",
	'\tconst pS = st.ctl.stopActive();',
	'\tst.gates.E.open();',
	'\tconst [rE] = await Promise.all([pE, pS]);',
	"\tconst stop = { stopEvents, dStops: st.boots.D.stops, eStale: rE.stale, eBoot: rE.boot, eStops: st.boots.E.stops, eShown: st.events.includes('notify:E'), current: st.ctl.getBoot() };",
	'\tconst logs = [];',
	'\tconst realError = console.error;',
	'\tconsole.error = (...args) => { logs.push(args.map(String)); };',
	'\tlet failed;',
	'\ttry {',
	"\t\tconst ctl = L.createShellBootController({ loadBootModule: async () => { const e = new Error('detail-that-must-not-print'); e.name = 'ChunkLoadError'; throw e; } });",
	"\t\tconst r = await ctl.open('Z');",
	'\t\tfailed = { boot: r.boot, stale: r.stale, loadFailed: r.loadFailed, current: ctl.getBoot() };',
	'\t} finally {',
	'\t\tconsole.error = realError;',
	'\t}',
	'\treturn { sequence, overlap, stop, failed, logs };',
	'});',
	'process.stdout.write(JSON.stringify(rows));',
].join('\n');

const child = spawnSync(
	process.execPath,
	[
		'--experimental-strip-types',
		'--no-warnings',
		'--import',
		'data:text/javascript,' + encodeURIComponent(REGISTER),
		'--input-type=module',
		'-e',
		HARNESS,
	],
	{ cwd: dashboardRoot(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', TZ: 'UTC' } },
);

/** @type {Record<string, any>} */
let ROWS = {};
try {
	ROWS = JSON.parse(child.stdout || '{}');
} catch {
	ROWS = {};
}

/** @param {string} name @returns {any} */
function rowOf(name) {
	assert.ok(name in ROWS, `harness produced no row "${name}"`);
	const value = ROWS[name];
	if (value && typeof value === 'object' && 'thrown' in value && !Array.isArray(value)) {
		assert.fail(`harness row "${name}" threw ${value.thrown.name}: ${value.thrown.message}`);
	}
	return value;
}

/** @param {string} key @param {Record<string, string>} [params] */
function copyOf(key, params = {}) {
	assert.equal(typeof COPY[key], 'string', `COPY has no ${key}`);
	return COPY[key].replace(/\{\{(\w+)\}\}/g, (_m, name) => params[name]);
}

test('shell-live harness: the child ran the real .ts module and exited 0', () => {
	assert.equal(child.status, 0, `child exited ${child.status}; stderr:\n${child.stderr}`);
	assert.ok(Object.keys(ROWS).length > 0, `child wrote no rows; stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
});

test('C1 chipModel: a live view reads Live, titled with the last pass time, with no Reconnect and no follower note', () => {
	const m = rowOf('C1');
	assert.equal(m.kind, 'live');
	assert.equal(m.text, copyOf('status.chip.live'));
	assert.equal(m.word, m.text);
	assert.equal(m.separator, null);
	assert.equal(m.title, copyOf('status.title.live', { time: '23:59:07' }));
	assert.equal(m.showReconnect, false);
	assert.equal(m.showFollowerNote, false);
	assert.equal(m.reconnecting, false);
	assert.equal(m.frozen, true);
});

test('C2 chipModel: catching up reads Catching up with its fixed title and no Reconnect', () => {
	const m = rowOf('C2');
	assert.equal(m.text, copyOf('status.chip.catching-up'));
	assert.equal(m.title, copyOf('status.title.catching-up'));
	assert.equal(m.showReconnect, false);
	assert.equal(m.showFollowerNote, false);
});

test('C3 chipModel: offline shows the last update time (or no update yet), a full-date title, and Reconnect', () => {
	const r = rowOf('C3');
	assert.equal(r.withTime.text, copyOf('status.chip.offline', { time: '23:59' }));
	assert.equal(r.withTime.word, 'Offline');
	assert.equal(r.withTime.separator, ' · ');
	assert.equal(r.withTime.detail, 'last update 23:59');
	assert.equal(r.withTime.title, r.fullTitle);
	assert.equal(r.withTime.showReconnect, true);
	assert.equal(r.withTime.reconnecting, false);
	assert.equal(r.noUpdate.text, copyOf('status.chip.offline-no-update'));
	assert.equal(r.noUpdate.detail, 'no update yet');
	assert.equal(r.noUpdate.title, null);
	assert.equal(r.noUpdate.showReconnect, true);
	assert.equal(r.reconnecting.reconnecting, true);
	assert.equal(r.reconnecting.showReconnect, true);
});

test('C4 chipModel: not live shows the follower note and no Reconnect; unpaired and no view give no chip', () => {
	const r = rowOf('C4');
	assert.equal(r.notLive.text, copyOf('status.chip.not-live'));
	assert.equal(r.notLive.showFollowerNote, true);
	assert.equal(r.notLive.showReconnect, false);
	assert.equal(r.notLive.title, null);
	assert.equal(r.unpaired, null);
	assert.equal(r.none, null);
});

test('C5 splitChipText: no separator keeps the whole text as the word; only the first separator splits', () => {
	const r = rowOf('C5');
	assert.deepEqual(r.plain, { word: 'Live', separator: null, detail: null });
	assert.deepEqual(r.firstOnly, { word: 'a', separator: ' · ', detail: 'b · c' });
	assert.deepEqual(r.noSpaces, { word: 'a·b', separator: null, detail: null });
});

test('C6 stepChipDebounce: a kind flip shows only after 1 s held, flicker never shows, and a new boot shows at once', () => {
	const r = rowOf('C6');
	assert.deepEqual(r.first, { kind: 'catching-up', wakeAt: null, bootKey: 'k1' });
	assert.deepEqual(r.sameKind, { same: true, wakeAt: null });
	assert.deepEqual(r.toLive, { kind: 'catching-up', pending: 'live', since: 100, wakeAt: 1100 });
	assert.deepEqual(r.early, { kind: 'catching-up', wakeAt: 1100 });
	assert.deepEqual(r.due, { kind: 'live', pending: null, wakeAt: null });
	assert.deepEqual(r.reconnectFlag, { same: true, wakeAt: null });
	assert.deepEqual(r.flicker, ['catching-up', 'catching-up', 'catching-up', 'catching-up'], 'live must never show inside 1 s');
	assert.equal(r.flickerPending, null, 'returning to the shown kind clears the pending flip');
	assert.equal(r.flickerWake, 1900, 'the hold restarts after a flicker');
	assert.deepEqual(r.newBoot, { kind: 'catching-up', bootKey: 'k2', wakeAt: null }, 'no Live carry-over to a new boot');
	assert.deepEqual(r.unpaired, { kind: 'unpaired', wakeAt: null });
	assert.deepEqual(r.cleared, { shown: null, wakeAt: null });
});

test('C7 formatClockTime / formatFullDateTime: local 24-hour times, and a fixed-text TypeError on a non-finite input', () => {
	const r = rowOf('C7');
	assert.deepEqual(r.zero, ['00:00', '00:00:00']);
	assert.deepEqual(r.late, ['23:59', '23:59:07']);
	assert.ok(r.full.includes('2026'), `no year in "${r.full}"`);
	assert.ok(r.full.includes('23:59'), `no 24-hour time in "${r.full}"`);
	assert.deepEqual(r.throws, [
		{ name: 'TypeError', message: 'formatClockTime: invalid time' },
		{ name: 'TypeError', message: 'formatClockTime: invalid time' },
		{ name: 'TypeError', message: 'formatFullDateTime: invalid time' },
		{ name: 'TypeError', message: 'formatFullDateTime: invalid time' },
	]);
});

test('C8 panelDataVersion: marks stay off until this boot was live once (followers excepted) and on a local-copy load', () => {
	const r = rowOf('C8');
	assert.equal(r.offSame, true);
	assert.deepEqual(r.gated, { same: false, frozen: true, markEligible: false, version: 3, tablesSame: true });
	assert.equal(r.everLiveSame, true);
	assert.equal(r.followerSame, true);
	assert.deepEqual(r.zero, { same: false, markEligible: false });
});

test('C9 officerLabel: a trimmed name, else the user id', () => {
	assert.deepEqual(rowOf('C9'), ['Ana', 'user-7', 'user-7', 'user-7', 'user-7', 'Bo B']);
});

test('C10 boot controller: stop before start, stale opens stopped and never shown, a failed load logs only a name', () => {
	const r = rowOf('C10');
	const s = r.sequence;
	assert.deepEqual(s.afterA, ['notify:null', 'start:A:adopt=H:deps=true', 'notify:A']);
	assert.deepEqual(s.afterB, ['notify:null', 'switch:A->B:adoptKey=false:deps=true', 'stop:A', 'notify:B']);
	assert.deepEqual(s.rA, { isA: true, stale: false, loadFailed: false });
	assert.deepEqual(s.rB, { isB: true, stale: false });
	assert.equal(s.current, 'B');
	assert.equal(s.aStops, 1);
	const o = r.overlap;
	assert.equal(o.bStale, true);
	assert.equal(o.bBoot, null);
	assert.equal(o.cIsC, true);
	assert.equal(o.cStale, false);
	assert.equal(o.current, 'C');
	assert.deepEqual([o.aStops, o.bStops, o.cStops], [1, 1, 0]);
	assert.equal(o.bShown, false, 'a stale boot is never shown');
	const st = r.stop;
	assert.deepEqual(st.stopEvents, ['notify:null', 'stop:D']);
	assert.equal(st.dStops, 1);
	assert.equal(st.eStale, true);
	assert.equal(st.eBoot, null);
	assert.equal(st.eStops, 1);
	assert.equal(st.eShown, false);
	assert.equal(st.current, null);
	assert.deepEqual(r.failed, { boot: null, stale: false, loadFailed: true, current: null });
	assert.deepEqual(r.logs, [['live/shell-live:', 'ChunkLoadError']]);
});

const SHELL_LIVE_CODE = stripComments(readFileSync(dashboardSrc('live', 'shell-live.ts'), 'utf8'));
const SHELL_LIVE_BANNED = [
	/\benum\b/,
	/\bnamespace\s/,
	new RegExp('\\.\\./' + 'peer/'),
	/Date\.parse/,
	/toISOString/,
	/console\.log/,
	/setInterval/,
];

test('C11 positive control: every shell-live ban hits a synthetic fixture', () => {
	const fixture = [
		'enum K { A }',
		'namespace N {}',
		"import x from '../" + "peer/boot.js';",
		'Date.parse(s);',
		'd.toISOString();',
		'console.log(1);',
		'setInterval(f, 1);',
	].join('\n');
	for (const re of SHELL_LIVE_BANNED) assert.match(fixture, re, `${re} is inert`);
});

test('C11 shell-live.ts: no enum, namespace, peer import, date parsing, ISO text, console.log or interval; one console.error, inside logFailure', () => {
	for (const re of SHELL_LIVE_BANNED) assert.doesNotMatch(SHELL_LIVE_CODE, re);
	const errors = [...SHELL_LIVE_CODE.matchAll(/console\.error\(/g)];
	assert.ok(errors.length <= 1, `expected at most one console.error, found ${errors.length}`);
	if (errors.length === 1) {
		const body = SHELL_LIVE_CODE.slice(SHELL_LIVE_CODE.indexOf('function logFailure('));
		const end = body.indexOf('\n}');
		assert.ok(body.slice(0, end).includes('console.error('), 'the console.error sits outside logFailure');
	}
});
// --- live shell wiring scans --------------------------------------------------

const SHELL = readFileSync(dashboardSrc('screens', 'DashboardShell.tsx'), 'utf8');
const CODE = stripComments(SHELL);
const GRID_RAW = readFileSync(dashboardSrc('screens', 'PanelGrid.tsx'), 'utf8');
const GRID_CODE = stripComments(GRID_RAW);
const SHELL_CSS = readFileSync(dashboardSrc('screens', 'shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Banned names, built from fragments so this file never spells them whole. */
const SNAP = 'snap' + 'shot';
const SNAPSHOT_INSTANT = SNAP + 'Instant';

// S1 -- imports: the peer layer only through one dynamic import, and no snapshot-era module.

const STATIC_PEER_IMPORT_RE = /import\s[^;]*?from\s*['"]\.\.\/peer\//;
const DYNAMIC_BOOT_IMPORT_RE = /import\('\.\.\/peer\/boot\.js'\)/g;
const RETIRED_MODULE_IMPORT_RE = new RegExp(
	"from\\s*['\"][^'\"]*(?:fresh" + 'ness|/re' + 'fresh|officer-' + 'swap|bootstrap-transport-' + "client|\\./Boot" + "strap)(?:\\.js)?['\"]",
);
const RETIRED_TOKENS = [
	SNAP + 'Freshness',
	'sh-re' + 'fresh-cta',
	'sh-fresh' + 'ness',
	"t('" + SNAP + '.',
	"t('net" + 'work.',
	'onRedeem' + 'Another',
	'pendingSwap' + 'Context',
	'withNetworkDb' + 'LifecycleLock',
	'attach' + 'NetworkDb',
];

test('S1 control: the import matchers hit a static peer import, a type-only peer import and a retired module', () => {
	assert.match("import { startDashboardBoot } from '../peer/boot.js';", STATIC_PEER_IMPORT_RE);
	assert.match("import type { DashboardBoot } from '../peer/boot.js';", STATIC_PEER_IMPORT_RE);
	assert.doesNotMatch("const m = await import('../peer/boot.js');", STATIC_PEER_IMPORT_RE);
	assert.match("import { x } from '../lifecycle/fresh" + "ness.js';", RETIRED_MODULE_IMPORT_RE);
	assert.match("import { y } from '../lifecycle/officer-" + "swap.js';", RETIRED_MODULE_IMPORT_RE);
	assert.match("import type { Z } from './Boot" + "strap.js';", RETIRED_MODULE_IMPORT_RE);
	assert.doesNotMatch("import { forgetNetwork } from '../lifecycle/forget-network.js';", RETIRED_MODULE_IMPORT_RE);
});

test('S1 the shell has no static peer import, exactly one dynamic boot import and no snapshot-era import or name', () => {
	assert.doesNotMatch(CODE, STATIC_PEER_IMPORT_RE);
	assert.equal((CODE.match(DYNAMIC_BOOT_IMPORT_RE) ?? []).length, 1);
	assert.doesNotMatch(CODE, RETIRED_MODULE_IMPORT_RE);
	for (const token of RETIRED_TOKENS) assert.ok(!CODE.includes(token), `the shell still names ${token}`);
});

// S2 -- boot wiring.

test('S2 control: the interval matcher hits a synthetic setInterval call', () => {
	assert.match('const id = setInterval(tick, 1000);', /setInterval\(/);
});

test('S2 the shell drives one boot controller, the live hooks, both boot callbacks and Reconnect, with no interval', () => {
	assert.equal((CODE.match(/createShellBootController\(/g) ?? []).length, 1);
	for (const needle of ['useLiveStatus(', 'useBootDataVersion(', 'onUnpaired(', 'onForgotten(', '.reconnect()']) {
		assert.ok(CODE.includes(needle), `the shell is missing ${needle}`);
	}
	assert.doesNotMatch(CODE, /setInterval\(/);
});

// S3 -- the panel grid call.

/** One self-closing <PanelGrid .../> element; lazy, so an arrow prop (`=>`) does not end it early. */
const PANEL_GRID_ELEMENT_RE = /<PanelGrid\b[\s\S]*?\/>/g;
const PANEL_VERSION_MEMO_RE = /const panelVersion = useMemo\(\s*\(\) => panelDataVersion\(/;

test('S3 control: the grid matchers hit a keyed element with the memoized version and miss a raw one', () => {
	const keyed = '<PanelGrid\n\tkey={activeNetworkHash}\n\tdb={bootDb}\n\tonToggleReveal={() => setRevealDenied((value) => !value)}\n\tdataVersion={panelVersion}\n/>';
	const raw = '<PanelGrid db={db} dataVersion={useBootDataVersion(boot)} />';
	assert.equal((keyed.match(PANEL_GRID_ELEMENT_RE) ?? []).length, 1);
	assert.match(keyed.match(PANEL_GRID_ELEMENT_RE)?.[0] ?? '', /dataVersion=\{panelVersion\}/, 'an arrow prop must not end the element early');
	assert.match(keyed, /key=\{activeNetworkHash\}/);
	assert.doesNotMatch(raw, /dataVersion=\{panelVersion\}/);
	assert.match('const panelVersion = useMemo(\n\t() => panelDataVersion(v, o),', PANEL_VERSION_MEMO_RE);
	assert.doesNotMatch('const panelVersion = panelDataVersion(v, o);', PANEL_VERSION_MEMO_RE);
});

test('S3 the one PanelGrid is keyed by network hash with the memoized version, and the old instant prop is gone', () => {
	const elements = CODE.match(PANEL_GRID_ELEMENT_RE) ?? [];
	assert.equal(elements.length, 1, 'expected exactly one <PanelGrid element');
	assert.match(elements[0], /key=\{activeNetworkHash\}/);
	assert.match(elements[0], /dataVersion=\{panelVersion\}/);
	assert.match(CODE, PANEL_VERSION_MEMO_RE);
	assert.ok(!SHELL.includes(SNAPSHOT_INSTANT), 'DashboardShell.tsx names the old instant prop');
	assert.ok(!GRID_RAW.includes(SNAPSHOT_INSTANT), 'PanelGrid.tsx names the old instant prop');
	assert.doesNotMatch(GRID_RAW, new RegExp(SNAP, 'i'));
	assert.match(GRID_CODE, /DataVersionContext\.Provider value=\{dataVersion \?\? DEFAULT_DATA_VERSION\}/);
});

// S4 -- the status chip.

const CHIP_OPEN_RE = /<span\s+className="sh-status-chip"[^>]*>/;

/** Open minus closed (non-self-closing) span elements in a JSX slice. @param {string} jsx */
function spanDepth(jsx) {
	const opens = [...jsx.matchAll(/<span\b[^>]*?(\/?)>/g)].filter((m) => m[1] !== '/').length;
	const closes = (jsx.match(/<\/span>/g) ?? []).length;
	return opens - closes;
}

test('S4 control: the chip matcher reads the attributes of a synthetic chip and the role count bites', () => {
	const fixture = '<span className="sh-status-chip" data-kind={k} role="status" aria-live="polite" aria-atomic="true">';
	const open = fixture.match(CHIP_OPEN_RE);
	assert.ok(open);
	assert.match(open[0], /role="status"/);
	assert.equal(('role="status" x role="status"'.match(/role="status"/g) ?? []).length, 2);
	assert.equal(spanDepth('<span className="c" role="status"><span className="d" aria-hidden="true" /><span>w</span>'), 1);
	assert.equal(spanDepth('<span className="c"><span className="d" /><span>w</span></span>'), 0);
});

test('S4 one role=status, on the polite atomic chip; Reconnect sits after the chip, toggles its word and disables while retrying', () => {
	assert.equal((CODE.match(/role="status"/g) ?? []).length, 1);
	const open = CODE.match(CHIP_OPEN_RE);
	assert.ok(open, 'the sh-status-chip element is missing');
	for (const attr of ['role="status"', 'aria-live="polite"', 'aria-atomic="true"']) {
		assert.ok(open[0].includes(attr), `the chip lacks ${attr}`);
	}
	const chipAt = CODE.indexOf(open[0]);
	const reconnectAt = CODE.indexOf('className="sh-reconnect"');
	assert.ok(chipAt >= 0 && reconnectAt > chipAt, 'Reconnect must render after the chip');
	assert.equal(spanDepth(CODE.slice(chipAt, reconnectAt)), 0, 'Reconnect renders inside the status element');
	const button = CODE.slice(CODE.lastIndexOf('<button', reconnectAt), CODE.indexOf('</button>', reconnectAt));
	assert.match(button, /disabled=\{model\.reconnecting\}/);
	assert.match(button, /\{model\.reconnecting \? t\('status\.reconnecting'\) : t\('status\.reconnect'\)\}/);
});

// S5 -- copy keys.

/** @param {string} source @returns {string[]} the literal keys of every t('...') call */
function literalCopyKeys(source) {
	return [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
}
/** @param {string[]} keys */
function missingKeys(keys) {
	return keys.filter((key) => typeof COPY[key] !== 'string');
}

test('S5 control: the key extractor finds literal keys and a fabricated key is reported missing', () => {
	const fixture = "t('status.reconnect'); t( 'status.chip.fabricated-key', { a }); t(group.titleKey);";
	assert.deepEqual(literalCopyKeys(fixture), ['status.reconnect', 'status.chip.fabricated-key']);
	assert.deepEqual(missingKeys(literalCopyKeys(fixture)), ['status.chip.fabricated-key']);
});

test('S5 every literal copy key in the shell and in shell-live.ts exists, the live keys are used and no swap key is', () => {
	const shellKeys = literalCopyKeys(CODE);
	assert.deepEqual(missingKeys([...shellKeys, ...literalCopyKeys(SHELL_LIVE_CODE)]), []);
	for (const key of [
		'switcher.opening',
		'switcher.pairAnother',
		'switcher.rowDetail',
		'switcher.rowDetailNotSyncing',
		'status.followerNote',
		'status.chip.not-live',
		'forget.heading',
		'forget.body',
		'forget.fieldLabel',
		'forget.cta',
		'forget.failed',
		'shell.openFailed',
	]) {
		assert.ok(shellKeys.includes(key), `the shell does not use ${key}`);
	}
	assert.ok(!CODE.includes("t('swap."), 'the shell renders a swap key');
});

// S6 -- forget.

const ERROR_CLASS_RENDER_RE = /forgetError as \{ name|\.name \?\? 'error'/;

test('S6 control: the error-class matcher hits the old dialog line', () => {
	assert.match("{(forgetError as { name?: string })?.name ?? 'error'}", ERROR_CLASS_RENDER_RE);
});

test('S6 one forgetNetwork call with the typed confirmation, the exact-name rule, the re-entrancy ref and the fixed failure line', () => {
	const calls = [...CODE.matchAll(/forgetNetwork\(\{([^}]*)\}\)/g)];
	assert.equal((CODE.match(/forgetNetwork\(/g) ?? []).length, 1);
	assert.equal(calls.length, 1);
	assert.match(calls[0][1], /typedConfirmation/);
	assert.doesNotMatch(calls[0][1], /\bdb\b/, 'forget stops the boot itself; the shell passes no handle');
	assert.match(CODE, /forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/);
	assert.match(CODE, /const forgettingRef = useRef\(false\)/);
	assert.match(CODE, /if \(!activeEntry \|\| forgettingRef\.current\) return;/);
	assert.match(CODE, /<p className="sh-dialog-error">\{t\('forget\.failed'\)\}<\/p>/);
	assert.doesNotMatch(CODE, ERROR_CLASS_RENDER_RE);
});

test('S6 control: the exact-name matcher rejects the old comparison that enabled the button for an empty name', () => {
	const fixture = 'const forgetConfirmDisabled = forgetConfirmationInput.trim() !== activeNetwork.authorityName.trim();';
	assert.doesNotMatch(fixture, /forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/);
});

// S7 -- scopes (advisory gating stays).

const SCOPES_PROVIDER_RE = /<PreviewAsProvider realScopes=\{grantedScopes\} scopesResolved=\{scopesResolved\}>/;
const SCOPES_RESET_RE = /setGrantedScopes\(\[\]\);\s*\n\s*setScopesResolved\(false\);/;
const VERIFIED_ID_READ_RE = /readGrantedScopes\([^,]+,\s*(?:entry|activeEntry)\.officerUserId\)/;

test('S7 control: the scope matchers miss the single-prop provider, a lone reset and a read for another id', () => {
	assert.doesNotMatch('<PreviewAsProvider realScopes={grantedScopes}>', SCOPES_PROVIDER_RE);
	assert.doesNotMatch('setDb(null);\n\t\tsetGrantedScopes([]);\n\t\tsetAttachError(null);', SCOPES_RESET_RE);
	assert.doesNotMatch('readGrantedScopes(db, statement.userId)', VERIFIED_ID_READ_RE);
	assert.match('readGrantedScopes(db, activeEntry.officerUserId)', VERIFIED_ID_READ_RE);
});

test('S7 the provider gets the real scopes and the resolved flag, the reset re-closes it, and scopes follow the verified id', () => {
	assert.match(CODE, SCOPES_PROVIDER_RE);
	assert.match(CODE, SCOPES_RESET_RE);
	assert.match(CODE, VERIFIED_ID_READ_RE);
	assert.ok(!CODE.includes('UserEngine'), 'the shell reads the officer name from the registry, not the database');
});

// S8 -- officer names, and no swap dialog in the shell.

const SWAP_DIALOG_RE = /OfficerSwapDialog|confirmSwap|swap\./;
const OFFICER_LABEL_RE = /officerLabel\(\s*entry\.officerName,\s*entry\.officerUserId\s*\)/;

test('S8 control: the swap matcher hits a synthetic swap dialog export, and the label matcher hits the registry call', () => {
	assert.match('export function OfficerSwapDialog(props) {}', SWAP_DIALOG_RE);
	assert.match('const officerName = officerLabel(entry.officerName, entry.officerUserId);', OFFICER_LABEL_RE);
	assert.doesNotMatch('const officerName = entry.officerUserId;', OFFICER_LABEL_RE);
});

test('S8 switcher rows name the officer through officerLabel, the unpaired notice carries officerName ?? null, and no swap dialog', () => {
	assert.match(CODE, OFFICER_LABEL_RE);
	assert.match(CODE, /t\('switcher\.rowDetail', \{ domain: entry\.domain, officerName \}\)/);
	assert.match(CODE, /t\('switcher\.rowDetailNotSyncing', \{ domain: entry\.domain, officerName \}\)/);
	assert.match(CODE, /officerName: entry\?\.officerName \?\? null/);
	const unpairedCall = CODE.slice(CODE.indexOf('boot.onUnpaired('), CODE.indexOf('boot.onForgotten('));
	assert.match(unpairedCall, /onUnpairedRef\.current\(\{ reason, authorityName: captured\.authorityName, officerName: captured\.officerName \}\)/);
	assert.doesNotMatch(CODE, SWAP_DIALOG_RE);
});

test('S8 "+ Pair another network" stops the active boot before handing over', () => {
	const body = CODE.slice(CODE.indexOf('async function handlePairAnother'), CODE.indexOf('function handleReconnect'));
	const stopAt = body.indexOf('await controller.stopActive()');
	const handAt = body.indexOf('onPairAnotherRef.current()');
	assert.ok(stopAt >= 0 && handAt > stopAt, 'onPairAnother must run after the boot stopped');
});

// S9 -- shell.css.

/** @param {string} css @param {string} selector @returns {string} the declarations of the first rule with exactly this selector */
function ruleBody(css, selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = css.match(new RegExp('(?:^|\\n)\\s*' + escaped + '\\s*\\{([^}]*)\\}'));
	return m ? m[1] : '';
}

test('S9 control: the rule reader finds a declaration in a synthetic rule and misses an absent selector', () => {
	const css = '.a-x {\n\theight: 32px;\n}\n.a-y { color: red; }';
	assert.match(ruleBody(css, '.a-x'), /height: 32px/);
	assert.equal(ruleBody(css, '.a-z'), '');
	assert.match('.sh-x { color: #fff; }', /#[0-9a-fA-F]{3,6}\b/);
});

test('S9 the chip, region and Reconnect geometry, the state colours, the narrow two-line rule, and no snapshot-era selector', () => {
	const chip = ruleBody(SHELL_CSS, '.sh-status-chip');
	for (const decl of ['height: 32px', 'min-width: 88px', 'white-space: nowrap', 'border-radius: var(--radius)', 'display: inline-flex']) {
		assert.ok(chip.includes(decl), `.sh-status-chip lacks ${decl}`);
	}
	const region = ruleBody(SHELL_CSS, '.sh-status-region');
	assert.ok(region.includes('max-width: 320px') && region.includes('flex: 0 1 auto'), '.sh-status-region geometry');
	assert.ok(ruleBody(SHELL_CSS, '.sh-reconnect').includes('height: 32px'), '.sh-reconnect height');
	const states = {
		live: ['var(--ok)', 'var(--ok)'],
		'catching-up': ['var(--warn)', 'var(--warn)'],
		offline: ['var(--muted)', 'var(--border)'],
		'not-live': ['var(--muted)', 'var(--muted)'],
	};
	for (const [kind, [color, border]] of Object.entries(states)) {
		const body = ruleBody(SHELL_CSS, `.sh-status-chip[data-kind="${kind}"]`);
		assert.ok(body.includes(`color: ${color}`), `${kind} text colour`);
		assert.ok(body.includes(`border-color: ${border}`), `${kind} border colour`);
	}
	const statusRules = [...SHELL_CSS.matchAll(/([^{}]*\.sh-(?:status|reconnect|follower)[^{}]*)\{([^}]*)\}/g)];
	assert.ok(statusRules.length >= 8, 'expected the status rules');
	for (const [, , body] of statusRules) {
		assert.ok(!body.includes('var(--fail)') && !body.includes('var(--primary)'), 'a status rule uses the destructive or accent colour');
	}
	const narrowAt = SHELL_CSS.indexOf('@media (max-width: 900px)', SHELL_CSS.indexOf('.sh-status-chip'));
	assert.ok(narrowAt >= 0, 'no narrow status block');
	const narrow = SHELL_CSS.slice(narrowAt, SHELL_CSS.indexOf('\n}\n', narrowAt));
	assert.match(narrow, /\.sh-status-detail\s*\{[^}]*display: block/);
	for (const gone of ['.sh-re' + 'fresh-cta', '.sh-fresh' + 'ness', '.sh-stale-' + 'banner', '.sh-to' + 'ast']) {
		assert.ok(!SHELL_CSS.includes(gone), `shell.css still declares ${gone}`);
	}
	assert.doesNotMatch(SHELL_CSS, /#[0-9a-fA-F]{3,6}\b/);
});

// S10 -- pins kept from the old shell file.

const PANELS_DIR = dashboardSrc('screens', 'panels');
/** Every panel body, plus the shell. */
const CONSOLE_SITES = readdirSync(PANELS_DIR)
	.filter((/** @type {string} */ name) => name.endsWith('.tsx'))
	.map((/** @type {string} */ name) => ({ name, source: readFileSync(path.join(PANELS_DIR, name), 'utf8') }))
	.concat([{ name: 'DashboardShell.tsx', source: SHELL }]);

// Any bare `err.message` / `error.message` read inside a single-line
// `console.error(...)` argument list.
const RAW_MESSAGE_RE = /console\.error\([^)]*\berr(or)?\.message\b/;

test('S10 no panel and not the shell logs a raw database error MESSAGE to the console', () => {
	// Quereus and its constraint layer embed row and column values in error
	// messages; the browser console is a durable, exportable sink.
	const offenders = CONSOLE_SITES.filter((f) => RAW_MESSAGE_RE.test(stripComments(f.source))).map((f) => f.name);
	assert.deepEqual(offenders, [], `these files log a raw error message: ${offenders.join(', ')}`);
});

test('S10 control: the raw-message matcher hits the exact shape all nine panels used to carry', () => {
	const fixture = "console.error('RegistrationsPanel: a read failed:', err instanceof Error ? err.message : String(err));";
	assert.match(fixture, RAW_MESSAGE_RE, 'matcher is inert');
});

test('S10 every console.error in a panel logs the error CLASS instead -- and there are nine of them', () => {
	const withClassLogging = CONSOLE_SITES.filter((f) =>
		/console\.error\([^)]*\)\?\.name \?\? 'Error'\)/.test(stripComments(f.source)),
	);
	assert.equal(withClassLogging.length, 9, 'expected exactly the nine panel bodies to log an error class');
});

test('S10 the shell names no unreachable panel state (read-only, the half-circle glyph, writable), comments included', () => {
	const RE = new RegExp('read-' + 'only|◐|writ' + 'able', 'i');
	assert.match('a read-' + 'only panel', RE, 'matcher is inert');
	assert.doesNotMatch(SHELL, RE);
});
