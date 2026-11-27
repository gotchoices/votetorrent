/**
 * app-shape.test.mjs — the per-app configuration D-16 says a shared package
 * cannot enforce for itself, asserted here at tier 1 in this app's own
 * suite. (53-12 adds the repo-root assertion that generalises this to
 * EVERY consumer; this file is the app-local half and is not made redundant
 * by it — 53-12 cannot run until wave 6.)
 *
 * Every path is resolved through scripts/lib/source-paths.mjs's
 * `publicRoot(...)`/`publicSrc(...)` (53-01) — never re-derived from
 * `import.meta.url`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { publicRoot, publicSrc, repoRoot } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const VITE_CONFIG_SOURCE = readFileSync(publicRoot('vite.config.ts'), 'utf8');
const VITE_CONFIG_STRIPPED = stripComments(VITE_CONFIG_SOURCE);

// ---------------------------------------------------------------------------
// 1. resolve.dedupe (D-16), now FOUR entries (54-11).
//
// REWRITTEN, NOT DELETED. What stood here was an exact-shape regex over the
// two React entries. 54-11 adds `@quereus/quereus` and
// `@quereus/plugin-indexeddb`, because this app now reaches a real browser
// database through `@votetorrent/web-data` and that package declares both in
// peerDependencies + devDependencies -- the same on-disk shape that makes
// React's entries necessary, one stack down. A second `@quereus/quereus` copy
// is a second `Database` class identity and a second plugin registry: it fails
// at plugin registration or at an `instanceof` boundary, in a build that still
// exits 0.
//
// The assertion is an EXTRACTION now rather than a shape match, so the entry
// list is compared as data and a drifting entry is named rather than reported
// as a bare regex miss. Both the original comment-only inertness control and a
// NEW discriminating control (a planted array missing one quereus entry must
// NOT satisfy the expectation) run before the real config is touched.
// ---------------------------------------------------------------------------

/** The dedupe entries this app must declare, in order. @type {ReadonlyArray<string>} */
const EXPECTED_DEDUPE = Object.freeze(['react', 'react-dom', '@quereus/quereus', '@quereus/plugin-indexeddb']);

/** @type {RegExp} */
const DEDUPE_ARRAY_RE = /dedupe:\s*\[([^\]]*)\]/;

/**
 * Pull the dedupe array literal's entries out of a config source, as data.
 * @param {string} source comment-stripped config source
 * @returns {string[] | null} the entries in declaration order, or null if there is no dedupe array at all.
 */
function extractDedupeEntries(source) {
	const m = source.match(DEDUPE_ARRAY_RE);
	if (!m) return null;
	return m[1]
		.split(',')
		.map((piece) => piece.trim().replace(/^['"`]|['"`]$/g, ''))
		.filter((piece) => piece !== '');
}

test('positive control: the extractor reads a planted four-entry dedupe array as data', () => {
	const planted = `export default defineConfig({ resolve: { dedupe: ${JSON.stringify([...EXPECTED_DEDUPE])} } });`;
	assert.deepEqual(extractDedupeEntries(planted), [...EXPECTED_DEDUPE], 'the extractor is inert against a planted array');
});

test('discriminating control: a planted dedupe array MISSING the quereus engine entry does not satisfy the expectation', () => {
	const dropped = [...EXPECTED_DEDUPE].filter((entry) => entry !== '@quereus/quereus');
	assert.equal(dropped.length, EXPECTED_DEDUPE.length - 1, 'fixture sanity: exactly one entry must have been dropped');
	const planted = `export default defineConfig({ resolve: { dedupe: ${JSON.stringify(dropped)} } });`;
	assert.notDeepEqual(extractDedupeEntries(planted), [...EXPECTED_DEDUPE], 'the assertion would accept a config that lost the engine dedupe entry');
});

test('inertness control: a config that only DISCUSSES dedupe in a comment yields no entries at all', () => {
	const commentOnly = stripComments(`// resolve: { dedupe: ${JSON.stringify([...EXPECTED_DEDUPE])} } is discussed here only\nexport default {};`);
	assert.equal(extractDedupeEntries(commentOnly), null, 'comment-only mention must not satisfy the extractor');
});

test('vite.config.ts declares resolve.dedupe with all FOUR entries in order -- react, react-dom, and the two quereus packages the shared data layer needs a single copy of', () => {
	assert.deepEqual(
		extractDedupeEntries(VITE_CONFIG_STRIPPED),
		[...EXPECTED_DEDUPE],
		'the dedupe entry list drifted. The quereus entries are NOT unrelated to React: @votetorrent/web-data declares both ' +
			'quereus packages in peerDependencies + devDependencies, and under nmHoistingLimits: workspaces a second copy is a ' +
			'second Database class identity -- a failure that shows up at plugin registration or an instanceof boundary, in a ' +
			'build that still exits 0. Do not delete them as leftovers.',
	);
});

// ---------------------------------------------------------------------------
// 2. No forbidden build escapes.
// ---------------------------------------------------------------------------
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const FORBIDDEN_BUILD_ESCAPES = [
	['define:', /\bdefine\s*:/],
	['envPrefix:', /\benvPrefix\s*:/],
	['alias:', /\balias\s*:/],
];
for (const [label, re] of FORBIDDEN_BUILD_ESCAPES) {
	test(`positive control: the "${label}" matcher fires on a planted fixture`, () => {
		assert.match(`export default defineConfig({ ${label} {} });`, re, `matcher for "${label}" is inert`);
	});

	test(`vite.config.ts contains no "${label}" (forbidden build escape)`, () => {
		assert.doesNotMatch(VITE_CONFIG_STRIPPED, re, `vite.config.ts must not declare "${label}"`);
	});
}

// ---------------------------------------------------------------------------
// 3. Port binding.
// ---------------------------------------------------------------------------
test('vite.config.ts binds both server and preview to port 5181 with strictPort: true', () => {
	const portMatches = VITE_CONFIG_STRIPPED.match(/port:\s*5181/g) ?? [];
	const strictPortMatches = VITE_CONFIG_STRIPPED.match(/strictPort:\s*true/g) ?? [];
	assert.equal(portMatches.length, 2, `expected exactly 2 "port: 5181" bindings (server + preview), found ${portMatches.length}`);
	assert.equal(strictPortMatches.length, 2, `expected exactly 2 "strictPort: true" bindings, found ${strictPortMatches.length}`);
});

// ---------------------------------------------------------------------------
// 4. Shared tsconfig base (D-16).
// ---------------------------------------------------------------------------
test('tsconfig.json extends packages/ui-web/tsconfig.base.json by relative path, no local compilerOptions, and the target exists on disk', () => {
	const tsconfig = JSON.parse(readFileSync(publicRoot('tsconfig.json'), 'utf8'));
	assert.equal(tsconfig.extends, '../../packages/ui-web/tsconfig.base.json', 'extends path drifted');
	assert.ok(!('compilerOptions' in tsconfig), 'tsconfig.json must declare no local compilerOptions');
	const resolvedBase = path.join(repoRoot, 'packages', 'ui-web', 'tsconfig.base.json');
	assert.ok(existsSync(resolvedBase), `the extends target must exist on disk at ${resolvedBase} — an extends pointing at nothing is a silently-empty config`);
});

test('would-fail control: an extends pointing at a non-existent sibling path is detectably absent', () => {
	const bogus = path.join(repoRoot, 'packages', 'ui-web', 'does-not-exist.json');
	assert.ok(!existsSync(bogus), 'sanity: the bogus path used to prove the existence check discriminates must not exist');
});

// ---------------------------------------------------------------------------
// 5. The single canonical stylesheet import, and its position (D-15).
// ---------------------------------------------------------------------------
test('app.css opens with exactly one correctly-positioned @import of @votetorrent/ui-web/tokens.css, and declares no custom property', () => {
	const cssSource = readFileSync(publicSrc('app.css'), 'utf8');
	const lines = cssSource.split('\n');
	let firstMeaningfulLine;
	let inBlockComment = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') continue;
		if (inBlockComment) {
			if (line.includes('*/')) inBlockComment = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inBlockComment = true;
			continue;
		}
		firstMeaningfulLine = line;
		break;
	}
	assert.equal(firstMeaningfulLine, "@import '@votetorrent/ui-web/tokens.css';", 'the first non-comment, non-blank line must be exactly the canonical import');

	const occurrences = cssSource.match(/@import\s+['"]@votetorrent\/ui-web\/tokens\.css['"]/g) ?? [];
	assert.equal(occurrences.length, 1, `expected exactly one canonical tokens import, found ${occurrences.length}`);

	assert.doesNotMatch(cssSource, /:root/, 'app.css must declare no :root block');
	assert.doesNotMatch(cssSource, /^\s*--/m, 'app.css must declare no custom property');
});

test('positive control: a stylesheet with the import positioned AFTER a layout rule would fail the position assertion', () => {
	const wrongOrder = ".foo { color: red; }\n@import '@votetorrent/ui-web/tokens.css';\n";
	const lines = wrongOrder.split('\n').map((l) => l.trim()).filter((l) => l !== '');
	assert.notEqual(lines[0], "@import '@votetorrent/ui-web/tokens.css';", 'sanity: proves position, not mere presence, is what this assertion checks');
});

// ---------------------------------------------------------------------------
// 6. The declared browser gate (the D-21 hook).
// ---------------------------------------------------------------------------
// 53-09 repoints test:browser from 53-06's `node test/browser/run-gate.mjs`
// stub to a real invocation of the shared runner
// (packages/ui-web/scripts/run-ui-gates.mjs, D-19) — a script that lives
// OUTSIDE test/browser/, unlike the legacy stub this assertion originally
// governed. This rung now accepts EITHER shape: a legacy-style direct
// invocation of a file under test/browser/, or a shared-runner invocation
// naming `run-ui-gates.mjs` (asserted to exist on disk) plus a
// `--gate-entry <file>` value that itself resolves under test/browser/ — so
// a future accidental revert to a missing/broken legacy path is still
// caught, and so is a shared-runner invocation whose `--gate-entry` names a
// harness file that was never actually created.
test('package.json declares a test:browser script naming a real gate target that exists on disk (either a legacy test/browser/ file, or the shared run-ui-gates.mjs runner plus a --gate-entry harness file under test/browser/)', () => {
	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	assert.ok('test:browser' in manifest.scripts, 'package.json scripts must declare test:browser');
	const scriptValue = manifest.scripts['test:browser'];

	const legacyMatch = scriptValue.match(/test\/browser\/([\w.-]+)/);
	if (legacyMatch) {
		const targetPath = publicRoot('test', 'browser', legacyMatch[1]);
		assert.ok(existsSync(targetPath), `test:browser's declared target ${targetPath} does not exist on disk — a declared script pointing at a missing file is exactly the failure this catches`);
		return;
	}

	assert.match(scriptValue, /run-ui-gates\.mjs/, `test:browser script value "${scriptValue}" names neither a test/browser/ path nor the shared run-ui-gates.mjs runner`);
	const runnerPath = path.join(repoRoot, 'packages', 'ui-web', 'scripts', 'run-ui-gates.mjs');
	assert.ok(existsSync(runnerPath), `the shared runner ${runnerPath} does not exist on disk`);

	const gateEntryMatch = scriptValue.match(/--gate-entry\s+(\S+)/);
	assert.ok(gateEntryMatch, `test:browser script value "${scriptValue}" invokes run-ui-gates.mjs but names no --gate-entry`);
	const entryPath = publicRoot('test', 'browser', gateEntryMatch[1]);
	assert.ok(existsSync(entryPath), `test:browser's --gate-entry target ${entryPath} does not exist on disk`);
});

test('inertness control: a --gate-entry value naming a nonexistent file would fail the assertion above', () => {
	const fixtureScript = 'node ../../packages/ui-web/scripts/run-ui-gates.mjs --app . --gate-entry nonexistent-gate.html';
	const gateEntryMatch = fixtureScript.match(/--gate-entry\s+(\S+)/);
	assert.ok(gateEntryMatch);
	const entryPath = publicRoot('test', 'browser', gateEntryMatch[1]);
	assert.equal(existsSync(entryPath), false, 'sanity: this fixture path must not exist, or the control proves nothing');
});

// ---------------------------------------------------------------------------
// 7. Standing dangerouslySetInnerHTML absence scan.
// ---------------------------------------------------------------------------
const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE, 'matcher is inert');
});

test('no file under src/ uses the raw-HTML-injection escape hatch (this lands before 53-07 introduces URL-derived input for ElectionShell to be dangerous with)', () => {
	const files = walkAll(publicSrc());
	const offenders = [];
	for (const file of files) {
		const stripped = stripComments(readFileSync(file, 'utf8'));
		if (RAW_HTML_ESCAPE_HATCH_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files use the raw-HTML-injection escape hatch: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 8. No prose in the chrome.
// ---------------------------------------------------------------------------
const JSX_TEXT_RUN_RE = /[>][^<>{}]*[A-Za-z]{2,}[^<>{}]*[<]/;

test('positive control: the JSX-text-run matcher fires on a planted text run', () => {
	assert.match('<div>Hello world</div>', JSX_TEXT_RUN_RE, 'matcher is inert against a planted JSX text run');
});

test('benign control: the matcher does not fire on text that lives only inside an attribute or an expression container', () => {
	const benign = '<div className="public-app">{children}</div>';
	assert.doesNotMatch(benign, JSX_TEXT_RUN_RE, 'matcher must not fire on attribute values or expression containers');
});

test('AppChrome.tsx renders no JSX text run (D-08 admits only the public.* keys 53-07 actually mounts)', () => {
	const source = readFileSync(publicSrc('screens', 'AppChrome.tsx'), 'utf8');
	const offendingLines = source.split('\n').filter((line) => JSX_TEXT_RUN_RE.test(line));
	assert.deepEqual(offendingLines, [], `AppChrome.tsx contains a JSX text run: ${JSON.stringify(offendingLines)}`);
});

// ---------------------------------------------------------------------------
// 9. No control byte in any source file under src/ (54-11).
//
// Found the hard way rather than anticipated: a stray NUL byte reached a React
// `key` template literal in `ElectionIndex.tsx`. It ran correctly and typechecked
// clean, and git classified the whole .tsx file as BINARY -- so every future
// diff of that file would have shown "Bin 5898 -> 6012 bytes" and nothing else,
// and every source scan in this repo that reads it as text could behave
// differently from the one that wrote it. A source tree that cannot be diffed
// is a source tree whose review is decorative.
//
// The scan covers every byte below 0x20 except tab, newline and carriage
// return, plus DEL -- none of which has any business in a .ts/.tsx/.js/.css
// file in this app.
// ---------------------------------------------------------------------------

const CONTROL_BYTE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

test('positive control: the control-byte matcher fires on a planted NUL, on a planted vertical tab and on a planted DEL', () => {
	for (const [label, planted] of [
		['NUL', `const key = \`\${a}\u0000\${b}\`;`],
		['vertical tab', 'const s = "a\u000Bb";'],
		['DEL', 'const s = "a\u007Fb";'],
	]) {
		assert.match(planted, CONTROL_BYTE_RE, `the matcher is inert against a planted ${label}`);
	}
});

test('benign control: the matcher does not fire on tabs, newlines or carriage returns, which this repo\'s source is full of', () => {
	assert.doesNotMatch('\tconst x = 1;\r\n\tconst y = 2;\n', CONTROL_BYTE_RE, 'the matcher would condemn ordinary indented source');
});

test('no source file under src/ contains a control byte -- a NUL in a template literal makes git treat the whole file as binary, hiding every future diff of it', () => {
	const files = walkAll(publicSrc());
	assert.ok(files.length > 0, 'sanity: expected at least one file under src/');
	const offenders = [];
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		const m = source.match(CONTROL_BYTE_RE);
		if (m) {
			const index = source.indexOf(m[0]);
			const line = source.slice(0, index).split('\n').length;
			offenders.push(`${file}:${line} (U+${m[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()})`);
		}
	}
	assert.deepEqual(offenders, [], `these source files contain a control byte: ${offenders.join(', ')}`);
});
