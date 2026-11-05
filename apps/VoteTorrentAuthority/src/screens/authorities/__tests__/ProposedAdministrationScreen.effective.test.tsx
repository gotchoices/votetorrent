/**
 * ProposedAdministrationScreen.effective.test.tsx — 66.1 (D-04..D-08): the Proposed Administration
 * change uses the one shared delay helper. The first Propose tap signs nothing and shows the local
 * time one hour later; Confirm signs exactly that string, even when the clock moved, unless the card
 * was left open more than five minutes (then it re-shows a fresh time and signs nothing). Every
 * change starts from the CURRENT administration (C2, F4), a pending change locks the screen and
 * offers Cancel change to a rad holder, and refusals render only translated copy.
 *
 * The clock is jest's fake system time; the time zone is read from getTimezoneOffset(). Mock
 * scaffold mirrors ProposedAdministrationScreen.refocus.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { ADMIN_CHANGE_DELAY_MS, adminChangeEffectiveAt } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// A STABLE `t` that shows an interpolated time, so the cards' local time is visible in the tree.
const mockT = (key: string, opts?: { time?: unknown }) =>
	opts && opts.time !== undefined ? key + ":" + String(opts.time) : key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

const mockSign = jest.fn();
const mockCreateDeviceSigner = jest.fn();
const mockGetOrCreateDeviceUser = jest.fn();
const mockGetDeviceUser = jest.fn();
let mockHandlerOutcome: { handled: boolean; message?: string } = { handled: false };

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
	getDeviceUser: () => mockGetDeviceUser(),
}));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => mockHandlerOutcome,
}));

const AUTHORITY = { id: "authority-1", name: "Test Authority", domainName: "test.example.org" };
const FOUNDER = { userId: "user-1", authorityId: AUTHORITY.id, title: "Chair", scopes: ["rad"] };
const SECOND = { userId: "user-2", authorityId: AUTHORITY.id, title: "Deputy", scopes: ["rad", "vrg"] };
const NAMES: Record<string, string> = { "user-1": "Founding Chair", "user-2": "Second Officer" };
const SIGNATURE = { signerUserId: "user-1", signerKey: "k", signature: "s" };
const SCOPE_ORDER = ["rn", "rad", "vrg", "iad", "uai", "ceb", "mel", "cap", "ik"];

// 03:57 UTC; one hour later is 04:57 UTC, which is 10:42 in Asia/Kathmandu (UTC+05:45).
const T0 = Date.UTC(2026, 10, 5, 3, 57, 0);
const PENDING_AT = "2026-11-05T04:57:00";
const IN_NEPAL = new Date(T0).getTimezoneOffset() === -345;
const pad2 = (n: number) => (n < 10 ? "0" + n : "" + n);
/** Local HH:MM of an instant, from the Date getters (independent of formatLocalTime). */
const expectedLocal = (ms: number) => pad2(new Date(ms).getHours()) + ":" + pad2(new Date(ms).getMinutes());

// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factories to close over them.
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockAuthorityEngine: Record<string, any> = {
	getAdminDetails: jest.fn(),
	getDetails: jest.fn(),
	proposeAdmin: jest.fn(),
	cancelAdminChange: jest.fn(),
	lastPromotionOutcome: undefined,
};
const mockNetworkEngine = {
	openAuthority: jest.fn(),
	getUser: jest.fn(async (id: string) => ({ getSummary: async () => ({ id, name: NAMES[id] ?? id }) })),
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p",
			background: "b",
			card: "c",
			text: "t",
			border: "bo",
			notification: "n",
			error: "e",
			textSecondary: "ts",
			important: "i",
			success: "s",
			accent: "a",
			warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: jest.fn() }),
	useRoute: () => ({ params: { authorityId: "authority-1" } }),
	// Run the callback once on mount (like a first focus) and record it.
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

type Tr = renderer.ReactTestRenderer;
type Node = renderer.ReactTestInstance;

function details(over: Record<string, unknown> = {}) {
	return {
		admin: {
			id: "authority-1:2026-10-01T00:00:00",
			authorityId: AUTHORITY.id,
			effectiveAt: 0,
			officers: [FOUNDER],
			thresholdPolicies: [],
		},
		...over,
	};
}

function pendingChange(promoted: boolean) {
	return {
		effectiveAt: PENDING_AT,
		officers: [{ existing: FOUNDER }, { existing: SECOND }],
		thresholdPolicies: [{ policy: "rad", threshold: 2 }],
		promoted,
	};
}

function adminWithBoth() {
	return { ...details().admin, officers: [FOUNDER, SECOND] };
}

function coded(code: string) {
	return Object.assign(new Error("RAW select * from Admin where Quereus"), { code });
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function flush() {
	for (let i = 0; i < 12; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			for (let j = 0; j < 5; j++) await Promise.resolve();
		});
	}
}

async function renderScreen(): Promise<Tr> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ProposedAdministrationScreen = require("../ProposedAdministrationScreen").default;
	let tr!: Tr;
	await renderer.act(async () => {
		tr = renderer.create(<ProposedAdministrationScreen />);
	});
	await flush();
	return tr;
}

function textOf(node: Node | string): string {
	if (typeof node === "string") return node;
	return node.children.map((c) => textOf(c as Node | string)).join(" ");
}

function allText(tr: Tr): string {
	return JSON.stringify(tr.toJSON());
}

function byTestId(tr: Tr, id: string): Node[] {
	return tr.root.findAll((n) => n.props?.testID === id, { deep: false });
}

function has(tr: Tr, id: string): boolean {
	return byTestId(tr, id).length > 0;
}

async function pressId(tr: Tr, id: string) {
	const target = tr.root.findAll((n) => n.props?.testID === id && typeof n.props?.onPress === "function")[0];
	if (!target) throw new Error("no control with testID " + id);
	await renderer.act(async () => {
		await target.props.onPress();
	});
	await flush();
}

function titled(tr: Tr, title: string): Node[] {
	return tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === "function");
}

async function pressPropose(tr: Tr) {
	const node = titled(tr, "propose")[0];
	if (!node) throw new Error("no Propose control");
	await renderer.act(async () => {
		await node.props.onPress();
	});
	await flush();
}

function cardTitles(tr: Tr): string[] {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { InfoCard } = require("../../../components/InfoCard");
	return tr.root.findAllByType(InfoCard).map((n) => n.props.title as string);
}

function lastProposal(): any {
	const calls = mockAuthorityEngine.proposeAdmin.mock.calls;
	return calls[calls.length - 1][0];
}

beforeEach(() => {
	jest.useFakeTimers({ now: T0, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
	jest.clearAllMocks();
	mockFocusCallbacks.splice(0);
	mockHandlerOutcome = { handled: false };
	mockSign.mockImplementation(async () => SIGNATURE);
	mockCreateDeviceSigner.mockImplementation(async () => mockSign);
	mockGetOrCreateDeviceUser.mockImplementation(async () => ({ id: "user-1", name: "Device User" }));
	mockGetDeviceUser.mockImplementation(async () => ({ id: "user-1", name: "Device User" }));
	mockAuthorityEngine.lastPromotionOutcome = undefined;
	mockAuthorityEngine.getAdminDetails.mockImplementation(async () => details());
	mockAuthorityEngine.getDetails.mockImplementation(async () => ({ authority: AUTHORITY }));
	mockAuthorityEngine.proposeAdmin.mockImplementation(async () => {
		mockAuthorityEngine.lastPromotionOutcome = { status: "promoted" };
	});
	// Stands in for the engine (R-06): one signature per cancel.
	mockAuthorityEngine.cancelAdminChange.mockImplementation(
		async (_target: unknown, sign: (d: Uint8Array) => Promise<unknown>) => {
			await sign(new Uint8Array([1]));
		},
	);
	mockNetworkEngine.openAuthority.mockImplementation(async () => mockAuthorityEngine);
});

afterEach(() => {
	jest.useRealTimers();
});

describe("confirm step (D-04, D-06)", () => {
	it("the first Propose tap signs nothing and shows the local time one hour after the tap", async () => {
		const tr = await renderScreen();
		await pressPropose(tr);
		expect(has(tr, "admin-change-confirm-card")).toBe(true);
		expect(allText(tr)).toContain("adminChangeConfirm:" + expectedLocal(T0 + ADMIN_CHANGE_DELAY_MS));
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(0);
		expect(mockSign).toHaveBeenCalledTimes(0);
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(0);
		expect(titled(tr, "propose")).toHaveLength(0);
	});

	it("roster and thresholds are locked while the card shows, so what is signed is what was shown", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ admin: { ...adminWithBoth(), thresholdPolicies: [{ policy: "rad", threshold: 2 }] } }),
		);
		const tr = await renderScreen();
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { ThresholdPolicyRow } = require("../components/ThresholdPolicyRow");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { InfoCard } = require("../../../components/InfoCard");
		expect(tr.root.findAllByType(ThresholdPolicyRow)).toHaveLength(SCOPE_ORDER.length);
		await pressPropose(tr);

		// No editable threshold row while the card shows; every scope is a read-only row.
		expect(tr.root.findAllByType(ThresholdPolicyRow)).toHaveLength(0);
		for (const scope of SCOPE_ORDER) {
			expect(has(tr, "pending-threshold-" + scope)).toBe(true);
		}
		expect(textOf(byTestId(tr, "pending-threshold-rad")[0]!)).toContain("2");
		expect(tr.root.findAll((n) => n.props?.label === "addAdministrator")).toHaveLength(0);
		// An officer row's edit handler, called directly, does nothing while the card shows.
		await renderer.act(async () => {
			tr.root.findAllByType(InfoCard).forEach((card) => card.props.onPress());
		});
		expect(mockNavigate).not.toHaveBeenCalled();

		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		expect(proposal.proposed.officers).toEqual([{ existing: FOUNDER }, { existing: SECOND }]);
		expect(proposal.proposed.thresholdPolicies).toEqual(
			SCOPE_ORDER.map((scope) => ({ policy: scope, threshold: scope === "rad" ? 2 : 1 })),
		);
	});

	it("signs exactly the time the card showed, even when the clock moved before Confirm", async () => {
		const tr = await renderScreen();
		await pressPropose(tr);
		jest.setSystemTime(T0 + 90_000);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		const effectiveAt = proposal.proposed.effectiveAt as string;
		expect(effectiveAt).toBe(adminChangeEffectiveAt(T0));
		expect(effectiveAt).not.toBe(adminChangeEffectiveAt(T0 + 90_000));
		expect(Date.parse(effectiveAt + "Z") - T0).toBe(ADMIN_CHANGE_DELAY_MS);
		expect(Date.parse(effectiveAt + "Z") - T0).toBe(60 * 60 * 1000);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(proposal.signers).toEqual(["user-1"]);
	});

	(IN_NEPAL ? it : it.skip)("Asia/Kathmandu: the confirm card reads 10:42", async () => {
		const tr = await renderScreen();
		await pressPropose(tr);
		expect(allText(tr)).toContain("adminChangeConfirm:10:42");
	});

	it("Go back closes the card with nothing signed; a later tap shows the time from the new tap", async () => {
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm-back");
		expect(has(tr, "admin-change-confirm-card")).toBe(false);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(0);
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(0);

		jest.setSystemTime(T0 + 600_000);
		await pressPropose(tr);
		expect(allText(tr)).toContain("adminChangeConfirm:" + expectedLocal(T0 + 600_000 + ADMIN_CHANGE_DELAY_MS));
	});

	it("a double press of Confirm while the proposal is in flight proposes once", async () => {
		const held = deferred<void>();
		mockAuthorityEngine.proposeAdmin.mockImplementation(() => held.promise);
		const tr = await renderScreen();
		await pressPropose(tr);
		const confirm = tr.root.findAll(
			(n) => n.props?.testID === "admin-change-confirm" && typeof n.props?.onPress === "function",
		)[0]!;
		await renderer.act(async () => {
			confirm.props.onPress();
			confirm.props.onPress();
		});
		await flush();
		await renderer.act(async () => {
			confirm.props.onPress();
		});
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		await renderer.act(async () => {
			held.resolve();
		});
		await flush();
	});

	it("a card left open two hours signs nothing, re-shows a fresh time with the notice, then signs that time", async () => {
		const LATER = T0 + 2 * 60 * 60 * 1000;
		const tr = await renderScreen();
		await pressPropose(tr);
		const opensBefore = mockNetworkEngine.openAuthority.mock.calls.length;
		jest.setSystemTime(LATER);
		await pressId(tr, "admin-change-confirm");

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(0);
		expect(mockSign).toHaveBeenCalledTimes(0);
		expect(mockGetOrCreateDeviceUser).toHaveBeenCalledTimes(0);
		expect(mockNetworkEngine.openAuthority.mock.calls.length).toBe(opensBefore);
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(0);
		expect(has(tr, "admin-change-confirm-card")).toBe(true);
		expect(allText(tr)).toContain("adminChangeConfirm:" + expectedLocal(LATER + ADMIN_CHANGE_DELAY_MS));
		expect(textOf(byTestId(tr, "admin-change-confirm-notice")[0]!)).toContain("adminChangeConfirmTimeUpdated");

		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		expect(lastProposal().proposed.effectiveAt).toBe(adminChangeEffectiveAt(LATER));
	});
});

describe("builds on the current administration (C2, F4)", () => {
	it("a stale proposal never seeds the next change", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({
				proposed: {
					proposed: {
						officers: [{ existing: FOUNDER }, { init: { name: "Stale", title: "Old", scopes: ["vrg"] } }],
						effectiveAt: "2027-11-05T04:57:00",
						thresholdPolicies: [],
					},
					signers: [],
				},
			}),
		);
		const tr = await renderScreen();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalled();
		expect(cardTitles(tr)).toEqual(["Founding Chair"]);
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		expect(proposal.proposed.officers).toEqual([{ existing: FOUNDER }]);
		expect(JSON.stringify(proposal)).not.toContain('"init"');
	});

	it("thresholds come from the current administration's policies", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ admin: { ...adminWithBoth(), thresholdPolicies: [{ policy: "rad", threshold: 2 }] } }),
		);
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const policies = lastProposal().proposed.thresholdPolicies as Array<{ policy: string; threshold: number }>;
		expect(policies.map((p) => p.policy)).toEqual(SCOPE_ORDER);
		expect(policies.find((p) => p.policy === "rad")!.threshold).toBe(2);
		expect(policies.filter((p) => p.policy !== "rad").every((p) => p.threshold === 1)).toBe(true);
	});
});

describe("pending change (D-04, D-05, D-08)", () => {
	it("shows the pending card with its local time and locks the screen", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ admin: adminWithBoth(), pending: pendingChange(true) }),
		);
		const tr = await renderScreen();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(allText(tr)).toContain("adminChangeTakesEffectAt:" + expectedLocal(Date.parse(PENDING_AT + "Z")));
		expect(titled(tr, "propose")).toHaveLength(0);
		expect(has(tr, "admin-change-confirm-card")).toBe(false);
		expect(tr.root.findAll((n) => n.props?.label === "addAdministrator")).toHaveLength(0);
		expect(has(tr, "pending-threshold-rad")).toBe(true);
		expect(textOf(byTestId(tr, "pending-threshold-rad")[0]!)).toContain("2");
		expect(cardTitles(tr)).toEqual(["Founding Chair", "Second Officer"]);
	});

	it.each([true, false])(
		"Cancel by a rad holder costs one signer and one cancel, then re-reads (promoted %s, R-33)",
		async (promoted) => {
			mockAuthorityEngine.getAdminDetails.mockImplementationOnce(async () =>
				details({ admin: adminWithBoth(), pending: pendingChange(promoted) }),
			);
			mockAuthorityEngine.getAdminDetails.mockImplementation(async () => details({ admin: adminWithBoth() }));
			const tr = await renderScreen();
			expect(has(tr, "admin-change-pending-card")).toBe(true);
			expect(titled(tr, "propose")).toHaveLength(0);
			expect(has(tr, "admin-change-cancel")).toBe(true);

			await pressId(tr, "admin-change-cancel");
			expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
			expect(mockSign).toHaveBeenCalledTimes(1);
			expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
			expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledWith(
				{ effectiveAt: PENDING_AT, userId: "user-1" },
				mockSign,
			);
			expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(2);
			expect(has(tr, "admin-change-pending-card")).toBe(false);
			expect(textOf(byTestId(tr, "admin-change-cancelled")[0]!)).toContain("adminChangeCancelled");
			expect(titled(tr, "propose")).toHaveLength(1);
		},
	);

	it("Cancel is hidden from a device user who is not an officer", async () => {
		mockGetDeviceUser.mockImplementation(async () => ({ id: "user-9", name: "Stranger" }));
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ admin: adminWithBoth(), pending: pendingChange(true) }),
		);
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(has(tr, "admin-change-cancel")).toBe(false);
	});

	it("Cancel is hidden from an officer without rad", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({
				admin: { ...details().admin, officers: [{ ...FOUNDER, scopes: ["vrg"] }] },
				pending: pendingChange(true),
			}),
		);
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(has(tr, "admin-change-cancel")).toBe(false);
	});
});

describe("refusals by code (D-07, D-08, R-16)", () => {
	it.each([
		["admin-change-pending", "adminChangePendingRefusal"],
		["admin-no-rad-holder", "adminChangeNoRadRefusal"],
	])("a %s proposal refusal shows %s and no engine text", async (code, key) => {
		mockAuthorityEngine.proposeAdmin.mockImplementation(async () => {
			throw coded(code);
		});
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const s = allText(tr);
		expect(s).toContain(key);
		expect(s).not.toContain("RAW");
		expect(s).not.toContain("select");
		expect(s).not.toContain("Quereus");
		expect(mockSign).toHaveBeenCalledTimes(0);
		expect(has(tr, "admin-change-confirm-card")).toBe(false);
	});

	it.each([
		["admin-cancel-not-authorized", "adminChangeCancelNotAuthorized"],
		["admin-cancel-not-pending", "adminChangeCancelNotPending"],
		["admin-cancel-refused", "adminChangeCancelRefused"],
	])("a %s cancel refusal shows %s inside the pending card and does not re-read", async (code, key) => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ admin: adminWithBoth(), pending: pendingChange(true) }),
		);
		mockAuthorityEngine.cancelAdminChange.mockImplementation(async () => {
			throw coded(code);
		});
		const tr = await renderScreen();
		await pressId(tr, "admin-change-cancel");
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		const card = textOf(byTestId(tr, "admin-change-pending-card")[0]!);
		expect(card).toContain(key);
		const s = allText(tr);
		expect(s).not.toContain("RAW");
		expect(s).not.toContain("select");
		expect(s).not.toContain("Quereus");
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(has(tr, "admin-change-cancelled")).toBe(false);
	});

	it("a refusal the signing handler takes renders no copy", async () => {
		mockHandlerOutcome = { handled: true };
		mockAuthorityEngine.proposeAdmin.mockImplementation(async () => {
			throw coded("admin-change-pending");
		});
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		const s = allText(tr);
		expect(s).not.toContain("adminChangePendingRefusal");
		expect(s).not.toContain("errorActionFailedGeneric");
		expect(s).not.toContain("RAW");
	});
});

describe("promotion outcome", () => {
	it("a refused promotion shows not-applied, re-reads, stays on screen and offers Cancel (R-33)", async () => {
		mockAuthorityEngine.proposeAdmin.mockImplementation(async () => {
			mockAuthorityEngine.lastPromotionOutcome = { status: "refused" };
		});
		const tr = await renderScreen();
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () =>
			details({ pending: { ...pendingChange(false), officers: [{ existing: FOUNDER }], thresholdPolicies: [] } }),
		);
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		expect(allText(tr)).toContain("adminChangeNotApplied");
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(2);
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(has(tr, "admin-change-cancel")).toBe(true);
	});

	it("awaiting co-signers is not a refusal", async () => {
		mockAuthorityEngine.proposeAdmin.mockImplementation(async () => {
			mockAuthorityEngine.lastPromotionOutcome = { status: "awaiting-co-signers" };
		});
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		expect(mockAuthorityEngine.proposeAdmin).toHaveBeenCalledTimes(1);
		expect(allText(tr)).not.toContain("adminChangeNotApplied");
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("probes the same engine instance proposeAdmin ran on", async () => {
		const instances: Array<Record<string, any>> = [];
		mockNetworkEngine.openAuthority.mockImplementation(async () => {
			const instance: Record<string, any> = {
				...mockAuthorityEngine,
				lastPromotionOutcome: undefined,
				proposeAdmin: jest.fn(async function (this: Record<string, any>) {
					this.lastPromotionOutcome = { status: "refused" };
				}),
			};
			instances.push(instance);
			return instance;
		});
		const tr = await renderScreen();
		await pressPropose(tr);
		await pressId(tr, "admin-change-confirm");
		const proposed = instances.filter((i) => i.proposeAdmin.mock.calls.length > 0);
		expect(proposed).toHaveLength(1);
		expect(allText(tr)).toContain("adminChangeNotApplied");
	});
});
