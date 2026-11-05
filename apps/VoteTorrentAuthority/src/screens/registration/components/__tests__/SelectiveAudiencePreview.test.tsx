/**
 * Co-located test for SelectiveAudiencePreview — pins D-12: the selective
 * tier renders raw and unmasked with zero reveal affordance, every raw row
 * is annotated Disclosed/Not-disclosed once an audience result is present
 * (never omitted), and no salt or hidden-leaf digest ever reaches the tree.
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the
 * i18n KEY string, so this suite does not depend on 47-02's copy values.
 */

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
const SelectiveAudiencePreviewModule = require("../SelectiveAudiencePreview");
const SelectiveAudiencePreview =
	SelectiveAudiencePreviewModule.SelectiveAudiencePreview ?? SelectiveAudiencePreviewModule.default;
const { toRenderableLeaves, SALT_KEY_PATTERN } = SelectiveAudiencePreviewModule;

const LEAVES: SelectiveLeaf[] = [
	{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" },
	{ name: "Email", value: "a@b.test", salt: "SALT_SENTINEL_EMAIL" },
	{ name: "Phone", value: "555-0100", salt: "SALT_SENTINEL_PHONE" },
];

function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
	const json = JSON.stringify(tr.toJSON()).toLowerCase();
	return json.includes(text.toLowerCase());
}

function findJsonNodeByTestID(node: unknown, testID: string): unknown {
	if (!node) return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findJsonNodeByTestID(child, testID);
			if (found) return found;
		}
		return null;
	}
	if (typeof node !== "object") return null;
	const n = node as { props?: { testID?: string }; children?: unknown };
	if (n.props?.testID === testID) return n;
	if (n.children) return findJsonNodeByTestID(n.children, testID);
	return null;
}

function checkGlyphCount(tr: renderer.ReactTestRenderer, testID: string): number {
	const wrapper = tr.root.findByProps({ testID });
	return wrapper.findAll(
		(node) => node.type === ("FontAwesome6" as never) && node.props.name === "check"
	).length;
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = wrapper.findAll((node) => typeof node.props.onPress === "function")[0];
	renderer.act(() => {
		pressable.props.onPress();
	});
}

function renderPreview(
	overrides: {
		leaves?: SelectiveLeaf[];
		selectedAudience?: "everyone" | "district";
		disclosure?: DisclosedSelective | null;
		onSelectAudience?: jest.Mock;
	} = {}
) {
	const onSelectAudience = overrides.onSelectAudience ?? jest.fn();
	const leaves = overrides.leaves ?? LEAVES;

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<SelectiveAudiencePreview
				leaves={leaves}
				selectedAudience={overrides.selectedAudience}
				disclosure={overrides.disclosure}
				onSelectAudience={onSelectAudience}
			/>
		);
	});
	return { tr, onSelectAudience };
}

beforeEach(() => {
	jest.clearAllMocks();
});

describe("SelectiveAudiencePreview — D-12", () => {
	it("renders the raw set unmasked with no mask or reveal affordance anywhere (D-12)", () => {
		const { tr } = renderPreview();

		expect(treeContainsText(tr, "Address")).toBe(true);
		expect(treeContainsText(tr, "12 Elm St")).toBe(true);
		expect(treeContainsText(tr, "Email")).toBe(true);
		expect(treeContainsText(tr, "a@b.test")).toBe(true);
		expect(treeContainsText(tr, "Phone")).toBe(true);
		expect(treeContainsText(tr, "555-0100")).toBe(true);

		const eyeNodes = tr.root.findAll(
			(node) =>
				node.type === ("FontAwesome6" as never) &&
				(node.props.name === "eye" || node.props.name === "eye-slash")
		);
		expect(eyeNodes).toHaveLength(0);
		expect(treeContainsText(tr, "registrantDetailPrivateMaskedValue")).toBe(false);

		// Only the two audience chip wrappers carry an onPress handler.
		const pressableWrappers = [
			tr.root.findByProps({ testID: "selective-audience-chip-everyone" }),
			tr.root.findByProps({ testID: "selective-audience-chip-district" }),
		];
		expect(pressableWrappers).toHaveLength(2);
	});

	it("salts never reach the rendered tree, in every audience state (D-12)", () => {
		const disclosedAddressOnly: DisclosedSelective = {
			cid: "cid1",
			root: "root1",
			disclosed: [{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" }],
			hidden: ["HIDDEN_DIGEST_SENTINEL"],
		};
		const disclosedAll: DisclosedSelective = {
			cid: "cid2",
			root: "root2",
			disclosed: LEAVES,
			hidden: ["HIDDEN_DIGEST_SENTINEL"],
		};

		for (const disclosure of [undefined, null, disclosedAddressOnly, disclosedAll]) {
			const { tr } = renderPreview({ disclosure });
			const json = JSON.stringify(tr.toJSON());
			expect(json).not.toContain("SALT_SENTINEL_ADDRESS");
			expect(json).not.toContain("SALT_SENTINEL_EMAIL");
			expect(json).not.toContain("SALT_SENTINEL_PHONE");
			expect(json).not.toContain("HIDDEN_DIGEST_SENTINEL");
		}
	});

	it("toRenderableLeaves strips every salt-shaped key (pure unit, no render)", () => {
		const result = toRenderableLeaves([
			{ name: "A", value: "v", salt: "s1", Salt: "s2", saltHex: "s3", fieldSalt: "s4" } as never,
		]);
		expect(result).toEqual([{ name: "A", value: "v" }]);
		const json = JSON.stringify(result);
		expect(json).not.toContain("s1");
		expect(json).not.toContain("s2");
		expect(json).not.toContain("s3");
		expect(json).not.toContain("s4");

		expect(SALT_KEY_PATTERN.test("Salt")).toBe(true);
		expect(SALT_KEY_PATTERN.test("saltHex")).toBe(true);
		expect(SALT_KEY_PATTERN.test("fieldSalt")).toBe(true);
		expect(SALT_KEY_PATTERN.test("name")).toBe(false);
	});

	it("selecting an audience fires onSelectAudience exactly once with the audience code", () => {
		const everyone = renderPreview();
		press(everyone.tr, "selective-audience-chip-everyone");
		expect(everyone.onSelectAudience).toHaveBeenCalledTimes(1);
		expect(everyone.onSelectAudience).toHaveBeenCalledWith("everyone");

		// 47-20 wires this callback to
		// getDisclosedSelective(electionId, registrantId, audience); this
		// component makes no engine call of its own.
		const district = renderPreview();
		press(district.tr, "selective-audience-chip-district");
		expect(district.onSelectAudience).toHaveBeenCalledTimes(1);
		expect(district.onSelectAudience).toHaveBeenCalledWith("district");
	});

	it("exactly one audience chip carries the check glyph, matching selectedAudience", () => {
		const everyoneSelected = renderPreview({ selectedAudience: "everyone" });
		expect(checkGlyphCount(everyoneSelected.tr, "selective-audience-chip-everyone")).toBe(1);
		expect(checkGlyphCount(everyoneSelected.tr, "selective-audience-chip-district")).toBe(0);

		const districtSelected = renderPreview({ selectedAudience: "district" });
		expect(checkGlyphCount(districtSelected.tr, "selective-audience-chip-everyone")).toBe(0);
		expect(checkGlyphCount(districtSelected.tr, "selective-audience-chip-district")).toBe(1);

		const unset = renderPreview({ selectedAudience: undefined });
		expect(checkGlyphCount(unset.tr, "selective-audience-chip-everyone")).toBe(0);
		expect(checkGlyphCount(unset.tr, "selective-audience-chip-district")).toBe(0);
	});

	it("EVERY row is annotated when an audience result is present — undisclosed rows are annotated, never omitted (D-12)", () => {
		const disclosure: DisclosedSelective = {
			cid: "cid1",
			root: "root1",
			disclosed: [{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" }],
			hidden: [],
		};
		const { tr } = renderPreview({ disclosure });

		expect(() => tr.root.findByProps({ testID: "selective-field-row-Address" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "selective-field-row-Email" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "selective-field-row-Phone" })).not.toThrow();

		const addressJson = JSON.stringify(
			findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-Address")
		);
		expect(addressJson).toContain("registrantDetailSelectiveDisclosedLabel");
		expect(addressJson).not.toContain("registrantDetailSelectiveNotDisclosedLabel");

		for (const name of ["Email", "Phone"]) {
			const json = JSON.stringify(
				findJsonNodeByTestID(tr.toJSON(), `selective-field-disclosure-${name}`)
			);
			expect(json).toContain("registrantDetailSelectiveNotDisclosedLabel");
			expect(json).not.toContain("registrantDetailSelectiveDisclosedLabel");
		}
	});

	it("disclosure === null annotates every row as not-disclosed; disclosure === undefined annotates none", () => {
		const nullDisclosure = renderPreview({ disclosure: null });
		for (const name of ["Address", "Email", "Phone"]) {
			expect(() =>
				nullDisclosure.tr.root.findByProps({ testID: `selective-field-disclosure-${name}` })
			).not.toThrow();
			const json = JSON.stringify(
				findJsonNodeByTestID(nullDisclosure.tr.toJSON(), `selective-field-disclosure-${name}`)
			);
			expect(json).toContain("registrantDetailSelectiveNotDisclosedLabel");
		}

		const undefinedDisclosure = renderPreview({ disclosure: undefined });
		for (const name of ["Address", "Email", "Phone"]) {
			expect(() =>
				undefinedDisclosure.tr.root.findByProps({ testID: `selective-field-disclosure-${name}` })
			).toThrow();
			expect(() =>
				undefinedDisclosure.tr.root.findByProps({ testID: `selective-field-row-${name}` })
			).not.toThrow();
		}
	});

	// 47-REVIEW IN-08. This previously asserted the OPPOSITE ("matching is
	// case-folded"), which made the preview claim a disclosure the engine had
	// not made. `getDisclosedSelective` matches policy FieldName to leaf name
	// EXACTLY, and both sides of this component's comparison are the same
	// RegistrantSelective leaf names read twice — so a fold here can only
	// diverge from the engine, never agree with it more often.
	it("disclosed-name matching is EXACT, never case-folded — the engine's own rule", () => {
		const foldOnly: DisclosedSelective = {
			cid: "cid1",
			root: "root1",
			// Differs from the "Address" leaf in case alone. The engine could not
			// have produced this for that leaf; the preview must not claim it did.
			disclosed: [{ name: "address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" }],
			hidden: [],
		};
		const foldJson = JSON.stringify(
			findJsonNodeByTestID(
				renderPreview({ disclosure: foldOnly }).tr.toJSON(),
				"selective-field-disclosure-Address"
			)
		);
		expect(foldJson).toContain("registrantDetailSelectiveNotDisclosedLabel");
		expect(foldJson).not.toContain("registrantDetailSelectiveDisclosedLabel");

		// The exact name still matches, so this is a tightening, not a break.
		const exact: DisclosedSelective = {
			cid: "cid1",
			root: "root1",
			disclosed: [{ name: "Address", value: "12 Elm St", salt: "SALT_SENTINEL_ADDRESS" }],
			hidden: [],
		};
		const exactJson = JSON.stringify(
			findJsonNodeByTestID(
				renderPreview({ disclosure: exact }).tr.toJSON(),
				"selective-field-disclosure-Address"
			)
		);
		expect(exactJson).toContain("registrantDetailSelectiveDisclosedLabel");
		expect(exactJson).not.toContain("registrantDetailSelectiveNotDisclosedLabel");
	});

	it("IN-08: two leaves differing only in case are annotated independently — one Disclosed, one not", () => {
		// The concrete false-claim the fold produced: the engine discloses ONE of
		// these, the folded preview marked BOTH.
		const leaves: SelectiveLeaf[] = [
			{ name: "Party", value: "Green", salt: "SALT_SENTINEL_PARTY_UPPER" },
			{ name: "party", value: "Blue", salt: "SALT_SENTINEL_PARTY_LOWER" },
		];
		const disclosure: DisclosedSelective = {
			cid: "cid1",
			root: "root1",
			disclosed: [{ name: "Party", value: "Green", salt: "SALT_SENTINEL_PARTY_UPPER" }],
			hidden: [],
		};
		const { tr } = renderPreview({ leaves, disclosure });

		const upper = JSON.stringify(
			findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-Party")
		);
		expect(upper).toContain("registrantDetailSelectiveDisclosedLabel");
		expect(upper).not.toContain("registrantDetailSelectiveNotDisclosedLabel");

		const lower = JSON.stringify(
			findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-party")
		);
		expect(lower).toContain("registrantDetailSelectiveNotDisclosedLabel");
		expect(lower).not.toContain("registrantDetailSelectiveDisclosedLabel");
	});

	it("empty leaves render the no-selective-tier copy and zero field rows", () => {
		const { tr } = renderPreview({ leaves: [] });
		expect(() => tr.root.findByProps({ testID: "selective-audience-preview-empty" })).not.toThrow();
		expect(treeContainsText(tr, "registrantDetailNoSelectiveTier")).toBe(true);
		expect(() => tr.root.findByProps({ testID: "selective-field-row-Address" })).toThrow();
	});
});
