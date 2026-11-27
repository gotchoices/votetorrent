/**
 * SettingsScreen — the owner-trust notice (D-09, D-10, D-11): S-1..S-7.
 *
 * The REAL SettingsScreen and the REAL OwnerTrustNotice mount over a mocked cadre-node context.
 * `t()` resolves against the REAL `resources`; `useTheme()` is the REAL light theme. "First" is
 * tree order under the scroll view, not measured geometry.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { resources } from "../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn(), goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false, setShowHelpIcons: jest.fn() }),
}));
jest.mock("../../../i18n", () => ({
	__esModule: true,
	...jest.requireActual("../../../i18n"),
	default: { language: "en", changeLanguage: jest.fn(async () => {}), on: jest.fn(), off: jest.fn() },
}));
jest.mock("../../../engines/engine-factory", () => {
	class NoNetworkEstablishedError extends Error {}
	return { NoNetworkEstablishedError, isNoNetworkEstablishedError: (e: unknown) => e instanceof NoNetworkEstablishedError };
});
let mockGetEngine = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: (...a: unknown[]) => mockGetEngine(...a) }),
}));
let mockCadreValue: Record<string, unknown> = { node: null };
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => mockCadreValue }));

import { OwnerTrustNotice } from "../../../components/OwnerTrustNotice";

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

function hosts(json: unknown): Json[] {
	const out: Json[] = [];
	const visit = (n: unknown) => {
		const list = n === null || n === undefined ? [] : Array.isArray(n) ? n : [n];
		for (const node of list as Json[]) {
			if (node === null || typeof node !== "object") continue;
			out.push(node);
			if (node.children) visit(node.children.filter((c) => typeof c !== "string"));
		}
	};
	visit(json);
	return out;
}

function textOf(node: Json): string {
	const parts: string[] = [];
	const visit = (n: Json) => {
		for (const c of n.children ?? []) {
			if (typeof c === "string") parts.push(c);
			else visit(c);
		}
	};
	visit(node);
	return parts.join("");
}

function pressableCount(json: unknown): number {
	return hosts(json).filter((h) => typeof h.props.onClick === "function" || typeof h.props.onPress === "function").length;
}

function noticeHosts(json: unknown): Json[] {
	return hosts(json).filter((h) => h.props.testID === "owner-trust-notice");
}

function scrollChildren(json: unknown): Json[] {
	const sv = hosts(json).find((h) => h.props.testID === "settings-scroll");
	if (!sv) throw new Error("settings-scroll not found");
	return hosts(sv.children?.filter((c): c is Json => typeof c !== "string"));
}

async function flush() {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(value: Record<string, unknown>): Promise<renderer.ReactTestRenderer> {
	mockCadreValue = { node: null, ...value };
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../SettingsScreen").default;
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<Screen />);
	});
	await flush();
	return r;
}

async function unmount(r: renderer.ReactTestRenderer): Promise<void> {
	await act(async () => {
		r.unmount();
	});
}

async function press(r: renderer.ReactTestRenderer, testID: string) {
	const el = r.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onPress === "function");
	expect(el.length).toBeGreaterThan(0);
	await act(async () => {
		el[0].props.onPress();
	});
	await flush();
}

const RAW = "Block default/app/TidHighWater is unavailable (cohort-unreachable): the repo could not determine whether it exists";

beforeEach(() => {
	jest.clearAllMocks();
	mockCurrentLocale = "en";
	mockGetEngine = jest.fn(async () => null);
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	(console.warn as jest.Mock).mockRestore();
	(console.error as jest.Mock).mockRestore();
	(console.info as jest.Mock).mockRestore();
});

describe("SettingsScreen owner-trust notice", () => {
	it("S-1: a missing ownerTrust and 'ok' render no notice", async () => {
		const a = await mount({});
		expect(noticeHosts(a.toJSON())).toHaveLength(0);
		await unmount(a);
		const b = await mount({ ownerTrust: "ok" });
		expect(noticeHosts(b.toJSON())).toHaveLength(0);
		await unmount(b);
	});

	describe.each(["en", "es"] as const)("S-2 (%s)", (locale) => {
		it.each(STATES)("%s shows one notice before the language row", async (state) => {
			mockCurrentLocale = locale;
			const r = await mount({ ownerTrust: state });
			const json = r.toJSON();
			expect(noticeHosts(json)).toHaveLength(1);
			const withId = scrollChildren(json).filter((h) => typeof h.props.testID === "string");
			expect(withId[0].props.testID).toBe("owner-trust-notice");
			const ids = withId.map((h) => h.props.testID);
			expect(ids.indexOf("owner-trust-notice")).toBeLessThan(ids.indexOf("settings-language-toggle"));
			const title = hosts(json).find((h) => h.props.testID === "owner-trust-notice-title") as Json;
			const body = hosts(json).find((h) => h.props.testID === "owner-trust-notice-body") as Json;
			expect(textOf(title)).toBe(tr(locale, KEYS[state].title));
			expect(textOf(body)).toBe(tr(locale, KEYS[state].body));
			await unmount(r);
		});
	});

	it.each(["memory-only", "blocked"] as const)("S-3: %s has no Open Settings action, and the setting row follows it", async (state) => {
		const r = await mount({ ownerTrust: state });
		const json = r.toJSON();
		expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice-" + state + "-action")).toHaveLength(0);
		const notice = noticeHosts(json)[0];
		expect(pressableCount(notice)).toBe(0);
		const ids = scrollChildren(json)
			.map((h) => h.props.testID)
			.filter((x) => typeof x === "string");
		expect(ids).toContain("settings-require-owner-trust");
		expect(ids.indexOf("settings-require-owner-trust")).toBeGreaterThan(ids.indexOf("owner-trust-notice"));
		await unmount(r);

		// Anti-vacuity: the same predicate counts the button when a screen does pass the callback.
		mockCadreValue = { node: null, ownerTrust: "blocked" };
		let lone!: renderer.ReactTestRenderer;
		await act(async () => {
			lone = renderer.create(<OwnerTrustNotice onOpenSettings={jest.fn()} />);
		});
		expect(pressableCount(lone.toJSON())).toBe(1);
		await unmount(lone);
	});

	it("S-4: needs-reinvite has the wired action and exactly one pressable", async () => {
		const r = await mount({ ownerTrust: "needs-reinvite" });
		const json = r.toJSON();
		expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice-needs-reinvite-action").length).toBeGreaterThan(0);
		expect(pressableCount(noticeHosts(json)[0])).toBe(1);
		const el = r.root.findAll((n) => n.props.testID === "owner-trust-notice-needs-reinvite-action" && typeof n.props.onPress === "function");
		await act(async () => {
			el[0].props.onPress();
		});
		expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
		await unmount(r);
	});

	it("S-5: the notice stays beside the peer notice, through Try Again and the language dropdown", async () => {
		mockGetEngine = jest
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error(RAW), { name: "BlockUnavailableError", reason: "cohort-unreachable" }))
			.mockResolvedValue(null);
		const r = await mount({ ownerTrust: "memory-only" });
		const peer = () => hosts(r.toJSON()).filter((h) => h.props.testID === "peer-read-unavailable-notice").length;
		expect(peer()).toBe(1);
		expect(noticeHosts(r.toJSON())).toHaveLength(1);
		await press(r, "peer-read-unavailable-retry");
		expect(peer()).toBe(0);
		expect(noticeHosts(r.toJSON())).toHaveLength(1);
		await press(r, "settings-language-toggle");
		expect(noticeHosts(r.toJSON())).toHaveLength(1);
		await unmount(r);
	});

	it("S-6: blocked with no node renders the notice and the row without a console.error", async () => {
		const r = await mount({ ownerTrust: "blocked", node: null });
		const json = r.toJSON();
		expect(noticeHosts(json)).toHaveLength(1);
		expect(hosts(json).filter((h) => h.props.testID === "settings-require-owner-trust").length).toBeGreaterThan(0);
		expect(console.error).not.toHaveBeenCalled();
		await unmount(r);
	});

	it("S-7: the notice goes away when the context value becomes ok", async () => {
		const r = await mount({ ownerTrust: "memory-only" });
		expect(noticeHosts(r.toJSON())).toHaveLength(1);
		mockCadreValue = { node: null, ownerTrust: "ok" };
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const Screen = require("../SettingsScreen").default;
		await act(async () => {
			r.update(<Screen />);
		});
		await flush();
		expect(noticeHosts(r.toJSON())).toHaveLength(0);
		await unmount(r);
	});
});
