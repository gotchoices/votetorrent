/**
 * Co-located test for AttestationProvisioningStatusScreen — pins D-09's
 * fail-conservative probe read (T-47-01), the heading/body pairing lock
 * (T-47-19-02), the real-copy corrected posture (both EN and ES), the
 * both-state SETUP.md pointer, and the zero-affordance contract.
 *
 * The identity `t` mock (react-i18next) means every RENDERED assertion
 * targets an i18n KEY, EXCEPT test 5, which deliberately reads the real EN
 * and ES values straight out of `src/i18n/index.ts` with `fs` — that is what
 * makes the D-09 posture assertion non-vacuous (a key-only assertion could
 * pass even if the shipped copy dropped the "still viewed and managed
 * normally" claim entirely).
 *
 * This suite mocks AppProvider directly (rather than importing a real mock
 * engine, the phase's usual convention) because the screen makes no engine
 * call at all — there is no engine surface to exercise here.
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality (e.g. two tokens sharing the same hex).
const PALETTE = {
	text: "#T",
	textSecondary: "#TS",
	success: "#SU",
	warning: "#WA",
	error: "#ER",
	accent: "#AC",
	card: "#CA",
	background: "#BG",
	border: "#BO",
};

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ dark: false, colors: PALETTE }),
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factory below to close over them despite being
// declared outside the factory's own scope. Routing the probe through
// `mockProbe` is what lets a single test install a THROWING probe.
let mockProbe: () => boolean = () => true;
const mockIsProvisioned = jest.fn(() => mockProbe());

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ isAttestationVerifierProvisioned: mockIsProvisioned }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require("../AttestationProvisioningStatusScreen");
const Screen = ScreenModule.default;
const { resolveProvisioningState, provisioningCopy } = ScreenModule;

beforeEach(() => {
	mockProbe = () => true;
	mockIsProvisioned.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders the screen with the given probe installed. The screen does zero
 * async work (no engine call, no effect), so this helper is deliberately
 * synchronous — no `await flush` is needed after mount.
 */
function render(probe: () => boolean): renderer.ReactTestRenderer {
	mockProbe = probe;
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<Screen />);
	});
	return tr;
}

function has(tr: renderer.ReactTestRenderer, testID: string): boolean {
	return tr.root.findAllByProps({ testID }).length > 0;
}

function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findByProps({ testID });
	const children = node.props.children;
	return Array.isArray(children) ? children.join("") : String(children);
}

function glyphs(tr: renderer.ReactTestRenderer): Array<{ name: unknown; color: unknown }> {
	return tr.root.findAllByType("FontAwesome6" as never).map((n) => ({ name: n.props.name, color: n.props.color }));
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

/**
 * Walks every node in the subtree rooted at `rootTestID` and counts nodes
 * whose `props.onPress` is a function. This is what makes "no affordance" a
 * mechanical assertion rather than a review note. Scoped to the CARD
 * subtree (not the screen root) so a ScrollView-internal handler from the
 * RN preset can never make this vacuously non-zero.
 */
function pressableCount(tr: renderer.ReactTestRenderer, rootTestID: string): number {
	const rootNode = tr.root.findByProps({ testID: rootTestID });
	const nodes = [rootNode, ...rootNode.findAll(() => true)];
	return nodes.filter((n) => typeof n.props.onPress === "function").length;
}

function i18nSource(): string {
	return fs.readFileSync(path.join(__dirname, "../../../i18n/index.ts"), "utf8");
}

function enSlice(src: string): string {
	const enStart = src.search(/^\ten: \{/m);
	const esStart = src.search(/^\tes: \{/m);
	return src.slice(enStart, esStart);
}

function esSlice(src: string): string {
	const esStart = src.search(/^\tes: \{/m);
	return src.slice(esStart);
}

function valueOf(slice: string, key: string): string | undefined {
	const re = new RegExp(`\\b${key}:\\s*(?:'([^']*)'|"([^"]*)")`);
	const m = slice.match(re);
	if (!m) return undefined;
	return m[1] !== undefined ? m[1] : m[2];
}

function hasKey(slice: string, key: string): boolean {
	return new RegExp(`^\\t+${key}:`, "m").test(slice);
}

// ---------------------------------------------------------------------------
// 1. resolveProvisioningState — the T-47-01 fail-conservative boundary
// ---------------------------------------------------------------------------

describe("resolveProvisioningState — T-47-01 fail-conservative boundary", () => {
	const CONSEQUENCE =
		"an operator must never be told device attestation is operational because a diagnostic call failed or drifted — D-09 / T-47-19-01";

	it(`(a) a probe returning strictly true resolves to true — ${CONSEQUENCE}`, () => {
		expect(resolveProvisioningState(() => true)).toBe(true);
	});

	it(`(b) a probe returning strictly false resolves to false — ${CONSEQUENCE}`, () => {
		expect(resolveProvisioningState(() => false)).toBe(false);
	});

	it(`(c) a THROWING probe resolves to false, and the throw does not escape — ${CONSEQUENCE}`, () => {
		const throwing = () => {
			throw new Error("boom");
		};
		expect(() => resolveProvisioningState(throwing)).not.toThrow();
		expect(resolveProvisioningState(throwing)).toBe(false);
	});

	it(`(d) a probe returning undefined resolves to false — ${CONSEQUENCE}`, () => {
		const undefinedProbe = (() => undefined) as unknown as () => boolean;
		expect(resolveProvisioningState(undefinedProbe)).toBe(false);
	});

	it(`(e) a probe returning the truthy non-boolean 1 resolves to false — ${CONSEQUENCE}`, () => {
		const driftedProbe = (() => 1) as unknown as () => boolean;
		expect(resolveProvisioningState(driftedProbe)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. provisioningCopy — the pairing lock
// ---------------------------------------------------------------------------

describe("provisioningCopy — the heading/body pairing lock", () => {
	const PROVISIONED_TRIPLE = {
		testIDBase: "attestation-provisioning-provisioned",
		headingKey: "attestationProvisioningProvisionedHeading",
		bodyKey: "attestationProvisioningProvisionedBody",
	};
	const NOT_PROVISIONED_TRIPLE = {
		testIDBase: "attestation-provisioning-not-provisioned",
		headingKey: "attestationProvisioningNotProvisionedHeading",
		bodyKey: "attestationProvisioningNotProvisionedBody",
	};

	it("(a) returns the exact provisioned and not-provisioned triples", () => {
		expect(provisioningCopy(true)).toEqual(PROVISIONED_TRIPLE);
		expect(provisioningCopy(false)).toEqual(NOT_PROVISIONED_TRIPLE);
	});

	it("(b) cross-contamination lock: neither branch's keys appear in the other's object", () => {
		const trueJson = JSON.stringify(provisioningCopy(true));
		const falseJson = JSON.stringify(provisioningCopy(false));
		expect(trueJson).not.toContain(NOT_PROVISIONED_TRIPLE.headingKey);
		expect(trueJson).not.toContain(NOT_PROVISIONED_TRIPLE.bodyKey);
		expect(falseJson).not.toContain(PROVISIONED_TRIPLE.headingKey);
		expect(falseJson).not.toContain(PROVISIONED_TRIPLE.bodyKey);
	});

	it("(c) closed allow-list: the union of both branches' heading/body keys is exactly the 4-element set", () => {
		const keys = [
			provisioningCopy(true).headingKey,
			provisioningCopy(true).bodyKey,
			provisioningCopy(false).headingKey,
			provisioningCopy(false).bodyKey,
		];
		expect(new Set(keys)).toEqual(
			new Set([
				"attestationProvisioningProvisionedHeading",
				"attestationProvisioningProvisionedBody",
				"attestationProvisioningNotProvisionedHeading",
				"attestationProvisioningNotProvisionedBody",
			]),
		);
	});

	it("(d) 47-02 drift tripwire: all 4 copy keys plus the setup-link key exist, non-empty, in BOTH EN and ES", () => {
		const src = i18nSource();
		const en = enSlice(src);
		const es = esSlice(src);
		const keys = [
			"attestationProvisioningProvisionedHeading",
			"attestationProvisioningProvisionedBody",
			"attestationProvisioningNotProvisionedHeading",
			"attestationProvisioningNotProvisionedBody",
			"attestationProvisioningSetupLink",
		];
		for (const key of keys) {
			expect(hasKey(en, key)).toBe(true);
			expect(hasKey(es, key)).toBe(true);
			expect(valueOf(en, key)).toBeTruthy();
			expect(valueOf(es, key)).toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------
// 3-4. Rendered states
// ---------------------------------------------------------------------------

describe("AttestationProvisioningStatusScreen — D-09 provisioning legibility", () => {
	it("3. provisioned render: shows exactly the provisioned pair, success glyph, and hides the not-provisioned pair", () => {
		const tr = render(() => true);

		expect(has(tr, "attestation-provisioning-provisioned-heading")).toBe(true);
		expect(has(tr, "attestation-provisioning-provisioned-body")).toBe(true);
		expect(textOf(tr, "attestation-provisioning-provisioned-heading")).toBe("attestationProvisioningProvisionedHeading");
		expect(textOf(tr, "attestation-provisioning-provisioned-body")).toBe("attestationProvisioningProvisionedBody");

		expect(has(tr, "attestation-provisioning-not-provisioned-heading")).toBe(false);
		expect(has(tr, "attestation-provisioning-not-provisioned-body")).toBe(false);

		const tree = treeText(tr);
		expect(tree).not.toContain("attestationProvisioningNotProvisionedHeading");
		expect(tree).not.toContain("attestationProvisioningNotProvisionedBody");

		const g = glyphs(tr);
		expect(g).toHaveLength(1);
		expect(g[0]).toEqual({ name: "shield-halved", color: PALETTE.success });
	});

	it("4. not-provisioned render: shows exactly the not-provisioned pair, warning glyph, and hides the provisioned pair", () => {
		const tr = render(() => false);

		expect(has(tr, "attestation-provisioning-not-provisioned-heading")).toBe(true);
		expect(has(tr, "attestation-provisioning-not-provisioned-body")).toBe(true);
		expect(textOf(tr, "attestation-provisioning-not-provisioned-heading")).toBe(
			"attestationProvisioningNotProvisionedHeading",
		);
		expect(textOf(tr, "attestation-provisioning-not-provisioned-body")).toBe("attestationProvisioningNotProvisionedBody");

		expect(has(tr, "attestation-provisioning-provisioned-heading")).toBe(false);
		expect(has(tr, "attestation-provisioning-provisioned-body")).toBe(false);

		const tree = treeText(tr);
		expect(tree).not.toContain("attestationProvisioningProvisionedHeading");
		expect(tree).not.toContain("attestationProvisioningProvisionedBody");

		const g = glyphs(tr);
		expect(g).toHaveLength(1);
		expect(g[0]).toEqual({ name: "shield-halved", color: PALETTE.warning });
	});

	// -------------------------------------------------------------------------
	// 5. D-09 corrected-posture assertion — the real shipped copy, not the key.
	// This is the sentence D-09 exists to communicate: before the guard
	// relocation, unprovisioned keys blocked association READS too; this copy
	// is where an operator learns that is no longer true. A paraphrase that
	// drops the claim fails here — and the ES-only regex proving it does NOT
	// match the PROVISIONED body value (below) proves this test discriminates
	// rather than matching any string.
	// -------------------------------------------------------------------------

	it("5a. EN not-provisioned body states the corrected posture in the real shipped copy", () => {
		const src = i18nSource();
		const en = enSlice(src);
		const notProvisionedBody = valueOf(en, "attestationProvisioningNotProvisionedBody");
		expect(notProvisionedBody).toMatch(/registrant and association data can still be viewed and managed normally/i);

		// Discrimination proof: the same regex must NOT match the PROVISIONED
		// body value — this test is not just matching any string.
		const provisionedBody = valueOf(en, "attestationProvisioningProvisionedBody");
		expect(provisionedBody).not.toMatch(/registrant and association data can still be viewed and managed normally/i);
	});

	it("5b. ES not-provisioned body states the corrected posture in the real shipped copy", () => {
		const src = i18nSource();
		const es = esSlice(src);
		const notProvisionedBody = valueOf(es, "attestationProvisioningNotProvisionedBody");
		expect(notProvisionedBody).toMatch(/pueden verse y gestionarse con normalidad/i);

		const provisionedBody = valueOf(es, "attestationProvisioningProvisionedBody");
		expect(provisionedBody).not.toMatch(/pueden verse y gestionarse con normalidad/i);
	});

	it("6. end-to-end fail-conservative render: a THROWING probe renders the not-provisioned pair and does not throw", () => {
		const throwing = () => {
			throw new Error("boom");
		};
		let tr!: renderer.ReactTestRenderer;
		expect(() => {
			tr = render(throwing);
		}).not.toThrow();

		expect(has(tr, "attestation-provisioning-not-provisioned-heading")).toBe(true);
		expect(has(tr, "attestation-provisioning-provisioned-heading")).toBe(false);
		const g = glyphs(tr);
		expect(g[0]).toEqual({ name: "shield-halved", color: PALETTE.warning });
	});

	it("7. the SETUP.md pointer renders in BOTH states", () => {
		const provisionedTr = render(() => true);
		expect(has(provisionedTr, "attestation-provisioning-setup-pointer")).toBe(true);
		expect(textOf(provisionedTr, "attestation-provisioning-setup-pointer")).toBe("attestationProvisioningSetupLink");

		const notProvisionedTr = render(() => false);
		expect(has(notProvisionedTr, "attestation-provisioning-setup-pointer")).toBe(true);
		expect(textOf(notProvisionedTr, "attestation-provisioning-setup-pointer")).toBe("attestationProvisioningSetupLink");
	});

	it('8. zero-affordance lock: no onPress anywhere in the card subtree, in either state — "the SETUP.md pointer is static text; a tappable control here would be a dead end"', () => {
		const provisionedTr = render(() => true);
		expect(pressableCount(provisionedTr, "attestation-provisioning-card")).toBe(0);
		expect(
			provisionedTr.root.findAllByType("FontAwesome6" as never).every((n) => typeof n.props.onPress !== "function"),
		).toBe(true);

		const notProvisionedTr = render(() => false);
		expect(pressableCount(notProvisionedTr, "attestation-provisioning-card")).toBe(0);
		expect(
			notProvisionedTr.root.findAllByType("FontAwesome6" as never).every((n) => typeof n.props.onPress !== "function"),
		).toBe(true);
	});

	it("9. the probe is called exactly once per render, with no arguments", () => {
		render(() => true);
		expect(mockIsProvisioned.mock.calls.length).toBe(1);
		expect(mockIsProvisioned.mock.calls[0].length).toBe(0);
	});

	it("10. no route, no scope gate, no engine call — source assertions", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "../AttestationProvisioningStatusScreen.tsx"),
			"utf8",
		);
		// Comment that 47-21 owns routing and that the absence of a scope gate is
		// deliberate (D-13: provisioning is not registrant data), so this
		// assertion protects a decision, not enforces an omission.
		const stripped = source
			.split("\n")
			.filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
			.join("\n");
		for (const forbidden of [
			"useNavigation",
			"useRoute",
			"navigation.navigate",
			"getEngine",
			"useCurrentOfficerScopes",
			"console.",
			"InlineError",
		]) {
			expect(stripped).not.toContain(forbidden);
		}
	});
});
