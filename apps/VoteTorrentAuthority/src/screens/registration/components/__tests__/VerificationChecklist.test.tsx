/**
 * VerificationChecklist.test.tsx — co-located coverage for the D-07
 * structured out-of-band verification checklist. `react-test-renderer`
 * only, file-scope module mocks — mirrors `RegistrantRow.test.tsx`'s
 * screen-local component test shape and `PrivateFieldRow.test.tsx`'s
 * 44x44/hitSlop assertion idiom.
 *
 * `@votetorrent/vote-core` is DELIBERATELY NOT MOCKED — the whole point of
 * this file is that the component is wired to 48-06's real
 * `isChecklistGateMet`/`canonicalizeVerificationChecklist`; mocking it would
 * make the delegation assertions vacuous. `yarn workspace
 * @votetorrent/vote-core build` must run before this suite: jest maps
 * `@votetorrent/vote-core` to `dist/src/index.js`, and this is the FIRST app
 * file to import VALUES (not just types) from that package — every
 * pre-existing app import of it is type-only and never exercised this path.
 *
 * ============================================================================
 * DECLARED BLIND SPOT (48-27) — a flex style in the tree is not proof of wrap.
 * ============================================================================
 * PROVEN here: every checklist label carries a flattened `flex: 1` in both
 * interactive and read-only modes, and no label anywhere in the source
 * carries a line-count truncation prop.
 *
 * NOT PROVEN, AND UNPROVABLE IN JEST: that the Spanish labels — in
 * particular "Comprobó contra el padrón electoral existente" (`roll`) and
 * the longer `eligibility` string — actually wrap inside the screen rather
 * than running past the right edge on a real device. `react-test-renderer`
 * has no layout engine and no text measurement, so a flex style in the tree
 * is evidence of intent, not of fit. This is the same substitution the UAT
 * identified as the reason 48-UAT.md gap 4 shipped in the first place.
 *
 * WHAT DISCHARGES IT: 48-29's on-device leg, walked in EN and then ES at the
 * same viewport — ES is the longer locale and was never walked before this
 * UAT.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";
import { StyleSheet, TouchableOpacity } from "react-native";
import * as fs from "fs";
import * as path from "path";
import { canonicalizeVerificationChecklist } from "@votetorrent/vote-core";
import type { RegistrationVerificationChecklistItem } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			success: "sentinel-success",
			warning: "sentinel-warning",
			error: "sentinel-error",
			accent: "sentinel-accent",
			card: "sentinel-card",
			textSecondary: "sentinel-textSecondary",
			text: "sentinel-text",
			border: "sentinel-border",
		},
	}),
}));

// Required AFTER the jest.mock() calls above — a static top-level `import` of
// a sibling that renders `TouchableOpacity` resolves against react-native's
// real module before the mocks above are wired, producing a "type is
// invalid" render crash (matches `RegistrantRow.test.tsx`'s convention).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VerificationChecklist } = require("../VerificationChecklist");

const PREFIX = "verification-checklist";
const ITEMS: RegistrationVerificationChecklistItem[] = ["id", "roll", "eligibility", "none"];

interface RenderOpts {
	checked?: RegistrationVerificationChecklistItem[];
	readOnly?: boolean;
	decidedAt?: string;
}

/**
 * Renders `VerificationChecklist` inside `renderer.act(...)` — required
 * under React 19's stricter act semantics (matches `RegistrantRow.test.tsx`/
 * `PrivateFieldRow.test.tsx`'s render helpers).
 */
function renderChecklist(opts: RenderOpts = {}) {
	const onChange = jest.fn();
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<VerificationChecklist
				checked={opts.checked ?? []}
				onChange={onChange}
				readOnly={opts.readOnly}
				decidedAt={opts.decidedAt}
			/>,
		);
	});
	return { tr, onChange };
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
	const toggle = tr.root.findByProps({ testID });
	renderer.act(() => {
		toggle.props.onPress();
	});
}

function stripComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => !/^\s*[*/]/.test(line))
		.join("\n");
}

describe("VerificationChecklist — D-07", () => {
	it("renders exactly four rows in document order: id, roll, eligibility, none — 48-06's canonical order", () => {
		const { tr } = renderChecklist();
		const rows = tr.root.findAll(
			(node) => typeof node.props.testID === "string" && node.props.testID.startsWith(`${PREFIX}-row-`),
			{ deep: false },
		);
		expect(rows.map((r) => r.props.testID)).toEqual([
			`${PREFIX}-row-id`,
			`${PREFIX}-row-roll`,
			`${PREFIX}-row-eligibility`,
			`${PREFIX}-row-none`,
		]);
		tr.unmount();
	});

	it("each row's label renders its own verificationChecklistItem* key", () => {
		const { tr } = renderChecklist();
		const expected: Record<string, string> = {
			id: "verificationChecklistItemId",
			roll: "verificationChecklistItemRoll",
			eligibility: "verificationChecklistItemEligibility",
			none: "verificationChecklistItemNone",
		};
		for (const item of ITEMS) {
			const label = tr.root.findAllByProps({ testID: `${PREFIX}-label-${item}` }, { deep: false })[0];
			expect(label.props.children).toBe(expected[item]);
		}
		tr.unmount();
	});

	it("the binding notice renders exactly once beneath the rows, in sentinel-textSecondary", () => {
		const { tr } = renderChecklist();
		const notices = tr.root.findAllByProps({ testID: `${PREFIX}-binding-notice` }, { deep: false });
		expect(notices.length).toBe(1);
		expect((notices[0].props.style as { color: string }).color).toBe("sentinel-textSecondary");
		expect(notices[0].props.children).toBe("verificationChecklistBindingNotice");
		tr.unmount();
	});

	// D-07 integrity assertion, not an ergonomics one: a mis-tap here changes
	// what the officer's signature attests to.
	it("every checkbox glyph wrapper carries minWidth 44 and minHeight 44, in both modes", () => {
		const { tr } = renderChecklist();
		for (const item of ITEMS) {
			const glyphBox = tr.root.findByProps({ testID: `${PREFIX}-glyph-${item}` });
			const flattened = StyleSheet.flatten(glyphBox.props.style) as { minWidth?: number; minHeight?: number };
			expect(flattened.minWidth).toBe(44);
			expect(flattened.minHeight).toBe(44);
		}
		tr.unmount();

		const { tr: trReadOnly } = renderChecklist({ readOnly: true });
		for (const item of ITEMS) {
			const glyphBox = trReadOnly.root.findByProps({ testID: `${PREFIX}-glyph-${item}` });
			const flattened = StyleSheet.flatten(glyphBox.props.style) as { minWidth?: number; minHeight?: number };
			expect(flattened.minWidth).toBe(44);
			expect(flattened.minHeight).toBe(44);
		}
		trReadOnly.unmount();
	});

	it("every interactive toggle carries hitSlop 8 on all four edges and a flattened minHeight of 44", () => {
		const { tr } = renderChecklist();
		for (const item of ITEMS) {
			const toggle = tr.root.findByProps({ testID: `${PREFIX}-toggle-${item}` });
			expect(toggle.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
			const flattened = StyleSheet.flatten(toggle.props.style) as { minHeight?: number };
			expect(flattened.minHeight).toBe(44);
		}
		tr.unmount();
	});

	it("with checked=['id'], the id glyph is square-check/success and the other three are square/textSecondary", () => {
		const { tr } = renderChecklist({ checked: ["id"] });
		for (const item of ITEMS) {
			const glyphBox = tr.root.findByProps({ testID: `${PREFIX}-glyph-${item}` });
			const icon = glyphBox.findAll((n) => n.type === ("FontAwesome6" as never))[0];
			if (item === "id") {
				expect(icon.props.name).toBe("square-check");
				expect(icon.props.color).toBe("sentinel-success");
			} else {
				expect(icon.props.name).toBe("square");
				expect(icon.props.color).toBe("sentinel-textSecondary");
			}
		}
		tr.unmount();
	});

	it("from checked=['id','roll'], pressing 'none' drops every substantive item — emits exactly ['none']", () => {
		const { tr, onChange } = renderChecklist({ checked: ["id", "roll"] });
		press(tr, `${PREFIX}-toggle-none`);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]![0]).toEqual(["none"]);
		tr.unmount();
	});

	it("from checked=['none'], pressing 'id' drops 'none' — emits exactly ['id']", () => {
		const { tr, onChange } = renderChecklist({ checked: ["none"] });
		press(tr, `${PREFIX}-toggle-id`);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]![0]).toEqual(["id"]);
		tr.unmount();
	});

	it("from checked=['id'], pressing 'id' unchecks it — emits exactly [] and adds nothing", () => {
		const { tr, onChange } = renderChecklist({ checked: ["id"] });
		press(tr, `${PREFIX}-toggle-id`);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]![0]).toEqual([]);
		tr.unmount();
	});

	// UI-SPEC: "Partial completion is always allowed and never blocks."
	it("from checked=['roll'], pressing 'eligibility' accumulates — emits ['roll','eligibility']", () => {
		const { tr, onChange } = renderChecklist({ checked: ["roll"] });
		press(tr, `${PREFIX}-toggle-eligibility`);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]![0]).toEqual(["roll", "eligibility"]);
		tr.unmount();
	});

	it("from checked=['eligibility'], pressing 'id' emits canonicalizeVerificationChecklist's own output — tap order does not survive", () => {
		const { tr, onChange } = renderChecklist({ checked: ["eligibility"] });
		press(tr, `${PREFIX}-toggle-id`);
		expect(onChange.mock.calls[0]![0]).toEqual(canonicalizeVerificationChecklist(["eligibility", "id"]));
		tr.unmount();
	});

	it("gate delegation: checking the first item emits gateMet=true; unchecking the only item emits gateMet=false", () => {
		const { tr, onChange } = renderChecklist({ checked: [] });
		press(tr, `${PREFIX}-toggle-id`);
		expect(onChange.mock.calls[0]![1]).toBe(true);
		tr.unmount();

		const { tr: tr2, onChange: onChange2 } = renderChecklist({ checked: ["id"] });
		press(tr2, `${PREFIX}-toggle-id`);
		expect(onChange2.mock.calls[0]![1]).toBe(false);
		tr2.unmount();
	});

	it("from checked=['id','roll'], pressing 'none' emits (['none'], true) — an honest 'none performed' record satisfies the gate", () => {
		const { tr, onChange } = renderChecklist({ checked: ["id", "roll"] });
		press(tr, `${PREFIX}-toggle-none`);
		expect(onChange.mock.calls[0]).toEqual([["none"], true]);
		tr.unmount();
	});

	// A source assertion rather than a behavioural one, deliberately: a
	// locally-rewritten predicate that happens to agree today would pass
	// every behavioural assertion above and still be the drift this plan
	// exists to close.
	it("SOURCE-LEVEL DELEGATION GATE: isChecklistGateMet( appears exactly once and no local gate expression exists", () => {
		const source = fs.readFileSync(path.join(__dirname, "../VerificationChecklist.tsx"), "utf8");
		const stripped = stripComments(source);
		const matches = stripped.match(/isChecklistGateMet\(/g) ?? [];
		expect(matches.length).toBe(1);
		for (const forbidden of ["checked.length", "checked.includes", ".length === 0", ".length > 0"]) {
			expect(stripped).not.toContain(forbidden);
		}
	});

	it("read-only mode preserves the decision-time state: id and roll glyphs remain square-check", () => {
		const { tr } = renderChecklist({ readOnly: true, checked: ["id", "roll"] });
		for (const item of ITEMS) {
			const glyphBox = tr.root.findByProps({ testID: `${PREFIX}-glyph-${item}` });
			const icon = glyphBox.findAll((n) => n.type === ("FontAwesome6" as never))[0];
			const expectedChecked = item === "id" || item === "roll";
			expect(icon.props.name).toBe(expectedChecked ? "square-check" : "square");
		}
		tr.unmount();
	});

	it("read-only mode mounts zero toggle testIDs and zero TouchableOpacity instances", () => {
		const { tr } = renderChecklist({ readOnly: true, checked: ["id"] });
		const toggles = tr.root.findAll(
			(n) => typeof n.props.testID === "string" && n.props.testID.startsWith(`${PREFIX}-toggle-`),
		);
		expect(toggles.length).toBe(0);
		expect(tr.root.findAllByType(TouchableOpacity).length).toBe(0);
		tr.unmount();
	});

	it("read-only decided-at: renders once with label+date when present, is absent without it, and never throws on a malformed value", () => {
		const { tr } = renderChecklist({ readOnly: true, decidedAt: "2026-07-04T10:20:30.000Z" });
		const decided = tr.root.findAllByProps({ testID: `${PREFIX}-decided-at` }, { deep: false });
		expect(decided.length).toBe(1);
		expect(String(decided[0]!.props.children)).toContain("verificationChecklistDecidedAtLabel");
		expect(String(decided[0]!.props.children)).toContain("2026-07-04");
		tr.unmount();

		const { tr: trNoDate } = renderChecklist({ readOnly: true });
		expect(trNoDate.root.findAllByProps({ testID: `${PREFIX}-decided-at` }, { deep: false }).length).toBe(0);
		trNoDate.unmount();

		expect(() => renderChecklist({ readOnly: true, decidedAt: "not-a-date" })).not.toThrow();
		const { tr: trMalformed } = renderChecklist({ readOnly: true, decidedAt: "not-a-date" });
		const decidedMalformed = trMalformed.root.findAllByProps({ testID: `${PREFIX}-decided-at` }, { deep: false });
		expect(String(decidedMalformed[0]!.props.children)).toContain("not-a-date");
		trMalformed.unmount();
	});

	// D-07 (48-27, closing 48-UAT.md gap 4): the Spanish item "Comprobó contra
	// el padrón electoral existente" clipped at the right edge instead of
	// wrapping — an officer attesting to text they could not read. `flex: 1`
	// is sufficient because this row IS width-constrained (`propertyRow` is
	// `width: "100%"`, `tapTarget` is `flex: 1`), unlike CustomButton's
	// content-sized row in 48-26.
	it("every label node carries flex:1 in both modes, and no label ever carries numberOfLines", () => {
		const { tr } = renderChecklist();
		for (const item of ITEMS) {
			const label = tr.root.findByProps({ testID: `${PREFIX}-label-${item}` });
			const flattened = StyleSheet.flatten(label.props.style) as { flex?: number };
			expect(flattened.flex).toBe(1);
			expect(label.props.numberOfLines).toBeUndefined();
		}
		tr.unmount();

		const { tr: trReadOnly } = renderChecklist({ readOnly: true });
		for (const item of ITEMS) {
			const label = trReadOnly.root.findByProps({ testID: `${PREFIX}-label-${item}` });
			const flattened = StyleSheet.flatten(label.props.style) as { flex?: number };
			expect(flattened.flex).toBe(1);
			expect(label.props.numberOfLines).toBeUndefined();
		}
		trReadOnly.unmount();
	});

	it("SOURCE-LEVEL: no numberOfLines anywhere in VerificationChecklist.tsx — truncation would trade one unreadable rendering for another", () => {
		const source = fs.readFileSync(path.join(__dirname, "../VerificationChecklist.tsx"), "utf8");
		expect(source).not.toContain("numberOfLines");
	});

	it("negative space: the rendered tree contains no ssn/score/rating/rank/percent substring — a closed set of codes, no numeric strength value", () => {
		const { tr } = renderChecklist({ checked: ["id", "roll", "eligibility", "none"] });
		const json = JSON.stringify(tr.toJSON());
		for (const forbidden of ["ssn", "SSN", "score", "rating", "rank", "percent"]) {
			expect(json).not.toContain(forbidden);
		}
		tr.unmount();
	});
});
