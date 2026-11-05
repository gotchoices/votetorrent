#!/usr/bin/env node
//
// scripts/lib/strip-comments.mjs
//
// Purpose : the ONE character-level, quote-state-tracking comment stripper in
//           this repository. Relocated verbatim from
//           `packages/web-data/test/lib/source-scan.mjs`, where it was
//           written for D-05's anonymity scan and proved (control 3b) to
//           handle JSX comments correctly. `source-scan.mjs` now RE-EXPORTS
//           this function rather than holding a second copy, so every
//           existing importer of `stripComments` from that module keeps
//           resolving unchanged, and D-05's anonymity gate — the one scan in
//           this repo that must not silently change behaviour — is the proof
//           this relocation carries forward rather than re-derives.
//
//           This is a RELOCATION, not a rewrite: the logic below is
//           byte-identical to what shipped in `source-scan.mjs`. Any
//           behaviour change here would silently alter what D-05's scan sees.
//
// Modes   : imported as an ESM module. Not a CLI; has no `--selftest` entry
//           point of its own. Proven by `packages/web-data/test/anonymity-scan.test.mjs`'s
//           controls 3a/3b (via the re-export) and by
//           `packages/ui-web/test/strip-comments.test.mjs`'s per-form
//           positive controls (direct).
//
// Provenance / scope: test-and-script tooling only, in the same sense
//           `scripts/lib/source-paths.mjs` declares for itself — never
//           imported by any `src/` module, never reaching a production
//           bundle. It reads nothing itself; it transforms a string a caller
//           already read.
//
// Deps    : none.
//
// ---------------------------------------------------------------------------

/**
 * Remove every comment from JavaScript/TypeScript/JSX source, preserving line
 * count and line positions so a reported line number is true to the file.
 *
 * DELIBERATELY STRONGER than the whole-line stripper the repo's other scans use
 * (`assert-no-node-polyfills.mjs`, `election-shell.test.mjs`). Those drop a line
 * that STARTS with `//`, `*` or `/*`. 54-06's read modules explain D-14, D-19
 * and D-22 in prose, and some of that prose sits on the same line as code; a
 * whole-line stripper would leave those explanations visible to a matcher and
 * report the module's own reasoning as a violation.
 *
 * Removes:
 *   - block comments, including multi-line and the JSX brace-wrapped block form
 *   - whole-line `//` comments
 *   - TRAILING `//` comments that follow code on the same line
 *
 * Preserves: a `//` sequence inside a string literal. `https://…` inside a
 * quoted string is the case that actually occurs, and truncating there would
 * delete real code. The line scanner therefore tracks single-quote,
 * double-quote and backtick state with backslash escaping.
 *
 * ACCEPTED LIMITATION, stated so nobody discovers it as a surprise: string state
 * is LINE-LOCAL. A template literal that spans lines is scanned as ordinary code
 * on its continuation lines, so a `//` sequence inside a multi-line template
 * WOULD be stripped. This is accepted because SQL templates contain no `//`, and
 * 54-08's Task 1 planted-violation control plants its violation INSIDE a
 * multi-line template precisely to prove the stripper does not swallow real
 * template content. A regex literal containing `//` is the same accepted class.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
	/** @type {string[]} */
	const out = [];
	let inBlock = false;
	for (const line of source.split('\n')) {
		let buf = '';
		let i = 0;
		/** @type {string | null} */
		let quote = null;
		while (i < line.length) {
			const c = line[i];
			const c2 = i + 1 < line.length ? line[i + 1] : '';
			if (inBlock) {
				if (c === '*' && c2 === '/') {
					inBlock = false;
					i += 2;
					continue;
				}
				i += 1;
				continue;
			}
			if (quote !== null) {
				if (c === '\\') {
					buf += c + c2;
					i += 2;
					continue;
				}
				if (c === quote) {
					quote = null;
					buf += c;
					i += 1;
					continue;
				}
				buf += c;
				i += 1;
				continue;
			}
			if (c === '/' && c2 === '*') {
				inBlock = true;
				i += 2;
				continue;
			}
			if (c === '/' && c2 === '/') break; // rest of the line is a comment
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				buf += c;
				i += 1;
				continue;
			}
			buf += c;
			i += 1;
		}
		out.push(buf);
	}
	return out.join('\n');
}
