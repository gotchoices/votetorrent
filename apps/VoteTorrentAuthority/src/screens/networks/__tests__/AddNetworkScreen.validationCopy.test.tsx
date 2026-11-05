/** AddNetworkScreen.validationCopy.test.tsx: builder validation failures show translated copy (wiring only, mock-backed). */


jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

const mockGetOrCreateDeviceUser = jest.fn();
const mockGetDeviceProvisioningRecord = jest.fn(async () => undefined as unknown);
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
	getDeviceProvisioningRecord: () => mockGetDeviceProvisioningRecord(),
}));

const mockGetDefaultUser = jest.fn(async () => ({ name: "Device User" }));
const mockDefaultUserEngine = { get: mockGetDefaultUser };
const mockGetSummary = jest.fn(async () => ({ id: "u1", activeKeys: [] as Array<{ key: string }> }));
const mockGetCurrentUser = jest.fn(async () => ({ getSummary: mockGetSummary }) as unknown);
const mockNetworkEngine = { getCurrentUser: () => mockGetCurrentUser() };
const mockGetEngine = jest.fn(async (name?: string) =>
	name === "network" ? mockNetworkEngine : mockDefaultUserEngine,
);
const mockNetworksEngine = {
	buildCreate: jest.fn(),
	getRecentNetworks: jest.fn(async () => [] as unknown[]),
	open: jest.fn(),
};
const mockSelectNetwork = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		networksEngine: mockNetworksEngine,
		selectNetwork: mockSelectNetwork,
	}),
}));

import { readFileSync } from "fs";
import path from "path";
import React from "react";
import renderer from "react-test-renderer";
import AddNetworkScreen from "../AddNetworkScreen";

const fixturesPath = path.join(__dirname, "../../../../__fixtures__/relay-address-fixtures.json");
const { fixtures } = JSON.parse(readFileSync(fixturesPath, "utf8")) as {
	fixtures: Array<{ address: string; expected: "valid" | "invalid" }>;
};

/** The only fixture rejected by BOTH the real parser and this jest stub (D-15 wiring-safe). */
/** A fixture expected valid under both parsers, for the not-invalid path. */
const VALID_ADDRESS = (() => {
	const found = fixtures.find((f) => f.expected === "valid");
	if (!found) throw new Error("fixture corpus is missing a valid entry");
	return found.address;
})();

function findByProps(
	tr: renderer.ReactTestRenderer,
	predicate: (props: Record<string, unknown>) => boolean,
) {
	return tr.root.findAll((n) => {
		try {
			return predicate(n.props as Record<string, unknown>);
		} catch {
			return false;
		}
	});
}

async function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AddNetworkScreen />);
	});
	return tr;
}

function getSignButton(tr: renderer.ReactTestRenderer) {
	return findByProps(tr, (p) => p.title === "sign" && typeof p.onPress === "function")[0];
}

function getCreateButton(tr: renderer.ReactTestRenderer) {
	return findByProps(
		tr,
		(p) => (p.title === "create" || p.title === "creating") && typeof p.onPress === "function",
	)[0];
}

function inlineErrorMessage(tr: renderer.ReactTestRenderer): string {
	const matches = findByProps(tr, (p) => "message" in p);
	return (matches[0]?.props as { message?: string } | undefined)?.message ?? "";
}

function getRelayInput(tr: renderer.ReactTestRenderer) {
	return findByProps(tr, (p) => p.placeholder === "multiaddress")[0];
}

/** Sets the (single, index-0) relay field's text via its onChangeText prop. */
async function setRelayAddress(tr: renderer.ReactTestRenderer, value: string) {
	await renderer.act(async () => {
		getRelayInput(tr)?.props.onChangeText(value);
	});
}

/** CREATE now checks every required field up front (network/authority/admin name, title, a relay,
 * the signature) before any engine or biometric work. Fill them so specs exercise the path they
 * are about rather than that check. `relay` is omitted by specs that test the empty-relay case. */
const FILLED_NAME = "Test Net";
async function fillRequiredFields(tr: renderer.ReactTestRenderer, opts: { relay?: string } = {}) {
	await renderer.act(async () => {
		for (const n of findByProps(tr, (p) => p.title === "name" && typeof p.onChangeText === "function")) {
			(n.props as { onChangeText: (v: string) => void }).onChangeText(FILLED_NAME);
		}
		for (const n of findByProps(tr, (p) => p.title === "title" && typeof p.onChangeText === "function")) {
			(n.props as { onChangeText: (v: string) => void }).onChangeText("Clerk");
		}
		if (opts.relay !== undefined) {
			for (const n of findByProps(tr, (p) => p.placeholder === "multiaddress" && typeof p.onChangeText === "function")) {
				(n.props as { onChangeText: (v: string) => void }).onChangeText(opts.relay);
			}
		}
	});
}

async function pressSignThenCreate(tr: renderer.ReactTestRenderer) {
	// Relay left as each spec set it (these specs are ABOUT the relay field).
	await fillRequiredFields(tr);
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
}

function armBuilder(errors: Array<{ path: string; code: string; message: string }>) {
	mockGetOrCreateDeviceUser.mockResolvedValue({
		id: "u1",
		name: "Device User",
		activeKeys: [
			{
				key: "03f450ccccbaefd2efe218d8eb8c2f84677aaed1fa7bc19b9dbcac96e6ef7d86ab",
				type: "P",
				expiration: Date.now() + 1000,
			},
		],
	});
	mockNetworksEngine.buildCreate.mockReturnValue({
		update: () => ({
			isValid: () => false,
			errors: () => errors,
			commit: async () => {
				throw new Error("commit must not run on a rejected builder");
			},
		}),
	});
}

async function createWithBuilderErrors(errors: Array<{ path: string; code: string; message: string }>) {
	armBuilder(errors);
	const tr = await renderScreen();
	await fillRequiredFields(tr, { relay: VALID_ADDRESS });
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
	return tr;
}

describe("AddNetworkScreen builder validation copy", () => {
	let errSpy: jest.SpyInstance;
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([]);
		errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => errSpy.mockRestore());

	it("V-3: a rejected field shows translated copy and no builder text", async () => {
		const tr = await createWithBuilderErrors([
			{ path: "networkInit.name", code: "MISSING", message: "networkInit.name must not be empty" },
		]);
		const msg = inlineErrorMessage(tr);
		expect(msg).toBe("validationRequired");
		expect(msg).not.toContain("networkInit");
	});

	it("V-3: the relays error still shows errRelayRequired", async () => {
		const tr = await createWithBuilderErrors([
			{ path: "networkInit.relays", code: "EMPTY", message: "networkInit.relays must not be empty" },
		]);
		expect(inlineErrorMessage(tr)).toBe("errRelayRequired");
	});

	it("V-3: the validation log carries codes only", async () => {
		await createWithBuilderErrors([
			{ path: "networkInit.name", code: "MISSING", message: "networkInit.name must not be empty" },
		]);
		const logged = JSON.stringify(errSpy.mock.calls);
		expect(logged).toContain("MISSING");
		expect(logged).not.toContain("must not be empty");
		expect(logged).not.toContain("networkInit.name");
	});
});
