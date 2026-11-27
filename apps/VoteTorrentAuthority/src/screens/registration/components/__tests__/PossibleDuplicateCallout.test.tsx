/**
 * PossibleDuplicateCallout.test.tsx — 62-27 (D-44, Surface 3).
 *
 * Mounted with react-test-renderer. RN jest has no layout engine, so "geometry" means the style
 * props that determine layout (`StyleSheet.flatten`), as in `button-radius-padding.test.tsx`.
 */

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import renderer, { act } from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		dark: false,
		colors: {
			text: "sentinel-text",
			textSecondary: "sentinel-textSecondary",
			success: "sentinel-success",
			warning: "sentinel-warning",
			error: "sentinel-error",
			accent: "sentinel-accent",
			card: "sentinel-card",
			background: "sentinel-background",
			border: "sentinel-border",
			dark: "sentinel-dark",
			light: "sentinel-light",
			primary: "sentinel-primary",
			notification: "sentinel-notification",
			important: "sentinel-important",
		},
	}),
}));

let mockLocale: "en" | "es" = "en";

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../../i18n");
			const template = (resources[mockLocale].translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../../i18n");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PossibleDuplicateCallout } = require("../PossibleDuplicateCallout");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registrationRequestDisplayName } = require("../../registration-request-display");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { truncateId } = require("../../registrant-display");

const FIRST = "Maximiliana Esperanza";
const LAST = "Villalobos-Etxeberria de la Cruz";

const CANDIDATE = {
	requestId: "req-dup-0001",
	authorityId: "auth-1",
	issuerType: "registrant",
	submittedAt: "2026-08-01T00:00:00Z",
	receivedAt: "2026-08-01T00:00:00Z",
	firstName: FIRST,
	lastName: LAST,
	matchedOn: [],
};

function mount(element: React.ReactElement): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(element);
	});
	return tr;
}

function flat(node: renderer.ReactTestInstance): Record<string, any> {
	return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, any>;
}

/** Text content of a host node subtree. */
function textOf(node: renderer.ReactTestInstance): string {
	return node.children
		.map((c) => (typeof c === "string" ? c : textOf(c as renderer.ReactTestInstance)))
		.join("");
}

/**
 * Walks from `node` up to `root`, returning a description of every ancestor (exclusive of the
 * node itself) that could clip or fix the size of its descendant. Empty means clean.
 */
function clippingAncestors(node: renderer.ReactTestInstance, root: renderer.ReactTestInstance): string[] {
	const problems: string[] = [];
	let cur: renderer.ReactTestInstance | null = node.parent;
	while (cur) {
		const st = flat(cur);
		for (const k of ["height", "maxHeight", "width"]) {
			if (st[k] !== undefined) problems.push(`${k}=${String(st[k])}`);
		}
		if (st.overflow === "hidden") problems.push("overflow:hidden");
		if (cur === root) break;
		cur = cur.parent;
	}
	return problems;
}

function bodyHasLineLimit(node: renderer.ReactTestInstance): boolean {
	return node.props.numberOfLines !== undefined || node.props.ellipsizeMode !== undefined;
}

beforeEach(() => {
	mockLocale = "en";
});

describe("PossibleDuplicateCallout (D-44, Surface 3)", () => {
	test("PD1: an undefined candidate renders null", () => {
		const tr = mount(<PossibleDuplicateCallout candidate={undefined} onViewOther={jest.fn()} />);
		expect(tr.toJSON()).toBeNull();
	});

	test("PD2: heading, body (interpolated with the full name) and button copy, EN and ES", () => {
		for (const locale of ["en", "es"] as const) {
			mockLocale = locale;
			const tr = mount(<PossibleDuplicateCallout candidate={CANDIDATE} onViewOther={jest.fn()} />);
			const dict = resources[locale].translation as Record<string, string>;
			const name = registrationRequestDisplayName({ requestId: CANDIDATE.requestId, lastName: LAST, firstName: FIRST });
			expect(textOf(tr.root.findByProps({ testID: "possible-duplicate-callout-heading" }))).toBe(dict.possibleDuplicateHeading);
			expect(textOf(tr.root.findByProps({ testID: "possible-duplicate-callout-body" }))).toBe(
				dict.possibleDuplicateBody.replace("{{name}}", name),
			);
			const button = tr.root.findByProps({ accessibilityRole: "button" });
			expect(button.props.accessibilityLabel).toBe(dict.possibleDuplicateViewOtherButton);
		}
	});

	test("PD3: pressing View Other calls onViewOther(candidate.requestId) once", () => {
		const onViewOther = jest.fn();
		const tr = mount(<PossibleDuplicateCallout candidate={CANDIDATE} onViewOther={onViewOther} />);
		const button = tr.root.findByProps({ accessibilityRole: "button" });
		act(() => {
			button.props.onPressIn();
		});
		expect(onViewOther).toHaveBeenCalledTimes(1);
		expect(onViewOther).toHaveBeenCalledWith(CANDIDATE.requestId);
	});

	test("PD4: warning left border, and the 40+ character name wraps in full (no clipping, no line limit)", () => {
		const tr = mount(<PossibleDuplicateCallout candidate={CANDIDATE} onViewOther={jest.fn()} />);
		const root = tr.root.findByProps({ testID: "possible-duplicate-callout" });
		const st = flat(root);
		expect(st.borderLeftWidth).toBe(4);
		expect(st.borderLeftColor).toBe("sentinel-warning");
		expect(st.overflow).not.toBe("hidden");

		const body = tr.root.findByProps({ testID: "possible-duplicate-callout-body" });
		expect(bodyHasLineLimit(body)).toBe(false);
		const bodyStyle = flat(body);
		expect(bodyStyle.width).toBeUndefined();
		expect(bodyStyle.height).toBeUndefined();
		expect(bodyStyle.maxHeight).toBeUndefined();
		expect(clippingAncestors(body, root)).toEqual([]);
		const full = registrationRequestDisplayName({ requestId: CANDIDATE.requestId, lastName: LAST, firstName: FIRST });
		expect(full.length).toBeGreaterThanOrEqual(40);
		expect(textOf(body)).toContain(full);
	});

	test("PD4 positive controls: the scan flags an overflow-hidden wrapper and a numberOfLines body", () => {
		const hidden = mount(
			<View testID="fixture-root">
				<View style={{ overflow: "hidden" }}>
					<Text testID="fixture-body">x</Text>
				</View>
			</View>,
		);
		const body = hidden.root.findByProps({ testID: "fixture-body" });
		expect(clippingAncestors(body, hidden.root.findByProps({ testID: "fixture-root" }))).toContain("overflow:hidden");

		const limited = mount(
			<Text testID="fixture-body" numberOfLines={1}>
				x
			</Text>,
		);
		expect(bodyHasLineLimit(limited.root.findByProps({ testID: "fixture-body" }))).toBe(true);
	});

	test("PD5: with no names, {{name}} is the truncated request id", () => {
		const bare = { ...CANDIDATE, firstName: undefined, lastName: undefined };
		const tr = mount(<PossibleDuplicateCallout candidate={bare} onViewOther={jest.fn()} />);
		const dict = resources.en.translation as Record<string, string>;
		expect(textOf(tr.root.findByProps({ testID: "possible-duplicate-callout-body" }))).toBe(
			dict.possibleDuplicateBody.replace("{{name}}", truncateId(CANDIDATE.requestId)),
		);
	});

	test("PD6: console spies are uncalled and the name occurs only inside the body node", () => {
		const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
		const tr = mount(<PossibleDuplicateCallout candidate={CANDIDATE} onViewOther={jest.fn()} />);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		spies.forEach((s) => s.mockRestore());

		const holders = tr.root
			.findAll((n) => typeof n.type === "string" && textOf(n).includes(FIRST) && n.children.every((c) => typeof c === "string"))
			.map((n) => n.props.testID);
		expect(holders).toEqual(["possible-duplicate-callout-body"]);
		// Not in any accessibility label either.
		const labels = tr.root.findAll((n) => typeof n.props.accessibilityLabel === "string").map((n) => n.props.accessibilityLabel as string);
		expect(labels.some((l) => l.includes(FIRST) || l.includes(LAST))).toBe(false);
	});
});
