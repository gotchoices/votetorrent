/**
 * BridgeSourceBadge.test.tsx — co-located coverage for the D-03 badge +
 * callout (the phase's headline UI requirement). `react-test-renderer` only,
 * file-scope module mocks — mirrors `VerdictBadge.test.tsx`'s harness
 * (sentinel-color idiom so a color assertion can never pass by accidental
 * token equality).
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? key + JSON.stringify(opts) : key) }),
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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
}));

// Required AFTER the jest.mock() calls above — a static top-level `import` of
// a sibling module that transitively renders `View`/`TouchableOpacity`
// resolves against react-native's real module BEFORE the mocks above are
// wired, producing a "type is invalid" render crash.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BridgeSourceBadgeModule = require("../BridgeSourceBadge");
const { BridgeSourceBadge, BridgeSourceCallout, BRIDGE_SOURCE_ICON, BRIDGE_SOURCE_COLOR_KEY, BRIDGE_MARKER_BORDER_WIDTH } =
	BridgeSourceBadgeModule;

function renderBadge(issuerType: "registrant" | "bridge", testID?: string) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<BridgeSourceBadge issuerType={issuerType} testID={testID} />);
	});
	return tr;
}

function renderCallout(props: {
	issuerType: "registrant" | "bridge";
	bridgeLabel?: string;
	bridgeId?: string;
	testID?: string;
}) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<BridgeSourceCallout {...props} />);
	});
	return tr;
}

function flattenedStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
	const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
	return Object.assign({}, ...style.filter((s: unknown) => s && typeof s === "object"));
}

/**
 * Both `BridgeSourceBadge` and `BridgeSourceCallout` forward their own
 * `testID` prop verbatim to their host `View`, so `findByProps({ testID })`
 * ambiguously matches the composite component instance too (it also carries
 * that same `testID` prop). Narrow to the actual host node — the one whose
 * `type` is the string `"View"`, which is the only instance carrying a
 * `style` array.
 */
function findHostByTestID(tr: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
	const matches = tr.root.findAllByProps({ testID });
	const host = matches.find((n) => typeof n.type === "string");
	if (!host) throw new Error(`no host node found for testID ${testID}`);
	return host;
}

describe("BridgeSourceBadge — D-03 constants", () => {
	it("exports the shared icon, color key, and border width", () => {
		expect(BRIDGE_SOURCE_ICON).toBe("sitemap");
		expect(BRIDGE_SOURCE_COLOR_KEY).toBe("warning");
		expect(BRIDGE_MARKER_BORDER_WIDTH).toBe(4);
	});
});

describe("BridgeSourceBadge", () => {
	it("registrant issuerType renders null", () => {
		const tr = renderBadge("registrant");
		expect(tr.toJSON()).toBeNull();
	});

	it("bridge issuerType renders the pill with the badge label, warning color, and tinted background", () => {
		const tr = renderBadge("bridge");
		const tree = tr.toJSON();
		expect(tree).not.toBeNull();
		expect(JSON.stringify(tree)).toContain("bridgeSourceBadgeLabel");

		const label = tr.root.findByProps({ children: "bridgeSourceBadgeLabel" });
		expect((label.props.style as { color: string }).color).toBe("sentinel-warning");
		// Never accent, never error.
		expect((label.props.style as { color: string }).color).not.toBe("sentinel-accent");
		expect((label.props.style as { color: string }).color).not.toBe("sentinel-error");
	});

	it("bridge pill background is tintPill('warning') — proving the shared helper, not a local alpha", () => {
		const tr = renderBadge("bridge", "my-badge");
		const pill = findHostByTestID(tr, "my-badge");
		const style = flattenedStyle(pill);
		expect(style.backgroundColor).toBe("sentinel-warning22");
	});
});

describe("BridgeSourceCallout", () => {
	it("registrant issuerType with a stray bridgeLabel/bridgeId still renders nothing", () => {
		const tr = renderCallout({ issuerType: "registrant", bridgeLabel: "County Clerk", bridgeId: "b-1" });
		expect(tr.toJSON()).toBeNull();
	});

	it("bridge issuerType renders the callout with the 4px warning left border and the heading/body", () => {
		const tr = renderCallout({ issuerType: "bridge", bridgeLabel: "County Clerk" });
		const container = findHostByTestID(tr, "bridge-source-callout");
		const style = flattenedStyle(container);
		expect(style.borderLeftWidth).toBe(4);
		expect(style.borderLeftColor).toBe("sentinel-warning");

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("bridgeSourceCalloutHeading");
		expect(text).toContain("bridgeSourceCalloutBody");
	});

	it("bridge issuerType with no label and no id still renders the callout — a missing label never downgrades", () => {
		const tr = renderCallout({ issuerType: "bridge" });
		expect(tr.toJSON()).not.toBeNull();
		const container = findHostByTestID(tr, "bridge-source-callout");
		const style = flattenedStyle(container);
		expect(style.borderLeftWidth).toBe(4);
	});
});
