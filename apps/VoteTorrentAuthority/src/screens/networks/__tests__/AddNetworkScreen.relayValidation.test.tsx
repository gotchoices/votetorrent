/**
 * AddNetworkScreen.relayValidation.test.tsx — R4 (D-11) closure coverage.
 *
 * This suite runs under `jest.config.js`'s `moduleNameMapper` redirect to
 * `__mocks__/@multiformats/multiaddr.js`. It therefore covers the SCREEN's error-surfacing
 * WIRING ONLY — it makes NO claim about multiaddr grammar (does the real parser accept or reject
 * a given address). Grammar/validity claims are owned exclusively by
 * `scripts/assert-relay-multiaddr-fixtures.mjs`, which runs the REAL
 * `@multiformats/multiaddr@13.0.3` parser under plain Node and proves the mock could not have
 * produced its green (D-15).
 *
 * The one invalid address used below (`not-a-multiaddr`) is drawn from the shared fixture corpus
 * because it is the ONLY fixture both the real parser and this jest stub reject — see that gate's
 * "wiring-safe" output. Bare `/` must NEVER be used as an "invalid" fixture anywhere in this repo:
 * the real parser ACCEPTS it while the jest stub REJECTS it (a reverse asymmetry), so a test using
 * it would go green under jest for exactly the wrong reason. It is deliberately absent from the
 * fixture corpus for this reason.
 */

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
const WIRING_SAFE_INVALID_ADDRESS = (() => {
	const found = fixtures.find((f) => f.expected === "invalid" && f.address === "not-a-multiaddr");
	if (!found) throw new Error('fixture corpus is missing the wiring-safe "not-a-multiaddr" entry');
	return found.address;
})();

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

function armSuccessfulCreate() {
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
			isValid: () => true,
			errors: () => [],
			commit: async () => ({ init: { hash: "net-hash", name: "", primaryAuthorityDomainName: "", relays: [] } }),
		}),
	});
}

/**
 * Mirrors the REAL builder's `networkInit.relays` validation: invalid (and only invalid) when the
 * relays array actually assembled into `networkInit` is empty. This is deliberately
 * content-aware (reads the `networkInit` passed to `.update()`) rather than always-rejecting, so
 * Tests 3/4 discriminate between "an empty array reached the builder" and "a non-empty array
 * reached it" -- an always-invalid stub would make Test 4 pass trivially both before and after
 * `handleCreate` is wired, the same weak-gate class documented for Test 6 above.
 */
function armRelayAwareBuilder() {
	mockNetworksEngine.buildCreate.mockReturnValue({
		update: (args: { networkInit: { relays: string[] } }) => {
			const relaysEmpty = args.networkInit.relays.length === 0;
			return {
				isValid: () => !relaysEmpty,
				errors: () =>
					relaysEmpty
						? [{ path: "networkInit.relays", message: "networkInit.relays must not be empty" }]
						: [],
				commit: async () => {
					throw new Error("commit should not be called in this spec — relays was non-empty unexpectedly");
				},
			};
		},
	});
}

describe("AddNetworkScreen relay validation (D-11) — WIRING coverage only, mock-backed (see file header, D-15)", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([]);
	});

	it("Test 1: an invalid relay address produces errRelayInvalid and the relay field stays reachable", async () => {
		const tr = await renderScreen();
		await setRelayAddress(tr, WIRING_SAFE_INVALID_ADDRESS);

		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).toBe("errRelayInvalid");
		// Relays are always shown now (no Advanced toggle): the relay input is still findable.
		expect(getRelayInput(tr)).toBeDefined();
	});

	it("Test 2: a valid relay address does not produce errRelayInvalid and proceeds into the engine path", async () => {
		armSuccessfulCreate();
		const tr = await renderScreen();
		await setRelayAddress(tr, VALID_ADDRESS);

		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).not.toBe("errRelayInvalid");
		expect(mockNetworksEngine.buildCreate).toHaveBeenCalledTimes(1);
	});

	it("Test 3: an empty relay field does not produce errRelayInvalid — errRelayRequired still owns the empty case", async () => {
		armRelayAwareBuilder();
		const tr = await renderScreen();

		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).not.toBe("errRelayInvalid");
		expect(inlineErrorMessage(tr)).toBe("errRelayRequired");
	});

	it("Test 4: a whitespace-only relay behaves as Test 3, not as Test 1 (normalized away, not invalid)", async () => {
		armRelayAwareBuilder();
		const tr = await renderScreen();
		await setRelayAddress(tr, "   ");

		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).not.toBe("errRelayInvalid");
		expect(inlineErrorMessage(tr)).toBe("errRelayRequired");
	});

	it("Test 5: validation runs BEFORE device identity resolution — getOrCreateDeviceUser and buildCreate are never called for an invalid relay", async () => {
		const tr = await renderScreen();
		await setRelayAddress(tr, WIRING_SAFE_INVALID_ADDRESS);

		await pressSignThenCreate(tr);

		expect(mockGetOrCreateDeviceUser).not.toHaveBeenCalled();
		expect(mockNetworksEngine.buildCreate).not.toHaveBeenCalled();
	});

	it("Test 6: the in-flight flag is cleared on the invalid-relay early return — CREATE re-enables", async () => {
		const tr = await renderScreen();
		await setRelayAddress(tr, WIRING_SAFE_INVALID_ADDRESS);

		await pressSignThenCreate(tr);

		// Precondition: tie the button-state assertion to relay validation actually having run —
		// without this, the button also re-enables on the unfixed screen via an UNRELATED crash
		// (buildCreate().update() on an unarmed mock), which would pass this spec for the wrong
		// reason.
		expect(inlineErrorMessage(tr)).toBe("errRelayInvalid");
		const createButton = getCreateButton(tr);
		expect(createButton.props.title).toBe("create");
		expect(createButton.props.disabled).toBe(false);
	});
});
