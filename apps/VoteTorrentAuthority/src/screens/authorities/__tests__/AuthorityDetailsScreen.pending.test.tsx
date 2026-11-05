/**
 * AuthorityDetailsScreen.pending.test.tsx — 66.1 (D-04, D-05, D-08): a change waiting for its time
 * shows as the pending card with its local time; Revise Administration is hidden while it waits;
 * Cancel change is offered only to a current rad holder and costs one signer and one engine call,
 * then the screen re-reads; refusals render only translated copy; returning to the screen re-reads.
 *
 * Mock scaffold mirrors AuthorityDetailsScreen.proposedLabels.test.tsx; useFocusEffect records its
 * callbacks like ProposedAdministrationScreen.refocus.test.tsx so a test can re-focus.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// A STABLE `t` (AuthorizationSection lists `t` in an effect's deps) that shows an interpolated time.
const mockT = (key: string, opts?: { time?: unknown }) =>
	opts && opts.time !== undefined ? key + ":" + String(opts.time) : key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factories to close over them.
let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
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
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
	// Run the callback once on mount (like a first focus) and record it so a test can re-focus.
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

const mockSign = jest.fn();
const mockCreateDeviceSigner = jest.fn();
const mockGetDeviceUser = jest.fn();
const mockGetOrCreateDeviceUser = jest.fn();
let mockHandlerOutcome: { handled: boolean; message?: string } = { handled: false };

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: () => mockGetDeviceUser(),
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
}));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => mockHandlerOutcome,
}));

const ADMIN_ID = "authority-1:2026-10-01T00:00:00";
const AUTHORITY_FIXTURE = { id: "authority-1", name: "Test Authority", domainName: "test.example.org", imageRef: undefined };
const FOUNDER = { userId: "user-1", authorityId: "authority-1", title: "Chair", scopes: ["rad"] };
const SECOND = { userId: "user-2", authorityId: "authority-1", title: "Deputy", scopes: ["vrg"] };
const NAMES: Record<string, string> = { "user-1": "Founding Chair", "user-2": "Second Officer" };
const SIGNATURE = { signerUserId: "user-1", signerKey: "k", signature: "s" };

// 04:57 UTC is 10:42 in Asia/Kathmandu (UTC+05:45).
const PENDING_AT = "2026-11-05T04:57:00";
const PENDING_MS = Date.parse(PENDING_AT + "Z");
const IN_NEPAL = new Date(PENDING_MS).getTimezoneOffset() === -345;
const pad2 = (n: number) => (n < 10 ? "0" + n : "" + n);
/** Local HH:MM of an instant, from the Date getters (independent of formatLocalTime). */
const expectedLocal = (ms: number) => pad2(new Date(ms).getHours()) + ":" + pad2(new Date(ms).getMinutes());

function admin(officers: unknown[] = [FOUNDER]) {
	return { id: ADMIN_ID, authorityId: "authority-1", officers, effectiveAt: Date.UTC(2026, 9, 1), thresholdPolicies: [] };
}

function pending(promoted: boolean) {
	return {
		effectiveAt: PENDING_AT,
		officers: [{ existing: FOUNDER }, { existing: SECOND }],
		thresholdPolicies: [],
		promoted,
	};
}

/** A promoted pending change: the roster is in Officer rows already, there is no live proposal. */
function promotedPending(officers: unknown[] = [FOUNDER]) {
	return { admin: admin(officers), pending: pending(true) };
}

const mockAuthorityEngine = {
	getAdminDetails: jest.fn(),
	getPendingInviteCids: jest.fn(async () => []),
	cancelAdminChange: jest.fn(),
};
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: jest.fn(async (id: string) => ({ getSummary: async () => ({ id, name: NAMES[id] ?? id }) })),
};
const mockGetEngine = jest.fn(async (name: string) =>
	name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined,
);

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

type Tr = renderer.ReactTestRenderer;
type Node = renderer.ReactTestInstance;

async function flush() {
	for (let i = 0; i < 10; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			for (let j = 0; j < 5; j++) await Promise.resolve();
		});
	}
}

async function renderScreen(): Promise<Tr> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreen = require("../AuthorityDetailsScreen").default;
	let tr!: Tr;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	await flush();
	return tr;
}

function textContent(node: Node | string): string {
	if (typeof node === "string") return node;
	return node.children.map((c) => textContent(c as Node | string)).join("");
}

/** Host-level Text nodes whose OWN text (no nested Text). */
function leafTexts(tr: Tr): string[] {
	return tr.root
		.findAllByType(Text)
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n))
		.map(textContent);
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

function reviseButtons(tr: Tr): Node[] {
	return tr.root.findAll((n) => n.props?.title === "reviseAdministration" && typeof n.props?.onPress === "function");
}

function cancelControl(tr: Tr): Node | undefined {
	return tr.root.findAll((n) => n.props?.testID === "admin-change-cancel" && typeof n.props?.onPress === "function")[0];
}

async function pressCancel(tr: Tr) {
	const target = cancelControl(tr);
	if (!target) throw new Error("no Cancel change control");
	await renderer.act(async () => {
		await target.props.onPress();
	});
	await flush();
}

function coded(code: string) {
	return Object.assign(new Error("RAW select * from Admin where Quereus"), { code });
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFocusCallbacks.splice(0);
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	mockHandlerOutcome = { handled: false };
	mockSign.mockImplementation(async () => SIGNATURE);
	mockCreateDeviceSigner.mockImplementation(async () => mockSign);
	mockGetDeviceUser.mockImplementation(async () => ({ id: "user-1", name: "Device User" }));
	mockGetOrCreateDeviceUser.mockImplementation(async () => ({ id: "user-1", name: "Device User" }));
	mockAuthorityEngine.getAdminDetails.mockImplementation(async () => promotedPending());
	// Stands in for the engine (R-06): one signature per cancel.
	mockAuthorityEngine.cancelAdminChange.mockImplementation(
		async (_target: unknown, sign: (d: Uint8Array) => Promise<unknown>) => {
			await sign(new Uint8Array([1]));
		},
	);
});

describe("AuthorityDetailsScreen — pending administration change (D-04, D-08)", () => {
	it("shows the pending card with the local time the change takes effect", async () => {
		const tr = await renderScreen();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(allText(tr)).toContain("adminChangeTakesEffectAt:" + expectedLocal(PENDING_MS));
	});

	(IN_NEPAL ? it : it.skip)("Asia/Kathmandu: reads 10:42", async () => {
		const tr = await renderScreen();
		expect(allText(tr)).toContain("adminChangeTakesEffectAt:10:42");
	});

	it("hides Revise Administration while a change is pending", async () => {
		const tr = await renderScreen();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(reviseButtons(tr)).toHaveLength(0);
	});

	it("control: with no pending change Revise Administration is offered and no pending card shows", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () => ({ admin: admin() }));
		const tr = await renderScreen();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(reviseButtons(tr)).toHaveLength(1);
		expect(has(tr, "admin-change-pending-card")).toBe(false);
	});

	it("lists a promoted pending roster under Proposed Administration with no Effective row and no authorization", async () => {
		const tr = await renderScreen();
		const texts = leafTexts(tr);
		expect(texts).toContain("proposedAdministration");
		const joined = texts.join(" | ");
		expect(joined).toContain("Founding Chair");
		expect(joined).toContain("Second Officer");
		expect(texts.filter((s) => s === "effective: ")).toHaveLength(1);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { AuthorizationSection } = require("../../../components/AuthorizationSection");
		expect(tr.root.findAllByType(AuthorizationSection)).toHaveLength(0);
	});

	it("never reads a pending proposal's canonical time as a local date", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () => ({
			admin: admin(),
			proposed: {
				proposed: { officers: pending(false).officers, effectiveAt: PENDING_AT, thresholdPolicies: [] },
				signers: ["user-1"],
			},
			pending: pending(false),
		}));
		const tr = await renderScreen();
		const texts = leafTexts(tr);
		expect(texts.filter((s) => s === "effective: ")).toHaveLength(1);
		expect(allText(tr)).toContain("adminChangeTakesEffectAt:" + expectedLocal(PENDING_MS));
		// The only date-shaped text is the current administration's.
		expect(texts.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))).toEqual(["2026-10-01"]);
	});
});

describe("AuthorityDetailsScreen — Cancel change (D-05)", () => {
	it("a rad holder's Cancel costs one signer and one cancel, then the screen re-reads", async () => {
		mockAuthorityEngine.getAdminDetails
			.mockImplementationOnce(async () => promotedPending())
			.mockImplementation(async () => ({ admin: admin() }));
		const tr = await renderScreen();
		expect(cancelControl(tr)).toBeDefined();

		await pressCancel(tr);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockSign).toHaveBeenCalledTimes(1);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledWith(
			{ effectiveAt: PENDING_AT, userId: "user-1" },
			mockSign,
		);
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(2);
		expect(has(tr, "admin-change-pending-card")).toBe(false);
		expect(textContent(byTestId(tr, "admin-change-cancelled")[0]!)).toContain("adminChangeCancelled");
		expect(reviseButtons(tr)).toHaveLength(1);
	});

	it("R-33: a refused promotion (promoted false, no proposal) shows the same card and cancels the same way", async () => {
		mockAuthorityEngine.getAdminDetails
			.mockImplementationOnce(async () => ({ admin: admin(), pending: pending(false) }))
			.mockImplementation(async () => ({ admin: admin() }));
		const tr = await renderScreen();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(cancelControl(tr)).toBeDefined();
		expect(reviseButtons(tr)).toHaveLength(0);

		await pressCancel(tr);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledWith(
			{ effectiveAt: PENDING_AT, userId: "user-1" },
			mockSign,
		);
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(2);
		expect(has(tr, "admin-change-cancelled")).toBe(true);
	});

	it("a double press while the cancel is in flight cancels once", async () => {
		let release!: () => void;
		mockAuthorityEngine.cancelAdminChange.mockImplementation(
			() =>
				new Promise<void>((r) => {
					release = r;
				}),
		);
		const tr = await renderScreen();
		const target = cancelControl(tr)!;
		await renderer.act(async () => {
			target.props.onPress();
			target.props.onPress();
		});
		await flush();
		await renderer.act(async () => {
			target.props.onPress();
		});
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		await renderer.act(async () => {
			release();
		});
		await flush();
	});

	it("is hidden from a device user who is not an officer", async () => {
		mockGetDeviceUser.mockImplementation(async () => ({ id: "user-9", name: "Stranger" }));
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(cancelControl(tr)).toBeUndefined();
	});

	it("is hidden from an officer without rad", async () => {
		mockAuthorityEngine.getAdminDetails.mockImplementation(async () => promotedPending([{ ...FOUNDER, scopes: ["vrg"] }]));
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(cancelControl(tr)).toBeUndefined();
	});

	it("is hidden when this device has no user", async () => {
		mockGetDeviceUser.mockImplementation(async () => undefined);
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(cancelControl(tr)).toBeUndefined();
	});

	it("is hidden when reading the device user throws", async () => {
		mockGetDeviceUser.mockImplementation(async () => {
			throw new Error("storage unavailable");
		});
		const tr = await renderScreen();
		expect(mockGetDeviceUser).toHaveBeenCalled();
		expect(has(tr, "admin-change-pending-card")).toBe(true);
		expect(cancelControl(tr)).toBeUndefined();
	});

	it.each([
		["admin-cancel-not-authorized", "adminChangeCancelNotAuthorized"],
		["admin-cancel-not-pending", "adminChangeCancelNotPending"],
		["admin-cancel-refused", "adminChangeCancelRefused"],
	])("a %s refusal shows %s on the card, no engine text, and no re-read", async (code, key) => {
		mockAuthorityEngine.cancelAdminChange.mockImplementation(async () => {
			throw coded(code);
		});
		const tr = await renderScreen();
		await pressCancel(tr);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		expect(textContent(byTestId(tr, "admin-change-pending-card")[0]!)).toContain(key);
		const s = allText(tr);
		expect(s).not.toContain("RAW");
		expect(s).not.toContain("select");
		expect(s).not.toContain("Quereus");
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(has(tr, "admin-change-cancelled")).toBe(false);
	});

	it("a failure the signing handler takes renders no copy", async () => {
		mockHandlerOutcome = { handled: true };
		mockAuthorityEngine.cancelAdminChange.mockImplementation(async () => {
			throw coded("admin-cancel-refused");
		});
		const tr = await renderScreen();
		await pressCancel(tr);
		expect(mockAuthorityEngine.cancelAdminChange).toHaveBeenCalledTimes(1);
		const s = allText(tr);
		expect(s).not.toContain("adminChangeCancelRefused");
		expect(s).not.toContain("errorActionFailedGeneric");
		expect(s).not.toContain("RAW");
	});
});

describe("AuthorityDetailsScreen — re-reads on return (stale-screen trap)", () => {
	it("the first focus is the mount read; a later focus reads the administration again", async () => {
		mockAuthorityEngine.getAdminDetails
			.mockImplementationOnce(async () => ({ admin: admin() }))
			.mockImplementation(async () => promotedPending());
		const tr = await renderScreen();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(1);
		expect(has(tr, "admin-change-pending-card")).toBe(false);

		// Re-focus: every distinct focus callback runs once, as on a navigator focus event.
		const callbacks = Array.from(new Set(mockFocusCallbacks));
		await renderer.act(async () => {
			callbacks.forEach((cb) => cb());
		});
		await flush();
		expect(mockAuthorityEngine.getAdminDetails).toHaveBeenCalledTimes(2);
		expect(has(tr, "admin-change-pending-card")).toBe(true);
	});
});
