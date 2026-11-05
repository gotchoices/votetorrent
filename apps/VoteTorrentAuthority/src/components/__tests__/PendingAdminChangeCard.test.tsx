/**
 * PendingAdminChangeCard: "Change pending", the local time the change takes effect, the screen's
 * error line, and Cancel change only when the screen says the device user may cancel.
 *
 * `t()` resolves against the REAL `resources`, THROWS on a missing key and fills `{{name}}`
 * placeholders; `useTheme()` returns the REAL light theme.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import type { PendingAdminChange } from "@votetorrent/vote-core";
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

import { PendingAdminChangeCard, type PendingAdminChangeCardProps } from "../PendingAdminChangeCard";

const IN_KTM = new Date(Date.UTC(2026, 10, 5, 4, 57, 0)).getTimezoneOffset() === -345;
const itKtm = IN_KTM ? it : it.skip;

const FIXTURE: PendingAdminChange = { effectiveAt: "2026-11-05T04:57:00", officers: [], thresholdPolicies: [], promoted: true };
const CANCEL_REFUSAL = "Only an administrator who can revise the administration can cancel this change.";

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

function props(over: Partial<PendingAdminChangeCardProps> = {}): PendingAdminChangeCardProps {
	return { pending: FIXTURE, canCancel: true, onCancel: jest.fn(), ...over };
}

async function mount(p: PendingAdminChangeCardProps): Promise<renderer.ReactTestRenderer> {
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<PendingAdminChangeCard {...p} />);
	});
	return r;
}

/** Fires the host node's press handler the way a tap does; the touchable decides whether a disabled button reacts. */
async function press(r: renderer.ReactTestRenderer, id: string): Promise<void> {
	const node = r.root.findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
	await act(async () => {
		node.props.onClick({ nativeEvent: {}, persist: () => {} });
	});
}

beforeEach(() => {
	mockCurrentLocale = "en";
});

describe("PendingAdminChangeCard", () => {
	it("shows Change pending and the local time the change takes effect", async () => {
		const r = await mount(props());
		const shown = text(r.toJSON());
		expect(shown).toContain("Change pending");
		expect(shown).toContain("Takes effect at " + formatLocalTime(FIXTURE.effectiveAt));
		expect(byTestId(r.toJSON(), "admin-change-pending-card")).toHaveLength(1);
	});

	itKtm("Asia/Kathmandu: shows exactly 10:42 for 04:57 UTC", async () => {
		const r = await mount(props());
		expect(text(r.toJSON())).toContain("Takes effect at 10:42");
	});

	it("shows the Spanish copy", async () => {
		mockCurrentLocale = "es";
		const r = await mount(props());
		const shown = text(r.toJSON());
		expect(shown).toContain("Cambio pendiente");
		expect(shown).toContain("Entra en vigor a las " + formatLocalTime(FIXTURE.effectiveAt));
	});

	it("canCancel shows Cancel change, and pressing it calls onCancel once with no arguments", async () => {
		const p = props({ canCancel: true });
		const r = await mount(p);
		expect(byTestId(r.toJSON(), "admin-change-cancel")).toHaveLength(1);
		expect(text(r.toJSON())).toContain("CANCEL CHANGE");
		await press(r, "admin-change-cancel");
		expect(p.onCancel).toHaveBeenCalledTimes(1);
		expect((p.onCancel as jest.Mock).mock.calls[0]).toEqual([]);
	});

	it("without canCancel there is no Cancel change button", async () => {
		const r = await mount(props({ canCancel: false }));
		expect(byTestId(r.toJSON(), "admin-change-cancel")).toHaveLength(0);
		expect(text(r.toJSON())).not.toContain("CANCEL CHANGE");
	});

	it("busy disables Cancel change and a press calls nothing", async () => {
		const p = props({ busy: true });
		const r = await mount(p);
		const node = r.root.findAll((n) => typeof n.type === "string" && n.props.testID === "admin-change-cancel")[0];
		expect(node.props.accessibilityState?.disabled).toBe(true);
		await press(r, "admin-change-cancel");
		expect(p.onCancel).not.toHaveBeenCalled();
	});

	it("renders the screen's error line, and nothing when there is none", async () => {
		const withError = await mount(props({ error: CANCEL_REFUSAL }));
		expect(text(withError.toJSON())).toContain(CANCEL_REFUSAL);
		const without = await mount(props());
		expect(text(without.toJSON())).not.toContain(CANCEL_REFUSAL);
	});

	it("renders the same pending text whether the change was promoted or not", async () => {
		const promoted = await mount(props({ pending: { ...FIXTURE, promoted: true } }));
		const waiting = await mount(props({ pending: { ...FIXTURE, promoted: false } }));
		expect(text(waiting.toJSON())).toBe(text(promoted.toJSON()));
	});
});
