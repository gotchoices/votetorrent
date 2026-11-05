/**
 * TransparencyStatsCard.negative-space.test.ts — the D-09 negative-space
 * source gate.
 *
 * A source gate, not a renderer test: reads `TransparencyStatsCard.tsx` and
 * `RejectReasonCard.tsx`, strips `//` line comments and `/* *\/` block
 * comments, then asserts zero case-insensitive word-boundary matches for the
 * evaluation-affordance vocabulary this phase forbids on the transparency
 * surface. The vocabulary deliberately excludes bare `rank` (a legitimate
 * substring in unrelated identifiers) and matches the list 48-05's and
 * 48-08's own negative-space gates enforce, so all three gates read as ONE
 * rule rather than three drifting ones.
 *
 * `RejectReasonCard.tsx` is included even though it is a different plan's
 * headline concern — both files ship in this plan, and neither may carry
 * this vocabulary.
 */

import fs from "fs";
import path from "path";

const TRANSPARENCY_CARD_SOURCE_PATH = path.join(__dirname, "../TransparencyStatsCard.tsx");
const REJECT_REASON_CARD_SOURCE_PATH = path.join(__dirname, "../RejectReasonCard.tsx");

const transparencyCardSource = fs.readFileSync(TRANSPARENCY_CARD_SOURCE_PATH, "utf8");
const rejectReasonCardSource = fs.readFileSync(REJECT_REASON_CARD_SOURCE_PATH, "utf8");

/**
 * Strips `/* *\/` block comments then `//` line comments. Order matters: a
 * block comment must be removed first so a `//` occurring INSIDE a block
 * comment is not mistaken for a line-comment opener once the block comment
 * is gone.
 */
function stripComments(src: string): string {
	const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, "");
	return withoutBlockComments.replace(/^\s*\/\/.*$/gm, "");
}

const FORBIDDEN_PATTERN = /\b(rating|ratings|score|scores|ranking|stars|thumbs)\b/i;
const FORBIDDEN_GLYPHS = ["star-half", "thumbs-up", "thumbs-down"];

describe("TransparencyStatsCard + RejectReasonCard — D-09 negative space", () => {
	test("1: TransparencyStatsCard.tsx contains no evaluation-affordance vocabulary once comments are stripped", () => {
		const stripped = stripComments(transparencyCardSource);
		const match = stripped.match(FORBIDDEN_PATTERN);
		expect(match).toBeNull();
	});

	test("2: RejectReasonCard.tsx contains no evaluation-affordance vocabulary once comments are stripped", () => {
		const stripped = stripComments(rejectReasonCardSource);
		const match = stripped.match(FORBIDDEN_PATTERN);
		expect(match).toBeNull();
	});

	test("3: the matcher is demonstrably live, not silently vacuous", () => {
		expect(stripComments("const rating = 5;")).toMatch(FORBIDDEN_PATTERN);
		expect(stripComments("// rating\nconst x = 1;")).not.toMatch(FORBIDDEN_PATTERN);
	});

	test("4: neither file contains a FontAwesome6 rating/thumbs glyph name (word-boundary matcher can't see these)", () => {
		for (const glyph of FORBIDDEN_GLYPHS) {
			expect(transparencyCardSource).not.toContain(glyph);
			expect(rejectReasonCardSource).not.toContain(glyph);
		}
	});

	test("5: bare 'rank' is intentionally NOT forbidden by this gate", () => {
		expect(stripComments("const rank = 1;")).not.toMatch(FORBIDDEN_PATTERN);
	});
});
