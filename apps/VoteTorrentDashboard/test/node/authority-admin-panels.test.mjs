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
import {
	networkSettingsMarkRows,
	authorityProfileMarkRows,
	administrationOfficersMarkRows,
} from '../../src/screens/panels/authority-admin-queries.js';

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

// --- 9. Live treatment (panels B) ----------------------------------------------
//
// The five administration panels this section covers re-read when a completed
// sync pass touched their tables, keep their data on screen while they do,
// mark changed fields or rows, show the action note on open invites, make no
// visibility decision and log only an error's class. KeyholdersPanel.tsx is
// NOT in this list: another plan owns its live treatment. Every matcher is
// built so the tokens it bans appear here only as fragments, and every real
// loop has a positive control before it.

/** @type {string[]} */
const LIVE_B_FILES = [
	'NetworkSettingsPanel.tsx',
	'AuthorityProfilePanel.tsx',
	'AuthorityPeersPanel.tsx',
	'AdministrationOfficersPanel.tsx',
	'InviteAuthoritiesPanel.tsx',
];

/** Each live panel's table-list constant (the name it passes to touchesTables).
 * @type {Record<string, string>} */
const LIVE_B_TABLES = {
	'NetworkSettingsPanel.tsx': 'NETWORK_SETTINGS_TABLES',
	'AuthorityProfilePanel.tsx': 'AUTHORITY_PROFILE_TABLES',
	'AuthorityPeersPanel.tsx': 'AUTHORITY_PEERS_TABLES',
	'AdministrationOfficersPanel.tsx': 'ADMINISTRATION_OFFICERS_TABLES',
	'InviteAuthoritiesPanel.tsx': 'AUTHORITY_INVITES_TABLES',
};

const READ_DEPS_RE = /\[db, readKey(?:, now)?\]/;

/** @param {string} haystack @param {string} needle @returns {number} */
function countOccurrences(haystack, needle) {
	return haystack.split(needle).length - 1;
}

test('L1 control: the read-dependency matcher rejects a read effect that depends on [db] alone', () => {
	const fixture = `useEffect(() => { void fetchX(db); }, [db]);`;
	assert.doesNotMatch(fixture, READ_DEPS_RE);
	assert.match(`}, [db, readKey]);`, READ_DEPS_RE, 'the matcher must accept the live dependency array');
});

test('L1: each live panel reads the data version, filters it by its own table list and re-reads on [db, readKey] (Administration also on now)', () => {
	for (const file of LIVE_B_FILES) {
		const source = STRIPPED[file];
		assert.ok(source.includes('useDataVersion()'), `${file} does not read the data version`);
		assert.ok(source.includes(`touchesTables(changedTables, ${LIVE_B_TABLES[file]})`), `${file} does not filter by ${LIVE_B_TABLES[file]}`);
		assert.match(source, READ_DEPS_RE, `${file} read effect does not depend on [db, readKey]`);
	}
	assert.ok(STRIPPED['AdministrationOfficersPanel.tsx'].includes('[db, readKey, now]'), 'the administration panel must also re-read on the clock tick');
});

const LOADING_RESET = 'setState(' + 'PANEL_READ_LOADING)';

test('L2 control: two loading resets in one source are counted as two', () => {
	const fixture = `${LOADING_RESET};\nif (x) ${LOADING_RESET};`;
	assert.equal(countOccurrences(fixture, LOADING_RESET), 2);
});

test('L2: each live panel resets to loading exactly once (on a new db handle) and still calls its own fetcher exactly once', () => {
	for (const file of LIVE_B_FILES) {
		const source = STRIPPED[file];
		assert.equal(countOccurrences(source, LOADING_RESET), 1, `${file} must reset to loading exactly once`);
		const fetcherName = FETCHER_NAMES[file];
		assert.equal([...source.matchAll(new RegExp(`\\b${fetcherName}\\(`, 'g'))].length, 1, `${file} must call ${fetcherName} exactly once`);
	}
});

const FRAME_OWNED_RE = new RegExp(['\\bheader' + 'Marked\\b', '\\bann' + 'ounce\\b'].join('|'));

test('L3 control: the frame-owned matcher catches a panel rendering the announcement', () => {
	const fixture = `<p>{ann${'ounce'}}</p>`;
	assert.match(fixture, FRAME_OWNED_RE);
});

test('L3: each live panel calls useChangeMarks once, puts markClass on its fields or rows, renders the visually hidden word and nothing the frame owns', () => {
	for (const file of LIVE_B_FILES) {
		const source = STRIPPED[file];
		assert.equal(countOccurrences(source, 'useChangeMarks('), 1, `${file} must call useChangeMarks exactly once`);
		assert.ok(source.includes('useChangeMarks(markRows, markRowKey, markRowSig)'), `${file} must hand the hook its mark rows`);
		assert.ok(source.includes('markClass('), `${file} never applies markClass`);
		assert.ok(source.includes('markable('), `${file} never applies the mark to a field or row`);
		assert.ok(source.includes('<ChangeMarkWord />'), `${file} never renders the visually hidden word`);
		assert.doesNotMatch(source, FRAME_OWNED_RE, `${file} renders something the frame owns`);
	}
});

/** Literal keys in `markable('<Key>'` calls.
 * @param {string} source @returns {string[]} */
function markableKeys(source) {
	return [...new Set([...source.matchAll(/markable\('([^']+)'/g)].map((m) => m[1]))].sort();
}

/** @param {string[]} a @param {string[]} b @returns {boolean} */
function sameSet(a, b) {
	const left = [...new Set(a)].sort();
	const right = [...new Set(b)].sort();
	return left.length === right.length && left.every((v, i) => v === right[i]);
}

const SAMPLE_SETTINGS = {
	Name: 'n',
	Hash: 'h',
	PrimaryAuthorityId: 'a1',
	Relays: [],
	TimestampAuthorities: [],
	NumberRequiredTSAs: 1,
	ElectionType: 'o',
	ElectionTypeName: 'Official',
};
const SAMPLE_PROFILE = { Id: 'a1', Name: 'n', DomainName: null, ImageRef: null };
const SAMPLE_ADMIN = { admin: { EffectiveAt: '2026-01-01T00:00:00', ThresholdPolicies: [] }, officers: [] };

test('L4 control: dropping one key from a copied key set is reported as a different set', () => {
	const keys = markableKeys(STRIPPED['NetworkSettingsPanel.tsx']);
	assert.ok(keys.length > 1, 'the control needs a real key set');
	assert.equal(sameSet(keys, keys.slice(1)), false);
	assert.equal(sameSet(keys, [...keys]), true);
});

test('L4: the marked field keys equal the <dt> labels and the mapper keys (Network settings, Authority profile), and the administration keys equal the mapper admin keys', () => {
	const settingsSource = STRIPPED['NetworkSettingsPanel.tsx'];
	const settingsKeys = markableKeys(settingsSource);
	assert.equal(settingsKeys.length, 7);
	assert.ok(sameSet(settingsKeys, extractDtLabels(settingsSource)), 'Network settings: marked keys differ from <dt> labels');
	assert.ok(sameSet(settingsKeys, networkSettingsMarkRows(SAMPLE_SETTINGS).map((r) => r.key)), 'Network settings: marked keys differ from mapper keys');

	const profileSource = STRIPPED['AuthorityProfilePanel.tsx'];
	const profileKeys = markableKeys(profileSource);
	assert.equal(profileKeys.length, 4);
	assert.ok(sameSet(profileKeys, extractDtLabels(profileSource)), 'Authority profile: marked keys differ from <dt> labels');
	assert.ok(sameSet(profileKeys, authorityProfileMarkRows(SAMPLE_PROFILE).map((r) => r.key)), 'Authority profile: marked keys differ from mapper keys');

	const adminKeys = markableKeys(STRIPPED['AdministrationOfficersPanel.tsx']).filter((k) => k.startsWith('admin:'));
	const mapperAdminKeys = administrationOfficersMarkRows(SAMPLE_ADMIN)
		.map((r) => r.key)
		.filter((k) => k.startsWith('admin:'));
	assert.equal(mapperAdminKeys.length, 2);
	assert.ok(sameSet(adminKeys, mapperAdminKeys), 'Administration: marked admin keys differ from mapper keys');
	assert.ok(STRIPPED['AdministrationOfficersPanel.tsx'].includes("markable(officerMarkKey(officer.UserId), 'aa-row')"), 'officer rows must be marked by officerMarkKey');
});

/** The text of every `.map(` call's argument list, balanced on parentheses.
 * @param {string} source @returns {string[]} */
function mapBodies(source) {
	/** @type {string[]} */
	const out = [];
	let from = 0;
	for (;;) {
		const at = source.indexOf('.map(', from);
		if (at < 0) break;
		let depth = 0;
		let i = at + 4;
		for (; i < source.length; i++) {
			if (source[i] === '(') depth++;
			else if (source[i] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		out.push(source.slice(at, i + 1));
		from = at + 5;
	}
	return out;
}

/** @param {string} source @returns {boolean} */
function noteInsideRowMap(source) {
	return mapBodies(source).some((body) => body.includes(`<${NOTE_IDENT}`));
}

test('L5 control: a note rendered inside the row map is caught as a per-row note', () => {
	const fixture = `{rows.map((row) => (<div key={row.Cid}><${NOTE_IDENT} variant="short" /></div>))}`;
	assert.equal(noteInsideRowMap(fixture), true);
	assert.equal(noteInsideRowMap(`<${NOTE_IDENT} variant="short" />{rows.map((row) => (<div key={row.Cid} />))}`), false);
});

test('L5: Invite authorities imports the note on its own line, renders the short note once above the rows, points open rows at it, and no live panel uses the long variant', () => {
	const raw = RAW['InviteAuthoritiesPanel.tsx'];
	assert.ok(raw.split('\n').includes(NOTE_IMPORT_LINE), 'the note import must stand alone on its own line, exactly');
	assert.equal(countOccurrences(raw, `<${NOTE_IDENT} variant="short" id={noteId} />`), 1);
	assert.ok(raw.includes('aria-describedby={noteId}'), 'open rows must point their accessible description at the note');
	assert.equal(noteInsideRowMap(STRIPPED['InviteAuthoritiesPanel.tsx']), false, 'the note must not be rendered per row');
	for (const file of LIVE_B_FILES) {
		assert.ok(!RAW[file].includes('variant="long"'), `${file} uses the long note variant`);
	}
});

const SELF_GATING_RE = new RegExp(
	['auth\\/gate\\.js', 'evaluate\\(', 'granted' + 'Scopes', 'useEffective' + 'Scopes', 'Granted' + 'ScopesContext', 'Preview' + 'As'].join('|'),
);

test('L6 control: the self-gating matcher catches a panel reading the effective scopes', () => {
	const fixture = `const s = useEffective${'Scopes'}();`;
	assert.match(fixture, SELF_GATING_RE);
});

test('L6: no live panel makes a visibility decision of its own (no gate, no scope reading, no preview)', () => {
	for (const file of LIVE_B_FILES) {
		assert.doesNotMatch(STRIPPED[file], SELF_GATING_RE, `${file} makes its own visibility decision`);
	}
});

const CSS_AFFORDANCE_RE = new RegExp(['\\bcur' + 'sor\\s*:', ':ho' + 'ver\\b', ':fo' + 'cus'].join('|'));

test('L7 control: the CSS affordance matcher catches a hover rule with a pointer', () => {
	const fixture = `.aa-row:${'hover'} { cur${'sor'}: pointer; }`;
	assert.match(fixture, CSS_AFFORDANCE_RE);
});

test('L7: authority-admin.css declares no cursor and no hover or focus rule', () => {
	const css = stripComments(readFileSync(path.join(PANELS_DIR, 'authority-admin.css'), 'utf8'));
	assert.doesNotMatch(css, CSS_AFFORDANCE_RE);
	assert.match(css, /\.aa-markable\s*\{/, 'the mark padding rule must exist');
});

/** Every `console.<method>(` call's argument text, balanced on parentheses.
 * @param {string} source @returns {string[]} */
function consoleCalls(source) {
	/** @type {string[]} */
	const out = [];
	for (const m of source.matchAll(/\bconsole\.\w+\(/g)) {
		const at = m.index ?? 0;
		let depth = 0;
		let i = at + m[0].length - 1;
		for (; i < source.length; i++) {
			if (source[i] === '(') depth++;
			else if (source[i] === ')') {
				depth--;
				if (depth === 0) break;
			}
		}
		out.push(source.slice(at, i + 1));
	}
	return out;
}

test('L8 control: a console call that logs the whole error is caught', () => {
	const [call] = consoleCalls(`console.error('x', err);`);
	assert.ok(call);
	assert.ok(!call.includes('?.name'));
});

test('L8: every console call in the live panels logs the error class only', () => {
	let total = 0;
	for (const file of LIVE_B_FILES) {
		for (const call of consoleCalls(STRIPPED[file])) {
			total += 1;
			assert.ok(call.includes('?.name'), `${file}: a console call logs more than the error class`);
		}
	}
	assert.ok(total >= LIVE_B_FILES.length, 'expected at least one console call per live panel');
});
