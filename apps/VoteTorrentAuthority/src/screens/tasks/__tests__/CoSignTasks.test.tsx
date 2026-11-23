/**
 * CoSignTasks.test.tsx — the co-signer tasks above a vrg threshold of 1: 'intake-policy' (a
 * proposed registration settings change) and 'association' (another officer's device change
 * decision). Covers the details components, the task card, and SignatureTaskScreen's title,
 * details branch and sign/reject calls. The engine is a call-recording stub; the real engine
 * paths are covered by vote-engine's intake-policy-cosign and reassociation specs.
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
let mockRouteTask: unknown = null;
jest.mock("@react-navigation/native", () => ({
	useRoute: () => ({ params: { task: mockRouteTask } }),
	useNavigation: () => ({ goBack: mockGoBack, setOptions: mockSetOptions }),
	useTheme: () => ({
		colors: {
			primary: "p",
			background: "b",
			card: "c",
			text: "t",
			border: "bd",
			notification: "n",
			error: "e",
			textSecondary: "s",
			important: "i",
			success: "ok",
			accent: "a",
			warning: "w",
			dark: "d",
			light: "l",
		},
	}),
}));

const mockGetTaskSigningStatus = jest.fn(async (_task: unknown): Promise<unknown> => null);
const mockGetSignatureDigest = jest.fn(async (_task: unknown) => new Uint8Array([7, 7, 7]));
const mockCompleteSignature = jest.fn(async (_task: unknown, _result: Record<string, unknown>) => {});
const mockGetEngine = jest.fn(async (_name: string): Promise<any> => ({
	getTaskSigningStatus: mockGetTaskSigningStatus,
	getSignatureDigest: mockGetSignatureDigest,
	completeSignature: mockCompleteSignature,
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));

const SIGNATURE = { signature: "sig", signerKey: "key", signerUserId: "u2" };
const mockSigner = jest.fn(async (_d: Uint8Array) => SIGNATURE);
const mockCreateDeviceSigner = jest.fn(async (_n: string) => mockSigner);
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: (n: string) => mockCreateDeviceSigner(n) }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");
const EN = resources.en.translation as Record<string, string>;
const ES = resources.es.translation as Record<string, string>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IntakePolicySignatureTaskDetails, AssociationSignatureTaskDetails } = require("../components/CoSignTaskDetails");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TaskCard } = require("../components/TaskCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SignatureTaskScreen = require("../SignatureTaskScreen").default;

const network = { name: "Net One", imageUrl: undefined };
const REGISTRANT = "registrant-0123456789abcdefghij";
const DEVICE_KEY = "02deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef";

function intakeTask(proposal: Record<string, unknown> = {}) {
	return {
		type: "signature",
		signatureType: "intake-policy",
		userId: "u2",
		network,
		authorityId: "auth-1",
		signingNonce: "nonce-intake",
		proposal: { revision: 2, restBridgeUrl: "https://bridge.example/intake", reassociationMode: "automatic", setAt: "2026-11-23T00:00:00Z", ...proposal },
	};
}

function associationTask(overrides: Record<string, unknown> = {}) {
	return {
		type: "signature",
		signatureType: "association",
		userId: "u2",
		network,
		signingNonce: "nonce-assoc",
		requestId: "arq-1",
		authorityId: "auth-1",
		deviceKey: DEVICE_KEY,
		decision: "a",
		registrantId: REGISTRANT,
		...overrides,
	};
}

function textOf(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOf(c as renderer.ReactTestInstance))).join("");
}

function mount(element: React.ReactElement): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(element);
	});
	return tr;
}

async function mountScreen(task: unknown): Promise<renderer.ReactTestRenderer> {
	mockRouteTask = task;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<SignatureTaskScreen />);
	});
	await renderer.act(async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	});
	return tr;
}

function footerButton(tr: renderer.ReactTestRenderer, slot: "accept" | "reject") {
	const wrapper = tr.root.findByProps({ testID: `signature-task-footer-${slot}-slot` });
	return wrapper.findAll((n) => typeof n.props.onPress === "function")[0]!;
}

beforeEach(() => {
	jest.clearAllMocks();
});

describe("co-signer task copy", () => {
	it("C0: every new key exists in English and Spanish, with no phase numbers", () => {
		for (const key of [
			"intakePolicyTaskTitle",
			"intakePolicyTaskBody",
			"intakePolicyTaskBridgeLabel",
			"intakePolicyTaskNoBridge",
			"associationTaskTitle",
			"associationTaskApproveBody",
			"associationTaskRejectBody",
			"associationTaskDeviceLabel",
			"signatureTaskThresholdCoSignSubtitle",
			"associationApprovalReviewPending",
		]) {
			for (const lang of [EN, ES]) {
				expect(typeof lang[key]).toBe("string");
				expect(lang[key]).not.toMatch(/\bphase\b|\bfase\b|\d{2}-\d{2}/i);
			}
		}
		expect(ES.associationTaskApproveBody).toContain("{{registrant}}");
	});
});

describe("IntakePolicySignatureTaskDetails", () => {
	it("C1: shows the proposed bridge URL and the proposed device change mode", () => {
		const tr = mount(<IntakePolicySignatureTaskDetails task={intakeTask()} />);
		expect(textOf(tr.root.findByProps({ testID: "intake-policy-task-bridge" }))).toBe("https://bridge.example/intake");
		expect(textOf(tr.root.findByProps({ testID: "intake-policy-task-mode" }))).toBe(EN.registrationPolicyReassociationAutomatic);
		expect(textOf(tr.root.findByProps({ testID: "intake-policy-task-details" }))).toContain(EN.intakePolicyTaskBody);
	});

	it("C2: a proposal with no bridge says so, and a manual mode reads manual", () => {
		const tr = mount(<IntakePolicySignatureTaskDetails task={intakeTask({ restBridgeUrl: null, reassociationMode: "manual" })} />);
		expect(textOf(tr.root.findByProps({ testID: "intake-policy-task-bridge" }))).toBe(EN.intakePolicyTaskNoBridge);
		expect(textOf(tr.root.findByProps({ testID: "intake-policy-task-mode" }))).toBe(EN.registrationPolicyReassociationManual);
	});
});

describe("AssociationSignatureTaskDetails", () => {
	it("C3: an approval names the registrant (shortened) and shows the new device key (shortened)", () => {
		const tr = mount(<AssociationSignatureTaskDetails task={associationTask()} />);
		const decision = textOf(tr.root.findByProps({ testID: "association-task-decision" }));
		expect(decision).toBe(EN.associationTaskApproveBody.replace("{{registrant}}", "registra…cdefghij"));
		const all = textOf(tr.root);
		expect(all).toContain("02deadbe…89abcdef");
		expect(all).not.toContain(DEVICE_KEY);
	});

	it("C4: a rejection uses the rejection copy and names no registrant", () => {
		const tr = mount(<AssociationSignatureTaskDetails task={associationTask({ decision: "r", registrantId: undefined })} />);
		expect(textOf(tr.root.findByProps({ testID: "association-task-decision" }))).toBe(EN.associationTaskRejectBody);
	});
});

describe("TaskCard for co-signer tasks", () => {
	it("C5: the intake-policy and association cards carry their own title, the co-sign subtitle and the network", () => {
		for (const [task, titleKey] of [
			[intakeTask(), "intakePolicyTaskTitle"],
			[associationTask(), "associationTaskTitle"],
		] as const) {
			const out = JSON.stringify(mount(<TaskCard task={task as never} showIndicator={false} />).toJSON());
			expect(out).toContain(EN[titleKey]);
			expect(out).toContain(EN.signatureTaskThresholdCoSignSubtitle);
			expect(out).toContain("Net One");
		}
	});
});

describe("SignatureTaskScreen for co-signer tasks", () => {
	it("C6: an intake-policy task gets its title and details; Sign signs the engine digest and completes without a re-sign callback", async () => {
		const task = intakeTask();
		const tr = await mountScreen(task);
		expect(mockSetOptions).toHaveBeenCalledWith({ title: EN.intakePolicyTaskTitle });
		expect(tr.root.findAllByProps({ testID: "intake-policy-task-details" }).length).toBeGreaterThan(0);

		await renderer.act(async () => {
			footerButton(tr, "accept").props.onPress();
		});
		expect(mockGetSignatureDigest).toHaveBeenCalledWith(task);
		expect(mockSigner).toHaveBeenCalledWith(new Uint8Array([7, 7, 7]));
		expect(mockCompleteSignature).toHaveBeenCalledWith(task, { isAccepted: true, signature: SIGNATURE, sign: undefined });
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("C7: an association task gets its title and details; Reject completes as a vote without signing", async () => {
		const task = associationTask();
		const tr = await mountScreen(task);
		expect(mockSetOptions).toHaveBeenCalledWith({ title: EN.associationTaskTitle });
		expect(tr.root.findAllByProps({ testID: "association-task-details" }).length).toBeGreaterThan(0);

		await renderer.act(async () => {
			footerButton(tr, "reject").props.onPress();
		});
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockCompleteSignature).toHaveBeenCalledWith(task, {
			isAccepted: false,
			signature: { signature: "", signerKey: "", signerUserId: "" },
		});
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});
});
