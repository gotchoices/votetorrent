/**
 * O-01 (A3): Enable Encrypted Intake on a device whose key is superseded by the officer's other
 * device shows the specific translated message, never the generic failure or developer English.
 */
import React from "react";
import renderer from "react-test-renderer";

jest.setTimeout(30_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
const mockRoute = { params: { authorityId: "auth-1" } };
const mockColors = new Proxy({}, { get: () => "#000" });
const mockTheme = { colors: mockColors };
jest.mock("@react-navigation/native", () => ({
	useTheme: () => mockTheme,
	useRoute: () => mockRoute,
}));
const mockT = { t: (key: string) => key };
jest.mock("react-i18next", () => ({ useTranslation: () => mockT }));
const mockScopes = { scopes: ["vrg"], loading: false };
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => mockScopes,
}));
const mockGetEngine = jest.fn(async () => ({}));
const mockResolveDeviceSigner = jest.fn(async () => async () => ({}));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, resolveDeviceSigner: mockResolveDeviceSigner }),
}));

const mockEnable = jest.fn<Promise<string>, []>();
jest.mock("../officer-intake-key", () => ({
	readOfficerIntakeKeyState: async () => "not-enabled",
	enableOfficerEncryptedIntake: () => mockEnable(),
	isIntakeKeySupersededError: (e: unknown) => (e as { code?: string } | null)?.code === "intake-key-superseded",
}));
const mockHandler = () => ({ handled: false, message: undefined });
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandler,
}));
jest.mock("../registration-bridge-config", () => ({
	isSaveableBridgeUrl: () => true,
	readRegistrationBridgeConfig: async () => ({ savedUrl: "https://bridge.example/intake", revision: 1 }),
	saveRegistrationBridgeUrl: async () => ({ outcome: "saved" }),
}));
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: async () => async () => ({}) }));
jest.mock("../../../engines/device-user", () => ({ getOrCreateDeviceUser: async () => ({ id: "u1", name: "n", activeKeys: [] }) }));

async function flush(): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < 6; i++) await Promise.resolve();
	});
}

describe("BulkImportSyncScreen superseded intake key (A3)", () => {
	it("renders officerIntakeKeySupersededBody and never the developer string", async () => {
		mockEnable.mockRejectedValueOnce(
			Object.assign(new Error("developer-only english"), { code: "intake-key-superseded" }),
		);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { BulkImportSyncScreen } = require("../BulkImportSyncScreen");
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<BulkImportSyncScreen />);
		});
		await flush();
		const wrapper = tr.root.findByProps({ testID: "officer-intake-key-enable" });
		await renderer.act(async () => {
			wrapper.findAll((n) => typeof n.props.onPress === "function")[0]!.props.onPress();
		});
		await flush();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("officerIntakeKeySupersededBody");
		expect(text).not.toContain("developer-only english");
		expect(text).not.toContain('"officerIntakeKeyError"');
	});
});
