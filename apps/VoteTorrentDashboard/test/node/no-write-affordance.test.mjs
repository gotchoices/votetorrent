/**
 * no-write-affordance.test.mjs -- the dashboard is read-only, permanently (D-10, D-11).
 *
 * THE POSTURE. A paired browser is a cadre MEMBER device: it replicates the
 * officer's strand and reads it, but it holds no officer key and cannot sign as
 * the officer. So the dashboard offers no write path at all -- no VoteTorrent
 * write or signing call, no cadre owner or membership write, no officer-shaped
 * control on a panel, and no pointer cursor that would make a data pill look
 * clickable. Anything an officer must act on carries the read-only action note
 * instead, on exactly the three panels that list pending items (D-11).
 *
 * WHAT THIS FILE PROVES, each as set equality over the real tree:
 *   W1  no `src/` file calls a VoteTorrent write/signing API or a cadre owner or
 *       membership write API (call position, comment-stripped);
 *   W2  the user engine is constructed in exactly one file, and there it is used
 *       for the privilege check only;
 *   W3  the panel surface has no control except the two named view-state
 *       toggles (the chart/grid switch and the denied-panel reveal toggle);
 *   W4  the only panel CSS selector with a pointer cursor is the view switch,
 *       and the base data pill rule declares the default cursor;
 *   W5  the action note renders in exactly Registrations, Ballots/Questions and
 *       Invite authorities, each importing it by the exact single-line form.
 *
 * ANTI-SELF-TRIP DISCIPLINE (a checker whose own text holds its pattern is
 * permanently green on itself):
 *   1. Every scan root is under the dashboard's `src/`, so this file, which
 *      lives under `test/`, can never scan itself.
 *   2. Every banned identifier is assembled from fragments at runtime; this
 *      file never spells one as a contiguous literal.
 *   3. Comments are stripped before matching, so prose that discusses an API
 *      in a header never counts as a call.
 *   4. Each matcher is proved on a synthetic fixture BEFORE the real scan runs,
 *      and every real assertion is set equality, never a bare `=== 0` count, so
 *      a scan that silently read nothing fails loudly.
 *
 * Admission calls (joining the cadre, redeeming the one invitation, adding the
 * officer's strand, trusting the owner keys) are the member device's own D-01
 * path, not an officer write, and are deliberately not listed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { scannedFilesFor, stripComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';
import { stripCssComments } from '../../../../scripts/lib/css-class-coverage.mjs';
import { COPY } from '@votetorrent/ui-web';

/** Join fragments into one identifier, so no banned name is spelled in this file. @param {...string} parts */
const w = (...parts) => parts.join('');

/** Repo-relative-to-the-dashboard path with forward slashes. @param {string} abs */
const rel = (abs) => path.relative(dashboardRoot(), abs).split(path.sep).join('/');

/** Every code file under the dashboard's `src/` (the shared library skips `dist` and fails on unknown extensions). */
const SRC_FILES = scannedFilesFor({ roots: [dashboardSrc()] });

/** Comment-stripped source by absolute path, read once. @type {Map<string, string>} */
const STRIPPED = new Map(SRC_FILES.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

// ---------------------------------------------------------------------------
// Reachability: the scan actually covers the dashboard, entry to peer layer.
// ---------------------------------------------------------------------------

test('reachability: the src/ scan covers at least 40 code files, including the entry, the peer boot, the shell and the privilege check', () => {
	assert.ok(SRC_FILES.length >= 40, `expected at least 40 code files under src/, found ${SRC_FILES.length}`);
	const names = new Set(SRC_FILES.map(rel));
	for (const required of ['src/main.tsx', 'src/peer/boot.js', 'src/screens/DashboardShell.tsx', 'src/auth/is-privileged.js']) {
		assert.ok(names.has(required), `the scan does not reach ${required}`);
	}
});

// ---------------------------------------------------------------------------
// W1: no write or signing API in call position.
// ---------------------------------------------------------------------------

/** VoteTorrent writes and signing. */
const VOTETORRENT_WRITE_NAMES = Object.freeze([
	w('revoke', 'Dashboard', 'Pairing'),
	w('request', 'Pair', 'Mint'),
	w('attach', 'Pair', 'Mint'),
	w('create', 'Pair', 'Mint', 'Service'),
	w('encode', 'Pairing', 'Code'),
	w('pairing', 'Statement', 'Digest'),
	w('pairing', 'Remove', 'Digest'),
	w('pairing', 'Revoke', 'Digest'),
	w('create', 'Device', 'Signer'),
	w('get', 'Revoke', 'Key', 'Digest'),
	w('revoke', 'Key'),
	w('add', 'Key'),
	w('connect', 'Device'),
]);

/** Cadre owner and membership writes. */
const CADRE_WRITE_NAMES = Object.freeze([
	w('create', 'Cadre', 'Invitation'),
	w('create', 'Open', 'Invitation'),
	w('create', 'Owner', 'Grant'),
	w('add', 'Owner'),
	w('remove', 'Owner'),
	w('remove', 'Machine'),
	w('remove', 'Peer'),
	w('withdraw', 'Cadre', 'Invitation'),
	w('withdraw', 'Owner', 'Grant'),
	w('authorize', 'Peer'),
	w('grant', 'Delegate', 'Admission'),
	w('form', 'Strand'),
	w('found', 'Strand'),
	w('publish', 'Strand'),
	w('enroll', 'Validation', 'Key'),
	w('remove', 'Validation', 'Key'),
]);

const WRITE_NAMES = Object.freeze([...VOTETORRENT_WRITE_NAMES, ...CADRE_WRITE_NAMES]);

/** Call position: the bare name followed by an opening parenthesis. */
const WRITE_CALL_RE = new RegExp(`\\b(${WRITE_NAMES.join('|')})\\s*\\(`);

test('W1 control: every banned name is caught in call position on a synthetic line', () => {
	assert.equal(WRITE_NAMES.length, 29);
	for (const name of WRITE_NAMES) {
		assert.match(stripComments(`await x.${name}(args);`), WRITE_CALL_RE, `the matcher misses ${name}`);
	}
	assert.doesNotMatch(stripComments('const value = holder.readOnlyValue;'), WRITE_CALL_RE);
});

test('W1 control: a // comment naming a banned call is stripped and does not hit', () => {
	const name = CADRE_WRITE_NAMES[5];
	const fixture = `// the owner phone calls ${name}(peer) on its own side\nconst keep = 1;`;
	assert.match(fixture, WRITE_CALL_RE, 'the raw fixture must hit, or this control proves nothing');
	assert.doesNotMatch(stripComments(fixture), WRITE_CALL_RE);
});

test('W1 (D-10): no dashboard src/ file calls a VoteTorrent write or signing API or a cadre owner or membership write API', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const [file, code] of STRIPPED) {
		const hit = code.match(WRITE_CALL_RE);
		if (hit) offenders.push(`${rel(file)}: ${hit[1]}`);
	}
	assert.deepEqual(offenders, [], `write affordance found: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// W2: the user engine is confined to the privilege check.
// ---------------------------------------------------------------------------

const ENGINE_CLASS = w('User', 'Engine');
const ENGINE_NEW_RE = new RegExp(`\\bnew\\s+${ENGINE_CLASS}\\s*\\(`);
const ENGINE_CALL_RE = /\bengine\.(\w+)\(/g;
const PRIVILEGE_METHOD = w('is', 'Privileged');

/** Method names called on `engine.` in a source. @param {string} code */
const engineCalls = (code) => [...code.matchAll(ENGINE_CALL_RE)].map((m) => m[1]);

test('W2 control: a fixture that calls a revising method on the engine is flagged', () => {
	const fixture = `const engine = new ${ENGINE_CLASS}(user, { db });\nawait engine.${PRIVILEGE_METHOD}(scope, id);\nawait engine.revise(user);`;
	assert.match(fixture, ENGINE_NEW_RE);
	assert.deepEqual(engineCalls(fixture).filter((m) => m !== PRIVILEGE_METHOD), ['revise']);
});

test('W2 (D-10): the user engine is constructed only in src/auth/is-privileged.js, and only for the privilege check', () => {
	const constructing = SRC_FILES.filter((f) => ENGINE_NEW_RE.test(/** @type {string} */ (STRIPPED.get(f)))).map(rel);
	assert.deepEqual(constructing, ['src/auth/is-privileged.js']);
	const calls = engineCalls(/** @type {string} */ (STRIPPED.get(dashboardSrc('auth', 'is-privileged.js'))));
	assert.ok(calls.length >= 1, 'expected at least one engine call in is-privileged.js');
	assert.deepEqual([...new Set(calls)], [PRIVILEGE_METHOD]);
});

// ---------------------------------------------------------------------------
// W3: the panel surface has no officer-shaped control.
// ---------------------------------------------------------------------------

const CONTROL_TOKENS = Object.freeze([
	'<button',
	'<a ',
	'<a>',
	'<form',
	'<input',
	'<select',
	'<textarea',
	'onClick',
	'onSubmit',
	'onChange',
	'href=',
	'role="button"',
	'role="link"',
	'tabIndex',
	'contentEditable',
]);

/** @param {string} code */
const controlTokensIn = (code) => CONTROL_TOKENS.filter((tok) => code.includes(tok));

/** Every `<button ... </button>` segment of a source. @param {string} code */
function buttonSegments(code) {
	/** @type {string[]} */
	const out = [];
	let at = code.indexOf('<button');
	while (at >= 0) {
		const end = code.indexOf('</button>', at);
		out.push(code.slice(at, end < 0 ? code.length : end + '</button>'.length));
		at = code.indexOf('<button', at + 1);
	}
	return out;
}

/** The panel surface: every panel component, the grid that frames them, and the action note. */
const PANEL_SURFACE = Object.freeze(
	[
		...SRC_FILES.filter((f) => rel(f).startsWith('src/screens/panels/') && f.endsWith('.tsx')),
		dashboardSrc('screens', 'PanelGrid.tsx'),
		dashboardSrc('live', 'ReadOnlyNote.tsx'),
	].sort(),
);

test('W3 control: a panel-shaped fixture with an approve button is flagged, and a commented-out button is not', () => {
	const flagged = stripComments('export function Panel() {\n\treturn <div className="eo-row"><button onClick={approve}>Approve</button></div>;\n}');
	assert.deepEqual(controlTokensIn(flagged), ['<button', 'onClick']);
	const commented = stripComments('// a <button onClick={approve}> once lived here\nexport const Panel = () => <p>Read only</p>;');
	assert.deepEqual(controlTokensIn(commented), []);
});

test('W3 control: the button-segment reader returns one segment per button, each running to its own closing tag', () => {
	const segs = buttonSegments('<div><button className="one">A</button><span /><button className="two">B</button></div>');
	assert.deepEqual(segs, ['<button className="one">A</button>', '<button className="two">B</button>']);
});

test('W3 (D-10): the panel surface has no control except the chart/grid view switch and the denied-panel reveal toggle', () => {
	assert.ok(PANEL_SURFACE.length >= 12, `the panel surface is too small to be real: ${PANEL_SURFACE.length}`);
	/** @type {Map<string, string>} */
	const code = new Map(PANEL_SURFACE.map((f) => [rel(f), stripComments(readFileSync(f, 'utf8'))]));
	const withControls = [...code.entries()].filter(([, src]) => controlTokensIn(src).length > 0).map(([name]) => name);
	assert.deepEqual(withControls, ['src/screens/PanelGrid.tsx', 'src/screens/panels/PanelFrame.tsx']);

	const frame = buttonSegments(/** @type {string} */ (code.get('src/screens/panels/PanelFrame.tsx')));
	assert.equal(frame.length, 2, 'PanelFrame.tsx must hold exactly the two view-switch buttons');
	for (const seg of frame) assert.ok(seg.includes('panel-view-switch__option'), 'a PanelFrame button is not a view-switch option');

	const grid = buttonSegments(/** @type {string} */ (code.get('src/screens/PanelGrid.tsx')));
	assert.equal(grid.length, 1, 'PanelGrid.tsx must hold exactly the reveal toggle');
	assert.ok(grid[0].includes('sh-reveal-toggle'), 'the PanelGrid button is not the reveal toggle');

	for (const name of ['src/screens/PanelGrid.tsx', 'src/screens/panels/PanelFrame.tsx']) {
		const src = /** @type {string} */ (code.get(name));
		for (const tok of ['type="submit"', '<form', '<input', 'href=']) {
			assert.ok(!src.includes(tok), `${name} carries ${tok}`);
		}
	}
});

// ---------------------------------------------------------------------------
// W4: no pointer cursor except the view switch.
// ---------------------------------------------------------------------------

/** Innermost CSS rules of a comment-stripped source. @param {string} css */
function cssRules(css) {
	return [...stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** @param {string} css */
const pointerSelectors = (css) =>
	cssRules(css)
		.filter((r) => /cursor:\s*pointer/.test(r.body))
		.map((r) => r.selector);

test('W4 control: a hover rule with a pointer cursor is found by its selector', () => {
	assert.deepEqual(pointerSelectors('.aa-row { color: red; }\n.aa-row:hover { cursor: pointer; }'), ['.aa-row:hover']);
});

test('W4 control: a pointer rule nested inside @media is still found, and a commented one is not', () => {
	const css = '@media (min-width: 40rem) {\n\t.eo-card { cursor: pointer; }\n}\n/* .ghost { cursor: pointer; } */';
	assert.deepEqual(pointerSelectors(css), ['.eo-card']);
});

test('W4 (D-10/D-11): the only panel CSS selector with a pointer cursor is the view switch, and the data pill declares the default cursor', () => {
	const cssFiles = [dashboardSrc('screens', 'panels', 'panels.css'), dashboardSrc('screens', 'panels', 'election-ops.css'), dashboardSrc('screens', 'panels', 'authority-admin.css')];
	/** @type {string[]} */
	const pointers = [];
	for (const file of cssFiles) pointers.push(...pointerSelectors(readFileSync(file, 'utf8')));
	assert.deepEqual(pointers.sort(), ['.panel-view-switch__option']);

	const pill = cssRules(readFileSync(cssFiles[0], 'utf8')).filter((r) => r.selector === '.pill');
	assert.equal(pill.length, 1, 'expected exactly one base .pill rule in panels.css');
	assert.match(pill[0].body, /cursor:\s*default/);
});

// ---------------------------------------------------------------------------
// W5: the action note sits on exactly the three panels with pending items.
// ---------------------------------------------------------------------------

const NOTE_IMPORT_LINE = "import { ReadOnlyNote } from '../../live/ReadOnlyNote.js';";
const NOTE_RENDER_RE = /<ReadOnlyNote\b/;

test('W5 control: the render matcher finds a rendered note and ignores one named only in a comment', () => {
	assert.match(stripComments('{count > 0 ? <ReadOnlyNote variant="short" /> : null}'), NOTE_RENDER_RE);
	assert.doesNotMatch(stripComments('// <ReadOnlyNote variant="short" /> belongs on the pending list\nconst keep = 1;'), NOTE_RENDER_RE);
});

test('W5 (D-11): the action note renders in exactly Registrations, Ballots/Questions and Invite authorities, each importing it by the exact single-line form', () => {
	const panelFiles = SRC_FILES.filter((f) => rel(f).startsWith('src/screens/panels/') && f.endsWith('.tsx'));
	const rendering = panelFiles.filter((f) => NOTE_RENDER_RE.test(/** @type {string} */ (STRIPPED.get(f)))).map((f) => path.basename(f));
	assert.deepEqual(rendering.sort(), ['BallotsQuestionsPanel.tsx', 'InviteAuthoritiesPanel.tsx', 'RegistrationsPanel.tsx']);
	for (const name of rendering) {
		const lines = readFileSync(dashboardSrc('screens', 'panels', name), 'utf8').split('\n');
		assert.equal(lines.filter((l) => l.trim() === NOTE_IMPORT_LINE).length, 1, `${name} must import the note by the exact single-line form`);
	}
	assert.equal(COPY['panel.readOnly.short'], 'Taken in the Authority app.');
	assert.ok(typeof COPY['panel.readOnly.long'] === 'string' && COPY['panel.readOnly.long'].length > 0);
});
