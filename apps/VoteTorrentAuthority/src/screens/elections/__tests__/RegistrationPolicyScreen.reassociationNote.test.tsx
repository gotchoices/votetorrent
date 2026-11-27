/**
 * RegistrationPolicyScreen.reassociationNote.test.tsx — the election's Registration Policy screen
 * no longer edits the per-authority device-change review setting (D-46 user ruling 2026-10-07):
 * it shows a read-only note. Engines are stubs; the assertions prove placement and the absence of
 * any write.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";

const mockNavigate = jest.fn();
const mockReadIntakePolicy = jest.fn();
const mockSetIntakePolicy = jest.fn();
const mockElectionEngine = {
	getBallots: jest.fn(async () => []),
	getBallotDetails: jest.fn(async () => ({ ballot: { districts: [] } })),
	getElectionDetails: jest.fn(async () => ({ election: {}, current: { timeline: { registrationEnds: 0 } } })),
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require("../../../../../../packages/vote-engine/dist/registration/mock-registration-engine");
const mockRegistrationEngine = new MockRegistrationEngine();
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "intake") return { readIntakePolicy: mockReadIntakePolicy, setIntakePolicy: mockSetIntakePolicy };
	return null;
});

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key + "|" + Object.entries(options).map(([k, v]) => k + "=" + String(v)).join(",")
				: key,
	}),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: new Proxy({}, { get: (_t, p) => "sentinel-" + String(p) }) }),
	useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: jest.fn(), setParams: jest.fn() }),
	useRoute: () => ({ params: { electionEngine: mockElectionEngine, electionId: "e-1", authorityId: "auth-1" } }),
	useFocusEffect: () => undefined,
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({ signature: "s", signerKey: "k", signerUserId: "u" })),
}));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: ["vrg", "mel"], loading: false }),
}));

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const mod = require("../RegistrationPolicyScreen");
	const Screen = mod.default ?? mod.RegistrationPolicyScreen;
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<Screen />);
	});
	await act(async () => {
		for (let i = 0; i < 12; i++) await Promise.resolve();
	});
	return tr;
}

beforeEach(() => {
	mockNavigate.mockReset();
	mockReadIntakePolicy.mockReset();
	mockSetIntakePolicy.mockReset();
	mockReadIntakePolicy.mockResolvedValue({
		authorityId: "auth-1",
		revision: 1,
		restBridgeUrl: null,
		reassociationMode: "automatic",
		setAt: null,
		isDefault: false,
	});
});

describe("RegistrationPolicyScreen — device-change review note (D-46 ruling)", () => {
	test("B2: the reassociation section holds the read-only note and no toggle", async () => {
		const tr = await renderScreen();
		const section = tr.root.findByProps({ testID: "registration-policy-reassociation-section" });
		expect(section.findAllByProps({ testID: "reassociation-review-note" }).length).toBeGreaterThan(0);
		const toggles = tr.root.findAll(
			(n) => typeof n.props.testID === "string" && n.props.testID.startsWith("reassociation-review-toggle"),
		);
		expect(toggles).toHaveLength(0);
	});

	test("B2: the note's button opens Registration Requests for this authority; nothing is written", async () => {
		const tr = await renderScreen();
		const btn = tr.root.findAllByProps({ testID: "reassociation-review-note-open" })[0]!;
		await act(async () => {
			btn.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("RegistrationInbox", { authorityId: "auth-1" });
		expect(mockSetIntakePolicy).not.toHaveBeenCalled();
	});
});
