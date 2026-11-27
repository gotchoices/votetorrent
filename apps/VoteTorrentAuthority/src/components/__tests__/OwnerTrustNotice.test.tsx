/**
 * OwnerTrustNotice — O-1..O-9 (D-09, D-10, D-11).
 *
 * `t()` resolves against the REAL `resources` and THROWS on a missing key; `useTheme()` returns the
 * REAL light or dark theme. The cadre-node context is mocked (the real provider cannot load under
 * the Authority RN jest config).
 */
import React from "react";
import fs from "fs";
import path from "path";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { lightTheme, darkTheme } from "../../theme/themes";
import { resources } from "../../i18n";
import { CustomButton } from "../CustomButton";
import { ThemedText } from "../ThemedText";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			if (typeof value !== "string") throw new Error("missing copy key " + key);
			return value;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

let mockDark = false;
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const themes = require("../../theme/themes");
		return mockDark ? themes.darkTheme : themes.lightTheme;
	},
}));

let mockCadreValue: Record<string, unknown> = { node: null };
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => mockCadreValue,
}));

import { OwnerTrustNotice, ownerTrustNoticeState } from "../OwnerTrustNotice";

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };

type StateName = "needs-reinvite" | "memory-only" | "blocked";
const STATES: StateName[] = ["needs-reinvite", "memory-only", "blocked"];
const KEYS: Record<StateName, { title: string; body: string }> = {
	"needs-reinvite": { title: "ownerTrustReinviteTitle", body: "ownerTrustReinviteBody" },
	"memory-only": { title: "ownerTrustMemoryTitle", body: "ownerTrustMemoryBody" },
	blocked: { title: "ownerTrustBlockedTitle", body: "ownerTrustBlockedBody" },
};

function tr(locale: "en" | "es", key: string): string {
	return (resources[locale].translation as Record<string, string>)[key];
}

function asNodes(json: unknown): Json[] {
	if (json === null || json === undefined) return [];
	return (Array.isArray(json) ? json : [json]) as Json[];
}

/** Pre-order list of host nodes. */
function hosts(json: unknown): Json[] {
	const out: Json[] = [];
	const visit = (n: unknown) => {
		for (const node of asNodes(n)) {
			if (node === null || typeof node !== "object") continue;
			out.push(node);
			if (node.children) visit(node.children.filter((c) => typeof c !== "string"));
		}
	};
	visit(json);
	return out;
}

function stringsIn(json: unknown): string[] {
	const out: string[] = [];
	const visit = (n: unknown) => {
		for (const node of asNodes(n)) {
			if (node === null || typeof node !== "object") continue;
			for (const c of node.children ?? []) {
				if (typeof c === "string") out.push(c);
				else visit(c);
			}
		}
	};
	visit(json);
	return out;
}

function labelsIn(json: unknown): string[] {
	return hosts(json)
		.map((h) => h.props.accessibilityLabel)
		.filter((l): l is string => typeof l === "string");
}

function pressableCount(json: unknown): number {
	return hosts(json).filter((h) => typeof h.props.onClick === "function" || typeof h.props.onPress === "function").length;
}

function textHostsWithNumberOfLines(json: unknown): Json[] {
	return hosts(json).filter((h) => h.props.numberOfLines !== undefined);
}

function byTestId(json: unknown, id: string): Json[] {
	return hosts(json).filter((h) => h.props.testID === id);
}

async function mount(value: Record<string, unknown>, props: Record<string, unknown> = {}) {
	mockCadreValue = value;
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<OwnerTrustNotice {...(props as object)} />);
	});
	return r;
}

async function unmount(r: renderer.ReactTestRenderer): Promise<void> {
	await act(async () => {
		r.unmount();
	});
}

function flat(style: unknown): Record<string, any> {
	return (StyleSheet.flatten(style as never) ?? {}) as Record<string, any>;
}

const consoleSpies: jest.SpyInstance[] = [];
beforeEach(() => {
	mockCurrentLocale = "en";
	mockDark = false;
	mockCadreValue = { node: null };
	for (const m of ["log", "info", "warn", "error", "debug"] as const) {
		consoleSpies.push(jest.spyOn(console, m).mockImplementation(() => {}));
	}
});
afterEach(() => {
	const calls = consoleSpies.reduce((n, s) => n + s.mock.calls.length, 0);
	consoleSpies.splice(0).forEach((s) => s.mockRestore());
	expect(calls).toBe(0);
});

describe("ownerTrustNoticeState (O-1)", () => {
	it("maps undefined, ok and unknown to null and each real state to itself", async () => {
		expect(ownerTrustNoticeState(undefined)).toBeNull();
		expect(ownerTrustNoticeState("ok")).toBeNull();
		expect(ownerTrustNoticeState("garbage" as never)).toBeNull();
		for (const s of STATES) expect(ownerTrustNoticeState(s)).toBe(s);
	});
});

describe("OwnerTrustNotice", () => {
	it("O-2: a missing ownerTrust and 'ok' render nothing", async () => {
		const a = await mount({ node: null });
		expect(a.toJSON()).toBeNull();
		await unmount(a);
		const b = await mount({ node: null, ownerTrust: "ok" });
		expect(b.toJSON()).toBeNull();
		await unmount(b);
	});

	describe.each(["en", "es"] as const)("O-3 copy (%s)", (locale) => {
		it.each(STATES)("renders %s once with its real title and body", async (state) => {
			mockCurrentLocale = locale;
			const r = await mount({ node: null, ownerTrust: state });
			const json = r.toJSON();
			expect(byTestId(json, "owner-trust-notice")).toHaveLength(1);
			expect(byTestId(json, "owner-trust-notice")[0].props.accessibilityRole).toBe("alert");
			for (const s of STATES) {
				expect(byTestId(json, "owner-trust-notice-" + s)).toHaveLength(s === state ? 1 : 0);
			}
			const title = tr(locale, KEYS[state].title);
			const body = tr(locale, KEYS[state].body);
			expect(stringsIn(byTestId(json, "owner-trust-notice-title"))).toEqual([title]);
			expect(stringsIn(byTestId(json, "owner-trust-notice-body"))).toEqual([body]);
			expect(stringsIn(json).sort()).toEqual([title, body].sort());
			expect(pressableCount(json)).toBe(0);
			await unmount(r);
		});
	});

	describe.each([
		["light", false],
		["dark", true],
	] as const)("O-4 styles (%s theme)", (_name, dark) => {
		it.each(STATES)("%s carries the approved container, icon, title and body styling", async (state) => {
			mockDark = dark;
			const colors = (dark ? darkTheme : lightTheme).colors;
			const r = await mount({ node: null, ownerTrust: state });
			const json = r.toJSON();
			const box = flat(byTestId(json, "owner-trust-notice")[0].props.style);
			expect(box.borderWidth).toBe(1);
			expect(box.borderRadius).toBe(8);
			expect(box.padding).toBe(16);
			expect(box.backgroundColor).toBe(colors.card);
			expect(box.borderColor).toBe(state === "blocked" ? colors.error : colors.warning);
			for (const k of ["width", "height", "maxHeight", "position", "overflow"]) {
				expect(Object.keys(box)).not.toContain(k);
			}
			const icon = byTestId(json, "owner-trust-notice-icon")[0];
			expect(icon.type).toBe("FontAwesome6");
			expect(icon.props.name).toBe(state === "blocked" ? "circle-exclamation" : "triangle-exclamation");
			expect(icon.props.color).toBe(state === "blocked" ? colors.error : colors.warningText);
			expect(icon.props.accessible).toBe(false);
			expect(icon.props.importantForAccessibility).toBe("no");
			const title = byTestId(json, "owner-trust-notice-title")[0];
			expect(flat(title.props.style).flexShrink).toBe(1);
			expect(flat(title.props.style).fontWeight).toBe("600");
			const body = byTestId(json, "owner-trust-notice-body")[0];
			expect(flat(body.props.style).color).toBe(colors.text);
			expect(flat(body.props.style).color).not.toBe(colors.textSecondary);
			expect(textHostsWithNumberOfLines(json)).toHaveLength(0);
			await unmount(r);
		});
	});

	describe("O-5 actions", () => {
		const press = async (r: renderer.ReactTestRenderer, id: string) => {
			const el = r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function");
			expect(el.length).toBeGreaterThan(0);
			await act(async () => {
				el[0].props.onPress();
			});
		};

		it("needs-reinvite: renders its action only with onNeedsReinvite", async () => {
			const fn = jest.fn();
			const r = await mount({ node: null, ownerTrust: "needs-reinvite" }, { onNeedsReinvite: fn });
			const json = r.toJSON();
			const btn = byTestId(json, "owner-trust-notice-needs-reinvite-action");
			expect(btn.length).toBeGreaterThan(0);
			expect(btn[0].props.accessibilityLabel).toBe(tr("en", "ownerTrustReinviteAction"));
			const el = r.root.findAll((n) => n.type === CustomButton);
			expect(el).toHaveLength(1);
			expect(el[0].props.icon).toBe("right-to-bracket");
			expect(el[0].props.size).toBe("tall");
			expect("backgroundColor" in el[0].props).toBe(false);
			await press(r, "owner-trust-notice-needs-reinvite-action");
			expect(fn).toHaveBeenCalledTimes(1);
			await unmount(r);
			for (const props of [{}, { onOpenSettings: jest.fn() }]) {
				const q = await mount({ node: null, ownerTrust: "needs-reinvite" }, props);
				expect(byTestId(q.toJSON(), "owner-trust-notice-needs-reinvite-action")).toHaveLength(0);
				expect(pressableCount(q.toJSON())).toBe(0);
				await unmount(q);
			}
		});

		it.each(["memory-only", "blocked"] as const)("%s: renders Open Settings only with onOpenSettings", async (state) => {
			const fn = jest.fn();
			const id = "owner-trust-notice-" + state + "-action";
			const r = await mount({ node: null, ownerTrust: state }, { onOpenSettings: fn });
			const btn = byTestId(r.toJSON(), id);
			expect(btn.length).toBeGreaterThan(0);
			expect(btn[0].props.accessibilityLabel).toBe(tr("en", "ownerTrustOpenSettings"));
			const el = r.root.findAll((n) => n.type === CustomButton);
			expect(el).toHaveLength(1);
			expect(el[0].props.icon).toBe("gear");
			expect(el[0].props.size).toBe("tall");
			expect("backgroundColor" in el[0].props).toBe(false);
			await press(r, id);
			expect(fn).toHaveBeenCalledTimes(1);
			await unmount(r);
			for (const props of [{}, { onNeedsReinvite: jest.fn() }]) {
				const q = await mount({ node: null, ownerTrust: state }, props);
				expect(byTestId(q.toJSON(), id)).toHaveLength(0);
				expect(pressableCount(q.toJSON())).toBe(0);
				await unmount(q);
			}
		});
	});

	describe("O-6 no dismiss", () => {
		it.each(STATES)("%s holds exactly one pressable and no close label", async (state) => {
			const r = await mount({ node: null, ownerTrust: state }, { onNeedsReinvite: jest.fn(), onOpenSettings: jest.fn() });
			const json = r.toJSON();
			expect(pressableCount(json)).toBe(1);
			for (const l of labelsIn(json)) expect(l).not.toMatch(/close|dismiss|cerrar|descartar/i);
			await unmount(r);
		});

		it("the component source has no dismiss vocabulary", async () => {
			const src = fs.readFileSync(path.join(__dirname, "../OwnerTrustNotice.tsx"), "utf8");
			const code = src
				.split("\n")
				.filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
				.join("\n");
			expect(code.length).toBeGreaterThan(500);
			for (const w of ["dismiss", "onDismiss", "onClose", "onHide", "visible", "hidden"]) {
				expect(new RegExp("\\b" + w + "\\b", "i").test(code)).toBe(false);
			}
			expect(code).not.toMatch(/numberOfLines|ScrollView|console\.|backgroundColor=/);
		});
	});

	describe.each(["en", "es"] as const)("O-7 copy hygiene (%s)", (locale) => {
		it.each(STATES)("%s has no phase number and names no screen", async (state) => {
			mockCurrentLocale = locale;
			const r = await mount({ node: null, ownerTrust: state }, { onNeedsReinvite: jest.fn(), onOpenSettings: jest.fn() });
			const json = r.toJSON();
			const all = [...stringsIn(json), ...labelsIn(json)];
			expect(all.length).toBeGreaterThanOrEqual(3);
			for (const s of all) {
				expect(s.length).toBeGreaterThan(0);
				expect(s).not.toMatch(/phase\s*\d+|fase\s*\d+/i);
				expect(s).not.toMatch(/\bNetworks\b|\bRedes\b/);
				expect(s).not.toMatch(/networks screen|pantalla (de )?redes/i);
			}
			await unmount(r);
		});
	});

	describe("O-8 never reads the node", () => {
		it.each(STATES)("%s renders with a node that throws on any access", async (state) => {
			const node = new Proxy(
				{},
				{
					get() {
						throw new Error("the notice read the node");
					},
				},
			);
			const r = await mount({ node, ownerTrust: state });
			expect(byTestId(r.toJSON(), "owner-trust-notice-" + state)).toHaveLength(1);
			expect(stringsIn(r.toJSON())).toHaveLength(2);
			await unmount(r);
		});
	});

	describe("O-9 anti-vacuity of the walkers", () => {
		it("the numberOfLines walker flags a synthetic Text", async () => {
			const synthetic: Json = {
				type: "View",
				props: {},
				children: [{ type: "Text", props: { numberOfLines: 2 }, children: ["x"] }],
			};
			expect(textHostsWithNumberOfLines(synthetic)).toHaveLength(1);
		});

		it("the string collector finds at least 2 strings in every state", async () => {
			for (const s of STATES) {
				const r = await mount({ node: null, ownerTrust: s });
				expect(stringsIn(r.toJSON()).length).toBeGreaterThanOrEqual(2);
				await unmount(r);
			}
		});

		it("the pressable predicate counts 1 on a lone CustomButton and 0 on a lone ThemedText", async () => {
			let a!: renderer.ReactTestRenderer;
			await act(async () => {
				a = renderer.create(<CustomButton title="x" onPress={jest.fn()} />);
			});
			expect(pressableCount(a.toJSON())).toBe(1);
			await unmount(a);
			let b!: renderer.ReactTestRenderer;
			await act(async () => {
				b = renderer.create(<ThemedText>x</ThemedText>);
			});
			expect(pressableCount(b.toJSON())).toBe(0);
			await unmount(b);
		});
	});
});
