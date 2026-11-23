/**
 * AddNetworkScreen.duplicateGate.test.tsx — 2026-09-09 todo: a retried CREATE (after "could not
 * confirm", or from a fresh screen while the first commit still runs) could mint a second network
 * with the same name and primary authority domain. Preamble copied from the reconciliation suite.
 *
 * Original preamble header (AddNetworkScreen.reconciliation.test.tsx — R1 (58-04) closure coverage):
 *
 * Proves D-01/D-02/D-03: a missed `builder.commit()` deadline never reports failure until
 * `getRecentNetworks()` has been re-read under its own separate deadline; a reconciled landing
 * runs the identical success tail a timely commit would; an unconfirmed outcome says only that —
 * never a failure claim, never a connection claim; a non-timeout rejection keeps its existing
 * routing untouched and reconciliation never runs for it; the reconciliation performs no write and
 * calls no `open()`; `finally` clears `creating` on every exit.
 *
 * Block A (`networkCreateOutcome`, pure) is the module's own coverage and is green immediately.
 * Block B (`AddNetworkScreen` behaviour) is proven RED against the unfixed screen — that is the
 * point (58-VALIDATION Known Blind Spot 4: prove every gate RED before trusting it).
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
// `getDeviceProvisioningRecord` is what the recovery-key gate reads to learn this device's
// recovery key. It must be on the mock: without it the real module's export is simply absent,
// `deviceNeedsRecoveryKeyRegistration` swallows the resulting TypeError, and the gate resolves
// false -- which would silently make the goBack-suppression specs below pass for the wrong
// reason (nothing to route to, rather than routing correctly suppressed).
const mockGetDeviceProvisioningRecord = jest.fn(async () => undefined as unknown);
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
	getDeviceProvisioningRecord: () => mockGetDeviceProvisioningRecord(),
}));

const mockGetDefaultUser = jest.fn(async () => ({ name: "Device User" }));
const mockDefaultUserEngine = { get: mockGetDefaultUser };
// The recovery-key gate resolves getEngine("network") -> getCurrentUser() -> getSummary(); the
// screen itself resolves getEngine("defaultUser"). A single catch-all engine cannot serve both,
// so dispatch on the name the caller actually asked for.
const mockGetSummary = jest.fn(async () => ({ id: "u1", activeKeys: [] as Array<{ key: string }> }));
const mockGetCurrentUser = jest.fn(async () => ({ getSummary: mockGetSummary }) as unknown);
const mockNetworkEngine = { getCurrentUser: () => mockGetCurrentUser() };
const mockGetEngine = jest.fn(async (name?: string) =>
	name === "network" ? mockNetworkEngine : mockDefaultUserEngine,
);
// `open` exists only so a spec can assert it is never called -- the screen must never call it
// (probing an unknown hash via `open()` would mint an empty on-disk store under it).
const mockNetworksEngine = {
	buildCreate: jest.fn(),
	getRecentNetworks: jest.fn(),
	open: jest.fn(),
};
const mockSelectNetwork = jest.fn();
// undefined = a useApp lacking the accessor (the safe default: the screen treats it as "selected").
let mockIsNetworkSelected: (() => boolean) | undefined;
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		networksEngine: mockNetworksEngine,
		selectNetwork: mockSelectNetwork,
		isNetworkSelected: mockIsNetworkSelected,
	}),
}));

import React from "react";
import renderer from "react-test-renderer";
import AddNetworkScreen from "../AddNetworkScreen";
import type { NetworkReference } from "@votetorrent/vote-core";
import {
	RECONCILE_TIMEOUT_MS,
	LATE_COMMIT_BUDGET_MS,
	NETWORK_CREATE_STEP_TIMEOUT,
	createStepTimeoutError,
	timedOutStep,
	findLandedNetwork,
	findDuplicateNetwork,
	isNetworkCreateInFlight,
	markNetworkCreateInFlight,
	networkCreateKey,
	resetNetworkCreatesInFlightForTests,
} from "../networkCreateOutcome";

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


// A known-valid relay from the shared fixture corpus, so the relay check passes for real.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VALID_RELAY: string = (
	require("../../../../__fixtures__/relay-address-fixtures.json") as {
		fixtures: Array<{ address: string; expected: "valid" | "invalid" }>;
	}
).fixtures.find((f) => f.expected === "valid")!.address;

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

/** Drives the screen to a signed, CREATE-pressed state so handleCreate's try body runs, and
 * awaits the returned promise fully. Use only for specs that do not need to drive a real timer. */
async function pressSignThenCreate(tr: renderer.ReactTestRenderer) {
	await fillRequiredFields(tr, { relay: VALID_RELAY });
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
}

/** Signs the screen and presses CREATE WITHOUT awaiting the result, returning the in-flight
 * promise so the caller can advance fake timers before it settles.
 *
 * Returns `{ promise }` rather than the promise itself: an `async function` that directly
 * `return`s a thenable has its OWN returned promise transparently chained to it (the engine
 * awaits the returned value before settling the outer promise) -- so `return createPromise;`
 * here would silently make every caller's `await signAndPressCreateWithoutAwaiting(tr)` block
 * until `handleCreate` itself resolves, which is exactly the still-pending promise this helper
 * exists to hand back UNresolved. Wrapping it in an object sidesteps the flattening. */
async function signAndPressCreateWithoutAwaiting(
	tr: renderer.ReactTestRenderer,
): Promise<{ promise: Promise<unknown> }> {
	await fillRequiredFields(tr, { relay: VALID_RELAY });
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	let createPromise!: Promise<unknown>;
	await renderer.act(async () => {
		createPromise = getCreateButton(tr).props.onPress() as Promise<unknown>;
	});
	return { promise: createPromise };
}

const SIGNING_KEY = "03f450ccccbaefd2efe218d8eb8c2f84677aaed1fa7bc19b9dbcac96e6ef7d86ab";
const RECOVERY_KEY = "036d541206f2fb5d6c67e0a39b615eebf8ada784a8b12dcab550c901305b6fcf3a";

/** Specs fill networkName with FILLED_NAME (see fillRequiredFields) and leave domainName "", so
 * every "landed" NetworkReference fixture used to drive `findLandedNetwork`'s match must carry
 * name: FILLED_NAME / primaryAuthorityDomainName: "" to be recognized as landed by the real code path. */
const BEFORE: NetworkReference[] = [
	{ hash: "existing-hash", name: "Old Net", primaryAuthorityDomainName: "old.example", relays: [] },
];
const LANDED_REF: NetworkReference = {
	hash: "landed-hash",
	name: "Test Net",
	primaryAuthorityDomainName: "",
	relays: [],
};

type CommitBehavior =
	| { kind: "resolve"; ref: NetworkReference }
	| { kind: "reject"; error: Error }
	| { kind: "pending" }
	| { kind: "deferred" };

/** Controls for the "deferred" commit: settles only when the spec says so. */
let deferredCommit: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | undefined;

function armCreate(behavior: CommitBehavior) {
	mockGetOrCreateDeviceUser.mockResolvedValue({
		id: "u1",
		name: "Device User",
		activeKeys: [{ key: SIGNING_KEY, type: "P", expiration: Date.now() + 1000 }],
	});
	mockNetworksEngine.buildCreate.mockReturnValue({
		update: () => ({
			isValid: () => true,
			errors: () => [],
			commit: () => {
				if (behavior.kind === "resolve") return Promise.resolve({ init: behavior.ref });
				if (behavior.kind === "reject") return Promise.reject(behavior.error);
				if (behavior.kind === "deferred") {
					return new Promise((resolve, reject) => {
						deferredCommit = { resolve, reject };
					});
				}
				return new Promise(() => {
					/* never settles */
				});
			},
		}),
	});
}

// Referenced so the copied preamble's imports stay used.
void [RECONCILE_TIMEOUT_MS, LATE_COMMIT_BUDGET_MS, NETWORK_CREATE_STEP_TIMEOUT, createStepTimeoutError, timedOutStep, findLandedNetwork, RECOVERY_KEY];

const SAME_NETWORK: NetworkReference = { hash: "first-hash", name: "Test Net", primaryAuthorityDomainName: "", relays: [] };

beforeEach(() => {
	jest.clearAllMocks();
	resetNetworkCreatesInFlightForTests();
	mockIsNetworkSelected = () => true;
	mockSelectNetwork.mockResolvedValue(undefined);
	jest.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
	jest.useRealTimers();
	jest.restoreAllMocks();
});

async function pressCreate(tr: renderer.ReactTestRenderer) {
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
}

describe("duplicate-create gate (pure)", () => {
	it("networkCreateKey trims the name and ignores domain case", () => {
		expect(networkCreateKey(" Net ", "A.Example")).toBe(networkCreateKey("Net", "a.example"));
		expect(networkCreateKey("Net", "a.example")).not.toBe(networkCreateKey("Net 2", "a.example"));
		expect(networkCreateKey("Net", "a.example")).not.toBe(networkCreateKey("Net", "b.example"));
	});

	it("findDuplicateNetwork matches name + domain only", () => {
		const recents = [{ hash: "h", name: "Net", primaryAuthorityDomainName: "A.example", relays: [] }];
		expect(findDuplicateNetwork(recents, { name: "Net", primaryAuthorityDomainName: "a.example" })?.hash).toBe("h");
		expect(findDuplicateNetwork(recents, { name: "Net", primaryAuthorityDomainName: "b.example" })).toBeUndefined();
		expect(findDuplicateNetwork(undefined, { name: "Net", primaryAuthorityDomainName: "a.example" })).toBeUndefined();
	});

	it("in-flight marks are counted and released once", () => {
		const key = networkCreateKey("Net", "");
		const r1 = markNetworkCreateInFlight(key);
		const r2 = markNetworkCreateInFlight(key);
		r1();
		r1();
		expect(isNetworkCreateInFlight(key)).toBe(true);
		r2();
		expect(isNetworkCreateInFlight(key)).toBe(false);
	});
});

describe("AddNetworkScreen duplicate-create gate", () => {
	it("a network with the same name and domain already in recents: the first CREATE warns and never commits; the second commits", async () => {
		armCreate({ kind: "resolve", ref: LANDED_REF });
		const commitSpy = jest.fn(() => Promise.resolve({ init: { ...LANDED_REF, hash: "second-hash" } }));
		mockNetworksEngine.buildCreate.mockReturnValue({
			update: () => ({ isValid: () => true, errors: () => [], commit: commitSpy }),
		});
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([SAME_NETWORK]);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);
		expect(commitSpy).not.toHaveBeenCalled();
		expect(inlineErrorMessage(tr)).toBe("networkCreateDuplicateConfirm");
		expect(mockSelectNetwork).not.toHaveBeenCalled();

		await pressCreate(tr);
		expect(commitSpy).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
	});

	it("a different name is not a duplicate: one CREATE commits", async () => {
		armCreate({ kind: "resolve", ref: LANDED_REF });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([{ ...SAME_NETWORK, name: "Other Net" }]);
		const tr = await renderScreen();
		await pressSignThenCreate(tr);
		expect(inlineErrorMessage(tr)).not.toBe("networkCreateDuplicateConfirm");
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
	});

	it("a create of the same network whose commit is still running is refused, even from a fresh screen", async () => {
		armCreate({ kind: "deferred" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([]);
		const first = await renderScreen();
		// Leave the first create running (its commit has not settled), then leave the screen.
		await signAndPressCreateWithoutAwaiting(first);
		await renderer.act(async () => {
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(isNetworkCreateInFlight(networkCreateKey("Test Net", ""))).toBe(true);
		await renderer.act(async () => {
			first.unmount();
		});

		const commitSpy = jest.fn(() => Promise.resolve({ init: LANDED_REF }));
		mockNetworksEngine.buildCreate.mockReturnValue({
			update: () => ({ isValid: () => true, errors: () => [], commit: commitSpy }),
		});
		const second = await renderScreen();
		await pressSignThenCreate(second);
		expect(commitSpy).not.toHaveBeenCalled();
		expect(inlineErrorMessage(second)).toBe("networkCreateDuplicateInFlight");

		// Settle the first commit: the mark clears and nothing is left running.
		await renderer.act(async () => {
			deferredCommit!.reject(new Error("first create failed"));
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(isNetworkCreateInFlight(networkCreateKey("Test Net", ""))).toBe(false);
	});

	it("the in-flight mark clears when the commit settles, so a failed create can be retried", async () => {
		armCreate({ kind: "reject", error: new Error("boom") });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue([]);
		const tr = await renderScreen();
		await pressSignThenCreate(tr);
		expect(inlineErrorMessage(tr)).toBe("networkCreateFailed");
		expect(isNetworkCreateInFlight(networkCreateKey("Test Net", ""))).toBe(false);
	});
});
