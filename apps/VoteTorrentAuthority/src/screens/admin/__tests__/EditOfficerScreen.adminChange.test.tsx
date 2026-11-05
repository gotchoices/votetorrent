/**
 * EditOfficerScreen.adminChange.test.tsx (66.1-07; D-04, D-06, D-07, D-08, D-12).
 *
 * Edit, add and remove on the Edit Administrator screen take their effective time from the shared
 * one-hour rule, show it in the confirm card before the one signing prompt, and sign exactly the
 * time shown. Every change starts from the current administration. A pending change is shown and
 * blocks a second change before any prompt. Add offers only accepted invitees, as existing
 * officers. The real confirm and pending cards, formatLocalTime and the refusal mapper run here.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Switch, TextInput } from "react-native";
import { ADMIN_CHANGE_DELAY_MS, adminChangeEffectiveAt } from "@votetorrent/vote-core";
import { AdminChangeConfirmCard } from "../../../components/AdminChangeConfirmCard";
import { PendingAdminChangeCard } from "../../../components/PendingAdminChangeCard";
import { formatLocalTime } from "../../../utils/displayUtils";
import { OFFICER_SCOPE_CODES } from "../../../utils/scopeLabel";

const FIXED_NOW = Date.UTC(2026, 10, 5, 4, 0, 0);
const LATER = FIXED_NOW + 2 * 60 * 60 * 1000;

const AUTHORITY = { id: "auth-1", name: "Test Authority", domainName: "test.example.org" };
const O1 = { userId: "o1", authorityId: AUTHORITY.id, title: "Chair", scopes: ["rad"] };
const O2 = { userId: "o2", authorityId: AUTHORITY.id, title: "Clerk", scopes: ["vrg"] };
const POLICIES = [{ policy: "rad", threshold: 1 }];
const ADMIN = { authorityId: AUTHORITY.id, effectiveAt: 0, officers: [O1, O2], thresholdPolicies: POLICIES };
const INVITEE_O1 = { slotCid: "slot-o1", name: "Asha Chair", userId: "o1" };
const INVITEE_NEW = { slotCid: "slot-new", name: "Bina New", userId: "u-new" };
const INVITEE_NEW2 = { slotCid: "slot-new2", name: "Chandra New", userId: "u-new2" };
const PENDING = {
	effectiveAt: "2026-11-05T05:30:00",
	officers: [{ existing: O1 }],
	thresholdPolicies: POLICIES,
	promoted: false,
};

// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factories to close over them.
let mockRouteParams: Record<string, unknown> = {};
let mockHeaderRight: undefined | (() => React.ReactElement<any>);
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
const mockNavigation = {
	navigate: jest.fn(),
	goBack: jest.fn(),
	setOptions: jest.fn((o: { headerRight?: () => React.ReactElement<any> }) => {
		mockHeaderRight = o?.headerRight;
	}),
};
let mockOutcome: unknown;
const mockOpensAtPropose: number[] = [];
const mockGetAdminDetails = jest.fn();
const mockProposeAdmin = jest.fn();
const mockOpenAuthority = jest.fn(async () => ({
	getAdminDetails: mockGetAdminDetails,
	proposeAdmin: mockProposeAdmin,
	lastPromotionOutcome: undefined as unknown,
}));
const mockGetUser = jest.fn(async (id: string) => ({ getSummary: async () => ({ id, name: "Asha Chair" }) }));
const mockNetworkEngine = { openAuthority: mockOpenAuthority, getUser: mockGetUser };
const mockGetAcceptedOfficerInvitees = jest.fn();
const mockInvitationEngine = { getAcceptedOfficerInvitees: mockGetAcceptedOfficerInvitees };
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === "network") return mockNetworkEngine;
	if (name === "invitations") return mockInvitationEngine;
	return undefined;
});
const mockSign = jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "device-user-1" }));
const mockCreateDeviceSigner = jest.fn(async (_name: string) => mockSign);
const mockGetOrCreateDeviceUser = jest.fn(async (_name: string) => ({ id: "device-user-1", name: "Device User" }));

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { time?: string }) => (opts && typeof opts.time === "string" ? key + "|" + opts.time : key),
	}),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: new Proxy({}, { get: (_t, p) => `c-${String(p)}` }) }),
	useNavigation: () => mockNavigation,
	useRoute: () => ({ params: mockRouteParams }),
	// Run the callback once on mount (a first focus) and record it so a test can re-focus.
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
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (name: string) => mockGetOrCreateDeviceUser(name),
}));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (name: string) => mockCreateDeviceSigner(name),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EditOfficerScreen = require("../EditOfficerScreen").default;

const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
afterAll(() => warnSpy.mockRestore());

const coded = (code: string) => Object.assign(new Error("Engine raw text table=AdminSigning"), { code });

function details(extra: Record<string, unknown> = {}) {
	return { admin: ADMIN, ...extra };
}

async function flush(n = 12) {
	await renderer.act(async () => {
		for (let i = 0; i < n; i++) await Promise.resolve();
	});
}

async function mount(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<EditOfficerScreen />);
	});
	await flush();
	return tr;
}

function allText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

function byTestId(tr: renderer.ReactTestRenderer, id: string) {
	const n = tr.root.findAll((x) => x.props?.testID === id && typeof x.props?.onPress === "function")[0];
	if (!n) throw new Error(`no pressable ${id}`);
	return n;
}

function hasTestId(tr: renderer.ReactTestRenderer, id: string): boolean {
	return tr.root.findAll((x) => x.props?.testID === id).length > 0;
}

function saveButton(tr: renderer.ReactTestRenderer) {
	const n = tr.root.findAll((x) => x.props?.title === "save" && typeof x.props?.onPress === "function")[0];
	if (!n) throw new Error("no save button");
	return n;
}

async function press(node: { props: Record<string, any> }) {
	await renderer.act(async () => {
		await node.props.onPress();
	});
	await flush();
}

async function pressSave(tr: renderer.ReactTestRenderer) {
	await press(saveButton(tr));
}

async function pressConfirm(tr: renderer.ReactTestRenderer) {
	await press(byTestId(tr, "admin-change-confirm"));
}

async function pressRemoveChip() {
	expect(typeof mockHeaderRight).toBe("function");
	const chip = mockHeaderRight!();
	await press({ props: { onPress: chip.props.onPress } });
}

function confirmCards(tr: renderer.ReactTestRenderer) {
	return tr.root.findAllByType(AdminChangeConfirmCard);
}

function titleField(tr: renderer.ReactTestRenderer) {
	const n = tr.root.findAll((x) => x.props?.title === "title" && x.props?.placeholder === "officialTitle" && typeof x.props?.onChangeText === "function")[0];
	if (!n) throw new Error("no title field");
	return n;
}

async function enterTitle(tr: renderer.ReactTestRenderer, value: string) {
	await renderer.act(async () => {
		titleField(tr).props.onChangeText(value);
	});
	await flush();
}

function switchFor(tr: renderer.ReactTestRenderer, scope: string) {
	const i = OFFICER_SCOPE_CODES.indexOf(scope);
	expect(i).toBeGreaterThanOrEqual(0);
	return tr.root.findAllByType(Switch)[i];
}

async function toggle(tr: renderer.ReactTestRenderer, scope: string, on: boolean) {
	await renderer.act(async () => {
		switchFor(tr, scope).props.onValueChange(on);
	});
	await flush();
}

async function selectInvitee(tr: renderer.ReactTestRenderer, slotCid: string) {
	const wrap = tr.root.findAll((x) => x.props?.testID === `edit-officer-invitee-${slotCid}`)[0];
	const card = wrap.findAll((x) => typeof x.props?.onPress === "function")[0];
	await press(card);
}

function lastProposal(): any {
	const calls = mockProposeAdmin.mock.calls;
	return calls[calls.length - 1][0];
}

async function refocus() {
	const callbacks = mockFocusCallbacks.splice(0);
	await renderer.act(async () => {
		callbacks.slice(-1).forEach((cb) => cb());
	});
	await flush();
}

beforeEach(() => {
	jest.useFakeTimers({
		now: FIXED_NOW,
		doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	jest.clearAllMocks();
	mockFocusCallbacks.splice(0);
	mockHeaderRight = undefined;
	mockOutcome = undefined;
	mockOpensAtPropose.splice(0);
	mockRouteParams = { authority: AUTHORITY, officerId: "o1" };
	mockGetAdminDetails.mockReset();
	mockGetAdminDetails.mockImplementation(async () => details());
	mockProposeAdmin.mockReset();
	// A non-arrow function, so `this` is the engine instance proposeAdmin was called on.
	mockProposeAdmin.mockImplementation(async function (this: { lastPromotionOutcome?: unknown }) {
		mockOpensAtPropose.push(mockOpenAuthority.mock.calls.length);
		this.lastPromotionOutcome = mockOutcome;
	});
	mockGetAcceptedOfficerInvitees.mockReset();
	mockGetAcceptedOfficerInvitees.mockImplementation(async () => [INVITEE_O1, INVITEE_NEW]);
});

afterEach(() => {
	jest.useRealTimers();
});

describe("EditOfficerScreen - edit uses the shared one-hour time, shown == signed (D-04, D-06)", () => {
	it("Save shows the confirm card one hour out; Confirm 90 s later signs the card's time on the current roster", async () => {
		expect(ADMIN_CHANGE_DELAY_MS).toBe(3_600_000);
		const tr = await mount();
		await enterTitle(tr, "Vice Chair");
		await pressSave(tr);

		const cards = confirmCards(tr);
		expect(cards).toHaveLength(1);
		const shown = cards[0].props.effectiveAt as string;
		expect(shown).toBe(adminChangeEffectiveAt(FIXED_NOW));
		expect(shown).toBe(new Date(FIXED_NOW + ADMIN_CHANGE_DELAY_MS).toISOString().slice(0, 19));
		expect(allText(tr)).toContain("adminChangeConfirm|" + formatLocalTime(shown));
		expect(mockProposeAdmin).not.toHaveBeenCalled();
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();

		jest.setSystemTime(FIXED_NOW + 90_000);
		await pressConfirm(tr);

		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		expect(proposal.proposed.effectiveAt).toBe(shown);
		expect(proposal.proposed.officers).toEqual([{ existing: { ...O1, title: "Vice Chair" } }, { existing: O2 }]);
		expect(proposal.proposed.thresholdPolicies).toEqual(POLICIES);
		expect(proposal.signers).toEqual(["device-user-1"]);
		expect(mockProposeAdmin.mock.calls[0][1]).toBe(mockSign);
		expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
	});

	it("Remove shows the confirm card; Confirm signs the roster without the officer at the card's time", async () => {
		const tr = await mount();
		await pressRemoveChip();
		expect(confirmCards(tr)).toHaveLength(1);
		expect(mockProposeAdmin).not.toHaveBeenCalled();
		await pressConfirm(tr);
		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		expect(proposal.proposed.officers).toEqual([{ existing: O2 }]);
		expect(proposal.proposed.effectiveAt).toBe(adminChangeEffectiveAt(FIXED_NOW));
		expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
	});

	it("roster base: a stale proposal with an init officer and other policies is never the base", async () => {
		const staleProposed = {
			proposed: {
				officers: [{ existing: O1 }, { init: { name: "Old Name", title: "Old", scopes: ["vrg"] } }],
				effectiveAt: "2027-11-05T04:00:00",
				thresholdPolicies: [{ policy: "rad", threshold: 2 }],
			},
			signers: ["o1"],
		};
		mockGetAdminDetails.mockImplementation(async () => details({ proposed: staleProposed }));
		const tr = await mount();
		await pressSave(tr);
		await pressConfirm(tr);
		const proposal = lastProposal();
		expect(proposal.proposed.officers).toEqual([{ existing: O1 }, { existing: O2 }]);
		expect(proposal.proposed.thresholdPolicies).toEqual(POLICIES);
		expect(JSON.stringify(proposal)).not.toContain('"init"');
	});

	it("Go back removes the card and signs nothing", async () => {
		const tr = await mount();
		await pressSave(tr);
		expect(confirmCards(tr)).toHaveLength(1);
		await press(byTestId(tr, "admin-change-confirm-back"));
		expect(confirmCards(tr)).toHaveLength(0);
		expect(mockProposeAdmin).not.toHaveBeenCalled();
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
	});
});

describe("EditOfficerScreen - add offers only accepted invitees, as existing officers (D-12)", () => {
	beforeEach(() => {
		mockRouteParams = { authority: AUTHORITY };
	});

	it("lists only the invitee who is not already an officer; Save waits for a choice and a title; the add is an existing selection", async () => {
		const tr = await mount();
		expect(hasTestId(tr, "edit-officer-invitee-slot-new")).toBe(true);
		expect(hasTestId(tr, "edit-officer-invitee-slot-o1")).toBe(false);
		expect(saveButton(tr).props.disabled).toBe(true);

		await selectInvitee(tr, "slot-new");
		expect(saveButton(tr).props.disabled).toBe(true);
		await enterTitle(tr, "Registrar");
		expect(saveButton(tr).props.disabled).toBe(false);
		await toggle(tr, "vrg", true);

		await pressSave(tr);
		expect(confirmCards(tr)).toHaveLength(1);
		await pressConfirm(tr);

		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		const officers = lastProposal().proposed.officers as Array<Record<string, unknown>>;
		expect(officers).toEqual([
			{ existing: O1 },
			{ existing: O2 },
			{ existing: { userId: "u-new", authorityId: AUTHORITY.id, title: "Registrar", scopes: ["vrg"] } },
		]);
		expect(officers.some((s) => "init" in s)).toBe(false);
		expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
	});

	it("nobody accepted: says so, Save stays disabled, and Send Invitation opens the invite in send mode", async () => {
		mockGetAcceptedOfficerInvitees.mockImplementation(async () => []);
		const tr = await mount();
		const empty = tr.root.findAll((x) => x.props?.testID === "edit-officer-no-invitees");
		expect(empty.length).toBeGreaterThan(0);
		expect(JSON.stringify(empty[0].props.children)).toContain("adminChangeNoAcceptedInvitees");
		await enterTitle(tr, "Registrar");
		expect(saveButton(tr).props.disabled).toBe(true);
		await press(byTestId(tr, "edit-officer-send-invitation"));
		expect(mockNavigation.navigate).toHaveBeenCalledWith("AdministratorInvitation", {
			mode: "send",
			authority: AUTHORITY,
			officerInit: { name: "", title: "Registrar" },
		});
	});

	it("an invitee who vanished by tap time is refused with no card, no signer and no proposal", async () => {
		const tr = await mount();
		await selectInvitee(tr, "slot-new");
		await enterTitle(tr, "Registrar");
		mockGetAcceptedOfficerInvitees.mockImplementation(async () => [INVITEE_O1]);
		await pressSave(tr);
		expect(allText(tr)).toContain("adminChangeInviteNotAccepted");
		expect(confirmCards(tr)).toHaveLength(0);
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockProposeAdmin).not.toHaveBeenCalled();
	});
});

describe("EditOfficerScreen - pending change and coded refusals (D-07, D-08)", () => {
	it("a pending change shows the pending card without Cancel; Save and Remove refuse before any prompt", async () => {
		mockGetAdminDetails.mockImplementation(async () => details({ pending: PENDING }));
		const tr = await mount();
		const pendingCards = tr.root.findAllByType(PendingAdminChangeCard);
		expect(pendingCards).toHaveLength(1);
		expect(pendingCards[0].props.pending).toEqual(PENDING);
		expect(hasTestId(tr, "admin-change-cancel")).toBe(false);

		await pressSave(tr);
		expect(allText(tr)).toContain("adminChangePendingRefusal");
		expect(confirmCards(tr)).toHaveLength(0);

		await pressRemoveChip();
		expect(allText(tr)).toContain("adminChangePendingRefusal");
		expect(confirmCards(tr)).toHaveLength(0);
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockProposeAdmin).not.toHaveBeenCalled();
	});

	it.each([
		["admin-change-pending", "adminChangePendingRefusal"],
		["admin-no-rad-holder", "adminChangeNoRadRefusal"],
	])("an engine refusal coded %s shows %s, no engine text, and the signing callback never runs", async (code, key) => {
		mockProposeAdmin.mockImplementation(async () => {
			throw coded(code);
		});
		const tr = await mount();
		await pressSave(tr);
		await pressConfirm(tr);
		const text = allText(tr);
		expect(text).toContain(key);
		expect(text).not.toContain("Engine raw text");
		expect(text).not.toContain("AdminSigning");
		expect(mockNavigation.goBack).not.toHaveBeenCalled();
		expect(mockSign).not.toHaveBeenCalled();
		expect(confirmCards(tr)).toHaveLength(0);
	});

	it("a refused promotion says the change could not be applied, stays open and re-reads", async () => {
		mockOutcome = { status: "refused" };
		const tr = await mount();
		await pressSave(tr);
		await pressConfirm(tr);
		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		expect(allText(tr)).toContain("adminChangeNotApplied");
		expect(mockNavigation.goBack).not.toHaveBeenCalled();
		const proposeOrder = mockProposeAdmin.mock.invocationCallOrder[0];
		expect(mockGetAdminDetails.mock.invocationCallOrder.some((o) => o > proposeOrder)).toBe(true);
	});

	it("a promoted change goes back and shows no not-applied line", async () => {
		mockOutcome = { status: "promoted" };
		const tr = await mount();
		await pressSave(tr);
		await pressConfirm(tr);
		expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
		expect(allText(tr)).not.toContain("adminChangeNotApplied");
	});
});

describe("EditOfficerScreen - locked inputs while the confirm card shows (D-04)", () => {
	it("locked-inputs: switches, title and the Remove chip are disabled and their handlers inert; Confirm signs the original change", async () => {
		const tr = await mount();
		await pressSave(tr);
		expect(confirmCards(tr)).toHaveLength(1);

		const switches = tr.root.findAllByType(Switch);
		expect(switches.length).toBe(OFFICER_SCOPE_CODES.length);
		for (const s of switches) expect(s.props.disabled).toBe(true);
		const input = tr.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === "title")!;
		expect(input.props.editable).toBe(false);
		expect(mockHeaderRight!().props.disabled).toBe(true);

		const before = switches.map((s) => s.props.value);
		await renderer.act(async () => {
			switchFor(tr, "vrg").props.onValueChange(true);
			titleField(tr).props.onChangeText("Changed");
		});
		await flush();
		expect(tr.root.findAllByType(Switch).map((s) => s.props.value)).toEqual(before);
		expect(titleField(tr).props.value).toBe("Chair");
		expect(confirmCards(tr)).toHaveLength(1);

		// The chip's handler is inert too while the card shows.
		await renderer.act(async () => {
			await mockHeaderRight!().props.onPress();
		});
		await flush();
		expect(confirmCards(tr)).toHaveLength(1);

		await pressConfirm(tr);
		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		expect(lastProposal().proposed.officers[0]).toEqual({ existing: O1 });
	});

	it("locked-inputs: Go back unlocks the switches and the title again", async () => {
		const tr = await mount();
		await pressSave(tr);
		await press(byTestId(tr, "admin-change-confirm-back"));
		for (const s of tr.root.findAllByType(Switch)) expect(s.props.disabled).toBe(false);
		const input = tr.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === "title")!;
		expect(input.props.editable).toBe(true);
		expect(mockHeaderRight!().props.disabled).toBe(false);
	});

	it("locked-inputs (add): invitee cards lose onPress and Send Invitation is disabled while the card shows", async () => {
		mockRouteParams = { authority: AUTHORITY };
		const tr = await mount();
		await selectInvitee(tr, "slot-new");
		await enterTitle(tr, "Registrar");
		await pressSave(tr);
		expect(confirmCards(tr)).toHaveLength(1);
		const wrap = tr.root.findAll((x) => x.props?.testID === "edit-officer-invitee-slot-new")[0];
		expect(wrap.findAll((x) => typeof x.props?.onPress === "function")).toHaveLength(0);
		const send = tr.root.findAll((x) => x.props?.testID === "edit-officer-send-invitation" && typeof x.props?.onPress === "function")[0];
		expect(send.props.disabled).toBe(true);
	});
});

describe("EditOfficerScreen - stale confirm signs nothing (D-01, D-04)", () => {
	it("stale-confirm: a card older than five minutes re-shows a fresh time with the notice; the next Confirm signs it", async () => {
		const tr = await mount();
		await pressSave(tr);
		expect(confirmCards(tr)[0].props.effectiveAt).toBe(adminChangeEffectiveAt(FIXED_NOW));
		const opensBefore = mockOpenAuthority.mock.calls.length;

		jest.setSystemTime(LATER);
		await pressConfirm(tr);

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(0);
		expect(mockSign).toHaveBeenCalledTimes(0);
		expect(mockGetOrCreateDeviceUser).toHaveBeenCalledTimes(0);
		expect(mockOpenAuthority.mock.calls.length).toBe(opensBefore);
		expect(mockProposeAdmin).toHaveBeenCalledTimes(0);

		const cards = confirmCards(tr);
		expect(cards).toHaveLength(1);
		const fresh = adminChangeEffectiveAt(LATER);
		expect(cards[0].props.effectiveAt).toBe(fresh);
		expect(allText(tr)).toContain("adminChangeConfirm|" + formatLocalTime(fresh));
		const notice = tr.root.findAll((x) => x.props?.testID === "admin-change-confirm-notice")[0];
		expect(notice).toBeDefined();
		expect(JSON.stringify(notice.props.children)).toContain("adminChangeConfirmTimeUpdated");

		await pressConfirm(tr);
		expect(mockProposeAdmin).toHaveBeenCalledTimes(1);
		const proposal = lastProposal();
		expect(proposal.proposed.effectiveAt).toBe(fresh);
		expect(proposal.proposed.officers).toEqual([{ existing: O1 }, { existing: O2 }]);
	});
});

describe("EditOfficerScreen - re-focus keeps the officer's edits", () => {
	it("re-focus (edit): title and permissions survive; the pending card appears; the officer is seeded once", async () => {
		const tr = await mount();
		await enterTitle(tr, "Vice Chair");
		await toggle(tr, "vrg", true);
		expect(switchFor(tr, "vrg").props.value).toBe(true);

		mockGetAdminDetails.mockImplementation(async () => details({ pending: PENDING }));
		await refocus();

		expect(titleField(tr).props.value).toBe("Vice Chair");
		expect(switchFor(tr, "vrg").props.value).toBe(true);
		expect(tr.root.findAllByType(PendingAdminChangeCard)).toHaveLength(1);
		expect(mockGetAdminDetails).toHaveBeenCalledTimes(2);
		expect(mockGetUser).toHaveBeenCalledTimes(1);
	});

	it("re-focus (add): new invitees are listed while the choice and title are kept", async () => {
		mockRouteParams = { authority: AUTHORITY };
		const tr = await mount();
		await selectInvitee(tr, "slot-new");
		await enterTitle(tr, "Registrar");

		mockGetAcceptedOfficerInvitees.mockImplementation(async () => [INVITEE_O1, INVITEE_NEW, INVITEE_NEW2]);
		await refocus();

		expect(hasTestId(tr, "edit-officer-invitee-slot-new")).toBe(true);
		expect(hasTestId(tr, "edit-officer-invitee-slot-new2")).toBe(true);
		expect(titleField(tr).props.value).toBe("Registrar");
		const selectedCard = tr.root
			.findAll((x) => x.props?.testID === "edit-officer-invitee-slot-new")[0]
			.findAll((x) => x.props?.icon !== undefined && x.props?.title === "Bina New")[0];
		expect(selectedCard.props.icon).toBe("circle-check");
		expect(saveButton(tr).props.disabled).toBe(false);
	});
});

describe("EditOfficerScreen - one engine for Confirm", () => {
	it("one-engine: Confirm opens exactly one engine before proposeAdmin and reads the outcome from it", async () => {
		mockOutcome = { status: "refused" };
		const tr = await mount();
		await pressSave(tr);
		const before = mockOpenAuthority.mock.calls.length;
		await pressConfirm(tr);
		expect(mockOpensAtPropose).toEqual([before + 1]);
		expect(allText(tr)).toContain("adminChangeNotApplied");
		expect(mockNavigation.goBack).not.toHaveBeenCalled();
	});
});
