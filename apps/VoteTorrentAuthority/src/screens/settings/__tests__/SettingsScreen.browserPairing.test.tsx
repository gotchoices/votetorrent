/**
 * SettingsScreen — the owner-only "Browser pairing" section (D-28): O1..O11.
 *
 * The section shows only on a phone whose identity is a cadre owner (the pair-mint host's own
 * predicate): the auto-approve switch and the last 20 pairing requests with officer names and an
 * outcome word. An unreadable switch shows OFF (as the host reads it); an unreadable log shows as
 * unreadable, never as empty.
 *
 * `t()` echoes the key, or `key|<json params>` when params are given. The store's switch and log
 * reads are mocked; `PairingOwnerStoreError` is the REAL class (the store imports AsyncStorage and a
 * type-only vote-engine import; its one value import, voter-invite, is mocked here).
 */
import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key),
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Every live focus effect registers a re-fire hook so a test can "focus the screen again"; an
// effect also re-runs when its callback changes (as the real hook does while focused).
const mockFocusFires = new Set<() => void>();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn(), goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const R = require("react");
		const ref = R.useRef(cb);
		ref.current = cb;
		R.useEffect(() => {
			const fire = () => {
				ref.current();
			};
			mockFocusFires.add(fire);
			return () => {
				mockFocusFires.delete(fire);
			};
		}, []);
		R.useEffect(() => {
			cb();
		}, [cb]);
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

const mockGetUser = jest.fn();
let mockNetworkEngine: Record<string, unknown> | null = null;
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: async (name: string) => (name === "network" ? mockNetworkEngine : null),
	}),
}));

const NODE = { tag: "cadre-node" };
let mockCadreValue: Record<string, unknown> = { node: null };
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => mockCadreValue }));

const mockCapability = jest.fn();
jest.mock("../../../engines/voter-invite", () => ({
	voterInviteCapability: (...a: unknown[]) => mockCapability(...a),
}));

const mockReadSwitch = jest.fn();
const mockWriteSwitch = jest.fn();
const mockReadMintLog = jest.fn();
jest.mock("../../../engines/pairing-owner-store", () => ({
	...jest.requireActual("../../../engines/pairing-owner-store"),
	readPairingSwitch: (...a: unknown[]) => mockReadSwitch(...a),
	writePairingSwitch: (...a: unknown[]) => mockWriteSwitch(...a),
	readMintLog: (...a: unknown[]) => mockReadMintLog(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PairingOwnerStoreError } = jest.requireActual("../../../engines/pairing-owner-store") as typeof import("../../../engines/pairing-owner-store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const settingsModule = require("../SettingsScreen") as typeof import("../SettingsScreen");
const Screen = settingsModule.default as React.ComponentType;
const { mintLogOutcomeKey, MINT_LOG_SHOWN } = settingsModule;

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");

// ---------------------------------------------------------------------------------------------
// Fixtures (distinctive ids, so the hygiene scans are meaningful)

const U1 = "officerOneUserIdOfficerOne01";
const U2 = "officerTwoUserIdOfficerTwo02";
const NONCES = ["MintNonceAlphaAlpha00001", "MintNonceBravoBravo00002", "MintNonceCharlieChar0003"];
const INVITE_KEYS = ["mintInviteKeyAlphaAlpha0001", "mintInviteKeyBravoBravo0002"];
const SECRETS = [U1, U2, ...NONCES, ...INVITE_KEYS];
const AT_1 = new Date(2026, 10, 3, 9, 5).getTime();
const AT_2 = new Date(2026, 10, 3, 8, 0).getTime();
const AT_3 = new Date(2026, 10, 2, 23, 59).getTime();

function logFixture() {
	return [
		{ nonce: NONCES[0], userId: U1, inviteKey: INVITE_KEYS[0], at: AT_1, expiresAt: "2026-11-03 09:20:00", outcome: "approved" },
		{ nonce: NONCES[1], userId: U2, inviteKey: null, at: AT_2, expiresAt: null, outcome: "refused:switched-off" },
		{ nonce: NONCES[2], userId: U1, inviteKey: INVITE_KEYS[1], at: AT_3, expiresAt: null, outcome: "unreachable" },
	];
}

function officer(name: string) {
	return { getSummary: async () => ({ id: "x", name, activeKeys: [] }) };
}

// ---------------------------------------------------------------------------------------------
// Helpers

const mounted: renderer.ReactTestRenderer[] = [];

async function flush(n = 12) {
	for (let i = 0; i < n; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(cadre: Record<string, unknown> = { node: NODE }): Promise<renderer.ReactTestRenderer> {
	mockCadreValue = cadre;
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<Screen />);
	});
	mounted.push(r);
	await flush();
	return r;
}

async function refocus() {
	await act(async () => {
		for (const fire of Array.from(mockFocusFires)) fire();
	});
	await flush();
}

const all = (r: renderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props.testID === id);
const has = (r: renderer.ReactTestRenderer, id: string) => all(r, id).length > 0;
const hostAll = (r: renderer.ReactTestRenderer, id: string) =>
	r.root.findAll((n) => n.props.testID === id && typeof n.type === "string");
const byId = (r: renderer.ReactTestRenderer, id: string) => {
	const found = all(r, id);
	if (found.length === 0) throw new Error(`no node with testID ${id}`);
	return found[0];
};
const textOf = (node: renderer.ReactTestInstance) =>
	node
		.findAll((n) => typeof n.type === "string" && (typeof n.props.children === "string" || typeof n.props.children === "number"))
		.map((n) => String(n.props.children))
		.join(" ");

/** The switch element (the composite carrying `value` and `onValueChange`). */
const pairingSwitch = (r: renderer.ReactTestRenderer) =>
	r.root.findAll(
		(n) => n.props.testID === "settings-browser-pairing-switch" && typeof n.props.onValueChange === "function"
	)[0];

async function toggle(r: renderer.ReactTestRenderer, next: boolean) {
	await act(async () => {
		pairingSwitch(r).props.onValueChange(next);
	});
	await flush();
}

function exposedStrings(r: renderer.ReactTestRenderer): string[] {
	const out: string[] = [];
	for (const n of r.root.findAll(() => true)) {
		const c = n.props.children;
		if (typeof c === "string") out.push(c);
		if (Array.isArray(c)) for (const x of c) if (typeof x === "string") out.push(x);
		for (const p of ["accessibilityLabel", "accessibilityHint", "testID", "nativeID"]) {
			if (typeof n.props[p] === "string") out.push(n.props[p]);
		}
	}
	return out;
}

function deferred<V>() {
	let resolve!: (v: V) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<V>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFocusFires.clear();
	mockCapability.mockResolvedValue("ready");
	mockReadSwitch.mockResolvedValue(true);
	mockWriteSwitch.mockResolvedValue(undefined);
	mockReadMintLog.mockImplementation(async () => logFixture());
	mockGetUser.mockImplementation(async (id: string) => (id === U1 ? officer("Ann Officer") : id === U2 ? officer("Bo Officer") : undefined));
	mockNetworkEngine = {
		getDetails: async () => ({ network: { name: "Net One" } }),
		getUser: (...a: unknown[]) => mockGetUser(...a),
	};
});

afterEach(async () => {
	while (mounted.length > 0) {
		const r = mounted.pop()!;
		try {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => r.unmount());
		} catch {
			// already unmounted
		}
	}
});

// ---------------------------------------------------------------------------------------------

describe("SettingsScreen browser pairing (owner phones only)", () => {
	it("O1 visibility: no node reads nothing and shows nothing; only an owner capability shows the section", async () => {
		const none = await mount({ node: null });
		expect(has(none, "settings-browser-pairing-section")).toBe(false);
		expect(mockCapability).not.toHaveBeenCalled();
		expect(mockReadSwitch).not.toHaveBeenCalled();
		expect(mockReadMintLog).not.toHaveBeenCalled();

		for (const cap of ["not-owner", "needs-owner-setup", "unavailable"]) {
			mockCapability.mockResolvedValue(cap);
			mockReadSwitch.mockClear();
			mockReadMintLog.mockClear();
			// eslint-disable-next-line no-await-in-loop
			const r = await mount();
			expect([cap, has(r, "settings-browser-pairing-section")]).toEqual([cap, false]);
			expect(mockReadSwitch).not.toHaveBeenCalled();
			expect(mockReadMintLog).not.toHaveBeenCalled();
		}

		mockCapability.mockRejectedValue(new Error("capability read failed"));
		const failed = await mount();
		expect(has(failed, "settings-browser-pairing-section")).toBe(false);

		mockCapability.mockResolvedValue("ready");
		const owner = await mount();
		expect(hostAll(owner, "settings-browser-pairing-section").length).toBe(1);
		expect(textOf(byId(owner, "settings-browser-pairing-section")).includes("pairingMintLogSectionTitle")).toBe(true);
		expect(mockCapability).toHaveBeenCalledWith(NODE);
		expect(pairingSwitch(owner).props.accessibilityLabel).toBe("pairingMintLogSwitchLabel");
	});

	it("O2 switch read: on/absent shows ON with the on help; off shows OFF; an unreadable switch shows OFF with a fixed-tag warning", async () => {
		const on = await mount();
		expect(pairingSwitch(on).props.value).toBe(true);
		expect(textOf(byId(on, "settings-browser-pairing-help"))).toBe("pairingMintLogSwitchHelpOn");

		mockReadSwitch.mockResolvedValue(false);
		const off = await mount();
		expect(pairingSwitch(off).props.value).toBe(false);
		expect(textOf(byId(off, "settings-browser-pairing-help"))).toBe("pairingMintLogSwitchHelpOff");

		mockReadSwitch.mockRejectedValue(new Error(`garbage ${NONCES[0]}`));
		const cap = captureConsole();
		let bad!: renderer.ReactTestRenderer;
		try {
			bad = await mount();
			const pairingLines = cap.calls().filter((c) => String(c[0]).startsWith("[browser-pairing]"));
			// One line per focus run (the run re-fires once the network engine loads).
			expect(pairingLines.length).toBeGreaterThanOrEqual(1);
			for (const line of pairingLines) expect(line).toEqual(["[browser-pairing] switch: unreadable"]);
			expectNoSecretInConsole(cap, [...SECRETS, "garbage"]);
		} finally {
			cap.restore();
		}
		expect(pairingSwitch(bad).props.value).toBe(false);
		expect(textOf(byId(bad, "settings-browser-pairing-help"))).toBe("pairingMintLogSwitchHelpOff");
	});

	it("O3 switch write: shows the choice at once, a failed save shows the line and the stored value, a late read or an older failure never overwrites a newer choice", async () => {
		const r = await mount();
		await toggle(r, false);
		expect(mockWriteSwitch).toHaveBeenCalledTimes(1);
		expect(mockWriteSwitch).toHaveBeenCalledWith(false);
		expect(pairingSwitch(r).props.value).toBe(false);
		expect(textOf(byId(r, "settings-browser-pairing-help"))).toBe("pairingMintLogSwitchHelpOff");
		expect(has(r, "settings-browser-pairing-save-failed")).toBe(false);

		// A failed save: the line, and the stored value (still OFF) shown instead of the unsaved ON.
		mockWriteSwitch.mockRejectedValueOnce(new Error("disk full"));
		mockReadSwitch.mockResolvedValue(false);
		await toggle(r, true);
		expect(mockWriteSwitch).toHaveBeenLastCalledWith(true);
		expect(textOf(byId(r, "settings-browser-pairing-save-failed"))).toBe("pairingMintLogSwitchSaveFailed");
		expect(pairingSwitch(r).props.value).toBe(false);
		expect(textOf(byId(r, "settings-browser-pairing-help"))).toBe("pairingMintLogSwitchHelpOff");
		// A later successful toggle clears the line.
		await toggle(r, true);
		expect(has(r, "settings-browser-pairing-save-failed")).toBe(false);
		expect(pairingSwitch(r).props.value).toBe(true);

		// A late first read never overwrites a value the owner already toggled.
		const firstRead = deferred<boolean>();
		mockReadSwitch.mockImplementation(() => firstRead.promise);
		const late = await mount();
		expect(pairingSwitch(late).props.value).toBe(true);
		await toggle(late, false);
		await act(async () => firstRead.resolve(true));
		await flush();
		expect(pairingSwitch(late).props.value).toBe(false);

		// An older write's failure never overwrites a newer choice.
		const olderWrite = deferred<void>();
		mockWriteSwitch.mockImplementationOnce(() => olderWrite.promise);
		mockReadSwitch.mockResolvedValue(false);
		const seq = await mount();
		await toggle(seq, false);
		await toggle(seq, true);
		await act(async () => olderWrite.reject(new Error("slow failure")));
		await flush();
		expect(pairingSwitch(seq).props.value).toBe(true);
		expect(has(seq, "settings-browser-pairing-save-failed")).toBe(false);
	});

	it("O4 log populated: reads the last 20, renders rows in store order with officer, local time and outcome word, plus title and footnote", async () => {
		const r = await mount();
		expect(MINT_LOG_SHOWN).toBe(20);
		expect(mockReadMintLog).toHaveBeenCalledWith(20);
		expect(textOf(byId(r, "settings-browser-pairing-section")).includes("pairingMintLogTitle")).toBe(true);
		const rows = hostAll(r, "settings-browser-pairing-log-row");
		expect(rows.length).toBe(3);
		expect(textOf(rows[0])).toBe(
			`pairingMintLogRow|${JSON.stringify({ officerName: "Ann Officer", date: "2026-11-03 09:05" })} pairingMintLogOutcomeApproved`
		);
		expect(textOf(rows[1])).toBe(
			`pairingMintLogRow|${JSON.stringify({ officerName: "Bo Officer", date: "2026-11-03 08:00" })} pairingMintLogOutcomeSwitchOff`
		);
		expect(textOf(rows[2])).toBe(
			`pairingMintLogRow|${JSON.stringify({ officerName: "Ann Officer", date: "2026-11-02 23:59" })} pairingMintLogOutcomeUnreachable`
		);
		expect(textOf(byId(r, "settings-browser-pairing-log-footnote"))).toBe(`pairingMintLogFootnote|${JSON.stringify({ n: 3 })}`);
		expect(has(r, "settings-browser-pairing-log-empty")).toBe(false);
		expect(has(r, "settings-browser-pairing-log-unreadable")).toBe(false);
	});

	it("O5 names: one lookup per distinct officer, unknown when missing, failing or without a network engine, at most 20 lookups", async () => {
		const r = await mount();
		const ids = mockGetUser.mock.calls.map((c) => c[0]);
		expect(ids.filter((id) => id === U1).length).toBe(1);
		expect(ids.filter((id) => id === U2).length).toBe(1);
		expect(hostAll(r, "settings-browser-pairing-log-row").length).toBe(3);

		mockGetUser.mockImplementation(async (id: string) => {
			if (id === U1) return undefined;
			throw new Error(`lookup failed ${U2}`);
		});
		const unknown = await mount();
		for (const row of hostAll(unknown, "settings-browser-pairing-log-row")) {
			expect(textOf(row).includes('"officerName":"pairingMintLogUnknownOfficer"')).toBe(true);
		}

		mockNetworkEngine = null;
		mockGetUser.mockClear();
		const noEngine = await mount();
		expect(mockGetUser).not.toHaveBeenCalled();
		for (const row of hostAll(noEngine, "settings-browser-pairing-log-row")) {
			expect(textOf(row).includes('"officerName":"pairingMintLogUnknownOfficer"')).toBe(true);
		}

		mockNetworkEngine = { getDetails: async () => ({ network: { name: "Net One" } }), getUser: (...a: unknown[]) => mockGetUser(...a) };
		const many = Array.from({ length: 25 }, (_, i) => ({
			nonce: `n${i}`,
			userId: `u${i}`,
			inviteKey: null,
			at: AT_1 - i * 60_000,
			expiresAt: null,
			outcome: "approved",
		}));
		mockReadMintLog.mockImplementation(async () => many);
		mockGetUser.mockClear();
		mockGetUser.mockImplementation(async () => officer("Someone"));
		await mount();
		const lookups = mockGetUser.mock.calls.map((c) => c[0] as string);
		const perLoad = new Set(lookups);
		expect(perLoad.size).toBeLessThanOrEqual(20);
		expect(perLoad.has("u20")).toBe(false);
	});

	it("O6 log empty: the empty line only, no rows, no footnote", async () => {
		mockReadMintLog.mockImplementation(async () => []);
		const r = await mount();
		expect(textOf(byId(r, "settings-browser-pairing-log-empty"))).toBe("pairingMintLogEmpty");
		expect(has(r, "settings-browser-pairing-log-row")).toBe(false);
		expect(has(r, "settings-browser-pairing-log-footnote")).toBe(false);
		expect(has(r, "settings-browser-pairing-log-unreadable")).toBe(false);
	});

	it("O7 unreadable: the real store error and a plain error both show the unreadable line, never the empty line", async () => {
		for (const err of [new PairingOwnerStoreError("unreadable"), new Error(`io ${NONCES[1]}`)]) {
			mockReadMintLog.mockImplementation(async () => {
				throw err;
			});
			// eslint-disable-next-line no-await-in-loop
			const r = await mount();
			expect(textOf(byId(r, "settings-browser-pairing-log-unreadable"))).toBe("pairingMintLogUnreadable");
			expect(has(r, "settings-browser-pairing-log-empty")).toBe(false);
			expect(has(r, "settings-browser-pairing-log-row")).toBe(false);
			expect(has(r, "settings-browser-pairing-log-footnote")).toBe(false);
			// The switch still works.
			expect(pairingSwitch(r).props.value).toBe(true);
		}
		expect(new PairingOwnerStoreError("unreadable").name).toBe("PairingOwnerStoreError");
	});

	it("O8 outcome mapping: only 'approved' reads Approved; known refusals get their word; anything else reads Refused", () => {
		expect(mintLogOutcomeKey("approved")).toBe("pairingMintLogOutcomeApproved");
		expect(mintLogOutcomeKey("refused:bad-signature")).toBe("pairingMintLogOutcomeKeyNotValid");
		expect(mintLogOutcomeKey("refused:switched-off")).toBe("pairingMintLogOutcomeSwitchOff");
		expect(mintLogOutcomeKey("refused:not-officer")).toBe("pairingMintLogOutcomeNotOfficer");
		expect(mintLogOutcomeKey("unreachable")).toBe("pairingMintLogOutcomeUnreachable");
		for (const other of [
			"refused:expired",
			"refused:rate-limited",
			"refused:not-owner",
			"refused:requester-mismatch",
			"refused:replayed",
			"",
			"something-new",
			"Approved",
			"approved ",
		]) {
			expect([other, mintLogOutcomeKey(other)]).toEqual([other, "pairingMintLogOutcomeRefused"]);
		}
	});

	it("O9 hygiene: no nonce, invitation key or user id on screen or in the console across the failure paths", async () => {
		const cap = captureConsole();
		try {
			const r = await mount();
			const exposed = exposedStrings(r).join("\n");
			for (const s of SECRETS) expect(exposed.includes(s)).toBe(false);
			mockWriteSwitch.mockRejectedValueOnce(new Error(`write ${U1} ${NONCES[0]}`));
			await toggle(r, false);
			mockReadSwitch.mockRejectedValue(new Error(`read ${INVITE_KEYS[0]}`));
			mockReadMintLog.mockImplementation(async () => {
				throw new Error(`log ${U2} ${NONCES[2]}`);
			});
			await mount();
			expectNoSecretInConsole(cap, SECRETS);
			const pairingLines = cap.calls().filter((c) => String(c[0]).startsWith("[browser-pairing]"));
			expect(pairingLines.length).toBeGreaterThanOrEqual(3);
			for (const line of pairingLines) expect(line.length).toBe(1);
		} finally {
			cap.restore();
		}
		expect(/inviteKey|\.nonce/.test(SOURCE)).toBe(false);
		expect(/FlatList/.test(SOURCE)).toBe(false);
	});

	it("O10 re-read on focus; a read settling after unmount sets no state", async () => {
		const r = await mount();
		const switchReads = mockReadSwitch.mock.calls.length;
		const logReads = mockReadMintLog.mock.calls.length;
		mockReadMintLog.mockImplementation(async () => logFixture().slice(0, 1));
		await refocus();
		expect(mockReadSwitch.mock.calls.length).toBeGreaterThan(switchReads);
		expect(mockReadMintLog.mock.calls.length).toBeGreaterThan(logReads);
		expect(hostAll(r, "settings-browser-pairing-log-row").length).toBe(1);

		const lateLog = deferred<unknown[]>();
		mockReadMintLog.mockImplementation(() => lateLog.promise);
		const r2 = await mount();
		const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		try {
			await act(async () => r2.unmount());
			await act(async () => lateLog.resolve(logFixture()));
			await flush();
			expect(errSpy).not.toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	it("O11 placement: after the require-owner-trust row and before the per-network block", () => {
		const trust = SOURCE.indexOf('testID="settings-require-owner-trust-entry"');
		const section = SOURCE.indexOf('testID="settings-browser-pairing-section"');
		const network = SOURCE.indexOf("{currentNetwork ? (");
		expect(trust).toBeGreaterThan(0);
		expect(section).toBeGreaterThan(trust);
		expect(network).toBeGreaterThan(section);
		expect(SOURCE.split('testID="settings-browser-pairing-section"').length - 1).toBe(1);
		expect(SOURCE.split("readMintLog(MINT_LOG_SHOWN)").length - 1).toBe(1);
	});
});
