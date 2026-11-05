/**
 * AdminChangeConfirmCard: the inline confirm step shows the local effective time it was GIVEN (never
 * one it computes), the optional notice above it, and two buttons that are disabled while busy.
 *
 * `t()` resolves against the REAL `resources`, THROWS on a missing key and fills `{{name}}`
 * placeholders; `useTheme()` returns the REAL light theme.
 */
import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";
import { formatLocalTime } from "../../utils/displayUtils";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			const { resources: res } = require("../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			if (typeof value !== "string") throw new Error("missing copy key " + key);
			return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m: string, name: string) => String(opts?.[name]));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		return require("../../theme/themes").lightTheme;
	},
}));

import { AdminChangeConfirmCard, type AdminChangeConfirmCardProps } from "../AdminChangeConfirmCard";

const IN_KTM = new Date(Date.UTC(2026, 10, 5, 4, 57, 0)).getTimezoneOffset() === -345;
const itKtm = IN_KTM ? it : it.skip;

const AT = "2026-11-05T04:57:00";
const LATER = "2026-11-05T13:14:00";

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };

function asNodes(json: unknown): Json[] {
	if (json === null || json === undefined) return [];
	return (Array.isArray(json) ? json : [json]) as Json[];
}

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

function text(json: unknown): string {
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
	return out.join("\n");
}

function byTestId(json: unknown, id: string): Json[] {
	return hosts(json).filter((h) => h.props.testID === id);
}

function props(over: Partial<AdminChangeConfirmCardProps> = {}): AdminChangeConfirmCardProps {
	return { effectiveAt: AT, onConfirm: jest.fn(), onBack: jest.fn(), ...over };
}

async function mount(p: AdminChangeConfirmCardProps): Promise<renderer.ReactTestRenderer> {
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<AdminChangeConfirmCard {...p} />);
	});
	return r;
}

/** Fires the host node's press handler the way a tap does; the touchable itself decides whether a disabled button reacts. */
async function press(r: renderer.ReactTestRenderer, id: string): Promise<void> {
	const node = r.root.findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
	await act(async () => {
		node.props.onClick({ nativeEvent: {}, persist: () => {} });
	});
}

beforeEach(() => {
	mockCurrentLocale = "en";
});

describe("AdminChangeConfirmCard", () => {
	it("shows the confirm line with the local time of the given effectiveAt", async () => {
		const r = await mount(props());
		expect(text(r.toJSON())).toContain("Takes effect at " + formatLocalTime(AT) + ". Confirm to sign this change.");
	});

	itKtm("Asia/Kathmandu: shows exactly 10:42 for 04:57 UTC", async () => {
		const r = await mount(props());
		expect(text(r.toJSON())).toContain("Takes effect at 10:42. Confirm to sign this change.");
	});

	it("shows the Spanish copy with the same time", async () => {
		mockCurrentLocale = "es";
		const r = await mount(props());
		expect(text(r.toJSON())).toContain("Entra en vigor a las " + formatLocalTime(AT));
	});

	it("takes the time from the prop: a new effectiveAt changes the shown time", async () => {
		const r = await mount(props());
		expect(formatLocalTime(LATER)).not.toBe(formatLocalTime(AT));
		await act(async () => {
			r.update(<AdminChangeConfirmCard {...props({ effectiveAt: LATER })} />);
		});
		const shown = text(r.toJSON());
		expect(shown).toContain("Takes effect at " + formatLocalTime(LATER) + ".");
		expect(shown).not.toContain("Takes effect at " + formatLocalTime(AT) + ".");
	});

	it("ignores the clock: a faked system time does not change the shown time", async () => {
		jest.useFakeTimers().setSystemTime(Date.UTC(2030, 0, 1, 0, 0, 0));
		try {
			let r!: renderer.ReactTestRenderer;
			act(() => {
				r = renderer.create(<AdminChangeConfirmCard {...props()} />);
			});
			expect(text(r.toJSON())).toContain("Takes effect at " + formatLocalTime(AT) + ".");
			act(() => {
				r.unmount();
			});
		} finally {
			jest.useRealTimers();
		}
	});

	it("Confirm and Go back each call their handler once with no arguments", async () => {
		const p = props();
		const r = await mount(p);
		await press(r, "admin-change-confirm");
		expect(p.onConfirm).toHaveBeenCalledTimes(1);
		expect((p.onConfirm as jest.Mock).mock.calls[0]).toEqual([]);
		await press(r, "admin-change-confirm-back");
		expect(p.onBack).toHaveBeenCalledTimes(1);
		expect((p.onBack as jest.Mock).mock.calls[0]).toEqual([]);
	});

	it("busy disables both buttons and pressing them calls nothing", async () => {
		const p = props({ busy: true });
		const r = await mount(p);
		for (const id of ["admin-change-confirm", "admin-change-confirm-back"]) {
			const node = r.root.findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
			expect(node.props.accessibilityState?.disabled).toBe(true);
			await press(r, id);
		}
		const buttons = r.root.findAll((n) => n.props.testID === "admin-change-confirm" && typeof n.props.disabled === "boolean");
		expect(buttons.length).toBeGreaterThan(0);
		for (const b of buttons) expect(b.props.disabled).toBe(true);
		expect(p.onConfirm).not.toHaveBeenCalled();
		expect(p.onBack).not.toHaveBeenCalled();
	});

	it("each testID resolves exactly once", async () => {
		const r = await mount(props());
		const json = r.toJSON();
		for (const id of ["admin-change-confirm-card", "admin-change-confirm", "admin-change-confirm-back"]) {
			expect(byTestId(json, id)).toHaveLength(1);
		}
	});

	it("shows a given notice once, above the time line, and nothing for an absent or empty notice", async () => {
		const withNotice = await mount(props({ notice: "Check the time" }));
		const nodes = byTestId(withNotice.toJSON(), "admin-change-confirm-notice");
		expect(nodes).toHaveLength(1);
		expect(text(nodes)).toBe("Check the time");
		const all = text(withNotice.toJSON());
		expect(all.indexOf("Check the time")).toBeLessThan(all.indexOf("Takes effect at "));

		const absent = await mount(props());
		expect(byTestId(absent.toJSON(), "admin-change-confirm-notice")).toHaveLength(0);
		const empty = await mount(props({ notice: "" }));
		expect(byTestId(empty.toJSON(), "admin-change-confirm-notice")).toHaveLength(0);
	});

	it("the component source computes no time", () => {
		const src = fs.readFileSync(path.join(__dirname, "..", "AdminChangeConfirmCard.tsx"), "utf8");
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
		for (const token of ["Date" + ".now", "new " + "Date", "ADMIN_CHANGE_" + "DELAY_MS", "adminChange" + "EffectiveAt"]) {
			expect(code.includes(token)).toBe(false);
		}
	});
});
