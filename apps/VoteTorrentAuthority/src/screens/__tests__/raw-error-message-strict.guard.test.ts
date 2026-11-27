/**
 * Strict guard: the approval, invitation, ballot, election and add-network screens never render
 * a caught error's message, with no allowance for a fallback after a helper (the wider guard in
 * raw-error-message-guard.test.ts permits those; these files do not use them).
 *
 * Every pattern is assembled from pieces so this file cannot match itself (checked by G-3).
 */
import * as fs from 'fs';
import * as path from 'path';
import { STRICT_RAW_ERROR_FILES } from '../__fixtures__/strict-raw-error-files';

const SRC = path.resolve(__dirname, '..', '..');

/** Files held to the strict rule, relative to src (shared with the whole-app guard's C12 check). */
export const STRICT_FILES: readonly string[] = STRICT_RAW_ERROR_FILES;

const CAUGHT = '(?:err|error|e|cause)';
// Patterns 2 and 3 are deliberately NOT anchored to a setter call on the same line (REVIEW
// WR-R5-03): `const m = err.message;` followed by `setError(m)`, or a setter whose argument sits on
// the next line, must fail too. These files never read a caught error's message or stringify a
// caught error anywhere, not even to classify it (the wider guard's helpers do that elsewhere).
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: 'error-or-string ternary', re: new RegExp(['instanceof Error', ' \\? ', '[A-Za-z_.]+', '\\.mess', 'age'].join('')) },
	{ name: 'String() of a caught error', re: new RegExp(['\\bStr', 'ing\\(\\s*', CAUGHT, '\\b'].join('')) },
	{ name: 'message of a caught error', re: new RegExp(['\\b', CAUGHT, '(?:!|\\?)?\\.mess', 'age'].join('')) },
	{ name: 'request id in a template literal', re: new RegExp(['`.*request', 'Id', '='].join('')) },
];

/** Allowed: the signing-error hook's own already-translated outcome. */
const ALLOWED = ['out', 'come.mess', 'age'].join('');

function isComment(trimmed: string): boolean {
	return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export function scanSource(source: string): string[] {
	const hits: string[] = [];
	for (const [i, line] of source.split('\n').entries()) {
		const t = line.trim();
		if (isComment(t)) continue;
		const probe = t.split(ALLOWED).join('');
		for (const p of PATTERNS) if (p.re.test(probe)) hits.push(`${i + 1}: [${p.name}] ${t}`);
	}
	return hits;
}

describe('strict raw error message guard', () => {
	it('G-1 no strict file renders an error message', () => {
		const violations: string[] = [];
		for (const rel of STRICT_FILES) {
			const abs = path.join(SRC, rel);
			expect(fs.existsSync(abs)).toBe(true);
			for (const h of scanSource(fs.readFileSync(abs, 'utf8'))) {
				violations.push(`${rel}:${h}`);
			}
		}
		expect(violations).toEqual([]);
	});

	// G-2: one control line per pattern, each matching ONLY its own pattern, so deleting or breaking
	// any single pattern turns its own case red (REVIEW WR-R5-03). Lines are assembled from pieces
	// so this file cannot match itself (G-3).
	const M = ['mess', 'age'].join('');
	const S = ['Str', 'ing'].join('');
	const RID = ['request', 'Id='].join('');
	const ONLY_ONE: ReadonlyArray<[string, string]> = [
		['error-or-string ternary', `setErrorMessage(failure instanceof Error ? failure.${M} : t("x"));`],
		['String() of a caught error', `setErrorMessage(${S}(err));`],
		['message of a caught error', `const m = err.${M};`],
		['request id in a template literal', 'const s = `sent ' + RID + '${id}`;'],
	];

	it.each(ONLY_ONE)('G-2 the "%s" pattern alone flags its control line', (name, line) => {
		expect(PATTERNS.map((p) => p.name)).toContain(name);
		const hits = scanSource(line);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toContain(`[${name}]`);
	});

	it('G-2 a caught message read on one line and rendered on the next is flagged', () => {
		const hits = scanSource(`const m = error.${M};\nsetError(m);`);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/^1: \[message of a caught error\]/);
	});

	it('G-2 a setter whose argument is on the next line is flagged', () => {
		const hits = scanSource(`setError(\n  ${S}(cause)\n);`);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatch(/^2: \[String\(\) of a caught error\]/);
	});

	it('G-2 the allowed already-translated outcome and a comment are not flagged', () => {
		expect(scanSource('setErrorMessage(' + ['out', 'come.mess', 'age'].join('') + ' ?? t("x"));')).toEqual([]);
		expect(scanSource(`// setErrorMessage(err.${M})`)).toEqual([]);
	});

	it('G-3 the guard source itself matches nothing', () => {
		expect(scanSource(fs.readFileSync(__filename, 'utf8'))).toEqual([]);
	});
});
