/**
 * authority-admin-panels.test.mjs -- source-level assertions over the six
 * Authority Administration panel bodies: no mutating affordance, no
 * invented copy, no key material, no self-gating. `node --test` cannot
 * import `.tsx`, so this file reads each source as TEXT, in
 * `test/node/registry.test.mjs`'s (50-06) shape, and strips `//` / `/* *\/`
 * comment lines before matching an unfiltered scan would be tripped by this
 * plan's own explanatory comments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc, workspacePath } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { COPY } from '@votetorrent/ui-web';

const PANELS_DIR = dashboardSrc('screens', 'panels');
const SCHEMA_PATH = workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql');

/** All six Authority Administration panel files this suite covers. A later
 * edit that quietly shrinks this list fails the length assertion below.
 * @type {string[]} */
export const FILES = [
	'NetworkSettingsPanel.tsx',
	'AuthorityProfilePanel.tsx',
	'AuthorityPeersPanel.tsx',
	'AdministrationOfficersPanel.tsx',
	'KeyholdersPanel.tsx',
	'InviteAuthoritiesPanel.tsx',
];

/** Parse the set of schema column identifiers: column declarations inside
 * `table` blocks (leading whitespace, an identifier, a recognised column
 * type keyword) plus `as <Name>` aliases inside `view` blocks.
 * @param {string} source @returns {Set<string>} */
function extractSchemaColumnIdentifiers(source) {
	const identifiers = new Set();
	const colRe = /^[ \t]*([A-Z][A-Za-z0-9]*)[ \t]+(text|integer|datetime|boolean)\b/gm;
	for (const m of source.matchAll(colRe)) identifiers.add(m[1]);
	const asRe = /\bas\s+([A-Z][A-Za-z0-9]*)\b/g;
	for (const m of source.matchAll(asRe)) identifiers.add(m[1]);
	return identifiers;
}

/** Extract every literal `<dt>...</dt>` text node.
 * @param {string} source @returns {string[]} */
function extractDtLabels(source) {
	return [...source.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1].trim()).filter((s) => s.length > 0);
}

const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, 'utf8');
const SCHEMA_COLUMN_IDENTIFIERS = extractSchemaColumnIdentifiers(SCHEMA_SOURCE);

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const file of FILES) {
	RAW[file] = readFileSync(path.join(PANELS_DIR, file), 'utf8');
	STRIPPED[file] = stripComments(RAW[file]);
}

test('FILES names exactly the six Authority Administration panels', () => {
	assert.equal(FILES.length, 6);
	assert.deepEqual(FILES, [
		'NetworkSettingsPanel.tsx',
		'AuthorityProfilePanel.tsx',
		'AuthorityPeersPanel.tsx',
		'AdministrationOfficersPanel.tsx',
		'KeyholdersPanel.tsx',
		'InviteAuthoritiesPanel.tsx',
	]);
});

// --- 1. No mutating affordance ----------------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|href=/;

test('no <button>, <form>, <input>, <select>, <textarea>, onClick, onSubmit, onChange or href= in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], CONTROL_RE, `${file} contains a control affordance`);
	}
});

test('positive control: the control matcher hits a synthetic fixture', () => {
	const fixture = `<button onClick={go}>Add peer</button>`;
	assert.match(fixture, CONTROL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- 2. No unreachable panel state (comments included) ----------------------

// The banned tokens are built from fragments so this file can never trip a
// scan of its own text, and so the old literal pattern no longer appears here.
const BANNED_READ = 'read';
const BANNED_STATE_RE = new RegExp(
	[BANNED_READ + '-only', BANNED_READ + 'only', 'writ' + 'able', 'dis' + 'abled', '◐'].join('|'),
	'i',
);

// The live panels show pending items with the shared action-note component
// (`src/live/`). Its exact identifier and its own single-name import line are
// the ONLY exemption: every other spelling -- the TS keyword, the hyphenated
// prose form, a longer identifier that merely contains the name -- stays
// banned. Import it alone, on its own line, with no alias.
const NOTE_IDENT = 'Read' + 'OnlyNote';
const NOTE_IMPORT_RE = new RegExp(
	`^\\s*import\\s*\\{\\s*${NOTE_IDENT}\\s*\\}\\s*from\\s*['"](?:\\.\\./)+live/${NOTE_IDENT}(?:\\.js)?['"];?\\s*$`,
	'gm',
);
const NOTE_IDENT_RE = new RegExp(`\\b${NOTE_IDENT}\\b`, 'g');

/** Remove the exempt import lines, then every remaining exact identifier.
 * @param {string} source @returns {string} */
export function exemptReadOnlyNote(source) {
	return source.replace(NOTE_IMPORT_RE, '').replace(NOTE_IDENT_RE, '');
}

const NOTE_IMPORT_LINE = `import { ${NOTE_IDENT} } from '../../live/${NOTE_IDENT}.js';`;

test('positive control: a stray hyphenated string still fails beside the exempt import and use', () => {
	const fixture = [NOTE_IMPORT_LINE, `<${NOTE_IDENT} variant="short" />`, `const label = '${BANNED_READ}-only';`].join('\n');
	assert.match(exemptReadOnlyNote(fixture), BANNED_STATE_RE, 'the exemption must not wave through a stray banned string');
});

test('positive control: the TS keyword still fails after exemption', () => {
	const fixture = `interface Rows { ${BANNED_READ}only items: string[] }`;
	assert.match(exemptReadOnlyNote(fixture), BANNED_STATE_RE, 'the exemption must not wave through the TS keyword');
});

test('positive control: the exemption is the exact identifier only (a longer or prefixed name still fails)', () => {
	assert.match(exemptReadOnlyNote(`<${NOTE_IDENT}s />`), BANNED_STATE_RE, 'a pluralised identifier must still fail');
	assert.match(exemptReadOnlyNote('const isRead' + 'Only = true;'), BANNED_STATE_RE, 'a prefixed identifier must still fail');
});

test('negative control: the exempt import line and a use pass after exemption', () => {
	const fixture = [NOTE_IMPORT_LINE, `<${NOTE_IDENT} variant="long" id="n" />`].join('\n');
	assert.doesNotMatch(exemptReadOnlyNote(fixture), BANNED_STATE_RE);
});

test('inertness control: the same exempt fixture matches before exemption, so the exemption is what lets it through', () => {
	const fixture = [NOTE_IMPORT_LINE, `<${NOTE_IDENT} variant="long" id="n" />`].join('\n');
	assert.match(fixture, BANNED_STATE_RE, 'the ban must see the identifier before the exemption runs');
});

test('no banned panel-state word (BANNED_STATE_RE) anywhere in the six files, comments included; only the exact ReadOnlyNote identifier and its own import line are exempt', () => {
	for (const file of FILES) {
		assert.doesNotMatch(exemptReadOnlyNote(RAW[file]), BANNED_STATE_RE, `${file} names the unreachable panel state`);
	}
});

// --- 3. No raw HTML seam -----------------------------------------------------

test('no dangerouslySetInnerHTML in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /dangerouslySetInnerHTML/, `${file} contains an injection surface`);
	}
});

// --- 4. No self-gating -------------------------------------------------------

test('no import of ../../auth/gate.js, no evaluate(, no grantedScopes reference in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /auth\/gate\.js|evaluate\(|grantedScopes/, `${file} makes its own visibility decision`);
	}
});

// --- 4b. No self-composition (50-06 contract C7) -----------------------------

const PANEL_FRAME_RE = /PanelFrame/;

test('none of the six files references PanelFrame -- 50-09\'s PanelGrid composes the frame', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], PANEL_FRAME_RE, `${file} imports or renders PanelFrame`);
	}
});

test('positive control: the PanelFrame-detection matcher hits a synthetic self-wrapping import', () => {
	const fixture = `import PanelFrame from './PanelFrame.tsx';`;
	assert.match(fixture, PANEL_FRAME_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- 5. No shared prefetch ----------------------------------------------------

/** @type {Record<string, string>} */
const FETCHER_NAMES = {
	'NetworkSettingsPanel.tsx': 'fetchNetworkSettings',
	'AuthorityProfilePanel.tsx': 'fetchAuthorityProfile',
	'AuthorityPeersPanel.tsx': 'fetchAuthorityPeers',
	'AdministrationOfficersPanel.tsx': 'fetchAdministrationOfficers',
	'KeyholdersPanel.tsx': 'fetchKeyholders',
	'InviteAuthoritiesPanel.tsx': 'fetchAuthorityInvites',
};

test('each file contains exactly one fetcher call, and it is its own', () => {
	for (const file of FILES) {
		const fetcherName = FETCHER_NAMES[/** @type {keyof typeof FETCHER_NAMES} */ (file)];
		const importMatches = [...STRIPPED[file].matchAll(/from ['"]\.\/authority-admin-queries\.js['"]/g)];
		assert.equal(importMatches.length, 1, `${file} must import authority-admin-queries.js exactly once`);
		const callMatches = [...STRIPPED[file].matchAll(new RegExp(`\\b${fetcherName}\\(`, 'g'))];
		assert.equal(callMatches.length, 1, `${file} must call ${fetcherName} exactly once`);
		for (const otherName of Object.values(FETCHER_NAMES)) {
			if (otherName === fetcherName) continue;
			assert.doesNotMatch(STRIPPED[file], new RegExp(`\\b${otherName}\\(`), `${file} calls ${otherName}, which is not its own fetcher`);
		}
	}
});

// --- 6. Empty state wired to the frozen table -----------------------------
//
// The original single test's subject was "empty state wired to the frozen
// table", asserted as a by-product of "no other t( call". Phase 60 widens
// this: KeyholdersPanel.tsx now carries three more state-copy keys (D-22),
// so the original zero-tolerance rule can no longer hold for that one file.
// This section keeps the original subject as its own direct assertion
// (6a), restates the original rule for the five untouched files while
// allowing KeyholdersPanel.tsx's three named additions (6b), and adds new
// strength the original test could not express at all: every allowed extra
// key is checked against the frozen copy table, not merely tolerated (6c),
// with a control proving an invented key is rejected, not silently waved
// through (6d).

/** Five entries keep today's zero-tolerance rule byte-for-byte; only
 * KeyholdersPanel.tsx (D-22) gets named additions.
 * @type {Record<string, string[]>} */
const EXTRA_T_KEYS = {
	'NetworkSettingsPanel.tsx': [],
	'AuthorityProfilePanel.tsx': [],
	'AuthorityPeersPanel.tsx': [],
	'AdministrationOfficersPanel.tsx': [],
	'KeyholdersPanel.tsx': [
		'panels.keyholders.loading',
		'panels.keyholders.unavailable',
		'panels.keyholders.readFailed',
		'panels.keyholders.meter.value',
	],
	'InviteAuthoritiesPanel.tsx': [],
};

/**
 * The 6b matcher, factored out so 6d's control can drive it against a
 * synthetic allowlist without duplicating the extraction/validation logic.
 * @param {string} source
 * @param {ReadonlyArray<string>} extraKeys
 * @returns {{ offendingFile: boolean; offenders: string[] }}
 */
function findDisallowedTCalls(source, extraKeys) {
	const tCalls = [...source.matchAll(/\bt\(([^)]*)\)/g)].map((m) => m[1].trim());
	/** @type {string[]} */
	const offenders = [];
	for (const arg of tCalls) {
		if (arg === 'capability.emptyKey') continue;
		// A key may be followed by an interpolation-params argument. The key
		// itself still has to be a named extra, so the params tail widens the
		// accepted SHAPE without widening which keys are allowed.
		const singleQuoted = arg.match(/^'([a-zA-Z][\w.]*)'(?:\s*,[\s\S]*)?$/);
		if (singleQuoted && extraKeys.includes(singleQuoted[1])) continue;
		offenders.push(arg);
	}
	return { offendingFile: offenders.length > 0, offenders };
}

test('6a: each file contains the literal t(capability.emptyKey)', () => {
	for (const file of FILES) {
		assert.match(STRIPPED[file], /t\(capability\.emptyKey\)/, `${file} does not call t(capability.emptyKey)`);
	}
});

test('6b: every t( call is either t(capability.emptyKey) or one of that file\'s named D-22 extras', () => {
	for (const file of FILES) {
		const tCalls = [...STRIPPED[file].matchAll(/\bt\(([^)]*)\)/g)].map((m) => m[1].trim());
		assert.ok(tCalls.length >= 1, `${file} must call t(...) at least once`);
		const { offenders } = findDisallowedTCalls(STRIPPED[file], EXTRA_T_KEYS[file]);
		assert.deepEqual(offenders, [], `${file} calls t(${offenders.join('), t(')}), which is not capability.emptyKey or an allowed extra`);
	}
});

test('6c: every EXTRA_T_KEYS entry and every emptyCopyKey prop literal is a real COPY key', () => {
	/** @type {string[]} */
	const emptyCopyKeyLiterals = [];
	for (const file of FILES) {
		for (const m of STRIPPED[file].matchAll(/emptyCopyKey=(?:"([^"]*)"|\{'([^']*)'\})/g)) {
			emptyCopyKeyLiterals.push(m[1] ?? m[2]);
		}
	}
	assert.ok(emptyCopyKeyLiterals.length > 0, 'expected at least one emptyCopyKey prop literal across the six files -- this assertion is vacuous otherwise');

	for (const file of FILES) {
		for (const key of EXTRA_T_KEYS[file]) {
			assert.ok(Object.prototype.hasOwnProperty.call(COPY, key), `${file}'s EXTRA_T_KEYS entry "${key}" is not a key in COPY`);
		}
	}
	for (const key of emptyCopyKeyLiterals) {
		assert.ok(Object.prototype.hasOwnProperty.call(COPY, key), `emptyCopyKey="${key}" is not a key in COPY`);
	}
});

test('6d: controls -- an invented key is rejected by 6b and absent from COPY, and only one file has named extras', () => {
	// (i) the 6b matcher rejects a synthetic invented key checked against
	// KeyholdersPanel.tsx's own allowlist.
	const fixture = `t(capability.emptyKey) t('panels.keyholders.invented')`;
	const { offendingFile, offenders } = findDisallowedTCalls(fixture, EXTRA_T_KEYS['KeyholdersPanel.tsx']);
	assert.ok(offendingFile, 'the 6b matcher is inert -- it must reject an invented key not in the allowlist');
	assert.deepEqual(offenders, ["'panels.keyholders.invented'"]);

	// (i-bis) the same rejection must hold in the params-carrying call shape
	// the matcher also accepts. Without this, widening the matcher to allow
	// t('key', { ... }) would silently wave through EVERY key in that shape.
	const paramsFixture = `t(capability.emptyKey) t('panels.keyholders.invented', { count: 1, total: 2 })`;
	const paramsResult = findDisallowedTCalls(paramsFixture, EXTRA_T_KEYS['KeyholdersPanel.tsx']);
	assert.ok(paramsResult.offendingFile, 'the 6b matcher waves through any params-carrying t( call -- the params tail must not bypass the allowlist');
	assert.deepEqual(paramsResult.offenders, ["'panels.keyholders.invented', { count: 1, total: 2 }"]);

	// (ii) that same invented key is genuinely absent from COPY -- otherwise
	// 6c could never fail on it.
	assert.ok(!Object.prototype.hasOwnProperty.call(COPY, 'panels.keyholders.invented'), '6c cannot prove anything if the negative-control key already exists in COPY');

	// (iii) exactly five of the six EXTRA_T_KEYS arrays are empty -- a later
	// edit that quietly widens a second file is visible as a failure here,
	// not a silent relaxation of this gate.
	const emptyCount = Object.values(EXTRA_T_KEYS).filter((keys) => keys.length === 0).length;
	assert.equal(emptyCount, 5, 'expected exactly five of six files to carry no extra allowed t( key');
});

// --- 7. Labels are schema identifiers (binding decision A) --------------------

test('every <dt> label in the six files is a schema column identifier parsed from votetorrent.qsql', () => {
	for (const file of FILES) {
		const labels = extractDtLabels(STRIPPED[file]);
		for (const label of labels) {
			assert.ok(SCHEMA_COLUMN_IDENTIFIERS.has(label), `${file} renders <dt>${label}</dt>, which is not a schema column identifier`);
		}
	}
});

test('positive control: the label extractor reports a literal invented label as not-a-column', () => {
	const fixture = `<dt>Relay servers</dt>`;
	const labels = extractDtLabels(fixture);
	assert.deepEqual(labels, ['Relay servers']);
	assert.ok(!SCHEMA_COLUMN_IDENTIFIERS.has('Relay servers'), 'a label check that cannot detect invented copy is not a label check');
});

// --- 8. CSS scoping ------------------------------------------------------------

test('every class selector in authority-admin.css starts with aa-, and the file has no hex colour literal', () => {
	const cssPath = path.join(PANELS_DIR, 'authority-admin.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = stripComments(css);
	const classSelectors = [...stripped.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
	assert.ok(classSelectors.length >= 5, 'expected at least 5 class selectors in authority-admin.css');
	for (const cls of classSelectors) {
		assert.ok(cls.startsWith('aa-'), `.${cls} does not start with aa-`);
	}
	assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,6}/, 'authority-admin.css contains a hex colour literal');
});

// --- Registry untouched, still nine, sibling panels untouched ------------------

test('registry.ts still declares exactly 9 *Panel.tsx files on disk', () => {
	const registrySource = readFileSync(path.join(PANELS_DIR, 'registry.ts'), 'utf8');
	const importMatches = [...registrySource.matchAll(/from\s+'\.\/(\w+Panel)'/g)].map((m) => m[1]);
	assert.equal(importMatches.length, 9);
});

// --- No role/group concept invented around Officer.Title -----------------------

test('AdministrationOfficersPanel.tsx invents no role/group concept around Title', () => {
	const source = STRIPPED['AdministrationOfficersPanel.tsx'];
	assert.doesNotMatch(source, /\brole\b|permission group|user group/i);
});

test('AdministrationOfficersPanel.tsx renders Scopes as chips', () => {
	assert.match(STRIPPED['AdministrationOfficersPanel.tsx'], /aa-scope/);
});

// --- Task 3: no key material in the two tier-2 panels --------------------------

const TIER2_FILES = ['KeyholdersPanel.tsx', 'InviteAuthoritiesPanel.tsx'];
const KEY_MATERIAL_RE = /UserKey|PubKey|PrivateKey|ReleaseKey|SignerKey|InviteKey|InviteSignature|Signature/i;

test('no key-material column in either tier-2 panel -- InviteKey/InviteSignature are real InviteSlot columns, excluded on purpose', () => {
	for (const file of TIER2_FILES) {
		assert.doesNotMatch(STRIPPED[file], KEY_MATERIAL_RE, `${file} references a key-material column`);
	}
});

test('positive control: the key-material matcher hits a synthetic InviteKey reference', () => {
	const fixture = `<dd>{row.InviteKey}</dd>`;
	assert.match(fixture, KEY_MATERIAL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- Task 3: no ceremony affordance ---------------------------------------------

// Assertion 6 (over all six files, including these two) already pins that the
// only `t(...)` call either file may make is `t(capability.emptyKey)` -- no
// second copy key can smuggle in a call-to-action sentence. This assertion
// covers the remaining surface: no literal JSX text node may read as an
// invite-shaped call-to-action ("Invite", "Send", "Create", "Add an
// authority", etc). Schema-column `<dt>` labels (binding decision A) are
// exempt by construction -- none of them contain these words.
const CEREMONY_CTA_RE = /\binvite\b|\bsend\b|\bcreate\b|\badd\b/i;

test('neither tier-2 file renders literal JSX text that reads as an invite-shaped call-to-action', () => {
	for (const file of TIER2_FILES) {
		const literalTextNodes = [...STRIPPED[file].matchAll(/<[a-zA-Z][\w-]*(?:\s[^>]*)?>([^<>{}]*)<\//g)]
			.map((m) => m[1].trim())
			.filter((s) => /[A-Za-z]{2,}/.test(s));
		for (const text of literalTextNodes) {
			assert.doesNotMatch(text, CEREMONY_CTA_RE, `${file} renders "${text}", which reads as a ceremony call-to-action`);
		}
	}
});

test('positive control: the ceremony call-to-action matcher hits a synthetic "Invite an authority" fixture', () => {
	assert.match('Invite an authority', CEREMONY_CTA_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- Task 3: tier is not restated as prose --------------------------------------

test('neither tier-2 file names "tier", "engine-delegated" or "schema CHECK" outside comments -- the tier pill is the only place that fact is surfaced', () => {
	for (const file of TIER2_FILES) {
		assert.doesNotMatch(STRIPPED[file], /\btier\b|engine-delegated|schema CHECK/i, `${file} restates tier as prose`);
	}
});
