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

const ATTACH_DEPS_RE =
	/\}, \[activeNetwork\?\.networkHash, activeNetwork\?\.officerUserId, activeNetwork\?\.bootstrappedAt\]\);/;

test('the attach effect depends on officerUserId and bootstrappedAt, not on networkHash alone', () => {
	// A successful officer swap replaces the registry entry's officerUserId and
	// bootstrappedAt while KEEPING the same networkHash. With a hash-only
	// dependency the effect never re-ran, so db stayed null and grantedScopes
	// stayed [] for the rest of the page's life -- while PanelGrid, whose
	// remount key DOES include both, remounted around the dead handle.
	assert.match(CODE, ATTACH_DEPS_RE);
});

test('inertness control: the dependency matcher does NOT accept the hash-only list', () => {
	assert.doesNotMatch('	}, [activeNetwork?.networkHash]);', ATTACH_DEPS_RE, 'matcher is inert');
});

test('handleConfirmSwap does not also tear the session down locally -- the re-keyed effect owns it', () => {
	const swapBody = CODE.slice(CODE.indexOf('async function handleConfirmSwap'), CODE.indexOf('function handleCancelSwap'));
	assert.ok(swapBody.length > 0, 'could not locate handleConfirmSwap');
	assert.doesNotMatch(swapBody, /setGrantedScopes\(\[\]\)/, 'two owners for one transition');
});

test('inertness control: the two-owners matcher hits a synthetic setGrantedScopes([]) fixture', () => {
	assert.match('setGrantedScopes([]);', /setGrantedScopes\(\[\]\)/, 'matcher is inert');
});

const HANDOVER_RE = /const handoverDb = dbRef\.current \?\? undefined;[\s\S]{0,600}?db: handoverDb,/;

test('handleConfirmSwap hands its open handle to performOfficerSwap BEFORE the swap runs', () => {
	// performOfficerSwap -> refreshNetwork -> redeemAndBootstrap({ replace:
	// true }) deletes this exact database, and indexedDB.deleteDatabase blocks
	// while any connection is open -- deleteNetworkDb deliberately refuses to
	// resolve on onblocked and throws DeleteBlockedError after its timeout. The
	// shell used to close its handle only AFTER the swap returned, so it raced
	// its own delete and every confirmed swap failed, burning the officer's
	// single-use code.
	assert.match(CODE, HANDOVER_RE);

	// And the handover must precede the call, not follow it. The call is now
	// reached through withNetworkDbLifecycleLock (CR-04), so this looks for
	// performOfficerSwap( itself rather than an immediately-preceding await.
	const handoverAt = CODE.indexOf('const handoverDb = dbRef.current');
	const swapCallAt = CODE.indexOf('performOfficerSwap(', handoverAt);
	assert.ok(handoverAt >= 0 && swapCallAt >= 0, 'could not locate both the handover and the swap call');
	assert.ok(handoverAt < swapCallAt, 'the handle is taken AFTER the swap call -- the delete is still racing it');
});

test('inertness control: the handover matcher does NOT accept a close-after-the-swap fixture', () => {
	const fixture = [
		'const result = await performOfficerSwap({ networkHash, pastedCode, transport });',
		'if (dbRef.current) { await closeNetworkDb(dbRef.current); dbRef.current = null; }',
	].join('\n');
	assert.doesNotMatch(fixture, HANDOVER_RE, 'matcher is inert');
});

test('every destructive call site that can hold a handle passes it: forgetNetwork and performOfficerSwap alike', () => {
	assert.match(CODE, /forgetNetwork\(\{[\s\S]{0,200}?db: dbRef\.current \?\? undefined,/);
	assert.match(CODE, /performOfficerSwap\(\{[\s\S]{0,200}?db: handoverDb,/);
});

// --- Panel console hygiene (WR-12) --------------------------------------------

const PANELS_DIR = dashboardSrc('screens', 'panels');
/** Every panel body, plus the shell -- the ten console.error call sites this app ships. */
const CONSOLE_SITES = readdirSync(PANELS_DIR)
	.filter((/** @type {string} */ name) => name.endsWith('.tsx'))
	.map((/** @type {string} */ name) => ({ name, source: readFileSync(path.join(PANELS_DIR, name), 'utf8') }))
	.concat([{ name: 'DashboardShell.tsx', source: SHELL }]);

// Widened per RF-03: the original matcher was keyed to the ternary shape
// `err instanceof Error ? err.message : ...` and missed the shape actually
// present at DashboardShell.tsx:623, `console.error(err.name, err.message)` --
// a plain two-argument call with no ternary at all. Rather than enumerate
// every call shape, this now matches ANY bare `err.message` / `error.message`
// property read appearing inside a `console.error(...)` call's argument list
// (single-line calls only, matching this matcher's existing `[^)]*` scope) --
// the ternary shape is a strict subset of this (it also contains the bare
// `err.message` token), so no case the old matcher caught is lost.
const RAW_MESSAGE_RE = /console\.error\([^)]*\berr(or)?\.message\b/;

test('no panel and not the shell logs a raw database error MESSAGE to the console', () => {
	// `err` comes from a query against tables full of registrant information,
	// and Quereus and its constraint layer routinely embed the offending row
	// and column values in an error message. The browser console is a durable,
	// exportable, screenshot-able sink.
	const offenders = CONSOLE_SITES.filter((f) => RAW_MESSAGE_RE.test(stripComments(f.source))).map((f) => f.name);
	assert.deepEqual(offenders, [], `these files log a raw error message: ${offenders.join(', ')}`);
});

test('inertness control: the raw-message matcher hits the exact shape all nine panels used to carry', () => {
	const fixture = "console.error('RegistrationsPanel: a read failed:', err instanceof Error ? err.message : String(err));";
	assert.match(fixture, RAW_MESSAGE_RE, 'matcher is inert');
});

test('every console.error in a panel logs the error CLASS instead -- and there are nine of them', () => {
	const withClassLogging = CONSOLE_SITES.filter((f) =>
		/console\.error\([^)]*\)\?\.name \?\? 'Error'\)/.test(stripComments(f.source)),
	);
	assert.equal(withClassLogging.length, 9, 'expected exactly the nine panel bodies to log an error class');
});

// --- Attach-failure banner (WR-16) ---------------------------------------------

test('the error banner is the DEFAULT for any attachError, and PanelGrid is reserved for a clean attach', () => {
	// Only two error classes used to reach a banner; every other attach failure
	// -- a corrupt row-count record, a Quereus DDL reconcile error, a quota
	// refusal, a plugin registration error -- fell through to the grid with a
	// null handle, and every panel then showed its own "No registrants yet."
	// For election infrastructure, "database broken" presented as "zero
	// registrants" is the worst available confusion.
	assert.match(CODE, /\{attachError \? \(/);
	assert.doesNotMatch(
		CODE,
		/\{attachError instanceof MissingRowCountsError \|\| attachError instanceof RowCountMismatchError \? \(\s*<div className="sh-error-banner">/,
	);
});

test('inertness control: the old two-class-only condition would be rejected by the matcher above', () => {
	const fixture = '{attachError instanceof MissingRowCountsError || attachError instanceof RowCountMismatchError ? (\n\t<div className="sh-error-banner">';
	assert.doesNotMatch(fixture, /\{attachError \? \(/, 'matcher is inert');
	assert.match(
		fixture,
		/\{attachError instanceof MissingRowCountsError \|\| attachError instanceof RowCountMismatchError \? \(\s*<div className="sh-error-banner">/,
		'the old-shape matcher is inert',
	);
});

test('an unrecognised attach failure gets its OWN copy, not the verification wording', () => {
	// "Your data failed its checksum" is a wrong answer for a database that
	// simply would not open.
	assert.match(CODE, /t\('snapshot\.errorAttachHeading'\)/);
	assert.match(CODE, /t\('snapshot\.errorAttachBody'\)/);
	assert.match(CODE, /t\('snapshot\.errorVerificationHeading'\)/);
});

// --- Forget confirmation (WR-18) -----------------------------------------------

test('the forget dialog stays disabled when there is no expected name to confirm against', () => {
	assert.match(CODE, /forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/);
});

test('inertness control: the old comparison, which enabled the button on open for an empty name, is rejected', () => {
	const fixture = 'const forgetConfirmDisabled = forgetConfirmationInput.trim() !== activeNetwork.authorityName.trim();';
	assert.doesNotMatch(
		fixture,
		/forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/,
		'matcher is inert',
	);
});

// --- Surfaced classify() failure (CR-03) ----------------------------------------

const CLASSIFY_CATCH_RE = /\} catch \(err\) \{\s*if \(!cancelled\) setSwapError\(err\);[\s\S]{0,80}?\} finally \{/;

test('classify() has a catch clause that surfaces the failure via setSwapError, positioned before the finally', () => {
	// Every throwing call inside classify() -- splitSignInCode on a malformed
	// code, transport.redeem rejecting, classifyRedemption, and a throw from
	// performOfficerSwap on the same-officer-refresh branch -- used to escape
	// as an unhandled promise rejection, leaving db === null with no banner
	// and no dialog while PanelGrid rendered nine panels each showing their
	// own empty copy.
	assert.match(CODE, CLASSIFY_CATCH_RE);
});

test('inertness control: the classify-catch matcher does NOT accept a bare try/finally with no catch', () => {
	const fixture = 'try {\n\t\t\t\t// work\n\t\t\t} finally {\n\t\t\t\tif (!cancelled) onSwapContextConsumed?.();\n\t\t\t}';
	assert.doesNotMatch(fixture, CLASSIFY_CATCH_RE, 'matcher is inert');
});

const MAIN_REGION_SWAP_ERROR_RE = /\{attachError \? \([\s\S]{0,900}?\) : swapError && !pendingSwap \? \(/;

test('the main region renders a dedicated banner for a surfaced swapError only when no swap dialog is pending', () => {
	// A classification failure must never be represented by nine panels each
	// showing their own empty copy -- an officer whose database failed must
	// never be told their authority has no registrants. The banner only
	// applies when no swap dialog is open: a confirmed-swap failure belongs
	// in the dialog the officer is already looking at.
	assert.match(CODE, MAIN_REGION_SWAP_ERROR_RE);
});

test('inertness control: the main-region matcher does NOT accept the old attachError-or-grid-only shape', () => {
	const fixture =
		'{attachError ? (\n\t\t\t\t\t\t<div className="sh-error-banner">\n\t\t\t\t\t\t\tstuff\n\t\t\t\t\t\t</div>\n\t\t\t\t\t) : (\n\t\t\t\t\t\t<PanelGrid';
	assert.doesNotMatch(fixture, MAIN_REGION_SWAP_ERROR_RE, 'matcher is inert');
});

test('the surfaced swap-error banner renders through t() with the two new copy keys', () => {
	assert.match(CODE, /t\('network\.swapErrorHeading'\)/);
	assert.match(CODE, /t\('network\.swapErrorBody'\)/);
});

// --- Handed-off transport cache ownership (D-14 continuity, 50-22) -------------

const RESET_CALL_RE = /\.reset\(\)/g;

test('the handed-off single-flight cache is reset on at least 7 terminal call sites', () => {
	// handleCancelSwap (unchanged) + the classify catch clause + the
	// fail-closed replay branch + officer-indeterminate + new-network + BOTH
	// routes of same-officer-refresh + all three terminal routes of
	// handleConfirmSwap. The one path that must NOT reset is 'officer-swap'
	// -- the confirm dialog still needs the cached envelope.
	const matches = CODE.match(RESET_CALL_RE) ?? [];
	assert.ok(matches.length >= 7, `expected at least 7 .reset() call sites, found ${matches.length}`);
});

const OFFICER_SWAP_CASE_RE = /case 'officer-swap':[\s\S]*?break;/;

test("the officer-swap case body resets nothing -- the confirm dialog still needs the cached envelope", () => {
	const match = CODE.match(OFFICER_SWAP_CASE_RE);
	assert.ok(match, 'could not locate the officer-swap case');
	assert.doesNotMatch(match[0], /\.reset\(\)/);
});

test('inertness control: the officer-swap-no-reset matcher DOES flag a fixture with a reset call inside that case', () => {
	const fixture = "case 'officer-swap':\n\tsetPendingSwap({ networkHash });\n\tswapContext.transport.reset();\n\tbreak;";
	const match = fixture.match(OFFICER_SWAP_CASE_RE);
	assert.ok(match);
	assert.match(match[0], /\.reset\(\)/, 'matcher is inert -- it correctly flags the misplaced reset');
});

const CLASSIFY_FINALLY_RE = /\} finally \{\s*if \(!cancelled\) onSwapContextConsumed\?\.\(\);\s*\}/;

test("classify()'s finally block contains no reset call -- officer-swap falls through the SAME finally and must keep its cache", () => {
	assert.match(CODE, CLASSIFY_FINALLY_RE);
});

test('inertness control: the finally-no-reset matcher rejects a fixture where reset was moved into finally (which would break the confirm path)', () => {
	const fixture =
		'} finally {\n\t\t\t\tswapContext.transport.reset();\n\t\t\t\tif (!cancelled) onSwapContextConsumed?.();\n\t\t\t}';
	assert.doesNotMatch(fixture, CLASSIFY_FINALLY_RE, 'matcher is inert');
});

// --- Every destructive db path queued onto the per-network lock (CR-04) --------

const FORGET_INSIDE_LOCK_RE = /withNetworkDbLifecycleLock\([^,]+,\s*\(\) =>\s*forgetNetwork\(/;

test('forgetNetwork is called only from inside withNetworkDbLifecycleLock', () => {
	// CR-04: withNetworkDbLifecycleLock serialized exactly attachNetworkDb and
	// closeNetworkDb. It did NOT wrap handleConfirmForget -> forgetNetwork ->
	// deleteNetworkDbSettled -> indexedDB.deleteDatabase, one of the two most
	// destructive open/close operations in the app against the same
	// networkHash.
	assert.match(CODE, FORGET_INSIDE_LOCK_RE);
	const forgetCallCount = (CODE.match(/forgetNetwork\(/g) ?? []).length;
	assert.equal(forgetCallCount, 1, 'expected exactly one forgetNetwork( call site');
});

test('inertness control: the forget-lock matcher rejects a bare (unwrapped) forgetNetwork call', () => {
	const fixture = 'const result = await forgetNetwork({ networkHash, typedConfirmation, db });';
	assert.doesNotMatch(fixture, FORGET_INSIDE_LOCK_RE, 'matcher is inert');
});

const PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE = /withNetworkDbLifecycleLock\([^,]+,\s*\(\) =>\s*performOfficerSwap\(/g;

test('both performOfficerSwap call sites are wrapped in withNetworkDbLifecycleLock, and there are exactly two', () => {
	// CR-04: neither the handleConfirmSwap call site nor the classify
	// effect's same-officer-refresh call site was queued onto the lock that
	// already serializes attach and close for the same networkHash.
	const wrapped = CODE.match(PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE) ?? [];
	assert.equal(wrapped.length, 2, `expected exactly 2 wrapped performOfficerSwap call sites, found ${wrapped.length}`);
	const totalCallSites = (CODE.match(/performOfficerSwap\(/g) ?? []).length;
	assert.equal(totalCallSites, 2, `expected exactly 2 performOfficerSwap( call sites total, found ${totalCallSites}`);
});

test('inertness control: the performOfficerSwap-lock matcher rejects a bare (unwrapped) call', () => {
	const fixture = 'const result = await performOfficerSwap({ networkHash, pastedCode, transport, db });';
	assert.doesNotMatch(fixture, PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE, 'matcher is inert');
});

// --- scopesResolved: closing the attach-window on first attach AND every re-attach (D-18, 50-23) ---

const SCOPES_RESOLVED_PROVIDER_RE = /<PreviewAsProvider realScopes=\{grantedScopes\} scopesResolved=\{scopesResolved\}>/;

test('DashboardShell passes scopesResolved to PreviewAsProvider alongside realScopes', () => {
	// PreviewAsProviderProps.scopesResolved is a REQUIRED prop (50-23 Task 1)
	// -- a mount site that omits it fails typecheck, not just this matcher.
	assert.match(CODE, SCOPES_RESOLVED_PROVIDER_RE);
});

test('inertness control: the provider-prop matcher does NOT accept the old single-prop opening tag', () => {
	const fixture = '<PreviewAsProvider realScopes={grantedScopes}>';
	assert.doesNotMatch(fixture, SCOPES_RESOLVED_PROVIDER_RE, 'matcher is inert');
});

const SCOPES_RESOLVED_RESET_RE = /setGrantedScopes\(\[\]\);\s*\n\s*setScopesResolved\(false\);/;

test("the attach effect's reset block sets scopesResolved false immediately after clearing grantedScopes -- a re-attach genuinely re-closes the window", () => {
	// Co-located with setGrantedScopes([]) rather than the effect's own
	// `setDb(null);` line above it, so the assertion is anchored to the
	// SAME reset block a network switch, an officer swap, or a refresh all
	// run through -- not merely present somewhere in the file.
	assert.match(CODE, SCOPES_RESOLVED_RESET_RE);
});

test('inertness control: the reset-block matcher does NOT accept a fixture where only setGrantedScopes([]) appears', () => {
	const fixture = 'setDb(null);\n\t\tsetGrantedScopes([]);\n\t\tsetAttachError(null);';
	assert.doesNotMatch(fixture, SCOPES_RESOLVED_RESET_RE, 'matcher is inert');
});
