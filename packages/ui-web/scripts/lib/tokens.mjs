#!/usr/bin/env node
/**
 * tokens.mjs — browser-free, unit-testable parsing and comparison for the
 * D-23 token probe. `run-ui-gates.mjs` is the only caller that ever combines
 * this module's output with a real `getComputedStyle` reading; everything
 * here is pure string/Map manipulation so it can be exhaustively unit-tested
 * without a browser (`test/tokens-parse.test.mjs`).
 */

/**
 * @typedef {{ tokens: Map<string, string>, bodyRule: Map<string, string>, rootDeclarationLineCount: number, hasRegisteredProperty: boolean }} ParsedTokens
 */

/**
 * Parses `packages/ui-web/src/tokens.css`'s shape: a leading block comment,
 * a single `:root { ... }` block of `--name: value;` custom-property
 * declarations (group comments may sit INSIDE that block, per the file's own
 * header — comments are stripped before any parsing below), and a `body {
 * ... }` rule the D-23 probe's base-rule checks read separately.
 *
 * @param {string} source
 * @returns {ParsedTokens}
 */
export function parseTokensCss(source) {
	// Strip /* ... */ comments first — they appear both above and inside
	// :root in this file, and must never be mistaken for a declaration.
	const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');

	// Collect every :root { ... } block (the file has one; this loop does not
	// assume that, so a future second :root block is still parsed correctly).
	const rootBlocks = [];
	const rootRe = /:root\s*\{([\s\S]*?)\}/g;
	let rootMatch;
	while ((rootMatch = rootRe.exec(noComments)) !== null) {
		rootBlocks.push(rootMatch[1]);
	}
	const rootText = rootBlocks.join('\n');

	/** @type {Map<string, string>} */
	const tokens = new Map();
	const declRe = /--([A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
	let declMatch;
	while ((declMatch = declRe.exec(rootText)) !== null) {
		const name = `--${declMatch[1]}`;
		const value = declMatch[2].trim();
		// A repeated name is last-wins — Map.set overwrites in place.
		tokens.set(name, value);
	}

	// An INDEPENDENTLY derived count: every line (inside the comment-stripped
	// :root block(s)) that looks like the start of a custom-property
	// declaration. Two independent parses that must agree is what makes "the
	// declaration parser silently returned nothing" (or silently merged two
	// declarations onto one line) detectable — see guard (b) in
	// run-ui-gates.mjs's token-declared-values rung.
	const lineRe = /^[ \t]*--[A-Za-z0-9-]+[ \t]*:/gm;
	const rootDeclarationLineCount = (rootText.match(lineRe) ?? []).length;

	// The body { ... } rule, matched only when "body" is a STANDALONE
	// selector immediately preceded (mod whitespace) by the end of the prior
	// rule or the start of the file — this is what keeps the earlier
	// "html,\nbody,\n#root {" compound selector list from being mistaken for
	// the rule this probe actually wants.
	/** @type {Map<string, string>} */
	const bodyRule = new Map();
	const bodyRuleRe = /(?:^|\})\s*body\s*\{([\s\S]*?)\}/;
	const bodyMatch = noComments.match(bodyRuleRe);
	if (bodyMatch) {
		const bodyDeclRe = /([a-zA-Z-]+)\s*:\s*([^;]+);/g;
		let bodyDeclMatch;
		while ((bodyDeclMatch = bodyDeclRe.exec(bodyMatch[1])) !== null) {
			bodyRule.set(bodyDeclMatch[1].trim(), bodyDeclMatch[2].trim());
		}
	}

	const hasRegisteredProperty = /@property\b/.test(noComments);

	return { tokens, bodyRule, rootDeclarationLineCount, hasRegisteredProperty };
}

/**
 * The ONLY normalisation ever applied to a declared-value comparison,
 * applied identically to both sides of every comparison in this module. It
 * absorbs whitespace differences in the token stream a browser round-trips
 * (notably `--font-family`'s comma-separated list) and nothing else: it
 * cannot make an absent token (`''`) equal any non-empty declared value, and
 * it cannot make `#0d0f14` equal `#0d0f15` — see
 * `test/tokens-parse.test.mjs` cases (4)-(6) for both directions of that
 * proof.
 *
 * @param {string} value
 * @returns {string}
 */
export function normaliseTokenValue(value) {
	return value.trim().replace(/\s+/g, ' ');
}

/**
 * One strict equality. No disjunct, no fallback, no `!== ''` — this is the
 * shape `gate-source-integrity.test.mjs` asserts against this function's own
 * source text.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {{ passed: boolean }}
 */
export function compareToken(expected, actual) {
	const passed = normaliseTokenValue(actual) === normaliseTokenValue(expected);
	return { passed };
}

/**
 * Converts a `#rgb`/`#rrggbb` hex colour to Chrome's `getComputedStyle`
 * serialisation for an opaque colour, `rgb(R, G, B)`. Throws on anything
 * else — a base-rule check keyed to a non-hex token value is a setup error,
 * not a value this function should silently coerce.
 *
 * @param {string} hex
 * @returns {string}
 */
export function hexToRgb(hex) {
	const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!match) {
		throw new Error(`hexToRgb: "${hex}" is not a #rgb or #rrggbb hex colour`);
	}
	let digits = match[1];
	if (digits.length === 3) {
		digits = digits
			.split('')
			.map((c) => c + c)
			.join('');
	}
	const r = parseInt(digits.slice(0, 2), 16);
	const g = parseInt(digits.slice(2, 4), 16);
	const b = parseInt(digits.slice(4, 6), 16);
	return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The D-15 base/reset half (the "tokens are declared but the base rules that
 * consume them did not travel" failure mode). Each entry's EXPECTED value is
 * derived from the parsed tokens map at run time by `run-ui-gates.mjs`,
 * never written out here — so a token value change propagates automatically
 * and no value is duplicated anywhere in this file or that one.
 *
 * `getComputedStyle` normalisation this deliberately encodes: *used* values
 * are normalised by the rendering engine (colours serialise to `rgb()`,
 * lengths keep their unit), which is why these three go through an explicit
 * per-entry normaliser, whereas the token rung above compares raw declared
 * strings for *unregistered* custom properties, whose computed value is
 * simply the specified token stream, unnormalised.
 *
 * `line-height` and the shorthand `background` property are deliberately
 * excluded: their computed forms (`21px`, and a longhand expansion) are
 * engine-normalised in ways that would need value-specific allowances this
 * probe does not carry.
 *
 * @type {ReadonlyArray<{ id: string, cssProperty: string, token: string, normaliser: 'hexToRgb' | 'identity' }>}
 */
export const BASE_RULE_CHECKS = Object.freeze([
	Object.freeze({ id: 'body-background', cssProperty: 'backgroundColor', token: '--bg', normaliser: 'hexToRgb' }),
	Object.freeze({ id: 'body-color', cssProperty: 'color', token: '--text', normaliser: 'hexToRgb' }),
	Object.freeze({ id: 'body-font-size', cssProperty: 'fontSize', token: '--font-body-size', normaliser: 'identity' }),
]);
