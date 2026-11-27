/**
 * source-scan.mjs — the one scanning engine every gate in 54-08 shares.
 *
 * WHY IT IS A LIBRARY AND NOT FOUR NEAR-COPIES. Four gates in this package need
 * the same four primitives: strip comments, walk a source tree, extract module
 * specifiers, split a select list. Written four times they drift, and a drifted
 * matcher is how a gate quietly stops covering the thing it names. Written once,
 * a fix to the stripper fixes every gate, and every gate's positive control is
 * simultaneously a control for the others.
 *
 * THIS FILE IMPORTS `node:test` NOWHERE, deliberately. The package's test glob is
 * `test/*.test.mjs`; this module sits at `test/lib/` and is neither collected as a
 * suite nor named like one, so it can never be mistaken for a gate that passed.
 *
 * PROVENANCE / SCOPE. Test-and-script tooling only, in the same sense
 * `scripts/lib/source-paths.mjs` declares for itself: never imported by any `src/`
 * module, never reaching a production bundle. It reads bytes out of the working
 * tree and never writes them.
 *
 * REJECTED DEPENDENCY, recorded so it is not "restored" later: spike 090's
 * `closure.mjs` is NOT used by anything here (54-RESEARCH Pitfall 5). It follows
 * only relative specifiers and records a bare workspace specifier such as
 * `@votetorrent/web-data/public` as external — which is precisely the edge these
 * gates must cross — and it is a frozen historical spike record, so coupling a
 * product gate to it would make a historical artifact load-bearing.
 *
 * Deps: node:fs and node:path, plus `scripts/lib/strip-comments.mjs` (54-22) —
 * this module re-exports `stripComments` from there rather than holding a
 * second implementation; see that module's JSDoc for the full contract.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

/**
 * Re-exported, not re-implemented (54-22). The character-level,
 * quote-state-tracking stripper below used to live here; it now lives in
 * `scripts/lib/strip-comments.mjs` as the repository's single implementation,
 * and this module re-exports the same name so every existing importer of
 * `stripComments` from `test/lib/source-scan.mjs` keeps resolving unchanged.
 * D-05's anonymity scan (this package's own controls 3a/3b) is the proof that
 * TRANSFERS to the shared module rather than being re-derived — see that
 * module's JSDoc for the full behaviour contract, including the accepted
 * line-local-string-state limitation.
 *
 * @type {(source: string) => string}
 */
export { stripComments };

/**
 * Extensions a table name, a module specifier or a SQL string could be written
 * in as CODE. Every one of these is scanned.
 * @type {ReadonlyArray<string>}
 */
export const CODE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/**
 * Extensions a source scan may skip. Enumerated rather than implied by "not in
 * CODE_EXTENSIONS", so that a file type nobody thought about lands in `unknown`
 * and forces a decision instead of being silently skipped.
 *
 * EVERY ENTRY IS A DECISION, and the decision is always the same one: a file of
 * this type cannot reference a schema table as CODE, cannot declare a module
 * specifier, and cannot carry a SQL string a guard would need to read. The raster
 * image types are here because `apps/VoteTorrentAuthority/src/assets/images/`
 * holds three of them and rule C2 walks every product `src` root; skipping them
 * is correct, but it must be recorded here rather than implied by a catch-all.
 * A new type is NOT added to this list to make a red gate green — it is added
 * only after answering "could a table name be written in this file as code?".
 * @type {ReadonlyArray<string>}
 */
export const NON_CODE_EXTENSIONS = Object.freeze([
	'.css',
	'.html',
	'.md',
	'.json',
	'.svg',
	'.snap',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
]);

/**
 * Compound suffixes a source scan may skip, checked BEFORE the plain extension so the bare
 * extension stays unclassified (a stray `notes.txt` under a scan root still lands in `unknown`).
 *
 * Same decision as NON_CODE_EXTENSIONS, made per suffix:
 *  - `.fixture.txt`: the Authority's raw-error guard fixtures
 *    (`apps/VoteTorrentAuthority/src/screens/__tests__/__fixtures__/raw-error/`). They are text
 *    the guard reads with `readFileSync` and feeds to its scanner as a string; nothing compiles,
 *    imports or bundles them, so a table name in one is never code. They are `.txt` precisely so
 *    that no toolchain treats them as source.
 *  - `-license.txt`: a third-party licence shipped next to the asset it covers, today
 *    `apps/VoteTorrentAuthority/src/utils/qr/FINGERPRINT-ATLAS-LICENSE.txt` (the OFL text for the
 *    fingerprint glyph atlas). It is licence prose; a test reads it with `readFileSync` to pin its
 *    hash, and nothing compiles, imports or bundles it. Compared case-insensitively, so a bare
 *    `LICENSE.txt` (no prefix) stays unknown.
 * @type {ReadonlyArray<string>}
 */
export const NON_CODE_SUFFIXES = Object.freeze(['.fixture.txt', '-license.txt']);

/** Directory names never walked. */
const SKIP_DIRS = Object.freeze(['node_modules', 'dist', 'dist-gate', '.git']);

/** Thrown when a scan root holds a file whose extension is in neither list. */
export class UnknownExtensionError extends Error {
	/** @param {ReadonlyArray<string>} files */
	constructor(files) {
		super(
			`UnknownExtensionError: ${files.length} file(s) under a scan root have an extension in ` +
				`neither CODE_EXTENSIONS nor NON_CODE_EXTENSIONS, so the scan does not know whether to ` +
				`read them: ${files.join(', ')}. Classify the extension in source-scan.mjs deliberately; ` +
				`do NOT let it default to skipped.`,
		);
		this.name = 'UnknownExtensionError';
	}
}

/**
 * Thrown when an `exclude` entry passed to {@link scannedFilesFor} matches zero
 * files walked from `roots`. A stale exclusion is the mechanism by which a
 * moved or renamed file silently re-enters a scan it was meant to stay out of
 * (or, just as bad, an exclusion nobody notices has stopped doing anything) —
 * it must be loud rather than a permanently-inert no-op.
 */
export class StaleExclusionError extends Error {
	/** @param {string} entry */
	constructor(entry) {
		super(
			`StaleExclusionError: exclusion "${entry}" matched zero files under the given roots. ` +
				`Either the excluded path moved/was renamed and the exclusion is now dead, or it never ` +
				`matched anything. A stale exclusion is a hole nobody is watching — fix the entry or ` +
				`remove it; do not leave it in place unverified.`,
		);
		this.name = 'StaleExclusionError';
		this.entry = entry;
	}
}

/**
 * Does `file` fall under `exclusionEntry`, either as an exact match or as a
 * descendant of it treated as a directory? Comparison is on a path-separator
 * boundary, never a bare string prefix — `.../officer` must not exclude a
 * sibling `.../officer-notes.js` merely because the strings share a prefix.
 *
 * @param {string} file - an absolute path, as returned by {@link walkSourceFiles}
 * @param {string} exclusionEntry - an absolute path (file or directory)
 * @returns {boolean}
 */
function isExcludedBy(file, exclusionEntry) {
	if (file === exclusionEntry) return true;
	const dirPrefix = exclusionEntry.endsWith(path.sep) ? exclusionEntry : exclusionEntry + path.sep;
	return file.startsWith(dirPrefix);
}

/**
 * Partition a file list into what a scan reads, what it may skip, and what it
 * does not recognise.
 *
 * THE `unknown` BUCKET IS THE POINT. It closes the quietest inertness hole a
 * source scan has: someone adds a `.cts`, a `.vue` or an `.astro` under a scan
 * root, the scan silently stops covering that file, and the gate stays green
 * while its coverage shrinks. Callers MUST fail on a non-empty `unknown` rather
 * than logging it.
 *
 * @param {ReadonlyArray<string>} files
 * @returns {{ scanned: string[], skipped: string[], unknown: string[] }}
 */
export function partitionByExtension(files) {
	/** @type {{ scanned: string[], skipped: string[], unknown: string[] }} */
	const out = { scanned: [], skipped: [], unknown: [] };
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		const lower = path.basename(file).toLowerCase();
		if (NON_CODE_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length)) out.skipped.push(file);
		else if (CODE_EXTENSIONS.includes(ext)) out.scanned.push(file);
		else if (NON_CODE_EXTENSIONS.includes(ext)) out.skipped.push(file);
		else out.unknown.push(file);
	}
	return out;
}

/**
 * Every file under `root`, recursively, as absolute paths, sorted for a
 * deterministic report. Skips `node_modules`, `dist`, `dist-gate`, any
 * `dist-mutant-*` and `.git`.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function walkSourceFiles(root) {
	/** @type {string[]} */
	const found = [];
	/** @param {string} dir */
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('dist-mutant-')) continue;
				walk(path.join(dir, entry.name));
			} else if (entry.isFile()) {
				found.push(path.join(dir, entry.name));
			}
		}
	}
	if (!statSync(root).isDirectory()) throw new Error(`walkSourceFiles: not a directory: ${root}`);
	walk(root);
	return found.sort();
}

/** Static `import … from 'x'` and bare side-effect `import 'x'`. */
const STATIC_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
/** `export … from 'x'` including `export * from 'x'`. */
const EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g;
/** `import('x')` with a single string-literal argument. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
/** `import(` whose argument does NOT begin with a quote — a computed specifier. */
const DYNAMIC_COMPUTED_RE = /\bimport\s*\(\s*(?!['"])[^)]/g;
/** `require('x')`. */
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every module specifier a file declares, read from COMMENT-STRIPPED source.
 *
 * A computed dynamic import — an `import(` whose argument is not a single string
 * literal — is returned as `{ specifier: null, kind: 'dynamic-computed' }`.
 * Callers must treat that as a FAILURE TO ANALYSE, not as an absence: a gate
 * that silently ignores what it cannot parse is the inert kind, and a computed
 * specifier is exactly the laundering route a boundary rule exists to forbid.
 *
 * @param {string} source - raw source; this function strips comments itself.
 * @returns {Array<{ specifier: string | null, kind: string }>}
 */
export function moduleSpecifiersOf(source) {
	const code = stripComments(source);
	/** @type {Array<{ specifier: string | null, kind: string }>} */
	const found = [];
	/** @param {RegExp} re @param {string} kind */
	const collect = (re, kind) => {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(code)) !== null) found.push({ specifier: m[1], kind });
	};
	collect(STATIC_IMPORT_RE, 'static');
	collect(EXPORT_FROM_RE, 'export-from');
	collect(DYNAMIC_IMPORT_RE, 'dynamic');
	collect(REQUIRE_RE, 'require');
	DYNAMIC_COMPUTED_RE.lastIndex = 0;
	while (DYNAMIC_COMPUTED_RE.exec(code) !== null) found.push({ specifier: null, kind: 'dynamic-computed' });
	return found;
}

/**
 * Split a statement's select list into items, on commas at PARENTHESIS DEPTH 0,
 * so `count(*)` and any function call with arguments survives as one item.
 *
 * Reuses `selectListOf` from `src/classification.js` rather than reimplementing
 * it: one parser, one failure mode. `selectListOf` fails CLOSED (it throws
 * `UnparseableSelectError`), and this function inherits that.
 *
 * @param {string} sql
 * @param {(sql: string) => string} selectListOf - the shipped parser, injected so
 *   this module stays free of a `src/` import.
 * @returns {string[]}
 */
export function selectItemsOf(sql, selectListOf) {
	const list = selectListOf(sql);
	/** @type {string[]} */
	const items = [];
	let depth = 0;
	let buf = '';
	for (const c of list) {
		if (c === '(') depth += 1;
		else if (c === ')') depth -= 1;
		if (c === ',' && depth === 0) {
			items.push(buf.trim());
			buf = '';
			continue;
		}
		buf += c;
	}
	if (buf.trim().length > 0) items.push(buf.trim());
	const nonEmpty = items.filter((i) => i.length > 0);
	if (nonEmpty.length === 0) throw new Error(`selectItemsOf: empty select list parsed from: ${sql.slice(0, 80)}`);
	return nonEmpty;
}

/** Words that put the token after them in a SQL table position. */
const SQL_TABLE_KEYWORDS = Object.freeze(['from', 'join', 'into', 'update']);

/**
 * The exact sorted absolute file list a scan over `roots` would read, after
 * `exclude` is applied — the file-set half of what `scanForNames` does, split
 * out so a test can assert WHAT was scanned and not only what was found.
 *
 * `scanForNames` obtains its own file list from this function rather than
 * re-deriving one, so the two can never disagree — a second "what would be
 * scanned" implementation next to the real one is exactly how a gate quietly
 * narrows without anyone noticing.
 *
 * Order of operations, stated precisely because ambiguity here is how a gate
 * quietly narrows:
 *   1. Walk every root and partition ALL walked files by extension. This is
 *      unaffected by `exclude` — an unclassified extension inside an excluded
 *      directory still raises `UnknownExtensionError`. Coverage of the
 *      extension taxonomy is not something an exclusion may buy its way out of.
 *   2. Every entry in `exclude` must match at least one walked file (of any
 *      classification), or this throws `StaleExclusionError` naming the entry.
 *      A stale exclusion is the mechanism by which a moved file silently
 *      re-enters a scan, or an exclusion nobody notices stops doing anything.
 *   3. The `scanned` (code-extension) bucket is filtered by `exclude` and
 *      returned, sorted.
 *
 * Exclusion matching is by exact path equality or by directory containment on
 * a path-separator boundary — never a bare string prefix, so an entry naming
 * `.../officer` does not accidentally exclude a sibling `.../officer-notes.js`.
 *
 * AN EXCLUSION MUST HAVE A CONTROL PROVING IT IS LOAD-BEARING. This is not a
 * convention to remember — every caller that adds an entry to its own exclude
 * list must pair it with a test that copies the excluded content into an
 * otherwise-clean scan root and asserts the scan reports it. An exclusion with
 * no such control is unverifiable: nobody can tell "correctly excluded" from
 * "the matcher never looked here in the first place".
 *
 * @param {{ roots: ReadonlyArray<string>, exclude?: ReadonlyArray<string> }} args
 * @returns {string[]}
 */
export function scannedFilesFor({ roots, exclude = [] }) {
	/** @type {string[]} */
	const allWalked = [];
	for (const root of roots) allWalked.push(...walkSourceFiles(root));

	const part = partitionByExtension(allWalked);
	if (part.unknown.length > 0) throw new UnknownExtensionError(part.unknown);

	for (const entry of exclude) {
		const matched = allWalked.some((file) => isExcludedBy(file, entry));
		if (!matched) throw new StaleExclusionError(entry);
	}

	return part.scanned.filter((file) => !exclude.some((entry) => isExcludedBy(file, entry))).sort();
}

/**
 * Walk `roots`, fail on any unrecognised extension, strip comments, and report
 * every occurrence of every name in `names` as a whole word.
 *
 * THE MATCHER IS THE BARE NAME, NOT A SQL-CONTEXT MATCHER, AND THAT IS
 * DELIBERATE. D-05's wording talks about `FROM`/`JOIN`/`INTO`/`UPDATE`; the bare
 * whole-word rule strictly SUBSUMES that wording, and the scan roots are small
 * enough (single-digit file counts) to afford the stricter rule. `sqlContext` is
 * DIAGNOSTIC ENRICHMENT ONLY — a reader of a failure wants to know whether the
 * hit was a query or a stray identifier. The gate fails on ANY occurrence. Do
 * not "restore" the weaker FROM/JOIN-only matcher: a forbidden table name
 * reaching the public source set as a bare identifier is the same leak by a
 * different spelling.
 *
 * `exclude` defaults to an empty array, so every existing call site keeps its
 * current behaviour with no edit. The file list itself comes from
 * {@link scannedFilesFor} — see that function's doc for the exclusion contract.
 *
 * @param {{ roots: ReadonlyArray<string>, names: ReadonlyArray<string>, exclude?: ReadonlyArray<string> }} args
 * @returns {Array<{ file: string, name: string, line: number, text: string, sqlContext: boolean }>}
 */
export function scanForNames({ roots, names, exclude = [] }) {
	/** @type {Array<{ file: string, name: string, line: number, text: string, sqlContext: boolean }>} */
	const offenders = [];
	const toScan = scannedFilesFor({ roots, exclude });

	const matchers = names.map((name) => /** @type {const} */ ([name, new RegExp(`\\b${name}\\b`)]));
	for (const file of toScan) {
		const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
		for (let i = 0; i < lines.length; i += 1) {
			const text = lines[i];
			if (text.length === 0) continue;
			for (const [name, re] of matchers) {
				if (!re.test(text)) continue;
				const before = text.slice(0, text.search(re)).toLowerCase();
				const sqlContext = SQL_TABLE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\s+$`).test(before));
				offenders.push({ file, name, line: i + 1, text: text.trim(), sqlContext });
			}
		}
	}
	return offenders;
}

/**
 * Same matcher as `scanForNames`, applied to an in-memory string. The controls
 * use this so a matcher fixture and the real scan cannot diverge.
 *
 * @param {string} source
 * @param {ReadonlyArray<string>} names
 * @returns {Array<{ name: string, line: number, text: string, sqlContext: boolean }>}
 */
export function scanSourceForNames(source, names) {
	/** @type {Array<{ name: string, line: number, text: string, sqlContext: boolean }>} */
	const hits = [];
	const lines = stripComments(source).split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const text = lines[i];
		for (const name of names) {
			const re = new RegExp(`\\b${name}\\b`);
			if (!re.test(text)) continue;
			const before = text.slice(0, text.search(re)).toLowerCase();
			const sqlContext = SQL_TABLE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\s+$`).test(before));
			hits.push({ name, line: i + 1, text: text.trim(), sqlContext });
		}
	}
	return hits;
}

/**
 * Strip `--` line comments from SQL, respecting single-quoted string literals so
 * a `--` inside a literal is preserved. Line count is preserved.
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripSqlComments(sql) {
	/** @type {string[]} */
	const out = [];
	for (const line of sql.split('\n')) {
		let buf = '';
		let i = 0;
		let inString = false;
		while (i < line.length) {
			const c = line[i];
			const c2 = i + 1 < line.length ? line[i + 1] : '';
			if (inString) {
				buf += c;
				if (c === "'") inString = false;
				i += 1;
				continue;
			}
			if (c === "'") {
				inString = true;
				buf += c;
				i += 1;
				continue;
			}
			if (c === '-' && c2 === '-') break;
			buf += c;
			i += 1;
		}
		out.push(buf);
	}
	return out.join('\n');
}
