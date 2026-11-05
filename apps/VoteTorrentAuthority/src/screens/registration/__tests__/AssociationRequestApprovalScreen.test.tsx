/**
 * AssociationRequestApprovalScreen.test.tsx — 62-27 (D-41, D-45, Surface 4).
 *
 * Every engine is a call-recording jest.fn: this proves the screen's CALL CONTRACT and what it
 * renders, never an access-control boundary (the 'vrg' AdminSigning CHECK and
 * `Association.DeleteValid` enforce that). "Geometry" means flattened style props: RN jest has no
 * layout engine, so on-device fit is proof debt, never claimed here.
 */

import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import renderer from "react-test-renderer";

const NEW_KEY = "NEWDEVICEKEY-0123456789abcdef";
const OLD_KEY_1 = "OLDDEVICE1-aaaaaaaaaaaaaaaa";
const OLD_KEY_2 = "OLDDEVICE2-bbbbbbbbbbbbbbbb";
const ENTERED_SENTINEL = "ENTERED-IDENTITY-SENTINEL-7781";
const RECORD_SENTINEL = "RECORD-IDENTITY-SENTINEL-4420";
const LONG_NAME = "Maximiliana Esperanza Villalobos-Etxeberria de la Cruz";

function review(overrides: Record<string, unknown> = {}): any {
	return {
		requestId: "arq-1",
		authorityId: "auth-1",
		status: "p",
		newDeviceKey: NEW_KEY,
		submittedAt: "2026-08-01T00:00:00Z",
		receivedAt: "2026-08-01T00:00:00Z",
		evidence: { kind: "code", outcome: "matched" },
		resolvedRegistrantId: "reg-1",
		registrantName: LONG_NAME,
		candidates: [],
		existingDevices: [
			{ registrantId: "reg-1", deviceKey: OLD_KEY_1 },
			{ registrantId: "reg-1", deviceKey: OLD_KEY_2 },
		],
		matchMethod: "code",
		route: "manual",
		...overrides,
	};
}

const IDENTITY_REVIEW = review({
	evidence: { kind: "identity", fields: [{ name: "lastName", value: ENTERED_SENTINEL }] },
	resolvedRegistrantId: undefined,
	registrantName: undefined,
	existingDevices: [],
	matchMethod: "identity",
	candidates: [
		{ registrantId: "reg-1", matchedFieldNames: ["lastName"], displayName: "Ada Lovelace" },
		{ registrantId: "reg-2-abcdefghij", matchedFieldNames: ["lastName", "district"] },
	],
});
const IDENTITY_RESOLVED_REVIEW = review({
	evidence: { kind: "identity", fields: [{ name: "lastName", value: ENTERED_SENTINEL }] },
	resolvedRegistrantId: "reg-2-abcdefghij",
	registrantName: "Grace Hopper",
	registrantRecord: [{ name: "lastName", value: RECORD_SENTINEL }],
	existingDevices: [{ registrantId: "reg-2-abcdefghij", deviceKey: OLD_KEY_1 }],
	matchMethod: "identity",
	candidates: IDENTITY_REVIEW.candidates,
});

let mockReview: any = review();
let mockResolvedReview: any = IDENTITY_RESOLVED_REVIEW;
let mockReviewReject: Error | undefined;
let mockScopes: string[] | undefined = ["vrg"];
let mockHasFactory = true;

const mockGetReassociationReview = jest.fn(async (_id: string, _a: any, _o: any, options?: any): Promise<any> => {
	if (mockReviewReject) throw mockReviewReject;
	return options?.registrantId ? mockResolvedReview : mockReview;
});
const mockApproveReassociation = jest.fn(async (..._args: any[]): Promise<any> => ({}));
const mockRejectReassociation = jest.fn(async (..._args: any[]): Promise<any> => ({}));
const mockAssociationEngine = {
	getReassociationReview: mockGetReassociationReview,
	approveReassociation: mockApproveReassociation,
	rejectReassociation: mockRejectReassociation,
};

const mockOpener = { __opener: true };
const mockCreateOpener = jest.fn(() => mockOpener);
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "association") return mockAssociationEngine;
	if (name === "intake") return { createOpener: mockCreateOpener };
	return null;
});
const mockTransports = {
	strandId: "strand-1",
	registration: { publishDecision: jest.fn(async () => "cid"), close: jest.fn(async () => undefined) },
	association: { close: jest.fn(async () => undefined) },
};
const mockCreateTransports = jest.fn((_d: any) => mockTransports);

const mockSignerFn = jest.fn(async (_d: Uint8Array) => ({ signature: "s", signerKey: "k", signerUserId: "u" }));
const mockCreateDeviceSigner = jest.fn(async (_n: string) => mockSignerFn);
const mockHandleDeviceSigningError = jest.fn((_e: unknown): { handled: boolean; message?: string } => ({ handled: false }));
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../i18n");
			const template = (resources.en.translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
jest.mock("@react-navigation/native", () => ({
	dark: false,
	useTheme: () => ({
		dark: false,
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions }),
	useRoute: () => ({ params: { requestId: "arq-1", authorityId: "auth-1" } }),
}));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		createPeerStagingTransports: mockHasFactory ? mockCreateTransports : undefined,
	}),
}));
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: (n: string) => mockCreateDeviceSigner(n) }));
jest.mock("../../../engines/key-vault", () => ({ resolveAuthorityKeyVault: jest.fn(() => ({ __vault: true })) }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleDeviceSigningError,
}));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: (_a: string) => ({ scopes: mockScopes, loading: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");
const EN = resources.en.translation as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isBareDismissLabel } = require("../components/LifecycleConfirmCard");

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) await Promise.resolve();
	});
}
async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../AssociationRequestApprovalScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flushTicks(12);
	return tr;
}
function collectTestIDs(node: any, acc: string[]): void {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const c of node) collectTestIDs(c, acc);
		return;
	}
	if (node.props && typeof node.props.testID === "string") acc.push(node.props.testID);
	if (node.children) for (const c of node.children) collectTestIDs(c, acc);
}
function orderedTestIDs(tr: renderer.ReactTestRenderer): string[] {
	const acc: string[] = [];
	collectTestIDs(tr.toJSON(), acc);
	return acc;
}
function exists(tr: renderer.ReactTestRenderer, testID: string): boolean {
	try {
		tr.root.findByProps({ testID });
		return true;
	} catch {
		return false;
	}
}
function textOfNode(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOfNode(c as renderer.ReactTestInstance))).join("");
}
function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	return textOfNode(tr.root.findByProps({ testID }));
}
function whole(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}
function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const node = [wrapper, ...wrapper.findAll(() => true)].find((n) => "disabled" in n.props);
	return node?.props.disabled === true;
}
function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	return [wrapper, ...wrapper.findAll(() => true)].find((n) => typeof n.props.onPress === "function");
}
async function pressAsync(tr: renderer.ReactTestRenderer, testID: string) {
	const p = findPressable(tr, testID)!;
	await renderer.act(async () => {
		p.props.onPress();
	});
	await flushTicks(12);
}
function flat(node: renderer.ReactTestInstance): Record<string, any> {
	return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, any>;
}
function clippingOrHorizontalAncestors(node: renderer.ReactTestInstance, stopAt: renderer.ReactTestInstance): string[] {
	const problems: string[] = [];
	let cur: renderer.ReactTestInstance | null = node.parent;
	while (cur) {
		const st = flat(cur);
		for (const k of ["width", "height", "maxHeight"]) if (st[k] !== undefined) problems.push(`${k}=${String(st[k])}`);
		if (st.overflow === "hidden") problems.push("overflow:hidden");
		if (cur.props.horizontal === true) problems.push("horizontal-scroll");
		if (cur === stopAt) break;
		cur = cur.parent;
	}
	return problems;
}

let consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
	consoleSpies = (["log", "warn", "error", "debug", "info"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterAll(() => consoleSpies.forEach((s) => s.mockRestore()));
beforeEach(() => {
	jest.clearAllMocks();
	consoleSpies.forEach((s) => s.mockClear());
	mockReview = review();
	mockResolvedReview = IDENTITY_RESOLVED_REVIEW;
	mockReviewReject = undefined;
	mockScopes = ["vrg"];
	mockHasFactory = true;
	mockApproveReassociation.mockResolvedValue({});
	mockRejectReassociation.mockResolvedValue({});
	mockHandleDeviceSigningError.mockReset();
	mockHandleDeviceSigningError.mockReturnValue({ handled: false });
});
afterEach(() => {
	consoleSpies.forEach((s) => expect(s).not.toHaveBeenCalled());
});

describe("AssociationRequestApprovalScreen — S1 code-matched (D-45, D-41)", () => {
	it("shows the badge, both devices, and no identity banner; comparison precedes the footer", async () => {
		const tr = await renderScreen();
		expect(textOf(tr, "association-approval-code-badge")).toBe(EN.associationApprovalCodeMatchedBadge);
		expect(exists(tr, "association-approval-evidence-banner")).toBe(false);
		expect(textOf(tr, "association-approval-new-device")).toContain(EN.associationApprovalNewDeviceLabel);
		expect(textOf(tr, "association-approval-new-device-key")).toBe(NEW_KEY.slice(0, 5) + "...");
		const existing = textOf(tr, "association-approval-existing-devices");
		expect(existing).toContain(EN.associationApprovalExistingDeviceLabel);
		expect(textOf(tr, "association-approval-existing-device-0")).toBe(OLD_KEY_1.slice(0, 5) + "...");
		expect(textOf(tr, "association-approval-existing-device-1")).toBe(OLD_KEY_2.slice(0, 5) + "...");
		const ids = orderedTestIDs(tr);
		expect(ids.indexOf("association-approval-comparison")).toBeGreaterThanOrEqual(0);
		expect(ids.indexOf("association-approval-footer")).toBeGreaterThan(ids.indexOf("association-approval-comparison"));
		// The new device and the retired devices are on screen together, before any decision.
		expect(mockApproveReassociation).not.toHaveBeenCalled();
	});

	it("tree order is error < evidence banner < comparison < footer when a notice and a banner are both showing", async () => {
		mockReview = IDENTITY_REVIEW;
		mockRejectReassociation.mockRejectedValue(new Error("x"));
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-reject");
		const ids = orderedTestIDs(tr);
		const at = (id: string) => ids.indexOf(id);
		expect(at("association-approval-error")).toBeGreaterThanOrEqual(0);
		expect(at("association-approval-evidence-banner")).toBeGreaterThan(at("association-approval-error"));
		expect(at("association-approval-comparison")).toBeGreaterThan(at("association-approval-evidence-banner"));
		expect(at("association-approval-footer")).toBeGreaterThan(at("association-approval-comparison"));
	});
});

describe("AssociationRequestApprovalScreen — S2 identity fallback (D-45)", () => {
	it("shows the warning banner, ranked candidates, Approve disabled until a candidate is chosen, then the comparison", async () => {
		mockReview = IDENTITY_REVIEW;
		const tr = await renderScreen();
		expect(textOf(tr, "association-approval-evidence-banner")).toBe(EN.associationApprovalIdentityMatchedBanner);
		const banner = tr.root.findByProps({ testID: "association-approval-evidence-banner" });
		expect(flat(banner).borderLeftColor).toBe("sentinel-warning");
		expect(exists(tr, "association-approval-code-badge")).toBe(false);
		const candidates = textOf(tr, "association-approval-candidates");
		expect(candidates).toContain(EN.associationApprovalCandidatesHeading);
		expect(candidates).toContain("Ada Lovelace");
		expect(candidates).toContain("reg-2");
		expect(isDisabled(tr, "association-approval-approve")).toBe(true);
		expect(isDisabled(tr, "association-approval-reject")).toBe(false);

		await pressAsync(tr, "association-approval-candidate-reg-2-abcdefghij");
		expect(mockGetReassociationReview).toHaveBeenLastCalledWith("arq-1", mockTransports.association, mockOpener, {
			registrantId: "reg-2-abcdefghij",
		});
		expect(textOf(tr, "association-approval-entered-fields")).toContain(EN.associationApprovalEnteredFieldsHeading);
		expect(textOf(tr, "association-approval-entered-fields")).toContain(ENTERED_SENTINEL);
		expect(textOf(tr, "association-approval-registrant-record")).toContain(EN.associationApprovalRegistrantRecordHeading);
		expect(textOf(tr, "association-approval-registrant-record")).toContain(RECORD_SENTINEL);
		expect(exists(tr, "association-approval-existing-device-0")).toBe(true);
		const chosen = tr.root.findByProps({ testID: "association-approval-candidate-reg-2-abcdefghij" });
		expect(chosen.props.accessibilityState.selected).toBe(true);
		expect(isDisabled(tr, "association-approval-approve")).toBe(false);
	});
});

describe("AssociationRequestApprovalScreen — S3 reject-only banners", () => {
	const CASES: Array<[string, any, string]> = [
		["code unmatched", { kind: "code", outcome: "unmatched" }, "associationApprovalCodeUnmatchedBanner"],
		["code unverifiable", { kind: "code", outcome: "unverifiable" }, "associationApprovalCodeUnverifiableBanner"],
		["no evidence", { kind: "none" }, "associationApprovalNoEvidenceBanner"],
	];
	for (const [label, evidence, key] of CASES) {
		it(`${label}: its own banner, no badge, Approve disabled, Reject enabled`, async () => {
			mockReview = review({ evidence, resolvedRegistrantId: undefined, existingDevices: [] });
			const tr = await renderScreen();
			expect(textOf(tr, "association-approval-evidence-banner")).toBe(EN[key]);
			expect(textOf(tr, "association-approval-evidence-banner")).not.toBe(EN.associationApprovalIdentityMatchedBanner);
			expect(exists(tr, "association-approval-code-badge")).toBe(false);
			expect(isDisabled(tr, "association-approval-approve")).toBe(true);
			expect(isDisabled(tr, "association-approval-reject")).toBe(false);
		});
	}
});

describe("AssociationRequestApprovalScreen — S4 destructive confirm (D-41)", () => {
	it("Approve opens the confirm with 0 calls; dismiss restores the footer; confirm approves once and goes back", async () => {
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-approve");
		expect(mockApproveReassociation).not.toHaveBeenCalled();
		expect(exists(tr, "association-approval-confirm-card")).toBe(true);
		expect(exists(tr, "association-approval-footer")).toBe(false);
		const card = tr.root.findByProps({ testID: "association-approval-confirm-card" });
		expect(flat(card).borderLeftColor).toBe("sentinel-error");
		expect(textOf(tr, "association-approval-confirm-title")).toBe(EN.associationApprovalApproveConfirmHeading);
		expect(textOf(tr, "association-approval-confirm-body")).toBe(
			EN.associationApprovalApproveConfirmBody.replace("{{registrantName}}", LONG_NAME)
		);
		expect(LONG_NAME.length).toBeGreaterThanOrEqual(40);
		const confirmBtn = tr.root.findByProps({ testID: "association-approval-confirm-confirm" }).findByProps({ accessibilityRole: "button" });
		expect(confirmBtn.props.accessibilityLabel).toBe(EN.associationApprovalApproveConfirmButton);
		const dismissBtn = tr.root.findByProps({ testID: "association-approval-confirm-dismiss" }).findByProps({ accessibilityRole: "button" });
		expect(dismissBtn.props.accessibilityLabel).toBe(EN.associationApprovalKeepReviewingButton);
		expect(isBareDismissLabel(EN.associationApprovalKeepReviewingButton)).toBe(false);

		await pressAsync(tr, "association-approval-confirm-dismiss");
		expect(exists(tr, "association-approval-footer")).toBe(true);
		expect(exists(tr, "association-approval-confirm-card")).toBe(false);
		expect(mockApproveReassociation).not.toHaveBeenCalled();

		await pressAsync(tr, "association-approval-approve");
		await pressAsync(tr, "association-approval-confirm-confirm");
		expect(mockApproveReassociation).toHaveBeenCalledTimes(1);
		const args = mockApproveReassociation.mock.calls[0];
		expect(args[0]).toBe("arq-1");
		expect(args[1]).toEqual({ registrantId: "reg-1" });
		expect(args[2]).toBe(mockSignerFn);
		expect(args[3]).toBe(mockTransports.association);
		expect(args[4]).toBe(mockOpener);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});
});

describe("AssociationRequestApprovalScreen — S5/S6/S7 decisions and failures", () => {
	it("S5. Reject calls rejectReassociation once with no confirm, then goes back", async () => {
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-reject");
		expect(exists(tr, "association-approval-confirm-card")).toBe(false);
		expect(mockRejectReassociation).toHaveBeenCalledTimes(1);
		const args = mockRejectReassociation.mock.calls[0];
		expect(args[0]).toBe("arq-1");
		expect(args[1]).toBe(mockSignerFn);
		expect(args[2]).toBe(mockTransports.association);
		expect(mockApproveReassociation).not.toHaveBeenCalled();
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("S6. the co-sign refusal renders its own copy, never the engine message, and disables both buttons", async () => {
		mockApproveReassociation.mockRejectedValue({ name: "ReassociationError", code: "threshold-requires-co-sign", message: "M-SECRET-MSG" });
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-approve");
		await pressAsync(tr, "association-approval-confirm-confirm");
		expect(textOf(tr, "association-approval-error")).toBe(EN.associationApprovalCoSignRequired);
		expect(whole(tr)).not.toContain("M-SECRET-MSG");
		expect(isDisabled(tr, "association-approval-approve")).toBe(true);
		expect(isDisabled(tr, "association-approval-reject")).toBe(true);
		await pressAsync(tr, "association-approval-reject");
		await pressAsync(tr, "association-approval-approve");
		expect(mockRejectReassociation).not.toHaveBeenCalled();
		expect(mockApproveReassociation).toHaveBeenCalledTimes(1);
	});

	it("S7. other failures show the decision error and re-enable both buttons; a device-signing error goes to the hook; not-pending reloads", async () => {
		mockRejectReassociation.mockRejectedValueOnce(new Error("boom"));
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-reject");
		expect(textOf(tr, "association-approval-error")).toBe(EN.associationApprovalDecisionError);
		expect(isDisabled(tr, "association-approval-approve")).toBe(false);
		expect(isDisabled(tr, "association-approval-reject")).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();

		const deviceErr = { code: "device-cancelled" };
		mockRejectReassociation.mockRejectedValueOnce(deviceErr);
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: true });
		await pressAsync(tr, "association-approval-reject");
		expect(mockHandleDeviceSigningError).toHaveBeenCalledWith(deviceErr);

		const reads = mockGetReassociationReview.mock.calls.length;
		mockRejectReassociation.mockRejectedValueOnce({ name: "ReassociationError", code: "not-pending", message: "x" });
		await pressAsync(tr, "association-approval-reject");
		expect(mockGetReassociationReview.mock.calls.length).toBeGreaterThan(reads);
	});
});

describe("AssociationRequestApprovalScreen — S8/S9/S10 disabled states (present, never hidden)", () => {
	it("S8. an unavailable session, a failed read and an undefined review each show the load error with a disabled footer", async () => {
		for (const arrange of [
			() => {
				mockHasFactory = false;
			},
			() => {
				mockReviewReject = new Error("read-boom");
			},
			() => {
				mockReview = undefined;
			},
		]) {
			jest.clearAllMocks();
			mockHasFactory = true;
			mockReviewReject = undefined;
			mockReview = review();
			arrange();
			const tr = await renderScreen();
			expect(textOf(tr, "association-approval-error")).toBe(EN.associationApprovalLoadError);
			expect(whole(tr)).not.toContain("read-boom");
			expect(exists(tr, "association-approval-footer")).toBe(true);
			expect(isDisabled(tr, "association-approval-approve")).toBe(true);
			expect(isDisabled(tr, "association-approval-reject")).toBe(true);
		}
	});

	it("S9. without the vrg scope both buttons are present and disabled", async () => {
		mockScopes = ["mel"];
		const tr = await renderScreen();
		expect(isDisabled(tr, "association-approval-approve")).toBe(true);
		expect(isDisabled(tr, "association-approval-reject")).toBe(true);
	});

	it("S10. a status other than pending disables both", async () => {
		mockReview = review({ status: "a" });
		const tr = await renderScreen();
		expect(isDisabled(tr, "association-approval-approve")).toBe(true);
		expect(isDisabled(tr, "association-approval-reject")).toBe(true);
	});
});

describe("AssociationRequestApprovalScreen — S11 geometry (Surface 4)", () => {
	it("device rows are unclipped and unscrolled, keys are truncated and wrap, candidates are 44 high, footer slots stretch", async () => {
		const tr = await renderScreen();
		const screen = tr.root.findByProps({ testID: "association-approval-screen" });
		for (const id of [
			"association-approval-new-device",
			"association-approval-existing-devices",
			"association-approval-existing-device-0",
			"association-approval-existing-device-1",
		]) {
			const node = tr.root.findByProps({ testID: id });
			expect(clippingOrHorizontalAncestors(node, screen)).toEqual([]);
			const st = flat(node);
			expect(st.height).toBeUndefined();
			expect(st.display).not.toBe("none");
		}
		const keyNode = tr.root.findByProps({ testID: "association-approval-new-device-key" });
		expect(textOfNode(keyNode)).toBe(NEW_KEY.slice(0, 5) + "...");
		expect(keyNode.props.numberOfLines).toBeUndefined();
		const limited = tr.root.findAll((n) => n.props.numberOfLines !== undefined && n.props.testID?.startsWith("association-approval"));
		expect(limited).toHaveLength(0);
		for (const slot of ["association-approval-approve", "association-approval-reject"]) {
			expect(flat(tr.root.findByProps({ testID: slot })).alignSelf).toBe("stretch");
		}
	});

	it("candidate rows are at least 44 high, banners and the 40+ character confirm body have no line limit", async () => {
		mockReview = IDENTITY_REVIEW;
		const tr = await renderScreen();
		for (const id of ["association-approval-candidate-reg-1", "association-approval-candidate-reg-2-abcdefghij"]) {
			const st = flat(tr.root.findByProps({ testID: id }));
			expect(st.minHeight).toBeGreaterThanOrEqual(44);
			expect(st.alignSelf).toBe("stretch");
		}
		expect(tr.root.findByProps({ testID: "association-approval-evidence-banner" }).findAll((n) => n.props.numberOfLines !== undefined)).toHaveLength(0);

		mockReview = review();
		const tr2 = await renderScreen();
		await pressAsync(tr2, "association-approval-approve");
		const body = tr2.root.findByProps({ testID: "association-approval-confirm-body" });
		expect(body.props.numberOfLines).toBeUndefined();
		expect(textOfNode(body)).toContain(LONG_NAME);
	});

	it("positive control: the scan flags a horizontal ScrollView and a fixed-width wrapper", () => {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<View testID="fixture-root">
					<ScrollView horizontal>
						<View style={{ width: 120 }}>
							<Text testID="fixture-leaf">x</Text>
						</View>
					</ScrollView>
				</View>
			);
		});
		const problems = clippingOrHorizontalAncestors(tr.root.findByProps({ testID: "fixture-leaf" }), tr.root.findByProps({ testID: "fixture-root" }));
		expect(problems).toEqual(expect.arrayContaining(["width=120", "horizontal-scroll"]));
	});
});

describe("AssociationRequestApprovalScreen — S12 never-log and session lifecycle", () => {
	it("an identity value appears only in its own field node, no console call, and unmount closes the session once", async () => {
		mockReview = IDENTITY_REVIEW;
		const tr = await renderScreen();
		await pressAsync(tr, "association-approval-candidate-reg-2-abcdefghij");
		const holders = (value: string) =>
			tr.root
				.findAll((n) => typeof n.type === "string" && n.children.some((c) => typeof c === "string" && c.includes(value)))
				.map((n) => {
					let cur: renderer.ReactTestInstance | null = n;
					while (cur && typeof cur.props.testID !== "string") cur = cur.parent;
					return cur?.props.testID;
				});
		expect(holders(ENTERED_SENTINEL)).toHaveLength(1);
		expect(holders(RECORD_SENTINEL)).toHaveLength(1);
		expect(holders(ENTERED_SENTINEL)[0]).toBe("association-approval-entered-fields");
		expect(holders(RECORD_SENTINEL)[0]).toBe("association-approval-registrant-record");

		expect(mockTransports.registration.close).not.toHaveBeenCalled();
		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);
		expect(mockTransports.registration.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.association.close).toHaveBeenCalledTimes(1);
		// The session is read-only: its decision signer is the always-rejecting read-only sign.
		const sign = (mockCreateTransports.mock.calls[0][0] as any).decisionSigner.sign;
		await expect(sign(new Uint8Array([1]))).rejects.toThrow();
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
	});
});

describe("AssociationRequestApprovalScreen — failed-open retry and stale reads (WR-06)", () => {
	function deferred<T>() {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	it("A-1. a failed open shows the load error and Retry; pressing Retry opens a NEW session and the review renders", async () => {
		mockCreateTransports.mockImplementationOnce(() => {
			throw Object.assign(new Error("strand"), { peerStrandUnavailable: true });
		});
		const tr = await renderScreen();
		expect(textOf(tr, "association-approval-error")).toBe(EN.associationApprovalLoadError);
		expect(exists(tr, "association-approval-retry")).toBe(true);
		expect(mockCreateTransports).toHaveBeenCalledTimes(1);

		await pressAsync(tr, "association-approval-retry");
		expect(mockCreateTransports).toHaveBeenCalledTimes(2);
		expect(exists(tr, "association-approval-error")).toBe(false);
		expect(exists(tr, "association-approval-approve")).toBe(true);
	});

	it("A-2. a slow earlier read never replaces the request being shown; Approve acts on the last selection", async () => {
		mockReview = IDENTITY_REVIEW;
		const slow = deferred<any>();
		const reg1Review = review({ ...IDENTITY_RESOLVED_REVIEW, resolvedRegistrantId: "reg-1", registrantName: "Ada Lovelace" });
		const tr = await renderScreen();
		mockGetReassociationReview.mockImplementationOnce(async () => slow.promise);
		mockGetReassociationReview.mockImplementationOnce(async () => mockResolvedReview);
		await renderer.act(async () => {
			findPressable(tr, "association-approval-candidate-reg-1")!.props.onPress();
		});
		await flushTicks(6);
		await renderer.act(async () => {
			findPressable(tr, "association-approval-candidate-reg-2-abcdefghij")!.props.onPress();
		});
		await flushTicks(12);
		await renderer.act(async () => {
			slow.resolve(reg1Review);
		});
		await flushTicks(12);

		expect(tr.root.findByProps({ testID: "association-approval-candidate-reg-2-abcdefghij" }).props.accessibilityState.selected).toBe(true);
		expect(tr.root.findByProps({ testID: "association-approval-candidate-reg-1" }).props.accessibilityState.selected).toBe(false);

		await pressAsync(tr, "association-approval-approve");
		await pressAsync(tr, "association-approval-confirm-confirm");
		expect(mockApproveReassociation).toHaveBeenCalledTimes(1);
		expect(mockApproveReassociation.mock.calls[0][1]).toEqual({ registrantId: "reg-2-abcdefghij" });
	});

	it("A-4 (WR-R3-04). a failed read after the session opened closes that session before Retry opens a fresh one", async () => {
		const first = {
			strandId: "strand-1",
			registration: { publishDecision: jest.fn(async () => "cid"), close: jest.fn(async () => undefined) },
			association: { close: jest.fn(async () => undefined) },
		};
		mockCreateTransports.mockImplementationOnce(() => first);
		mockReviewReject = new Error("read-boom");
		const tr = await renderScreen();
		expect(textOf(tr, "association-approval-error")).toBe(EN.associationApprovalLoadError);
		// The discarded session's transports are closed now, not leaked for the life of the app.
		expect(first.registration.close).toHaveBeenCalledTimes(1);
		expect(first.association.close).toHaveBeenCalledTimes(1);

		mockReviewReject = undefined;
		await pressAsync(tr, "association-approval-retry");
		expect(mockCreateTransports).toHaveBeenCalledTimes(2);
		expect(exists(tr, "association-approval-error")).toBe(false);
		expect(mockTransports.registration.close).not.toHaveBeenCalled();

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);
		expect(first.registration.close).toHaveBeenCalledTimes(1);
		expect(first.association.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.registration.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.association.close).toHaveBeenCalledTimes(1);
	});

	it("A-3. unmounting while a read is in flight raises no warnings and closes the session exactly once", async () => {
		const slow = deferred<any>();
		mockGetReassociationReview.mockImplementationOnce(async () => slow.promise);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const Screen = require("../AssociationRequestApprovalScreen").default;
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<Screen />);
		});
		await flushTicks(8);
		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);
		await renderer.act(async () => {
			slow.resolve(review());
		});
		await flushTicks(8);
		expect(mockTransports.registration.close).toHaveBeenCalledTimes(1);
		expect(mockTransports.association.close).toHaveBeenCalledTimes(1);
	});
});
