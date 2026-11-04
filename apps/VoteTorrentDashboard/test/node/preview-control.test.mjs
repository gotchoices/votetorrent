/**
 * preview-control.test.mjs — source-level assertions over the "Preview as"
 * control, its provider, `GrantedScopesContext.ts`, `preview-as.css`, and
 * the bounded wiring into 50-09's `DashboardShell.tsx` / `PanelGrid.tsx`.
 * The advisory disclosure component itself moved to packages/ui-web in
 * 53-05 (D-01/D-02/D-07) -- its own source assertions moved with it into
 * packages/ui-web/test/shared-components.test.mjs; what remains here is the
 * dashboard's own wiring guarantee that its shell mounts it with an
 * explicit voice. `node --test` cannot import `.tsx`, so this suite reads
 * each file as TEXT and strips `//` / `/* *\/`-style comment lines where a
 * behavior item says "comment-stripped" — the same shape
 * `test/node/registry.test.mjs` (50-06) and
 * `authority-admin-panels.test.mjs` (50-11) both already established.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardRoot, dashboardSrc, uiWebSrc, webDataSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const APP_ROOT = dashboardRoot();
const SCREENS_DIR = dashboardSrc('screens');

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

/** The five files this suite reads — the three of this plan's own files that remain in the dashboard, plus the two 50-09 files this plan's bounded edit touches. `AdvisoryDisclosure.tsx` moved to packages/ui-web in 53-05 (D-01/D-02/D-07); its source assertions moved with it into packages/ui-web/test/shared-components.test.mjs. @type {Record<string, string>} */
const FILES = {
	context: 'GrantedScopesContext.ts',
	control: 'PreviewAsControl.tsx',
	css: 'preview-as.css',
	shell: 'DashboardShell.tsx',
	grid: 'PanelGrid.tsx',
};

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const [key, file] of Object.entries(FILES)) {
	RAW[key] = readFileSync(path.join(SCREENS_DIR, file), 'utf8');
	STRIPPED[key] = stripComments(RAW[key]);
}

// --- GrantedScopesContext.ts -------------------------------------------------

test('GrantedScopesContext.ts creates a context with an empty-array default and exports both hooks', () => {
	assert.match(STRIPPED.context, /createContext/);
	assert.match(STRIPPED.context, /effective:\s*Object\.freeze\(\[\]\)/);
	assert.match(STRIPPED.context, /export function useEffectiveScopes/);
	assert.match(STRIPPED.context, /export function usePreview/);
});

test('positive control: the default-effective matcher hits a synthetic fixture', () => {
	const fixture = 'effective: Object.freeze([])';
	assert.match(fixture, /effective:\s*Object\.freeze\(\[\]\)/, 'matcher is inert');
});

// --- scopesResolved: closing the attach-window click gap (D-18, 50-23) ---------

test('GrantedScopesContext.ts DEFAULT_VALUE sets scopesResolved to false -- fail-safe outside a provider', () => {
	assert.match(STRIPPED.context, /scopesResolved:\s*false/);
});

test('positive control: the DEFAULT_VALUE scopesResolved matcher does NOT accept a permissive true default', () => {
	const fixture = 'scopesResolved: true,';
	assert.doesNotMatch(fixture, /scopesResolved:\s*false/, 'matcher is inert');
});

// --- PreviewAsControl.tsx -----------------------------------------------------

test('PreviewAsControl renders a fieldset legended "preview.title" and drives its rows from CAPABILITIES.map', () => {
	assert.match(STRIPPED.control, /<fieldset/);
	assert.match(STRIPPED.control, /t\('preview\.title'\)/);
	assert.match(STRIPPED.control, /CAPABILITIES\.map/);
});

test('each row carries type="checkbox", a capability.titleKey label, and a pv-scope chip with the schemaName tooltip', () => {
	assert.match(RAW.control, /type="checkbox"/);
	assert.match(STRIPPED.control, /t\(capability\.titleKey\)/);
	assert.match(STRIPPED.control, /className="pv-scope"/);
	assert.match(STRIPPED.control, /title=\{capability\.schemaName\}/);
});

test('both badge copy keys are present in source, backing the rendered t() call', () => {
	assert.ok((RAW.control.match(/gate\.badgeSimulated/g) ?? []).length >= 1, 'gate.badgeSimulated not found');
	assert.ok((RAW.control.match(/gate\.badgeReal/g) ?? []).length >= 1, 'gate.badgeReal not found');
});

test('the reset button renders t(\'gate.resetScopesCta\')', () => {
	assert.match(STRIPPED.control, /t\('gate\.resetScopesCta'\)/);
});

test('PreviewAsControl.tsx contains no literal binding copy string -- every string arrives through t()', () => {
	const BANNED = /answered by the database|simulated scope set|Preview as|Reset to my scopes/;
	assert.doesNotMatch(STRIPPED.control, BANNED);
});

test('positive control: the literal-copy matcher hits a synthetic hardcoded fixture', () => {
	assert.match('const x = "simulated scope set";', /answered by the database|simulated scope set|Preview as|Reset to my scopes/, 'matcher is inert');
});

test('PreviewAsControl.tsx imports nothing from ../auth/gate.js -- it decides no visibility', () => {
	assert.equal((STRIPPED.control.match(/from ['"]\.\.\/auth\/gate\.js['"]/g) ?? []).length, 0);
});

test('PreviewAsControl.tsx imports toggleScope, resetToReal, resyncRealScopes and badgeKey from ../auth/preview-scopes.js', () => {
	assert.match(STRIPPED.control, /from ['"]\.\.\/auth\/preview-scopes\.js['"]/);
	assert.match(STRIPPED.control, /\btoggleScope\b/);
	assert.match(STRIPPED.control, /\bresetToReal\b/);
	assert.match(STRIPPED.control, /\bresyncRealScopes\b/);
	assert.match(STRIPPED.control, /\bbadgeKey\b/);
});

// --- scopesResolved: the attach-window inputs stay inert until resolved --------

const CHECKBOX_DISABLED_RE = /type="checkbox"[\s\S]{0,150}?disabled=\{!scopesResolved\}/;

test('each checkbox input renders disabled={!scopesResolved}', () => {
	assert.match(STRIPPED.control, CHECKBOX_DISABLED_RE);
});

test('inertness control: the checkbox-disabled matcher does NOT accept the pre-fix element (no disabled attribute)', () => {
	const fixture = [
		'<input',
		'	id={`pv-scope-${capability.id}`}',
		'	type="checkbox"',
		'	checked={effective.includes(capability.scope)}',
		'	onChange={() => toggle(capability.scope)}',
		'/>',
	].join('\n');
	assert.doesNotMatch(fixture, CHECKBOX_DISABLED_RE, 'matcher is inert');
});

const RESET_DISABLED_RE = /className="pv-reset"[\s\S]{0,120}?disabled=\{!scopesResolved\}/;

test('the reset button renders disabled={!scopesResolved}', () => {
	assert.match(STRIPPED.control, RESET_DISABLED_RE);
});

test('inertness control: the reset-disabled matcher does NOT accept the pre-fix button (no disabled attribute)', () => {
	const fixture = '<button type="button" className="pv-reset" onClick={reset}>';
	assert.doesNotMatch(fixture, RESET_DISABLED_RE, 'matcher is inert');
});

test('PreviewAsProviderProps declares scopesResolved: boolean as a REQUIRED member', () => {
	// Required (no `?`) so TypeScript forces every mount site to make an
	// explicit decision instead of silently inheriting a permissive default.
	assert.match(STRIPPED.control, /scopesResolved:\s*boolean;/);
	assert.doesNotMatch(STRIPPED.control, /scopesResolved\?:\s*boolean/);
});

test('inertness control: the required-prop matcher does NOT accept an optional declaration', () => {
	const fixture = 'scopesResolved?: boolean;';
	assert.doesNotMatch(fixture, /scopesResolved:\s*boolean;/, 'matcher is inert');
});

test('the provider destructures scopesResolved from its props and carries it unchanged onto the context value', () => {
	assert.match(STRIPPED.control, /function PreviewAsProvider\(\{\s*realScopes,\s*scopesResolved,\s*children\s*\}/);
	assert.match(STRIPPED.control, /scopesResolved,\s*\n\s*\}\),\s*\n\s*\[state,\s*scopesResolved\]/);
});

test('inertness control: the context-value matcher does NOT accept a memo whose deps omit scopesResolved', () => {
	const fixture = '\t\t}),\n\t\t[state],\n\t);';
	assert.doesNotMatch(fixture, /scopesResolved,\s*\n\s*\}\),\s*\n\s*\[state,\s*scopesResolved\]/, 'matcher is inert');
});

// --- AdvisoryDisclosure.tsx ------------------------------------------------
//
// `AdvisoryDisclosure.tsx` itself moved to packages/ui-web in 53-05
// (D-01/D-02/D-07) -- its own no-branch/no-fallback source assertions moved
// with it into packages/ui-web/test/shared-components.test.mjs. What stays
// here is the dashboard's OWN wiring guarantee: that its production shell
// mounts the component with an explicit voice, never a bare zero-prop tag.

// --- Wiring: the bounded shell edit --------------------------------------------

test('PanelGrid.tsx calls useEffectiveScopes() and still imports evaluate from ../auth/gate.js exactly once', () => {
	assert.match(STRIPPED.grid, /useEffectiveScopes/);
	assert.equal((STRIPPED.grid.match(/from ['"]\.\.\/auth\/gate\.js['"]/g) ?? []).length, 1);
});

test('PreviewAsProvider re-seeds from realScopes in an effect via resyncRealScopes, not only in the useState initializer', () => {
	// The defect this pins: `useState(() => createPreviewState(realScopes))`
	// alone runs on the FIRST render only, and `DashboardShell` supplies `[]`
	// there because the officer's scopes are read asynchronously. Without a
	// re-seed the provider froze an empty set and every capability evaluated
	// as denied. The re-seed DECISION (including the sticky `touched` guard
	// so a late arrival cannot discard an in-progress preview) lives in the
	// pure, tier-1-tested `resyncRealScopes` (../auth/preview-scopes.js) --
	// this effect must delegate to it, not re-implement the decision inline.
	assert.match(STRIPPED.control, /useEffect\(/, 'PreviewAsProvider has no effect at all');
	assert.match(STRIPPED.control, /resyncRealScopes\(prev,\s*realScopes\)/);
	assert.match(STRIPPED.control, /\}, \[realKey\]\);/);
});

test('positive control: the re-seed matcher does NOT hit an initializer-only fixture', () => {
	const fixture = 'const [state, setState] = useState(() => createPreviewState(realScopes));';
	assert.doesNotMatch(fixture, /resyncRealScopes\(prev,\s*realScopes\)/, 'matcher is inert');
});

test('PanelGrid.tsx takes no grantedScopes prop -- the context hook is its only scope source', () => {
	// A dead prop that duplicated the context value is what made the frozen
	// empty-scope defect above hard to see from `DashboardShell`'s call site.
	assert.doesNotMatch(STRIPPED.grid, /grantedScopes/);
	assert.doesNotMatch(STRIPPED.shell, /grantedScopes=\{/);
});

test('positive control: the dead-prop matcher hits a synthetic <PanelGrid grantedScopes={x} /> fixture', () => {
	assert.match('<PanelGrid grantedScopes={scopes} />', /grantedScopes=\{/, 'matcher is inert');
});

test('DashboardShell.tsx renders PreviewAsProvider, PreviewAsControl and an explicit-voice AdvisoryDisclosure', () => {
	// Tightened in 53-05 (D-07): the shell must STATE its voice, not merely
	// mount the component -- a zero-prop <AdvisoryDisclosure /> no longer
	// compiles (the prop is required), but a wiring regression that added a
	// permissive default back to the component would slip past a matcher
	// that only checked the tag was present.
	assert.match(STRIPPED.shell, /<PreviewAsProvider/);
	assert.match(STRIPPED.shell, /<PreviewAsControl/);
	assert.match(STRIPPED.shell, /<AdvisoryDisclosure variant="authority"/);
});

test('inertness control: the explicit-voice matcher does NOT accept a bare zero-prop mount', () => {
	const fixture = '<PreviewAsControl /><AdvisoryDisclosure />';
	assert.doesNotMatch(fixture, /<AdvisoryDisclosure variant="authority"/, 'matcher is inert');
});

// --- Elevation-of-privilege confinement (T-50-12-01) ---------------------------

const CONFINEMENT_RE = /preview|simulat|effectiveScopes|GrantedScopesContext/i;

test('no file under the shared web-data package, the src/peer network layer, src/lifecycle or the shared package\'s lifecycle mentions preview, simulat, effectiveScopes or GrantedScopesContext, comment-stripped', () => {
	// Comment-stripped, per this behavior group's own header -- election-
	// phase.js documents (in prose) why it does NOT add a phase picker,
	// using the word "simulation"; that is a design note, not a leak of
	// this plan's previewed value into a lifecycle module. 53-05 (D-01/D-02)
	// moved election-phase.js to packages/ui-web/src/lifecycle -- this walk
	// follows it there via uiWebSrc('lifecycle'), or this confinement
	// guarantee would silently cover less than it did before the move.
	// 54-03a moved the dashboard's src/db into packages/web-data -- a second
	// instance of the same precedent: dashboardSrc('db') is replaced with
	// webDataSrc() here, or this walk would crash with ENOENT the moment
	// src/db stopped existing (walkFiles below has no existsSync guard),
	// rather than silently narrowing.
	// 66-24 retired the sign-in transport directory with the snapshot path; the
	// walk follows the network layer to src/peer (the member node, pairing,
	// replication and strand reader), so a previewed scope can reach none of it.
	const DIRS = [webDataSrc(), dashboardSrc('peer'), dashboardSrc('lifecycle'), uiWebSrc('lifecycle')];
	/** @type {string[]} */
	const offenders = [];
	for (const abs of DIRS) {
		for (const file of walkFiles(abs)) {
			if (CONFINEMENT_RE.test(stripComments(readFileSync(file, 'utf8')))) {
				offenders.push(path.relative(APP_ROOT, file));
			}
		}
	}
	assert.deepEqual(offenders, [], `the previewed value leaked into: ${offenders.join(', ')}`);
});

test('positive control: the confinement matcher hits a synthetic "const s = effectiveScopes(state)" fixture', () => {
	assert.match('const s = effectiveScopes(state)', CONFINEMENT_RE, 'matcher is inert');
});

// --- Storage hygiene and unreachable-state hygiene -----------------------------

test('the three new src/screens/ files contain no localStorage, sessionStorage, indexedDB or writeRowCounts reference', () => {
	const RE = /localStorage|sessionStorage|indexedDB|writeRowCounts/;
	for (const key of ['context', 'control', 'css']) {
		assert.doesNotMatch(STRIPPED[key], RE, `${FILES[key]} references storage`);
	}
});

test('none of the three new files or the two edited shell files names read-only, ◐ or writable -- comments included', () => {
	const RE = /read-only|◐|writable/i;
	for (const key of Object.keys(FILES)) {
		assert.doesNotMatch(RAW[key], RE, `${FILES[key]} names the unreachable panel state`);
	}
});

// --- preview-as.css -------------------------------------------------------------

test('every class selector in preview-as.css starts with pv-, has no hex literal, and --ok/--warn each appear exactly once', () => {
	const classSelectors = [...STRIPPED.css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
	assert.ok(classSelectors.length >= 5, 'expected at least 5 class selectors in preview-as.css');
	for (const cls of classSelectors) {
		assert.ok(cls.startsWith('pv-'), `.${cls} does not start with pv-`);
	}
	assert.doesNotMatch(STRIPPED.css, /#[0-9a-fA-F]{3,6}/, 'preview-as.css contains a hex colour literal');
	assert.equal((RAW.css.match(/--ok\b/g) ?? []).length, 1);
	assert.equal((RAW.css.match(/--warn\b/g) ?? []).length, 1);
});
