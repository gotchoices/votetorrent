/**
 * Guard: no Authority screen or component may render a raw engine error text.
 *
 * Scope: src/screens and src/components (non-test). src/engines is out of
 * scope (dev proofs and logging; device-signer's module-resolution error is
 * developer-facing).
 *
 * The scanned pattern is assembled from pieces so this file cannot match it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { STRICT_RAW_ERROR_FILES } from '../__fixtures__/strict-raw-error-files';

const SRC = path.resolve(__dirname, '..', '..');
const ROOTS = ['screens', 'components'];

const RAW = new RegExp(
	['instanceof Error \\? ', '[A-Za-z_.]+', '\\.message : ', 'String\\('].join(''),
);
const ALLOWED_MARKERS = ['peerUnavailable' + 'Message(', 'outcome.' + 'message ??'];

/** file (relative to src, posix) + trimmed line text -> reason. */
export const EXCEPTIONS: ReadonlyArray<{ file: string; text: string; reason: string }> = [
	{
		file: 'screens/elections/election-error-messages.ts',
		text: 'const raw = err instanceof Error ? err.message : String(err);',
		reason: 'regex-matched to classify, never rendered',
	},
];

function walk(dir: string, out: string[]): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '__tests__') continue;
			walk(p, out);
		} else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
			out.push(p);
		}
	}
}

export function scan(files: string[], exceptions = EXCEPTIONS) {
	const violations: string[] = [];
	const used = new Set<number>();
	for (const f of files) {
		const rel = path.relative(SRC, f).split(path.sep).join('/');
		for (const [i, line] of fs.readFileSync(f, 'utf8').split('\n').entries()) {
			if (!RAW.test(line)) continue;
			if (ALLOWED_MARKERS.some((m) => line.includes(m))) continue;
			const t = line.trim();
			const idx = exceptions.findIndex((x) => x.file === rel && x.text === t);
			if (idx >= 0) {
				used.add(idx);
				continue;
			}
			violations.push(`${rel}:${i + 1}: ${t}`);
		}
	}
	return { violations, used };
}

function allFiles(): string[] {
	const files: string[] = [];
	for (const r of ROOTS) walk(path.join(SRC, r), files);
	return files;
}

describe('raw error message guard', () => {
	it('scans a non-empty file set', () => {
		expect(allFiles().length).toBeGreaterThan(0);
	});

	it('has no unclassified raw error message site', () => {
		expect(scan(allFiles()).violations).toEqual([]);
	});

	it('has no stale exception', () => {
		const { used } = scan(allFiles());
		const stale = EXCEPTIONS.filter((_, i) => !used.has(i)).map((x) => `${x.file}: ${x.text}`);
		expect(stale).toEqual([]);
		expect(EXCEPTIONS).toHaveLength(1);
		for (const x of EXCEPTIONS) expect(x.reason.length).toBeGreaterThan(0);
	});
});

// strict-guard:begin
// The strict describe: the WHOLE Authority app, every non-test source file. Entries below are
// keys and prose only, never line text, so this section cannot match its own patterns (the
// self-scan test proves it). Never run a formatter on this file: one entry per source line.
import * as crypto from 'crypto';

export type Hit = { file: string; line: number; key: string; text: string };
export type ExemptFile = { file: string; reason: string };
export type ExemptLine = { file: string; key: string; count: number; reason: string };
export type Lists = {
	EXEMPT_FILES?: ExemptFile[];
	EXEMPT_LINES?: ExemptLine[];
};

const MSG = 'mess' + 'age';
const NAME_BASE = '\\w*(?:[Ee]rr|[Ee]rror|[Cc]ause|[Rr]eason)\\w*|e|e2|ex|caught';
const R1 = new RegExp('instanceof ' + 'Error \\? [\\w$.?]+\\.' + MSG);
const R5_A = '.errors' + '().map(';

function nameAlt(extra: string[]): string {
	return '(?:' + [NAME_BASE, ...extra].join('|') + ')';
}

function patternsFor(extra: string[]): RegExp[] {
	const n = nameAlt(extra);
	const BANG = '(?:!|\\?)?';
	return [
		R1,
		// String(x), String(x as Error), String(x ?? "y")
		new RegExp('String\\(\\s*' + n + '\\b'),
		// x.message, x?.message, x!.message
		new RegExp('\\b' + n + BANG + '\\.' + MSG),
		// (x as Error).message, (x as Error)!.message
		new RegExp('\\)' + BANG + '\\.' + MSG),
		new RegExp('\\$\\{' + n + '\\}'),
		// x["message"], x['message']
		new RegExp('\\b' + n + BANG + '\\[\\s*["\']' + MSG + '["\']\\s*\\]'),
		// x.toString()
		new RegExp('\\b' + n + BANG + '\\.to' + 'String\\('),
		// JSON.stringify(x)
		new RegExp('JSON\\.str' + 'ingify\\(\\s*' + n + '\\b'),
		// "Failed: " + x
		new RegExp('\\+\\s*' + n + '\\b(?!\\s*[.([])'),
		// const { message } = x
		new RegExp('\\{\\s*' + MSG + '\\s*\\}\\s*='),
	];
}

/** The top-level comma of a bracket span's contents, or -1 (strings and nesting skipped). */
function topLevelComma(inner: string): number {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === "'" || c === '"' || c === '`') {
			let j = i + 1;
			while (j < inner.length && inner[j] !== c) j += inner[j] === '\\' ? 2 : 1;
			i = j;
		} else if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') depth--;
		else if (c === ',' && depth === 0) return i;
	}
	return -1;
}

const PARAM_HEAD = /^(?:async\s+)?(?:function\s*[\w$]*\s*)?\(?\s*([A-Za-z_$][\w$]*)/;

function catchBoundNames(text: string): string[] {
	const out = new Set<string>();
	const re = /catch\s*\(\s*([A-Za-z_$][\w$]*)/g;
	for (let m = re.exec(text); m; m = re.exec(text)) out.add(m[1]);
	const re2 = /\.catch\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:=>|\)|:|,)/g;
	for (let m = re2.exec(text); m; m = re2.exec(text)) out.add(m[1]);
	// .then(ok, (problem) => ...): the rejection callback's parameter
	const re3 = /\.then\(/g;
	for (let m = re3.exec(text); m; m = re3.exec(text)) {
		const open = m.index + m[0].length - 1;
		const close = findClose(text, open);
		if (close < 0) continue;
		const inner = text.slice(open + 1, close);
		const comma = topLevelComma(inner);
		if (comma < 0) continue;
		const p = PARAM_HEAD.exec(inner.slice(comma + 1).trimStart());
		if (p) out.add(p[1]);
	}
	// onError: (problem) => ..., onError={(problem) => ...}, onFailure = (problem) => ..., onError(problem) { ... }
	const re4 = /\bon(?:Error|Fail|Failure|Reject|Rejected)\s*[:=]\s*\{?\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?\(?\s*([A-Za-z_$][\w$]*)/g;
	for (let m = re4.exec(text); m; m = re4.exec(text)) out.add(m[1]);
	const re5 = /\bon(?:Error|Fail|Failure|Reject|Rejected)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*\{/g;
	for (let m = re5.exec(text); m; m = re5.exec(text)) out.add(m[1]);
	return [...out];
}

export function lineKey(line: string): string {
	const norm = line.trim().replace(/\s+/g, ' ');
	return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/**
 * Index of the bracket closing the one at `open`, or -1. A small character scanner, not a regex:
 * the contents of single-quoted and double-quoted strings (one line, backslash escapes honoured),
 * of template strings (may span lines, contents opaque) and of comments never move the depth.
 */
function findClose(text: string, open: number): number {
	const n = text.length;
	let depth = 0;
	for (let i = open; i < n; i++) {
		const c = text[i];
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
			i = j;
		} else if (c === '`') {
			let j = i + 1;
			while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
			if (j >= n) return -1;
			i = j;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const j = text.indexOf('*/', i + 2);
			if (j < 0) return -1;
			i = j + 1;
		} else if (c === '(' || c === '[' || c === '{') {
			depth++;
		} else if (c === ')' || c === ']' || c === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Blank the argument span of every console call to spaces, keeping newlines. */
export function blankConsoleSpans(text: string): { text: string; unclosed: number } {
	const chars = text.split('');
	let unclosed = 0;
	const re = /console\.(?:log|warn|error|info|debug)\(/g;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const open = m.index + m[0].length - 1;
		const close = findClose(text, open);
		if (close < 0) {
			unclosed++;
			continue;
		}
		for (let i = open + 1; i < close; i++) if (chars[i] !== '\n') chars[i] = ' ';
		re.lastIndex = close + 1;
	}
	return { text: chars.join(''), unclosed };
}

export function scanTextFull(relPath: string, text: string): { hits: Hit[]; unclosed: number } {
	const { text: blanked, unclosed } = blankConsoleSpans(text);
	const pats = patternsFor(catchBoundNames(text));
	const orig = text.split('\n');
	const hits: Hit[] = [];
	for (const [i, line] of blanked.split('\n').entries()) {
		const t = line.trim();
		if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
		// Same-line block comments (including JSX `{/* ... */}`) are prose, never a render.
		const code = line.replace(/\/\*.*?\*\//g, ' ');
		const hit = pats.some((p) => p.test(code)) || (code.includes(R5_A) && code.includes('.' + MSG));
		if (hit) hits.push({ file: relPath, line: i + 1, key: lineKey(orig[i]), text: orig[i].trim() });
	}
	return { hits, unclosed };
}

export function scanText(relPath: string, text: string): Hit[] {
	return scanTextFull(relPath, text).hits;
}

// The strict (C12) screens: one shared list, never a local copy (a drifted copy named four paths
// that did not exist, so those screens could be exempted unnoticed).
const C12_FILES: readonly string[] = STRICT_RAW_ERROR_FILES;

export function classify(hits: Hit[], lists: Lists, scannedFileCount: number): string[] {
	const failures: string[] = [];
	const exemptFiles = lists.EXEMPT_FILES ?? [];
	const exemptLines = lists.EXEMPT_LINES ?? [];
	if (scannedFileCount <= 0) failures.push('zero files scanned');
	for (const x of exemptFiles) {
		if (!hits.some((h) => h.file === x.file)) failures.push(`stale EXEMPT_FILES entry (no hits): ${x.file}`);
	}
	const listed = (f: string, k: string) => exemptLines.filter((x) => x.file === f && x.key === k);
	const actual = new Map<string, Hit[]>();
	for (const h of hits) {
		if (exemptFiles.some((x) => x.file === h.file)) continue;
		const id = h.file + '\u0000' + h.key;
		actual.set(id, [...(actual.get(id) ?? []), h]);
	}
	for (const [id, hs] of actual) {
		const [f, k] = id.split('\u0000');
		const entries = listed(f, k);
		if (entries.length === 0) {
			for (const h of hs) failures.push(`unlisted ${h.file}:${h.line} key=${h.key} ${h.text}`);
		} else if (entries.length > 1 || entries[0].count !== hs.length) {
			failures.push(`count mismatch ${f} key=${k}: ${hs.length} hits, listed ${entries.map((e) => e.count).join('+')}`);
		}
	}
	for (const e of exemptLines) {
		if (!actual.has(e.file + '\u0000' + e.key)) failures.push(`stale entry ${e.file} key=${e.key}`);
	}
	for (const x of [...exemptFiles, ...exemptLines]) {
		if (C12_FILES.includes(x.file)) failures.push(`C12 file must not be exempt: ${x.file}`);
	}
	return failures;
}

const SKIP_DIRS = ['__tests__', '__fixtures__', '__mocks__'];

function walkAll(dir: string, out: string[]): void {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (!SKIP_DIRS.includes(e.name)) walkAll(p, out);
		} else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
			out.push(p);
		}
	}
}

export function scanTree(rootDir: string, lists: Lists): { failures: string[]; hits: Hit[]; files: number } {
	const files: string[] = [];
	walkAll(rootDir, files);
	const hits: Hit[] = [];
	const failures: string[] = [];
	for (const f of files) {
		const rel = path.relative(rootDir, f).split(path.sep).join('/');
		const r = scanTextFull(rel, fs.readFileSync(f, 'utf8'));
		hits.push(...r.hits);
		if (r.unclosed > 0) failures.push(`unclosed console call in ${rel}`);
	}
	failures.push(...classify(hits, lists, files.length));
	return { failures, hits, files: files.length };
}

export const EXEMPT_FILES: ExemptFile[] = [
	{ file: 'engines/replication-proof-runner.ts', reason: 'dev proof harness, imported only from a gated proof runner, never rendered' },
	{ file: 'engines/noise-crypto-parity-probe.ts', reason: 'dev probe, imported only behind a development flag, never rendered' },
	{ file: 'engines/dial-probe.ts', reason: 'dev probe, imported only behind a development flag, never rendered' },
	{ file: 'engines/persistence-proof.ts', reason: 'dev proof, imported only by its proof runner, never rendered' },
	{ file: 'engines/strand-persistence-proof-runner.ts', reason: 'dev proof runner, started only behind a development flag, never rendered' },
	{ file: 'engines/recovery-branch-proof.ts', reason: 'dev proof, imported only by its proof runner, never rendered' },
];
export const EXEMPT_LINES: ExemptLine[] = [
	{ file: 'engines/control-schema-recovery.ts', key: 'c42d2f971c7320c8', count: 1, reason: 'matches the boot error chain against fixed patterns to choose a recovery; the text is never rendered or returned' },
	{ file: 'engines/device-signer.ts', key: 'e71aa10492f070ee', count: 1, reason: 'developer-facing text inside a thrown error for an unlinked native module; every screen maps it through the shared error copy' },
	{ file: 'screens/authorities/AuthorityDetailsScreen.tsx', key: 'e5fdcc7f513d08cb', count: 1, reason: 'reads the failure only to detect the not-found case, never rendered' },
	{ file: 'screens/elections/election-error-messages.ts', key: 'd7eb40dd0c9ea05d', count: 1, reason: 'matched against constraint patterns to classify, never returned' },
	{ file: 'screens/registration/continuity-review.ts', key: '7c59e887d021bca7', count: 1, reason: 'error subclass constructor whose reason is a closed union of fixed tokens; the message is never rendered' },
	{ file: 'screens/settings/SettingsScreen.tsx', key: 'f79afbba4990186c', count: 1, reason: 'debug seed control, rendered only in development builds' },
	{ file: 'screens/users/RevokeKeyScreen.tsx', key: '1e730b284ab023c7', count: 1, reason: 'substring classification of the failure, never rendered' },
];

describe('strict: no raw error text anywhere in the Authority app', () => {
	it('has no unlisted, stale or miscounted raw error render', () => {
		const r = scanTree(SRC, { EXEMPT_FILES, EXEMPT_LINES });
		expect(r.files).toBeGreaterThan(0);
		expect(r.failures).toEqual([]);
	});
});

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'raw-error');
const FIXTURE_NAMES = [
	'n01-instanceof-ternary',
	'n04-cast-message',
	'n05-optional-message',
	'n06-catch-bound-name',
	'n07-template',
	'n08-console-same-line',
	'n09-string-name',
	'n10-builder-join',
	'n12-duplicated-exempt-line',
	'n13-unbalanced-paren-in-console-string',
	'n14-non-null-message',
	'n15-bracket-message',
	'n16-destructured-message',
	'n17-to-string',
	'n18-string-cast',
	'n19-string-coalesce',
	'n20-concat',
	'n21-json-stringify',
	'n22-then-reject-param',
	'n23-on-error-callback',
].map((n) => n + '.fixture.txt');
// fixture name -> the line (1-based) that must be hit; undefined = the last line
const RENDER_LINE: Record<string, number> = {
	'n08-console-same-line.fixture.txt': 1,
	'n13-unbalanced-paren-in-console-string.fixture.txt': 3,
};

describe('strict guard self-test', () => {
	it('keeps exactly the committed negative-control fixtures', () => {
		expect(fs.readdirSync(FIXTURE_DIR).sort()).toEqual([...FIXTURE_NAMES].sort());
	});

	it.each(FIXTURE_NAMES.filter((n) => !n.startsWith('n12')))('catches %s on its render line', (name) => {
		const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
		const hits = scanText(name, text);
		expect(hits.length).toBeGreaterThan(0);
		const want = RENDER_LINE[name] ?? text.replace(/\n$/, '').split('\n').length;
		expect(hits.map((h) => h.line)).toContain(want);
	});

	it('flags a duplicated exempt line as a count mismatch (2 hits, listed 1)', () => {
		const name = 'n12-duplicated-exempt-line.fixture.txt';
		const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
		const hits = scanText(name, text);
		expect(hits).toHaveLength(2);
		const failures = classify(
			hits,
			{ EXEMPT_LINES: [{ file: name, key: lineKey(text.split('\n')[0]), count: 1, reason: 'self-test' }] },
			1,
		);
		expect(failures.some((f) => f.includes('count mismatch'))).toBe(true);
	});

	it('every C12 file exists, so the never-exempt rule can match it', () => {
		expect(C12_FILES.length).toBeGreaterThan(0);
		const missing = C12_FILES.filter((f) => !fs.existsSync(path.join(SRC, f)));
		expect(missing).toEqual([]);
	});

	it.each([...C12_FILES])('refuses an exemption naming the C12 file %s', (file) => {
		const asFile = classify([], { EXEMPT_FILES: [{ file, reason: 'self-test' }] }, 1);
		expect(asFile).toContain(`C12 file must not be exempt: ${file}`);
		const asLine = classify([], { EXEMPT_LINES: [{ file, key: '0000000000000000', count: 1, reason: 'self-test' }] }, 1);
		expect(asLine).toContain(`C12 file must not be exempt: ${file}`);
	});

	it('ignores a same-line block comment but still sees the code beside it', () => {
		expect(scanText('c.tsx', '{/* field + InlineError */}')).toEqual([]);
		expect(scanText('c.tsx', 'setX(err.' + MSG + '); /* note */')).toHaveLength(1);
	});

	it('scans its own strict section to zero hits', () => {
		const src = fs.readFileSync(__filename, 'utf8').split('\n');
		const begin = src.indexOf('// strict-guard' + ':begin');
		const end = src.indexOf('// strict-guard' + ':end');
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(begin);
		expect(scanText('self', src.slice(begin, end + 1).join('\n'))).toEqual([]);
	});
});
// strict-guard:end
