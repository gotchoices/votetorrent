/**
 * RegistrationInboxScreen.reassociationReview.test.tsx — the per-authority device-change review
 * setting lives on the authority's Registration Requests screen (D-46 user ruling 2026-10-07).
 * Same component, same 'vrg' gate, same signed write. Engines are stubs: these assertions prove the
 * placement and the call contract, never an access-control boundary.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";

let mockScopes: string[] | undefined = ["vrg"];

const mockReadIntakePolicy = jest.fn();
const mockSetIntakePolicy = jest.fn();
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "intake") return { readIntakePolicy: mockReadIntakePolicy, setIntakePolicy: mockSetIntakePolicy };
	if (name === "signatureTasksEngine") return { getRequestedSignatures: jest.fn(async () => []) };
	return null;
});
const mockSignerFn = jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "u" }));

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key + "|" + Object.entries(options).map(([k, v]) => k + "=" + String(v)).join(",")
				: key,
	}),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: new Proxy({}, { get: (_t, p) => "sentinel-" + String(p) }),
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), setParams: jest.fn() }),
	useRoute: () => ({ params: { authorityId: "auth-1" } }),
	useFocusEffect: () => undefined,
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => mockSignerFn),
}));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: mockScopes, loading: false }),
}));
jest.mock("../components/ReassociationQueueSection", () => ({
	ReassociationQueueSection: () => null,
}));

function policy(mode: "manual" | "automatic" = "manual") {
	return { authorityId: "auth-1", revision: 3, restBridgeUrl: null, reassociationMode: mode, setAt: null, isDefault: true };
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const mod = require("../RegistrationInboxScreen");
	const Screen = mod.default ?? mod.RegistrationInboxScreen;
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<Screen />);
	});
	await act(async () => {
		for (let i = 0; i < 12; i++) await Promise.resolve();
	});
	return tr;
}

function textOf(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOf(c as renderer.ReactTestInstance))).join("");
}

beforeEach(() => {
	jest.clearAllMocks();
	mockScopes = ["vrg"];
	mockReadIntakePolicy.mockResolvedValue(policy());
	mockSetIntakePolicy.mockImplementation(async (a: any) => policy(a.reassociationMode));
});

describe("RegistrationInboxScreen — device-change review setting (D-46 ruling)", () => {
	test("B1: the section sits directly above the queue, with the authority-wide line and the toggle", async () => {
		const tr = await renderScreen();
		const section = tr.root.findByProps({ testID: "registration-inbox-reassociation-review" });
		expect(textOf(section)).toContain("reassociationReviewAuthorityWide");
		expect(section.findAllByProps({ testID: "reassociation-review-toggle" }).length).toBeGreaterThan(0);
		const queue = tr.root.findByProps({ testID: "registration-inbox-reassociation-queue" });
		const siblings = (section.parent as renderer.ReactTestInstance).children as renderer.ReactTestInstance[];
		const sIdx = siblings.indexOf(section);
		expect(siblings[sIdx + 1]).toBe(queue);
	});

	test("B1: with 'vrg', choosing automatic performs the unchanged signed write", async () => {
		const tr = await renderScreen();
		const radio = tr.root.findByProps({ testID: "reassociation-review-toggle-automatic" });
		expect(radio.props.accessibilityState.disabled).toBe(false);
		await act(async () => {
			radio.props.onPress();
		});
		await act(async () => {
			for (let i = 0; i < 8; i++) await Promise.resolve();
		});
		expect(mockSetIntakePolicy).toHaveBeenCalledTimes(1);
		expect(mockSetIntakePolicy.mock.calls[0]![0]).toEqual({
			authorityId: "auth-1",
			reassociationMode: "automatic",
			expectedRevision: 3,
		});
	});

	test("B1: without 'vrg' the radios are disabled and nothing is written", async () => {
		mockScopes = ["mel"];
		const tr = await renderScreen();
		const radio = tr.root.findByProps({ testID: "reassociation-review-toggle-automatic" });
		expect(radio.props.accessibilityState.disabled).toBe(true);
		await act(async () => {
			radio.props.onPress?.();
		});
		// WR-R6-07: the write path awaits getEngine("intake") and createDeviceSigner before
		// setIntakePolicy; give a regression the same flush the positive case needs before asserting.
		await act(async () => {
			for (let i = 0; i < 8; i++) await Promise.resolve();
		});
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { createDeviceSigner } = require("../../../engines/device-signer");
		expect(mockSetIntakePolicy).not.toHaveBeenCalled();
		expect(createDeviceSigner).not.toHaveBeenCalled();
	});
});
