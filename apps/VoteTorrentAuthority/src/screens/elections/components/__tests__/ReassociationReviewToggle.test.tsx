/**
 * ReassociationReviewToggle.test.tsx — 62-27 (D-46, Surface 4 settings).
 *
 * Every engine is a jest.fn stub: the assertions prove the CALL CONTRACT and the rendering, never
 * an access-control boundary (the 'vrg' AdminSigning CHECK enforces that). "Geometry" means the
 * flattened style props, since RN jest has no layout engine.
 */

import React from "react";
import fs from "fs";
import path from "path";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		dark: false,
		colors: {
			text: "sentinel-text",
			textSecondary: "sentinel-textSecondary",
			success: "sentinel-success",
			warning: "sentinel-warning",
			error: "sentinel-error",
			accent: "sentinel-accent",
			card: "sentinel-card",
			background: "sentinel-background",
			border: "sentinel-border",
			dark: "sentinel-dark",
			light: "sentinel-light",
			primary: "sentinel-primary",
			notification: "sentinel-notification",
			important: "sentinel-important",
		},
	}),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../../i18n");
			const template = (resources.en.translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockReadIntakePolicy = jest.fn();
const mockSetIntakePolicy = jest.fn();
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "intake") return { readIntakePolicy: mockReadIntakePolicy, setIntakePolicy: mockSetIntakePolicy };
	return null;
});
const mockSignerFn = jest.fn(async (_d: Uint8Array) => ({ signature: "s", signerKey: "k", signerUserId: "u" }));
const mockCreateDeviceSigner = jest.fn(async (_n: string) => mockSignerFn);
const mockHandleDeviceSigningError = jest.fn((_err: unknown): { handled: boolean; message?: string } => ({ handled: false }));

jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));
jest.mock("../../../../engines/device-signer", () => ({
	createDeviceSigner: (n: string) => mockCreateDeviceSigner(n),
}));
jest.mock("../../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleDeviceSigningError,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../../i18n");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReassociationReviewToggle } = require("../ReassociationReviewToggle");

const EN = resources.en.translation as Record<string, string>;
const PREFIX = "reassociation-review-toggle";

function view(overrides: Record<string, unknown> = {}) {
	return {
		authorityId: "auth-1",
		revision: 0,
		restBridgeUrl: null,
		reassociationMode: "manual",
		setAt: null,
		isDefault: true,
		...overrides,
	};
}

async function mount(canWrite = true): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<ReassociationReviewToggle authorityId="auth-1" canWrite={canWrite} />);
	});
	return tr;
}

async function flush() {
	await act(async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	});
}

function option(tr: renderer.ReactTestRenderer, mode: "manual" | "automatic") {
	return tr.root.findByProps({ testID: `${PREFIX}-${mode}` });
}

function textOf(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOf(c as renderer.ReactTestInstance))).join("");
}

function allText(tr: renderer.ReactTestRenderer): string {
	return textOf(tr.root);
}

beforeEach(() => {
	mockReadIntakePolicy.mockReset();
	mockSetIntakePolicy.mockReset();
	mockCreateDeviceSigner.mockClear();
	mockGetEngine.mockClear();
	mockHandleDeviceSigningError.mockReset();
	mockHandleDeviceSigningError.mockReturnValue({ handled: false });
	mockReadIntakePolicy.mockResolvedValue(view());
});

describe("ReassociationReviewToggle (D-46)", () => {
	test("T1: while the policy read is unresolved, manual is selected and both options are disabled", async () => {
		mockReadIntakePolicy.mockReturnValue(new Promise(() => undefined));
		const tr = await mount();
		expect(option(tr, "manual").props.accessibilityState).toEqual({ selected: true, disabled: true });
		expect(option(tr, "automatic").props.accessibilityState).toEqual({ selected: false, disabled: true });
	});

	test("T2: an isDefault view selects manual and shows the default note", async () => {
		const tr = await mount();
		await flush();
		expect(option(tr, "manual").props.accessibilityState.selected).toBe(true);
		expect(option(tr, "automatic").props.accessibilityState.selected).toBe(false);
		expect(textOf(tr.root.findByProps({ testID: `${PREFIX}-default-note` }))).toBe(EN.registrationPolicyReassociationDefaultNote);
	});

	test("T3: automatic at revision 3 selects automatic", async () => {
		mockReadIntakePolicy.mockResolvedValue(view({ reassociationMode: "automatic", revision: 3, isDefault: false }));
		const tr = await mount();
		await flush();
		expect(option(tr, "automatic").props.accessibilityState.selected).toBe(true);
		expect(option(tr, "manual").props.accessibilityState.selected).toBe(false);
	});

	test("T4: pressing Automatic writes once with the revision and the device signer; two presses in one tick make one call", async () => {
		mockReadIntakePolicy.mockResolvedValue(view({ revision: 3, isDefault: false }));
		let resolveWrite!: (v: unknown) => void;
		mockSetIntakePolicy.mockReturnValue(new Promise((r) => (resolveWrite = r)));
		const tr = await mount();
		await flush();
		await act(async () => {
			option(tr, "automatic").props.onPress();
			option(tr, "automatic").props.onPress();
		});
		expect(mockSetIntakePolicy).toHaveBeenCalledTimes(1);
		const [input, sign] = mockSetIntakePolicy.mock.calls[0];
		expect(input).toEqual({ authorityId: "auth-1", reassociationMode: "automatic", expectedRevision: 3 });
		expect(sign).toBe(mockSignerFn);
		await act(async () => {
			resolveWrite(view({ reassociationMode: "automatic", revision: 4, isDefault: false }));
		});
		await flush();
		expect(option(tr, "automatic").props.accessibilityState.selected).toBe(true);
	});

	test("T5: without write access both options are present and disabled, and a press makes no call", async () => {
		const tr = await mount(false);
		await flush();
		expect(option(tr, "manual").props.accessibilityState.disabled).toBe(true);
		expect(option(tr, "automatic").props.accessibilityState.disabled).toBe(true);
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		expect(mockSetIntakePolicy).not.toHaveBeenCalled();
	});

	test("T6: the co-sign refusal renders its own copy, never the engine message, and disables both options", async () => {
		mockSetIntakePolicy.mockRejectedValue({ name: "IntakeError", code: "threshold-requires-co-sign", message: "M-SECRET" });
		const tr = await mount();
		await flush();
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		const text = allText(tr);
		expect(text).toContain(EN.registrationPolicyReassociationCoSignRequired);
		expect(text).not.toContain("M-SECRET");
		expect(text.toLowerCase()).not.toContain("try again");
		expect(option(tr, "manual").props.accessibilityState.disabled).toBe(true);
		expect(option(tr, "automatic").props.accessibilityState.disabled).toBe(true);
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		expect(mockSetIntakePolicy).toHaveBeenCalledTimes(1);
	});

	test("T7: other failures show the save error and keep the selection; a revision conflict re-reads; a device error is routed to the hook", async () => {
		mockSetIntakePolicy.mockRejectedValueOnce(new Error("boom"));
		const tr = await mount();
		await flush();
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationSaveError);
		expect(option(tr, "manual").props.accessibilityState.selected).toBe(true);

		const reads = mockReadIntakePolicy.mock.calls.length;
		mockSetIntakePolicy.mockRejectedValueOnce({ name: "IntakeError", code: "policy-revision-conflict", message: "x" });
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		expect(mockReadIntakePolicy.mock.calls.length).toBe(reads + 1);
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationSaveError);

		const deviceErr = { code: "device-cancelled" };
		mockSetIntakePolicy.mockRejectedValueOnce(deviceErr);
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: true });
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		expect(mockHandleDeviceSigningError).toHaveBeenCalledWith(deviceErr);
		expect(allText(tr)).not.toContain(EN.registrationPolicyReassociationSaveError);
	});

	test("T8: a failed read selects neither option, disables both, and shows the load error", async () => {
		mockReadIntakePolicy.mockRejectedValue(new Error("nope"));
		const tr = await mount();
		await flush();
		expect(option(tr, "manual").props.accessibilityState).toEqual({ selected: false, disabled: true });
		expect(option(tr, "automatic").props.accessibilityState).toEqual({ selected: false, disabled: true });
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationLoadError);
	});

	test("T9: geometry — each option is at least 44 high and stretched, labels wrap, no Switch", async () => {
		const tr = await mount();
		await flush();
		for (const mode of ["manual", "automatic"] as const) {
			const st = StyleSheet.flatten(option(tr, mode).props.style) as Record<string, any>;
			expect(st.minHeight).toBeGreaterThanOrEqual(44);
			expect(st.alignSelf).toBe("stretch");
		}
		const limited = tr.root.findAll((n) => n.props.numberOfLines !== undefined || n.props.ellipsizeMode !== undefined);
		expect(limited).toHaveLength(0);
		const switches = tr.root.findAll((n) => (n.type as { displayName?: string; name?: string })?.displayName === "Switch" || (n.type as { name?: string })?.name === "Switch");
		expect(switches).toHaveLength(0);
	});

	// 62-143 (authority-level ruling): the toggle lives on Registration Requests, gated on the vrg scope;
	// Registration Policy keeps only a read-only note in its reassociation section, after attestation.
	test("T10: RegistrationInboxScreen mounts the toggle gated on vrg; RegistrationPolicyScreen shows only the note", () => {
		const inbox = fs.readFileSync(path.resolve(__dirname, "../../../registration/RegistrationInboxScreen.tsx"), "utf8");
		const reviewAt = inbox.indexOf('testID="registration-inbox-reassociation-review"');
		expect(reviewAt).toBeGreaterThan(0);
		expect(inbox.indexOf("<ReassociationReviewToggle")).toBeGreaterThan(reviewAt);
		expect(inbox).toMatch(/canWrite = !scopesLoading && scopes\?\.includes\("vrg"\) === true/);
		expect(inbox).toMatch(/<ReassociationReviewToggle authorityId=\{authorityId\} canWrite=\{canWrite\} \/>/);

		const policy = fs.readFileSync(path.resolve(__dirname, "../../RegistrationPolicyScreen.tsx"), "utf8");
		const attestationAt = policy.indexOf('testID="registration-policy-attestation-section"');
		const sectionAt = policy.indexOf('testID="registration-policy-reassociation-section"');
		expect(attestationAt).toBeGreaterThan(0);
		expect(sectionAt).toBeGreaterThan(attestationAt);
		expect(policy.indexOf("<ReassociationReviewNote")).toBeGreaterThan(sectionAt);
		expect(policy).not.toContain("<ReassociationReviewToggle");
	});
});

describe("ReassociationReviewToggle — read recovery (IN-01)", () => {
	function pressRetry(tr: renderer.ReactTestRenderer) {
		return act(async () => {
			tr.root.findByProps({ testID: `${PREFIX}-retry` }).findAll((n) => typeof n.props.onPress === "function")[0].props.onPress();
		});
	}

	test("T-1: Retry (shown only while unreadable) clears the load error and enables the options", async () => {
		mockReadIntakePolicy.mockRejectedValueOnce(new Error("boom"));
		const tr = await mount();
		await flush();
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationLoadError);
		expect(option(tr, "manual").props.accessibilityState.disabled).toBe(true);

		await pressRetry(tr);
		await flush();
		expect(allText(tr)).not.toContain(EN.registrationPolicyReassociationLoadError);
		expect(option(tr, "manual").props.accessibilityState.disabled).toBe(false);
		expect(tr.root.findAllByProps({ testID: `${PREFIX}-retry` })).toHaveLength(0);
	});

	test("T-2: a conflict whose re-read fails shows load-error with Retry; a conflict whose re-read succeeds shows save-error", async () => {
		mockSetIntakePolicy.mockRejectedValue({ name: "IntakeError", code: "policy-revision-conflict" });
		let tr = await mount();
		await flush();
		mockReadIntakePolicy.mockRejectedValueOnce(new Error("reread failed"));
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationLoadError);
		expect(allText(tr)).not.toContain(EN.registrationPolicyReassociationSaveError);
		expect(tr.root.findAllByProps({ testID: `${PREFIX}-retry` }).length).toBeGreaterThan(0);

		tr = await mount();
		await flush();
		await act(async () => {
			option(tr, "automatic").props.onPress();
		});
		await flush();
		expect(allText(tr)).toContain(EN.registrationPolicyReassociationSaveError);
	});
});
