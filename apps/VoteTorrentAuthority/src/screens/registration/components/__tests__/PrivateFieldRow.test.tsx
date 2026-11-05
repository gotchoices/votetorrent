/**
 * Co-located test for PrivateFieldRow — pins D-01 (masked by default, mask is
 * an absence from the tree not a style), D-13 (44x44 tap target), and D-14
 * (one-way reveal, no retraction path) plus T-47-02 (never-log rule).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the
 * i18n KEY string, so this suite does not depend on 47-02's copy values.
 */

import React from "react";
import renderer from "react-test-renderer";

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

const SSN_SENTINEL = "123-45-6789";
const FIELD_NAME = "SSN";

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

function findFontAwesomeNodesByName(tr: renderer.ReactTestRenderer, name: string) {
	return tr.root.findAll(
		node => node.type === ("FontAwesome6" as never) && node.props.name === name,
	);
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
	const toggle = tr.root.findByProps({ testID });
	renderer.act(() => {
		toggle.props.onPress();
	});
}

function renderRow(overrides: {
	name?: string;
	value?: string;
	onReveal?: jest.Mock;
	testIDPrefix?: string;
	extraProps?: Record<string, unknown>;
} = {}) {
	const onReveal = overrides.onReveal ?? jest.fn();
	const name = overrides.name ?? FIELD_NAME;
	const value = overrides.value ?? SSN_SENTINEL;

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<PrivateFieldRow
				name={name}
				value={value}
				onReveal={onReveal}
				testIDPrefix={overrides.testIDPrefix}
				{...overrides.extraProps}
			/>,
		);
	});
	return { tr, onReveal };
}

beforeEach(() => {
	jest.clearAllMocks();
});

describe("PrivateFieldRow — D-01/D-13/D-14/T-47-02", () => {
	it("renders masked by default: the mask key and an eye glyph, and the value is ABSENT from the tree", () => {
		const { tr } = renderRow();
		const json = JSON.stringify(tr.toJSON());

		expect(json).toContain("registrantDetailPrivateMaskedValue");
		expect(findFontAwesomeNodesByName(tr, "eye")).toHaveLength(1);
		expect(findFontAwesomeNodesByName(tr, "eye-slash")).toHaveLength(0);
		expect(json.includes(SSN_SENTINEL)).toBe(false);
	});

	it("tap reveals: value appears, glyph flips to eye-slash, onReveal fires once with the NAME", () => {
		const { tr, onReveal } = renderRow();
		press(tr, "private-field-toggle-SSN");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(SSN_SENTINEL);
		expect(findFontAwesomeNodesByName(tr, "eye-slash")).toHaveLength(1);
		expect(findFontAwesomeNodesByName(tr, "eye")).toHaveLength(0);
		expect(onReveal).toHaveBeenCalledTimes(1);
		expect(onReveal.mock.calls[0]).toEqual(["SSN"]);
		expect(JSON.stringify(onReveal.mock.calls)).not.toContain(SSN_SENTINEL);
	});

	it("D-14: re-masking retracts nothing — no second call, and an injected onHide is never invoked", () => {
		const onHide = jest.fn();
		const { tr, onReveal } = renderRow({ extraProps: { onHide } });

		// D-14: the officer already saw it. There is no retraction path by
		// design — the props interface offers nowhere to wire one.
		press(tr, "private-field-toggle-SSN"); // reveal
		press(tr, "private-field-toggle-SSN"); // re-mask

		const json = JSON.stringify(tr.toJSON());
		expect(json.includes(SSN_SENTINEL)).toBe(false);
		expect(onReveal).toHaveBeenCalledTimes(1);
		expect(onHide).toHaveBeenCalledTimes(0);

		press(tr, "private-field-toggle-SSN"); // reveal again
		expect(onReveal).toHaveBeenCalledTimes(2);
		expect(onReveal.mock.calls[1]).toEqual(["SSN"]);
	});

	it("44x44: the glyph container declares a minWidth and minHeight of 44 and the row declares hitSlop", () => {
		const { tr } = renderRow();
		const toggle = tr.root.findByProps({ testID: "private-field-toggle-SSN" });
		const toggleStyle = Array.isArray(toggle.props.style) ? toggle.props.style.flat(5) : [toggle.props.style];
		expect(toggleStyle.some((s: unknown) => s !== null && typeof s === "object" && (s as Record<string, unknown>).minHeight === 44)).toBe(true);

		const glyphNode = findJsonNodeByTestID(tr.toJSON(), "private-field-value-SSN");
		// The glyph container is a sibling of the value View, not inside it —
		// resolve it directly via the FontAwesome6 node's parent style chain.
		const glyphInstance = tr.root.findAll(node => node.type === ("FontAwesome6" as never))[0];
		const glyphParent = glyphInstance.parent;
		const glyphParentStyle = Array.isArray(glyphParent!.props.style)
			? glyphParent!.props.style.flat(5)
			: [glyphParent!.props.style];
		expect(glyphParentStyle.some((s: unknown) => s !== null && typeof s === "object" && (s as Record<string, unknown>).minWidth === 44)).toBe(true);
		expect(glyphParentStyle.some((s: unknown) => s !== null && typeof s === "object" && (s as Record<string, unknown>).minHeight === 44)).toBe(true);

		expect(glyphNode).not.toBeNull();

		const hitSlop = toggle.props.hitSlop;
		expect(hitSlop).toEqual(
			expect.objectContaining({
				top: expect.any(Number),
				bottom: expect.any(Number),
				left: expect.any(Number),
				right: expect.any(Number),
			}),
		);
		expect(hitSlop.top).toBeGreaterThanOrEqual(8);
		expect(hitSlop.bottom).toBeGreaterThanOrEqual(8);
		expect(hitSlop.left).toBeGreaterThanOrEqual(8);
		expect(hitSlop.right).toBeGreaterThanOrEqual(8);
	});

	it("T-47-02: no private value reaches the debug console in any state", () => {
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});

		const { tr } = renderRow();
		press(tr, "private-field-toggle-SSN"); // reveal
		press(tr, "private-field-toggle-SSN"); // re-mask
		press(tr, "private-field-toggle-SSN"); // reveal again

		for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
			expect(spy).toHaveBeenCalledTimes(0);
			spy.mockRestore();
		}
	});

	it("the accessibility label flips between the reveal and hide hint keys", () => {
		const { tr } = renderRow();
		let toggle = tr.root.findByProps({ testID: "private-field-toggle-SSN" });
		expect(toggle.props.accessibilityLabel).toBe("registrantDetailPrivateRevealHint");

		press(tr, "private-field-toggle-SSN");
		toggle = tr.root.findByProps({ testID: "private-field-toggle-SSN" });
		expect(toggle.props.accessibilityLabel).toBe("registrantDetailPrivateHideHint");
	});

	it("under StrictMode, ONE tap still emits exactly ONE onReveal", () => {
		// DECLARED WEAKNESS, read before trusting this test as the regression
		// lock for the updater-purity fix: react-test-renderer does NOT
		// double-invoke state updaters under StrictMode (verified — it invokes
		// the updater once even with `unstable_isConcurrent: true`), so this
		// test passes against the pre-fix source too. It locks the OBSERVABLE
		// one-tap-one-reveal contract; the structural guard below is what
		// actually locks the fix.
		const onReveal = jest.fn();
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<React.StrictMode>
					<PrivateFieldRow name={FIELD_NAME} value={SSN_SENTINEL} onReveal={onReveal} />
				</React.StrictMode>,
			);
		});

		press(tr, "private-field-toggle-SSN");
		expect(onReveal).toHaveBeenCalledTimes(1);
		expect(onReveal.mock.calls[0]).toEqual([FIELD_NAME]);

		press(tr, "private-field-toggle-SSN"); // re-mask — emits nothing (D-14)
		expect(onReveal).toHaveBeenCalledTimes(1);

		press(tr, "private-field-toggle-SSN"); // reveal again
		expect(onReveal).toHaveBeenCalledTimes(2);
	});

	it("STRUCTURAL GUARD: onReveal is never called from inside a setState updater", () => {
		// The defect this locks:
		//     setRevealed(prev => { const next = !prev; if (next) onReveal(name); return next; });
		// React state updaters must be PURE — React double-invokes them in
		// StrictMode/dev and may re-invoke them during concurrent rendering, so
		// onReveal fired twice per tap in dev and had no once-per-tap guarantee
		// under concurrent rendering. The Set inside createAccessTrailVisit
		// absorbed the duplicate, making that accumulator's dedup load-bearing
		// for a property that should be structural — and it would break the
		// moment the accumulator became order-sensitive.
		//
		// A source gate rather than a behavioural one BY NECESSITY: this app's
		// only render harness (react-test-renderer) does not reproduce React's
		// StrictMode updater double-invoke, so the impurity is invisible to
		// every behavioural test that could be written here.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		const source: string = fs.readFileSync(path.join(__dirname, "../PrivateFieldRow.tsx"), "utf8");

		// Every setRevealed(...) call must take a plain VALUE, not a function.
		// A non-empty match means an updater form is back: setRevealed must be
		// called with a value, and the reveal side effect must not live inside
		// it. Derive `next` outside the updater instead.
		const updaterForm = /setRevealed\(\s*(\(?\s*\w*\s*\)?\s*=>|function)/g;
		expect(source.match(updaterForm) ?? []).toEqual([]);

		// Non-vacuity: the call site the guard is aimed at still exists.
		expect(source).toContain("setRevealed(next)");
		expect(source).toContain("onReveal(name)");
	});
});
