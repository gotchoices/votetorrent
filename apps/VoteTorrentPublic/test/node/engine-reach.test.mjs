/**
 * engine-reach.test.mjs — the tier-1, pre-build half, RECONCILED WITH D-01.
 *
 * Runs before any build, so it catches the INTENT rather than the artefact
 * (`scripts/assert-engine-reach.mjs`'s post-build scan is the expensive,
 * artefact-level half).
 *
 * WHAT THIS FILE CLAIMS, AND WHAT IT STOPPED CLAIMING (54-10, I-02)
 * ----------------------------------------------------------------
 * Phase 53 built this as D-13's tier-1 half: "the public app opens no
 * database". D-01 makes that FALSE ON PURPOSE — an anonymous reader's data
 * comes from an already-bootstrapped browser's own IndexedDB, so the public
 * page legitimately opens one.
 *
 * The claim is therefore narrowed, not dropped, to a DELEGATION RULE:
 *
 *   this app never opens a database ITSELF — every database primitive it
 *   uses arrives through `@votetorrent/web-data/public`, the audience-split
 *   entry D-04 makes structural.
 *
 * That is a strictly more useful claim than the one it replaces. It is also
 * the reason section 10 of `election-shell.test.mjs` could retire its own
 * boundary fence with ZERO loss of coverage on the four database-opening
 * primitives: this file enforced them independently, and still does — the
 * matcher's term list below is byte-for-byte the one it has always had.
 *
 * A DESIGN CONSTRAINT THIS FILE PLACES ON LATER WAVES
 * ---------------------------------------------------
 * The real IndexedDB read must go THROUGH `@votetorrent/web-data/public`.
 * If some later plan finds it MUST name one of these primitives directly in
 * the app, that is a design smell to raise, not a rung to silence.
 *
 * Every path is resolved through scripts/lib/source-paths.mjs's
 * `publicSrc(...)`/`publicRoot(...)`/`webDataRoot(...)` (53-01) — never
 * re-derived from `import.meta.url`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { publicSrc, publicRoot, webDataRoot } from '../../../../scripts/lib/source-paths.mjs';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';
import { enginePreflight } from '../../src/engine-preflight.js';

/**
 * The DELEGATION matcher. Its alternation is UNCHANGED from the
 * prohibition-era matcher it renames: same six terms, same word boundaries,
 * same two substring branches. Only the meaning of a hit changed — a match
 * no longer means "this app touched a database", it means "this app reached
 * AROUND `@votetorrent/web-data` instead of through it".
 *
 * It no longer mirrors any rung in `scripts/assert-engine-reach.mjs`: 54-10
 * retired that script's dist-level symbol scan, because esbuild renames bare
 * local bindings and an absence assertion on a renameable identifier can pass
 * on a bundle that genuinely contains the code. This is now the standalone
 * tier-1 delegation rule, and the artefact-level successor is that script's
 * module-graph privilege-surface negative.
 */
const DIRECT_DB_PRIMITIVE_RE = /\b(initDB|prepareDb|registerDbPlugins|isSchemaInitialized)\b|indexedDB|@quereus\/plugin-indexeddb/;

/** Same line-based comment-stripping idiom the repo's other tier-1 assertions use.
 * @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
			continue;
		}
		out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------------------
// 1. Positive control, first — the matcher must be able to detect the
//    forbidden symbols before it is trusted to scan real files.
// ---------------------------------------------------------------------------
test('positive control: the direct-DB-primitive matcher fires on a planted fixture containing each forbidden identifier', () => {
	const fixture =
		'import { initDB, prepareDb, registerDbPlugins, isSchemaInitialized } from "x";\n' +
		'const db = indexedDB;\nconst pkg = "@quereus/plugin-indexeddb";';
	for (const term of ['initDB', 'prepareDb', 'registerDbPlugins', 'isSchemaInitialized', 'indexedDB', '@quereus/plugin-indexeddb']) {
		assert.ok(fixture.includes(term), `fixture sanity: must literally contain "${term}"`);
	}
	assert.match(fixture, DIRECT_DB_PRIMITIVE_RE, 'matcher is inert against the planted fixture');
});

// ---------------------------------------------------------------------------
// 2. Benign controls — a matcher that fires on everything discriminates
//    nothing, and this app's own engine-preflight.js header comment
//    legitimately explains which symbols it refuses to import.
// ---------------------------------------------------------------------------
test('benign control: the matcher does not fire on a comment discussing the absence, once comments are stripped', () => {
	const commentOnly = [
		'// This module never calls initDB, prepareDb, registerDbPlugins or isSchemaInitialized.',
		'// It opens no indexedDB and declares no @quereus/plugin-indexeddb dependency.',
		'const x = 1;',
	].join('\n');
	assert.match(commentOnly, DIRECT_DB_PRIMITIVE_RE, 'sanity: the RAW comment text should still match (it names the words)');
	assert.doesNotMatch(stripCommentLines(commentOnly), DIRECT_DB_PRIMITIVE_RE, 'comment-stripped source must not trip the matcher');
});

test('benign control: the matcher does not fire on an identifier that merely contains a banned word as a substring', () => {
	const benign = 'const initDBValue = 1; const prepareDbConfigDefaults = {};';
	assert.doesNotMatch(benign, DIRECT_DB_PRIMITIVE_RE, 'matcher is indiscriminate against substring-only identifiers');
});

// ---------------------------------------------------------------------------
// 3. The delegation rule — every file under publicSrc(), comments stripped.
//
//    Two halves, and they only mean anything together: the app names no
//    database primitive of its own (3a), AND every specifier it uses to reach
//    the shared data package is the public subpath (3b). Without 3b the app
//    could satisfy 3a while importing the officer read surface; without 3a it
//    could import the right subpath and then hand-roll a raw handle anyway.
// ---------------------------------------------------------------------------
test('delegation rule: no file under src/ names a database primitive itself — the app reaches a database only THROUGH the shared package, never around it', () => {
	const srcRoot = publicSrc();
	const files = walkAll(srcRoot);
	assert.ok(files.length > 0, 'expected at least one file under src/');

	const offenders = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		const match = stripped.match(DIRECT_DB_PRIMITIVE_RE);
		if (match) {
			offenders.push(`${file}: "${match[0]}"`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'these files open a database DIRECTLY instead of delegating to the audience-split package — the app reached around ' +
			`@votetorrent/web-data instead of through it (D-01/D-04):\n${offenders.join('\n')}`,
	);
});

// -- 3b. The web-data subpath allowlist -------------------------------------
//
// The real subpath names are read from the landed manifest, never invented
// here: if the package ever renames its exports, this file fails loudly
// rather than silently allowlisting a specifier that no longer exists.
const WEB_DATA_MANIFEST = JSON.parse(readFileSync(webDataRoot('package.json'), 'utf8'));
const WEB_DATA_PACKAGE_NAME = WEB_DATA_MANIFEST.name;
const WEB_DATA_EXPORT_SUBPATHS = Object.keys(WEB_DATA_MANIFEST.exports ?? {});
const WEB_DATA_PUBLIC_SPECIFIER = `${WEB_DATA_PACKAGE_NAME}/public`;
const WEB_DATA_OFFICER_SPECIFIER = `${WEB_DATA_PACKAGE_NAME}/officer`;

/** Matches a static `from '...'`, a bare side-effect `import '...'` and a dynamic `import('...')`. */
const MODULE_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

/** @param {string} source @returns {string[]} every specifier that addresses the shared data package. */
function webDataSpecifiers(source) {
	/** @type {string[]} */
	const out = [];
	const re = new RegExp(MODULE_SPECIFIER_RE.source, 'g');
	let m;
	while ((m = re.exec(stripCommentLines(source)))) {
		const spec = m[1];
		if (spec === WEB_DATA_PACKAGE_NAME || spec.startsWith(`${WEB_DATA_PACKAGE_NAME}/`)) out.push(spec);
	}
	return out;
}

test('contract check: the shared data package really does publish the two subpaths this allowlist is written against', () => {
	assert.ok(WEB_DATA_EXPORT_SUBPATHS.includes('./public'), `expected ${WEB_DATA_PACKAGE_NAME} to export "./public", found: ${WEB_DATA_EXPORT_SUBPATHS.join(', ')}`);
	assert.ok(WEB_DATA_EXPORT_SUBPATHS.includes('./officer'), `expected ${WEB_DATA_PACKAGE_NAME} to export "./officer", found: ${WEB_DATA_EXPORT_SUBPATHS.join(', ')}`);
});

test('positive control: the subpath allowlist flags an officer-subpath specifier and a bare-package-root specifier', () => {
	const fixture = [
		`import { readKeyholders } from '${WEB_DATA_OFFICER_SPECIFIER}';`,
		`import { openDb } from '${WEB_DATA_PACKAGE_NAME}';`,
		`const late = await import('${WEB_DATA_OFFICER_SPECIFIER}');`,
	].join('\n');
	const found = webDataSpecifiers(fixture);
	assert.equal(found.length, 3, `expected three web-data specifiers, found: ${found.join(', ')}`);
	const disallowed = found.filter((s) => s !== WEB_DATA_PUBLIC_SPECIFIER);
	assert.equal(disallowed.length, 3, 'the allowlist is inert — it accepted an officer subpath or a bare package root');
});

test('benign control: the subpath allowlist accepts the public subpath and ignores unrelated specifiers', () => {
	const fixture = [
		`import { readElection } from '${WEB_DATA_PUBLIC_SPECIFIER}';`,
		"import { t } from '@votetorrent/ui-web';",
		"import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';",
	].join('\n');
	const found = webDataSpecifiers(fixture);
	assert.deepEqual(found, [WEB_DATA_PUBLIC_SPECIFIER], `expected exactly the public subpath, found: ${found.join(', ')}`);
	assert.deepEqual(found.filter((s) => s !== WEB_DATA_PUBLIC_SPECIFIER), []);
});

test('delegation rule: every shared-data-package specifier under src/ is the public subpath — never the officer subpath, never the bare package root', () => {
	// VACUOUSLY SATISFIED TODAY, and that is stated rather than hidden:
	// nothing under src/ imports the package yet, so this scan currently sees
	// an empty specifier set. Its two controls above are therefore the ONLY
	// thing proving it is live. It becomes load-bearing the moment the real
	// read lands, which is exactly why it is written now instead of then.
	const offenders = [];
	for (const file of walkAll(publicSrc())) {
		for (const spec of webDataSpecifiers(readFileSync(file, 'utf8'))) {
			if (spec !== WEB_DATA_PUBLIC_SPECIFIER) offenders.push(`${file}: "${spec}"`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'these files reach the shared data package by a specifier other than its public subpath. The audience split is what ' +
			`makes the anonymity guarantee structural rather than textual (D-04) — only ${WEB_DATA_PUBLIC_SPECIFIER} may ` +
			`appear under src/:\n${offenders.join('\n')}`,
	);
});

// ---------------------------------------------------------------------------
// 4. Manifest scan — the structural half of the control.
//
//    The banned list is UNCHANGED. Only the claim over it narrows: after
//    D-01 this app's dependency closure DOES transitively contain
//    IndexedDB-capable code (through the shared data package), so asserting
//    that it "declares none of the IndexedDB-capable packages" would be a
//    green gate over false words — the exact 53-D07 failure. What stays
//    true, and is worth asserting, is that it declares no DIRECT dependency
//    on any of them, so it cannot reach around the package to a raw handle.
// ---------------------------------------------------------------------------
/** Every package that can hand this app a raw database handle. UNCHANGED
 * from the list 54-10 wrote; only the claim over it moves. @type {ReadonlyArray<string>} */
const RAW_HANDLE_PACKAGES = Object.freeze([
	'@quereus/quereus',
	'@quereus/plugin-indexeddb',
	'@quereus/store',
	'@quereus/isolation',
	'@optimystic/quereus-plugin-crypto',
	'fake-indexeddb',
]);

/** The two the single-instance obligation forces into the manifest, admitted
 * ONLY on the condition asserted below. @type {ReadonlyArray<string>} */
const DEDUPE_ONLY_PACKAGES = Object.freeze(['@quereus/quereus', '@quereus/plugin-indexeddb']);

/**
 * AMENDMENT LEDGER (54-16). Two raw-handle packages are now admitted in
 * `devDependencies` ONLY, and the narrowing is deliberate rather than a
 * concession.
 *
 * Until 54-16 no fixture in this repo could seed `RegistrantPublic`:
 * `Registrant.SignatureValid` calls the crypto plugin FOR REAL — it has no
 * `context.IsSignatureValid` escape hatch — so a roll fixture must hold a
 * signing primitive, and a tier-1 suite must hold an IndexedDB shim to run at
 * all. Without them `readRegistrantRoll` stays parse-proven and never
 * data-proven, which is the coverage gap D-54-08-01 recorded.
 *
 * WHAT KEEPS THIS A RULE RATHER THAN A HOLE, in three parts:
 *   1. `dependencies` stays clean — asserted directly below. A test-only
 *      package that appears in `dependencies` is a production raw handle no
 *      matter which list it ALSO appears in.
 *   2. Nothing under `src/` may IMPORT either package — already asserted by
 *      section 4b's import scan, which covers every entry of
 *      `RAW_HANDLE_PACKAGES` including these two, in all three specifier forms,
 *      and has its own positive control. That scan is the real teeth: a
 *      manifest entry hands nobody a handle, an import does.
 *   3. Nothing under `src/` may import the fixtures that DO use them — D-17,
 *      asserted by `election-harness.test.mjs`.
 * @type {ReadonlyArray<string>}
 */
const TEST_ONLY_PACKAGES = Object.freeze(['@optimystic/quereus-plugin-crypto', 'fake-indexeddb']);

/**
 * The two manifest comparators, as pure functions over an already-parsed
 * manifest, so the controls below can exercise the SAME code the real check
 * runs rather than a re-implementation of it that could pass while the real one
 * is inert.
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} manifest
 * @returns {{ unexplained: string[], leakedToRuntime: string[] }}
 */
function rawHandleManifestOffenders(manifest) {
	const runtimeDeps = { ...(manifest.dependencies ?? {}) };
	const declared = { ...runtimeDeps, ...(manifest.devDependencies ?? {}) };
	const admitted = [...DEDUPE_ONLY_PACKAGES, ...TEST_ONLY_PACKAGES];
	return {
		unexplained: RAW_HANDLE_PACKAGES.filter((dep) => dep in declared && !admitted.includes(dep)),
		leakedToRuntime: TEST_ONLY_PACKAGES.filter((dep) => dep in runtimeDeps),
	};
}

test('positive control: the manifest comparators fire on an unadmitted raw-handle dependency and on a test-only package promoted into dependencies', () => {
	const unadmitted = rawHandleManifestOffenders({ dependencies: { '@quereus/store': '1.0.0' } });
	assert.deepEqual(
		unadmitted.unexplained,
		['@quereus/store'],
		'the unadmitted-dependency comparator is inert — it accepted a raw-handle package on no exemption at all',
	);

	const promoted = rawHandleManifestOffenders({ dependencies: { 'fake-indexeddb': '^6.2.5' } });
	assert.deepEqual(
		promoted.leakedToRuntime,
		['fake-indexeddb'],
		'the test-only comparator is inert — it accepted a fixture package sitting in production dependencies',
	);
});

test('benign control: the manifest comparators accept the app as it stands, with the test-only packages in devDependencies', () => {
	const benign = rawHandleManifestOffenders({
		dependencies: { '@quereus/quereus': '4.17.1', '@quereus/plugin-indexeddb': '4.17.1', react: '19.0.0' },
		devDependencies: { '@optimystic/quereus-plugin-crypto': '^0.27.0', 'fake-indexeddb': '^6.2.5' },
	});
	assert.deepEqual(benign, { unexplained: [], leakedToRuntime: [] });
});

test('the manifest declares no DIRECT dependency on a raw-handle package, EXCEPT the two the single-instance obligation forces — and each of those must appear in resolve.dedupe, which is the only reason it is admitted', () => {
	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
	const { unexplained, leakedToRuntime } = rawHandleManifestOffenders(manifest);

	assert.deepEqual(
		unexplained,
		[],
		`the manifest declares a DIRECT dependency that hands this app a raw database handle: ${unexplained.join(', ')}`,
	);

	// Part 1 of the ledger above: a test-only exemption is only an exemption
	// while the package stays OUT of `dependencies`. In `dependencies` it is a
	// production raw handle with a story attached.
	assert.deepEqual(
		leakedToRuntime,
		[],
		'these packages are admitted for TEST FIXTURES ONLY and must appear in devDependencies, never in ' +
			`dependencies: ${leakedToRuntime.join(', ')}`,
	);

	// The condition that makes the exemption a rule rather than a hole: a
	// dedupe-only dependency that is NOT in resolve.dedupe is just a raw-handle
	// dependency with a story attached.
	const viteConfig = stripCommentLines(readFileSync(publicRoot('vite.config.ts'), 'utf8'));
	const dedupeMatch = viteConfig.match(/dedupe:\s*\[([^\]]*)\]/);
	assert.ok(dedupeMatch, 'vite.config.ts declares no resolve.dedupe array at all — the exemption below would be unconditional');
	const dedupeEntries = dedupeMatch[1].split(',').map((piece) => piece.trim().replace(/^['"`]|['"`]$/g, ''));

	for (const dep of DEDUPE_ONLY_PACKAGES) {
		if (!(dep in declared)) continue;
		assert.ok(
			dedupeEntries.includes(dep),
			`"${dep}" is declared as a direct dependency but does not appear in resolve.dedupe. The ONLY sanctioned reason ` +
				'for this app to declare a raw-handle package is to give `dedupe` an entry it can resolve from the project ' +
				'root; without the dedupe entry it is simply a direct dependency on a raw handle.',
		);
	}
});

// ---------------------------------------------------------------------------
// 4b. The claim that actually carries the security content now (54-11).
//
// AMENDMENT LEDGER. Until 54-11 the manifest scan above was BOTH the story
// and the enforcement: nothing under `apps/VoteTorrentPublic/node_modules`
// resolved a quereus package, so no file under src/ could have imported one
// even if it tried. 54-11's `resolve.dedupe` obligation ends that — the two
// packages are now resolvable from this app — so the manifest scan alone
// would be a green gate over a claim it no longer enforces, which is the
// 53-D07 failure this file's own section-4 comment warns about.
//
// The replacement is strictly STRONGER for the threat that matters, because
// it measures the thing the threat is actually made of: an IMPORT. A manifest
// entry hands nobody a handle; an import does. This scan would also have
// caught a transitively-resolvable raw handle, which the manifest scan never
// could.
// ---------------------------------------------------------------------------

/** Matches a static `from '...'`, a bare side-effect `import '...'` and a dynamic `import('...')`. */
const ANY_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

/** @param {string} source @returns {string[]} every raw-handle package specifier in the source. */
function rawHandleSpecifiers(source) {
	/** @type {string[]} */
	const out = [];
	const re = new RegExp(ANY_SPECIFIER_RE.source, 'g');
	let m;
	while ((m = re.exec(stripCommentLines(source)))) {
		const spec = m[1];
		for (const pkg of RAW_HANDLE_PACKAGES) {
			if (spec === pkg || spec.startsWith(`${pkg}/`)) out.push(spec);
		}
	}
	return out;
}

test('positive control: the raw-handle import scan fires on a planted import of every package on the list, in all three specifier forms', () => {
	const planted = RAW_HANDLE_PACKAGES.map((pkg, i) => {
		if (i % 3 === 0) return `import { Database } from '${pkg}';`;
		if (i % 3 === 1) return `import '${pkg}/register';`;
		return `const late = await import('${pkg}');`;
	}).join('\n');
	const found = rawHandleSpecifiers(planted);
	assert.equal(found.length, RAW_HANDLE_PACKAGES.length, `the scan is inert — found ${found.length} of ${RAW_HANDLE_PACKAGES.length} planted imports`);
});

test('benign control: the raw-handle import scan ignores the specifiers this app legitimately uses, and does not fire on a comment naming one', () => {
	const benign = [
		"import { listNetworks } from '@votetorrent/web-data/public';",
		"import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';",
		"import { t } from '@votetorrent/ui-web';",
		"// this module never imports @quereus/quereus directly",
	].join('\n');
	assert.deepEqual(rawHandleSpecifiers(benign), []);
});

test('delegation rule: no file under src/ IMPORTS a raw-handle package — the two in the manifest exist for resolve.dedupe and are reached only THROUGH the shared data package', () => {
	const offenders = [];
	for (const file of walkAll(publicSrc())) {
		for (const spec of rawHandleSpecifiers(readFileSync(file, 'utf8'))) {
			offenders.push(`${file}: "${spec}"`);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		'these files import a raw-handle package directly instead of delegating to the audience-split package (D-01/D-04):\n' +
			offenders.join('\n'),
	);
});

// ---------------------------------------------------------------------------
// 5. The positive half, at tier 1 — engine-preflight.js's named import, and
//    the two counts that make its header rule MECHANICAL rather than
//    advisory. A wildcard is not the only way `UserEngine` could arrive: a
//    second named binding in the same brace list would do it just as well,
//    and nothing before 54-10 forbade one.
// ---------------------------------------------------------------------------
const NAMESPACE_IMPORT_RE = /import\s*\*\s*as\s+\w+\s+from/;

const PREFLIGHT_SOURCE_RAW = readFileSync(publicSrc('engine-preflight.js'), 'utf8');
const PREFLIGHT_SOURCE_STRIPPED = stripCommentLines(PREFLIGHT_SOURCE_RAW);

/** @param {string} strippedSource @returns {number} */
function countImportStatements(strippedSource) {
	return (strippedSource.match(/^[ \t]*import\b/gm) ?? []).length;
}

/** @param {string} strippedSource @returns {number} bindings inside the first `import { ... } from` brace list. */
function countNamedBindings(strippedSource) {
	const m = strippedSource.match(/import\s*\{([^}]*)\}\s*from/);
	if (!m) return 0;
	return m[1]
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0).length;
}

test('inertness control: the namespace-import matcher fires on a planted "import * as x from \'y\';" fixture', () => {
	assert.match("import * as x from 'y';", NAMESPACE_IMPORT_RE, 'matcher is inert against a planted namespace import');
});

test('positive control: the import counters fire on a planted two-import fixture and a planted two-binding fixture', () => {
	const twoImports = ["import { A } from 'x';", "import { B } from 'y';"].join('\n');
	assert.equal(countImportStatements(twoImports), 2, 'the import-statement counter is inert against a planted second import');

	const twoBindings = "import { VOTETORRENT_SCHEMA_SQL, UserEngine } from '@votetorrent/vote-engine/browser';";
	assert.equal(countNamedBindings(twoBindings), 2, 'the binding counter is inert against a planted second named binding');

	// And the counters agree with themselves on the one-of-each shape.
	const single = "import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';";
	assert.equal(countImportStatements(single), 1);
	assert.equal(countNamedBindings(single), 1);
});

test('engine-preflight.js names VOTETORRENT_SCHEMA_SQL via a named import and contains no namespace import', () => {
	assert.match(
		PREFLIGHT_SOURCE_RAW,
		/import\s*\{[^}]*\bVOTETORRENT_SCHEMA_SQL\b[^}]*\}\s*from\s*['"]@votetorrent\/vote-engine\/browser['"]/,
		'expected a named import of VOTETORRENT_SCHEMA_SQL from @votetorrent/vote-engine/browser',
	);
	assert.doesNotMatch(PREFLIGHT_SOURCE_RAW, NAMESPACE_IMPORT_RE, 'engine-preflight.js must not use a namespace import');
});

test('engine-preflight.js contains EXACTLY ONE import statement, whose brace list holds EXACTLY ONE binding — a second binding is how the privilege primitive would arrive without any wildcard', () => {
	assert.equal(
		countImportStatements(PREFLIGHT_SOURCE_STRIPPED),
		1,
		'engine-preflight.js must contain exactly one import statement — see its header: this module is the schema-reach probe and nothing else',
	);
	assert.equal(
		countNamedBindings(PREFLIGHT_SOURCE_STRIPPED),
		1,
		'engine-preflight.js must import exactly one named binding. A second one drags another export of the subpath into an ' +
			'anonymous page\'s bundle — the officer-scope primitive being the one that matters (D-01: public means no officer identity)',
	);
});

// ---------------------------------------------------------------------------
// 6. The live-value schema-reach assertion — the tier-1 successor to the
//    boundary fence election-shell.test.mjs retired in 54-10.
//
//    The fence proved only that this app had not yet started the next
//    phase's work, which stops being worth anything the moment the phase
//    starts. This proves something that stays true forever and is checkable
//    BEFORE any build: the schema import is real and WHOLE.
//
//    Both expectations are derived from the LIVE binding. No byte count and
//    no line count is written as a literal anywhere in this file, so the
//    assertion cannot drift into asserting a stale number.
// ---------------------------------------------------------------------------

/** The same short first line `scripts/assert-engine-reach.mjs` uses as its negative control. */
const SCHEMA_FIRST_LINE_FIXTURE = 'declare schema main';

test('enginePreflight() reports the LIVE schema value\'s own length and line count, and both are discriminated against a constant-foldable prefix', () => {
	const { schemaByteLength, schemaLineCount } = enginePreflight();

	assert.equal(schemaByteLength, VOTETORRENT_SCHEMA_SQL.length, 'schemaByteLength must equal the live binding\'s own length');
	assert.equal(schemaLineCount, VOTETORRENT_SCHEMA_SQL.split('\n').length, 'schemaLineCount must equal the live binding\'s own newline-split length');

	// The discriminating negative: a minifier that constant-folded the
	// schema's short first line while tree-shaking the real string away would
	// still satisfy an equality written against a literal. It cannot satisfy
	// this one.
	assert.ok(
		schemaByteLength > SCHEMA_FIRST_LINE_FIXTURE.length,
		`schemaByteLength (${schemaByteLength}) is no larger than the schema's own first line (${SCHEMA_FIRST_LINE_FIXTURE.length} chars) — ` +
			'the reported value is consistent with a constant-folded prefix rather than the whole schema',
	);
	assert.ok(schemaLineCount > 1, `schemaLineCount (${schemaLineCount}) is consistent with a single-line prefix rather than the whole schema`);
	assert.ok(VOTETORRENT_SCHEMA_SQL.startsWith(SCHEMA_FIRST_LINE_FIXTURE), 'fixture sanity: the negative control must really be the schema\'s own first line');
});

test('sanity: dist/ (if present from a prior local build) is not itself a src/ file walked above', () => {
	// Guards against a future refactor accidentally pointing publicSrc() at a
	// root that includes build output.
	const srcRoot = publicSrc();
	assert.ok(!srcRoot.includes(`${path.sep}dist${path.sep}`), 'publicSrc() must never resolve into dist/');
	// WR-12 (Phase 53 review): the prior `if (...) { assert.ok(true); }` block
	// was a literal no-op — it contributed to publicTier1's minPassing count
	// while asserting nothing. Assert what this test was presumably meant to:
	// publicSrc() resolves to a real, existing directory.
	assert.ok(statSync(srcRoot, { throwIfNoEntry: false })?.isDirectory(), `${srcRoot} must exist and be a directory`);
});
