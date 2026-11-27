/**
 * @format
 *
 * T-62-28-01 (62-SECURITY.md, Open Threats) - the continuity screens must not write error text,
 * error objects, or any evidence / code / identity value to device logs. Every console call in
 * the target files may carry only string literals and `errorClassName(<identifier>)`.
 *
 * Scoped to an EXPLICIT file list on purpose, so it cannot drift into flagging unrelated logging
 * elsewhere in the app. Modelled on `no-client-identity-persistence.test.ts`.
 *
 * Self-tripping-checker trap: every matcher runs on COMMENT-STRIPPED source, and the planted
 * fixtures below prove each forbidden shape can fire and each allowed shape cannot. No assertion
 * reads this test file's own text.
 */
import * as fs from 'fs';
import * as path from 'path';

const APP_ROOT = path.resolve(__dirname, '..');

const TARGET_FILES = [
	'src/screens/registration/ContinueOnAnotherDeviceScreen.tsx',
	'src/screens/registration/ConfirmationScreen.tsx',
];

/** Strip comments while preserving line numbers (block comments keep their newlines). */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
		.replace(/\/\/.*$/gm, '');
}

interface ConsoleCall {
	method: string;
	line: number;
	index: number;
	args: string | null; // null => unparseable
}

const CALL_RE = /\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/g;

/** Walk from just after an opening paren to its match; skips strings. Returns end index or -1. */
function scanBalanced(src: string, start: number): number {
	let depth = 1;
	let i = start;
	while (i < src.length) {
		const c = src[i];
		if (c === "'" || c === '"' || c === '`') {
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === '\\') i++;
				i++;
			}
			if (i >= src.length) return -1;
		} else if (c === '(' || c === '[' || c === '{') {
			depth++;
		} else if (c === ')' || c === ']' || c === '}') {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

function lineOf(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

function findConsoleCalls(stripped: string): ConsoleCall[] {
	const calls: ConsoleCall[] = [];
	CALL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CALL_RE.exec(stripped)) !== null) {
		const open = m.index + m[0].length;
		const end = scanBalanced(stripped, open);
		calls.push({
			method: m[1],
			line: lineOf(stripped, m.index),
			index: m.index,
			args: end === -1 ? null : stripped.slice(open, end),
		});
	}
	return calls;
}

function splitTopLevelArgs(argText: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (let i = 0; i < argText.length; i++) {
		const c = argText[i];
		if (c === "'" || c === '"' || c === '`') {
			cur += c;
			i++;
			while (i < argText.length && argText[i] !== c) {
				if (argText[i] === '\\') {
					cur += argText[i];
					i++;
				}
				cur += argText[i] ?? '';
				i++;
			}
			cur += c;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') depth++;
		if (c === ')' || c === ']' || c === '}') depth--;
		if (c === ',' && depth === 0) {
			out.push(cur.trim());
			cur = '';
		} else {
			cur += c;
		}
	}
	if (cur.trim() !== '') out.push(cur.trim());
	return out;
}

function isStringLiteral(arg: string): boolean {
	const q = arg[0];
	if (arg.length < 2 || arg[arg.length - 1] !== q) return false;
	if (q !== "'" && q !== '"' && q !== '`') return false;
	// Ensure the closing quote is the first unescaped one (a single complete literal).
	for (let i = 1; i < arg.length - 1; i++) {
		if (arg[i] === '\\') {
			i++;
			continue;
		}
		if (arg[i] === q) return false;
	}
	if (q === '`' && arg.includes('${')) return false;
	return true;
}

const CLASS_NAME_RE = /^errorClassName\(\s*[A-Za-z_$][\w$]*\s*\)$/;

function isAllowedArg(arg: string): boolean {
	return isStringLiteral(arg) || CLASS_NAME_RE.test(arg);
}

function scanFile(stripped: string): string[] {
	const offenders: string[] = [];
	const calls = findConsoleCalls(stripped);
	for (const call of calls) {
		if (call.args === null) {
			offenders.push(`line ${call.line}: console.${call.method}(<unparseable>)`);
			continue;
		}
		const args = splitTopLevelArgs(call.args);
		if (args.some(a => !isAllowedArg(a))) {
			offenders.push(`line ${call.line}: console.${call.method}(${call.args.replace(/\s+/g, ' ').trim()})`);
		}
	}
	// Any `console` token that is not the start of a parsed call (aliasing, bracket access).
	const parsedStarts = new Set(calls.map(c => c.index));
	const tokenRe = /\bconsole\b/g;
	let t: RegExpExecArray | null;
	while ((t = tokenRe.exec(stripped)) !== null) {
		if (!parsedStarts.has(t.index)) {
			offenders.push(`line ${lineOf(stripped, t.index)}: unparsed console reference`);
		}
	}
	return offenders;
}

function scanSynthetic(source: string): string[] {
	return scanFile(stripComments(source));
}

describe('no error text in continuity-screen logs (T-62-28-01)', () => {
	test('the scoped file list resolves and is non-empty', () => {
		expect(TARGET_FILES.length).toBeGreaterThan(0);
		for (const rel of TARGET_FILES) {
			expect(fs.existsSync(path.join(APP_ROOT, rel))).toBe(true);
		}
	});

	test('non-vacuity: each target parses at least one console call, and every console token is a parsed call', () => {
		for (const rel of TARGET_FILES) {
			const stripped = stripComments(fs.readFileSync(path.join(APP_ROOT, rel), 'utf8'));
			const calls = findConsoleCalls(stripped);
			const tokens = (stripped.match(/\bconsole\b/g) ?? []).length;
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.length).toBe(tokens);
		}
	});

	test('every console call in the targets carries only string literals or errorClassName(<identifier>)', () => {
		const offenders: string[] = [];
		for (const rel of TARGET_FILES) {
			const stripped = stripComments(fs.readFileSync(path.join(APP_ROOT, rel), 'utf8'));
			for (const o of scanFile(stripped)) offenders.push(`${rel} ${o}`);
		}
		expect(offenders).toEqual([]);
	});
});

describe('planted-fixture self-test (each matcher can fire, and cannot over-fire)', () => {
	const forbidden: Array<[string, string]> = [
		['raw err', "console.error('X: failed:', err);"],
		['raw fallbackErr', "console.error('X: failed:', fallbackErr);"],
		['template literal interpolation', 'console.error(`X: ${err}`);'],
		['err.message', "console.error('X', err.message);"],
		['String(err)', "console.error('X', String(err));"],
		['JSON.stringify(evidence)', "console.error('X', JSON.stringify(evidence));"],
		['bare code identifier', "console.error('X', code);"],
		['errorClassName with member access', "console.error('X', errorClassName(err.cause));"],
		['call split across lines', "console.error(\n\t'X',\n\terr,\n);"],
		['aliased console method', 'const log = console.error;'],
		['bracket access', "console['error']('X');"],
		['unterminated call', "console.error('X', err"],
	];
	for (const [name, src] of forbidden) {
		test(`reports: ${name}`, () => {
			expect(scanSynthetic(src).length).toBeGreaterThan(0);
		});
	}

	const allowed: Array<[string, string]> = [
		['fixed string plus errorClassName', "console.error('X: submit failed:', errorClassName(err));"],
		['single fixed string', "console.warn('continuity: code availability read failed');"],
		['string with commas and parens then helper', "console.error('a, b (c), d', errorClassName(err));"],
		['line comment mention', "// console.error('x', err);\nconst a = 1;"],
		['block comment mention', "/* console.error('x', err);\n console.log(code); */\nconst a = 1;"],
	];
	for (const [name, src] of allowed) {
		test(`does not report: ${name}`, () => {
			expect(scanSynthetic(src)).toEqual([]);
		});
	}

	test('multi-line fixture reports the line of its console token', () => {
		const out = scanSynthetic("const a = 1;\n\nconsole.error(\n\t'X',\n\terr,\n);");
		expect(out.length).toBe(1);
		expect(out[0]).toMatch(/^line 3:/);
	});
});
