/**
 * private-tier-invariants — the executable form of Phase 47's "private-tier
 * values are never logged" and "salts are never displayed" rules (D-01,
 * D-12, T-47-02).
 *
 * These assertions are STRUCTURAL, not behavioral — they pin the SOURCE of
 * `PrivateFieldRow.tsx` and `SelectiveAudiencePreview.tsx` so a later edit
 * that introduces a diagnostic log line or a raw-leaf render fails a
 * Phase-47-named test rather than surviving review. Part A reads the
 * component source (via `fs.readFileSync`, mirroring
 * `foundingOfficerScopes.test.ts`'s source-text-gate idiom) and strips line
 * and block comments before matching, so a header comment describing the
 * constraint can never accidentally self-satisfy the gate. Part B renders
 * both components together and asserts over the combined tree.
 */

import * as fs from "fs";
import * as path from "path";
import React from "react";
import renderer from "react-test-renderer";
import type { DisclosedSelective, SelectiveLeaf } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		dark: false,
		colors: {
			primary: "#007AFF",
			background: "#FFFFFF",
			card: "#F2F2F7",
			text: "#000000",
			border: "#C6C6C8",
			notification: "#FF3B30",
			error: "#FF3B30",
			textSecondary: "#888888",
			accent: "#5856D6",
			warning: "#FF9500",
			success: "#34C759",
			dark: "#000000",
			light: "#FFFFFF",
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PrivateFieldRowModule = require("../PrivateFieldRow");
const PrivateFieldRow = PrivateFieldRowModule.PrivateFieldRow ?? PrivateFieldRowModule.default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SelectiveAudiencePreviewModule = require("../SelectiveAudiencePreview");
const SelectiveAudiencePreview =
	SelectiveAudiencePreviewModule.SelectiveAudiencePreview ?? SelectiveAudiencePreviewModule.default;

const PRIVATE_FIELD_ROW_PATH = path.join(__dirname, "../PrivateFieldRow.tsx");
const SELECTIVE_AUDIENCE_PREVIEW_PATH = path.join(__dirname, "../SelectiveAudiencePreview.tsx");

/**
 * Blanks out every comment span in a source string — line comments, block
 * comments and doc-comment header blocks — so a prose mention of a forbidden
 * token inside a comment can never trip, or HIDE a trip of, a gate meant to
 * catch it in real code.
 *
 * TOKENIZER, NOT A REGEX (47-REVIEW WR-12). The previous implementation was
 *
 *     source.replace(BLOCK_COMMENT_RE, "")
 *           .split("\n").map(l => l.replace(LINE_COMMENT_RE, "")).join("\n")
 *
 * and the `//`-stripping half truncated a line at the first `//` ANYWHERE,
 * including inside a string literal, a URL or a regex literal. One line of the
 * shape `const doc = "see https://x"; console.log(value);` would have been
 * silently cut before the `console.log` the gate exists to catch. The
 * block-comment half had the mirror-image problem: a `/*` inside a string
 * literal swallowed everything up to the next block-comment terminator. For a
 * test whose entire value is that it cannot be accidentally satisfied, a
 * stripper that can accidentally HIDE a violation is a real weakness.
 *
 * `@babel/parser` gives exact comment ranges. Each span is replaced with the
 * SAME number of spaces (newlines preserved) so byte offsets, line numbers and
 * line counts are unchanged — a match/no-match result stays attributable to a
 * real source location.
 *
 * 47-REVIEW WR-04: `@babel/parser` is now a DECLARED devDependency of this app.
 * It previously resolved only as a hoisted transitive of `@babel/core`, so a
 * Babel major, a yarn hoisting change or a `nohoist` would have turned this
 * repo's strongest privacy gate into a module-load crash rather than a check.
 * A parse failure is likewise reported as an explicit "the gate is NOT
 * running" error rather than as a raw SyntaxError, because the correct
 * response is to add the missing parser plugin, never to relax the gate.
 */
function stripComments(source: string): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { parse } = require("@babel/parser");
	let ast: { comments?: Array<{ start: number; end: number }> };
	try {
		ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	} catch (err) {
		throw new Error(
			"private-tier-invariants: could not parse the source under gate — the never-log " +
				"gate is NOT running. Add the missing @babel/parser plugin (decorators, `using` " +
				"declarations, a future TS/JSX syntax) rather than relaxing the gate. " +
				String(err)
		);
	}
	const comments: Array<{ start: number; end: number }> = ast.comments ?? [];
	let out = source;
	// Reverse order so earlier spans' offsets stay valid as we rewrite.
	for (const comment of [...comments].sort((a, b) => b.start - a.start)) {
		const span = out.slice(comment.start, comment.end);
		const blanked = span.replace(/[^\n]/g, " ");
		out = out.slice(0, comment.start) + blanked + out.slice(comment.end);
	}
	return out;
}

function readStripped(filePath: string): string {
	return stripComments(fs.readFileSync(filePath, "utf8"));
}

// Deliberately module scope, and deliberately NOT wrapped in a per-test lazy
// getter (47-REVIEW WR-04, secondary): if the parse fails, every source-text
// gate in this file is inoperative, so taking the whole suite down at import
// time is the correct blast radius. The failure mode that would actually be
// dangerous is a gate that still REPORTS green on unparsed or blanked-out
// input, and neither this nor stripComments' explicit throw can produce that.
const PRIVATE_SOURCE = readStripped(PRIVATE_FIELD_ROW_PATH);
const SELECTIVE_SOURCE = readStripped(SELECTIVE_AUDIENCE_PREVIEW_PATH);

describe("private-tier-invariants — Part 0: the comment stripper itself (WR-12)", () => {
	// This gate is only as strong as its stripper. The two cases below are the
	// exact ways the previous regex stripper could be DEFEATED — not merely made
	// noisy, but made to hide a real violation from every assertion in Part A.

	it("a `//` inside a string literal does not truncate the rest of the line", () => {
		const source = 'const doc = "see https://example.com"; console.log(value);\n';
		const stripped = stripComments(source);
		expect(stripped).toContain("console.log");
		expect(stripped).toContain("https://example.com");
	});

	it("a `/*` inside a string literal does not swallow the code that follows", () => {
		const source = 'const glob = "/*"; console.log(value);\nconst after = 1;\n';
		const stripped = stripComments(source);
		expect(stripped).toContain("console.log");
		expect(stripped).toContain("const after");
	});

	it("real comments ARE removed — line, trailing and block", () => {
		const source = [
			"// console.log(a)",
			"const x = 1; // console.log(b)",
			"/* console.log(c) */",
			"/**\n * console.log(d)\n */",
			"const y = 2;",
		].join("\n");
		const stripped = stripComments(source);
		expect(stripped).not.toContain("console.log");
		expect(stripped).toContain("const x = 1;");
		expect(stripped).toContain("const y = 2;");
	});

	it("offsets and line count are preserved, so a match stays attributable", () => {
		const source = "const a = 1; // comment\nconst b = 2;\n/* two\n   lines */\nconst c = 3;\n";
		const stripped = stripComments(source);
		expect(stripped.length).toBe(source.length);
		expect(stripped.split("\n").length).toBe(source.split("\n").length);
	});

	it("is non-vacuous against the real sources: they parse and are not blanked wholesale", () => {
		expect(PRIVATE_SOURCE).toContain("PrivateFieldRow");
		expect(SELECTIVE_SOURCE).toContain("SelectiveAudiencePreview");
	});

	it("@babel/parser is a DECLARED dependency, not a hoisted transitive (WR-04)", () => {
		// The stripper hard-depends on it. Resolving it only through
		// @babel/core's dependency tree meant a Babel major, a yarn hoisting
		// change or a `nohoist` would turn this gate into a module-load crash
		// rather than a check.
		const pkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "../../../../../package.json"), "utf8")
		);
		const declared = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
		expect(declared).toContain("@babel/parser");
	});

	it("an unparseable source throws the 'gate is NOT running' error, never a silent pass (WR-04)", () => {
		// A future syntax outside the two configured plugins (decorators,
		// `using` declarations) must be attributable, and must never be able to
		// make a Part A assertion pass on blanked-out or partial input.
		expect(() => stripComments("const x = @@@ ;")).toThrow(/the never-log gate is NOT running/);
		expect(() => stripComments("const x = @@@ ;")).toThrow(/@babel\/parser plugin/);
	});
});

describe("private-tier-invariants — Part A: source-text gates (D-01/D-12/T-47-02)", () => {
	it("neither private-tier component writes to the debug console", () => {
		expect((PRIVATE_SOURCE.match(/console\s*\./g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/console\s*\./g) ?? []).length).toBe(0);
	});

	it("PrivateFieldRow binds no value into a translated string", () => {
		expect((PRIVATE_SOURCE.match(/\bt\([^)]*,/g) ?? []).length).toBe(0);
	});

	it("PrivateFieldRow declares no error state and no serialization", () => {
		expect(PRIVATE_SOURCE).not.toMatch(/errorMessage/);
		expect(PRIVATE_SOURCE).not.toMatch(/\bcatch\b/);
		expect(PRIVATE_SOURCE).not.toMatch(/JSON\.stringify/);
		expect(PRIVATE_SOURCE).not.toMatch(/onError/);
	});

	it("PrivateFieldRow exposes no retraction callback (D-14)", () => {
		expect(PRIVATE_SOURCE).not.toMatch(/onHide/);
		expect(PRIVATE_SOURCE).not.toMatch(/onConceal/);
		expect(PRIVATE_SOURCE).not.toMatch(/onRetract/);
		expect(PRIVATE_SOURCE).not.toMatch(/onUnreveal/);
		expect(PRIVATE_SOURCE).not.toMatch(/onMask/);
	});

	it("PrivateFieldRow declares a 44x44 tap target", () => {
		expect(PRIVATE_SOURCE).toMatch(/minWidth:\s*44/);
		expect(PRIVATE_SOURCE).toMatch(/minHeight:\s*44/);
		expect(PRIVATE_SOURCE).toMatch(/hitSlop/);
	});

	it("SelectiveAudiencePreview never dereferences a salt or a hidden digest", () => {
		expect((SELECTIVE_SOURCE.match(/\.salt\b/g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/\.hidden\b/g) ?? []).length).toBe(0);
		expect((SELECTIVE_SOURCE.match(/SALT_KEY_PATTERN/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("neither component imports an engine, a scope hook, or navigation", () => {
		for (const source of [PRIVATE_SOURCE, SELECTIVE_SOURCE]) {
			expect(source).not.toMatch(/useCurrentOfficerScopes/);
			expect(source).not.toMatch(/useApp\b/);
			expect(source).not.toMatch(/EngineFactory/);
			expect(source).not.toMatch(/useNavigation/);
			expect(source).not.toMatch(/@votetorrent\/vote-engine/);
		}
	});
});

// ---------------------------------------------------------------------------
// Part B — rendered-tree gates
// ---------------------------------------------------------------------------

const SSN_SENTINEL = "123-45-6789";

const LEAVES: SelectiveLeaf[] = [
	{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" },
	{ name: "Email", value: "a@b.test", salt: "SALT_SENTINEL_EMAIL" },
	{ name: "Phone", value: "555-0100", salt: "SALT_SENTINEL_PHONE" },
];

const DISCLOSURE: DisclosedSelective = {
	cid: "cid1",
	root: "root1",
	disclosed: LEAVES,
	hidden: ["HIDDEN_DIGEST_SENTINEL"],
};

function renderCombined() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<>
				<PrivateFieldRow name="SSN" value={SSN_SENTINEL} onReveal={jest.fn()} />
				<SelectiveAudiencePreview
					leaves={LEAVES}
					selectedAudience={undefined}
					disclosure={DISCLOSURE}
					onSelectAudience={jest.fn()}
				/>
			</>
		);
	});
	return tr;
}

function pressPrivateToggle(tr: renderer.ReactTestRenderer) {
	const toggle = tr.root.findByProps({ testID: "private-field-toggle-SSN" });
	renderer.act(() => {
		toggle.props.onPress();
	});
}

function pressAudienceChip(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = wrapper.findAll((node) => typeof node.props.onPress === "function")[0];
	renderer.act(() => {
		pressable.props.onPress();
	});
}

describe("private-tier-invariants — Part B: rendered-tree gates (D-01/D-12)", () => {
	it("a masked private value and every salt are absent from the combined rendered tree", () => {
		const tr = renderCombined();
		const json = JSON.stringify(tr.toJSON());

		expect(json).not.toContain(SSN_SENTINEL);
		expect(json).not.toContain("SALT_SENTINEL_ADDRESS");
		expect(json).not.toContain("SALT_SENTINEL_EMAIL");
		expect(json).not.toContain("SALT_SENTINEL_PHONE");
		expect(json).not.toContain("HIDDEN_DIGEST_SENTINEL");
	});

	it("revealing the private field surfaces exactly that one value and still no salt", () => {
		const tr = renderCombined();
		pressPrivateToggle(tr);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(SSN_SENTINEL);
		expect(json).not.toContain("SALT_SENTINEL_ADDRESS");
		expect(json).not.toContain("SALT_SENTINEL_EMAIL");
		expect(json).not.toContain("SALT_SENTINEL_PHONE");
		expect(json).not.toContain("HIDDEN_DIGEST_SENTINEL");
	});

	it("no console method is called across the full combined interaction", () => {
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});

		const tr = renderCombined();
		pressPrivateToggle(tr); // reveal
		pressAudienceChip(tr, "selective-audience-chip-everyone");
		pressPrivateToggle(tr); // re-mask

		for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
			expect(spy).toHaveBeenCalledTimes(0);
			spy.mockRestore();
		}
	});
});
