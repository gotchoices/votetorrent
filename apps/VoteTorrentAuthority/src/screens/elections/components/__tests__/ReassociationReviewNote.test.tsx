/**
 * ReassociationReviewNote.test.tsx — the read-only note that replaced the per-election toggle
 * (D-46 user ruling 2026-10-07). Engines are jest.fn stubs; the assertions prove the call
 * contract and the rendering.
 */

import React from "react";
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
	useNavigation: () => ({ navigate: mockNavigate }),
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

const mockNavigate = jest.fn();
const mockReadIntakePolicy = jest.fn();
const mockSetIntakePolicy = jest.fn();
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "intake") return { readIntakePolicy: mockReadIntakePolicy, setIntakePolicy: mockSetIntakePolicy };
	return null;
});

jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../../i18n");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ReassociationReviewNote } = require("../ReassociationReviewNote");

const EN = resources.en.translation as Record<string, string>;

function view(mode: "manual" | "automatic") {
	return { authorityId: "auth-1", revision: 0, restBridgeUrl: null, reassociationMode: mode, setAt: null, isDefault: true };
}

async function mount(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<ReassociationReviewNote authorityId="auth-1" />);
	});
	await act(async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	});
	return tr;
}

function textOf(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOf(c as renderer.ReactTestInstance))).join("");
}

beforeEach(() => {
	mockNavigate.mockReset();
	mockReadIntakePolicy.mockReset();
	mockSetIntakePolicy.mockReset();
});

describe("ReassociationReviewNote (D-46 ruling)", () => {
	test("R1: manual shows heading, authority-wide line, current value and where to change it", async () => {
		mockReadIntakePolicy.mockResolvedValue(view("manual"));
		const tr = await mount();
		const text = textOf(tr.root.findByProps({ testID: "reassociation-review-note" }));
		expect(text).toContain(EN.registrationPolicyReassociationHeading);
		expect(text).toContain(EN.reassociationReviewAuthorityWide);
		expect(text).toContain(`Current setting: ${EN.registrationPolicyReassociationManual}`);
		expect(text).toContain(`open ${EN.registrationRequestScreenTitle} for this authority`);
	});

	test("R1: automatic shows the automatic label", async () => {
		mockReadIntakePolicy.mockResolvedValue(view("automatic"));
		const tr = await mount();
		const text = textOf(tr.root);
		expect(text).toContain(`Current setting: ${EN.registrationPolicyReassociationAutomatic}`);
		expect(text).not.toContain(`Current setting: ${EN.registrationPolicyReassociationManual}`);
	});

	test("R2: a rejected read shows the load-error copy and no current value", async () => {
		mockReadIntakePolicy.mockRejectedValue(new Error("boom engine detail"));
		const tr = await mount();
		const text = textOf(tr.root);
		expect(text).toContain(EN.registrationPolicyReassociationLoadError);
		expect(text).not.toContain("Current setting");
		expect(text).not.toContain("boom engine detail");
	});

	test("R3: the button opens Registration Requests for the same authority", async () => {
		mockReadIntakePolicy.mockResolvedValue(view("manual"));
		const tr = await mount();
		const btn = tr.root.findByProps({ testID: "reassociation-review-note-open" });
		await act(async () => {
			btn.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("RegistrationInbox", { authorityId: "auth-1" });
	});

	test("R4: no write and no radios", async () => {
		mockReadIntakePolicy.mockResolvedValue(view("manual"));
		const tr = await mount();
		expect(mockSetIntakePolicy).not.toHaveBeenCalled();
		expect(tr.root.findAll((n) => typeof n.props.testID === "string" && n.props.testID.startsWith("reassociation-review-toggle"))).toHaveLength(0);
	});
});
