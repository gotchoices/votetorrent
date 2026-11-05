/**
 * AddNetworkScreen.reconciliation.test.tsx — R1 (58-04) closure coverage.
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

describe("networkCreateOutcome (pure, no timers, no render)", () => {
	describe("timedOutStep", () => {
		it("returns the step for an error from createStepTimeoutError", () => {
			const err = createStepTimeoutError("commit", "did not finish in time");
			expect(timedOutStep(err)).toBe("commit");
		});

		it("preserves the message verbatim", () => {
			const err = createStepTimeoutError("select", "the select step message");
			expect((err as Error).message).toBe("the select step message");
		});

		it("returns undefined for a plain Error", () => {
			expect(timedOutStep(new Error("boom"))).toBeUndefined();
		});

		it("returns undefined for null", () => {
			expect(timedOutStep(null)).toBeUndefined();
		});

		it("returns undefined for a bare string", () => {
			expect(timedOutStep("boom")).toBeUndefined();
		});

		it("returns undefined for an object whose marker property is not a string", () => {
			expect(timedOutStep({ [NETWORK_CREATE_STEP_TIMEOUT]: 42 })).toBeUndefined();
		});
	});

	describe("findLandedNetwork", () => {
		const expected = { name: "New Net", primaryAuthorityDomainName: "new.example" };
		const before: NetworkReference[] = [
			{ hash: "h1", name: "Other Net", primaryAuthorityDomainName: "other.example", relays: [] },
		];

		it("returns the new matching entry", () => {
			const landed: NetworkReference = {
				hash: "h2",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const after = [...before, landed];
			expect(findLandedNetwork(before, after, expected)).toEqual(landed);
		});

		it("returns undefined when after equals before", () => {
			expect(findLandedNetwork(before, before, expected)).toBeUndefined();
		});

		it("returns undefined when the only new entry differs in name", () => {
			const after = [
				...before,
				{ hash: "h2", name: "Wrong Name", primaryAuthorityDomainName: "new.example", relays: [] },
			];
			expect(findLandedNetwork(before, after, expected)).toBeUndefined();
		});

		it("returns undefined when the only new entry differs in primaryAuthorityDomainName", () => {
			const after = [
				...before,
				{ hash: "h2", name: "New Net", primaryAuthorityDomainName: "wrong.example", relays: [] },
			];
			expect(findLandedNetwork(before, after, expected)).toBeUndefined();
		});

		it("returns the LAST match when two new matching entries appear", () => {
			const first: NetworkReference = {
				hash: "h2",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const second: NetworkReference = {
				hash: "h3",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const after = [...before, first, second];
			expect(findLandedNetwork(before, after, expected)).toEqual(second);
		});

		it("returns undefined for non-array inputs", () => {
			expect(
				findLandedNetwork(undefined as unknown as NetworkReference[], before, expected),
			).toBeUndefined();
			expect(
				findLandedNetwork(before, undefined as unknown as NetworkReference[], expected),
			).toBeUndefined();
		});
	});
});

describe("AddNetworkScreen — R1: reconcile before reporting a missed commit deadline", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockGetDeviceProvisioningRecord.mockResolvedValue(undefined);
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [] });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("(1, D-02) commit never settles; the deadline fires; the recents re-read shows a new matching entry -> the normal success tail runs", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(LANDED_REF);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(inlineErrorMessage(tr)).toBe("");
	});

	it("(2, D-02 load-bearing return) same landing, but the recovery-key gate fires -> navigates and does NOT goBack", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);
		// The provisioning record holds the recovery key; getSummary shows only the signing key,
		// so the gate fires (measured on real hardware, see AddNetworkScreen.tsx 49-19).
		mockGetDeviceProvisioningRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY_KEY,
		});
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("(3, D-01/D-03) deadline fires; the re-read returns the unchanged list -> reports networkCreateUnconfirmed, no select, no goBack", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
		});
		// Still inside the late-commit budget: neutral status, never the unconfirmed copy.
		expect(inlineErrorMessage(tr)).toBe("");
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(LATE_COMMIT_BUDGET_MS);
			await createPromise;
		});

		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("(4, D-01 own deadline) waits genuinely on the re-read, then reports unconfirmed only after its OWN RECONCILE_TIMEOUT_MS elapses", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE).mockReturnValueOnce(
			new Promise(() => {
				/* the reconcile re-read never settles */
			}),
		);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		// Advance exactly past the commit deadline -- the screen must still be waiting on the
		// re-read, not already giving up. This is the paired control for the second half below.
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(45_001);
		});
		expect(inlineErrorMessage(tr)).toBe("");

		// The reconcile timer is scheduled in a microtask that runs after the first
		// advanceTimersByTimeAsync resolves, so it needs a second, separate advance.
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS + 1);
		});
		// The reconcile miss no longer ends the create: the late-commit wait begins.
		expect(inlineErrorMessage(tr)).toBe("");
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(LATE_COMMIT_BUDGET_MS);
			await createPromise;
		});

		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
	});

	it("(5, finally on every path) after the unconfirmed outcome, the CREATE button re-enables", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
		});
		// Still inside the late-commit budget: neutral status, never the unconfirmed copy.
		expect(inlineErrorMessage(tr)).toBe("");
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(LATE_COMMIT_BUDGET_MS);
			await createPromise;
		});

		// The precondition this spec's re-enable check is conditioned on: without it, `finally`
		// clearing `creating` is pre-existing behaviour untouched by this plan and would pass
		// trivially against the unfixed screen too (58-VALIDATION Known Blind Spot 4).
		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
		const createButton = getCreateButton(tr);
		expect(createButton.props.title).toBe("create");
		expect(createButton.props.disabled).toBe(false);
	});

	it("(6, non-timeout passthrough) a NO_KEY_PROVISIONED commit() rejection keeps its existing routing; reconciliation never runs", async () => {
		const rejection = Object.assign(new Error("no device signing key provisioned"), {
			code: "NO_KEY_PROVISIONED",
		});
		armCreate({ kind: "reject", error: rejection });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(inlineErrorMessage(tr)).toBe("");
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
	});

	it("(7, non-timeout passthrough) a plain Error rejection shows the translated create-failure copy, never its text; reconciliation never runs", async () => {
		armCreate({ kind: "reject", error: new Error("boom") });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).toBe("networkCreateFailed");
		expect(JSON.stringify(tr.toJSON())).not.toContain("boom");
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
	});

	it("(8, read-only guarantee) on the landed path, open() is never called and getRecentNetworks is called exactly twice", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockNetworksEngine.open).not.toHaveBeenCalled();
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(2);
	});

	it("(9, happy path unchanged) commit() resolves promptly -> one snapshot read, select with the commit's own ref, goBack", async () => {
		const ref: NetworkReference = {
			hash: "net-hash",
			name: "",
			primaryAuthorityDomainName: "",
			relays: [],
		};
		armCreate({ kind: "resolve", ref });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(ref);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	/** Resource guard for `withTimeout`. The helper races a promise against a `setTimeout`; if the
	 * losing timer is never cleared it stays armed for the full CREATE_TIMEOUT_MS holding its closure,
	 * and handleCreate races several steps per create. Nothing behavioural catches that -- rejecting
	 * an already-settled race is a no-op -- so the only symptom is jest reporting "did not exit",
	 * which does not fail a run.
	 *
	 * Identifies withTimeout's timers BY DELAY rather than by counting all pending timers: this path
	 * legitimately arms unrelated background timers (measured: 5), so a raw `getTimerCount()`
	 * assertion would either be brittle against unrelated internals or silently drift. Only
	 * withTimeout arms a 45s timer here, which makes the delay a precise selector.
	 *
	 * Proven load-bearing: with the `clearTimeout` removed, the happy path leaks exactly 3 armed
	 * 45s timers (one each for the snapshot, commit and select steps) and this spec fails. */
	it("(10, resource guard) every withTimeout race clears its losing timer -- no 45s timer stays armed after a settled create", async () => {
		jest.useFakeTimers();
		// Mirrors CREATE_TIMEOUT_MS in AddNetworkScreen.tsx, which is module-local and not exported.
		const CREATE_TIMEOUT_MS = 45_000;
		const ref: NetworkReference = {
			hash: "net-hash",
			name: "",
			primaryAuthorityDomainName: "",
			relays: [],
		};
		armCreate({ kind: "resolve", ref });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		const setSpy = jest.spyOn(global, "setTimeout");
		const clearSpy = jest.spyOn(global, "clearTimeout");

		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);
		await renderer.act(async () => {
			await createPromise;
		});

		const armedByWithTimeout = setSpy.mock.calls
			.map((call, i) => ({ delay: call[1], handle: setSpy.mock.results[i]?.value }))
			.filter((entry) => entry.delay === CREATE_TIMEOUT_MS)
			.map((entry) => entry.handle);
		const clearedHandles = clearSpy.mock.calls.map((call) => call[0]);

		// Load-bearing: proves the create actually ran its withTimeout-wrapped steps, so an empty
		// leaked-set means "cleared", not "never armed in the first place".
		expect(mockSelectNetwork).toHaveBeenCalledWith(ref);
		expect(armedByWithTimeout.length).toBeGreaterThan(0);

		const leaked = armedByWithTimeout.filter((handle) => !clearedHandles.includes(handle));
		expect(leaked).toEqual([]);

		setSpy.mockRestore();
		clearSpy.mockRestore();
	});
});

describe("AddNetworkScreen — late commit (commit outlives its deadline)", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockIsNetworkSelected = undefined;
		deferredCommit = undefined;
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockGetDeviceProvisioningRecord.mockResolvedValue(undefined);
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [] });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const LATE_REF: NetworkReference = {
		hash: "late-hash",
		name: "Test Net",
		primaryAuthorityDomainName: "",
		relays: [],
	};

	async function startAndMissDeadline() {
		jest.useFakeTimers();
		armCreate({ kind: "deferred" });
		const tr = await renderScreen();
		const { promise } = await signAndPressCreateWithoutAwaiting(tr);
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
		});
		return { tr, promise };
	}

	function stillFinishingShown(tr: renderer.ReactTestRenderer) {
		return findByProps(tr, (p) => p.testID === "network-create-still-finishing").length > 0;
	}

	it("(A) shows the neutral status while waiting, then runs the tail exactly once when the commit lands", async () => {
		mockNetworksEngine.getRecentNetworks.mockResolvedValue(BEFORE);
		const { tr, promise } = await startAndMissDeadline();

		expect(stillFinishingShown(tr)).toBe(true);
		expect(inlineErrorMessage(tr)).toBe("");
		expect(mockSelectNetwork).not.toHaveBeenCalled();

		await renderer.act(async () => {
			deferredCommit!.resolve({ init: LATE_REF });
			await promise;
		});

		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(LATE_REF);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(inlineErrorMessage(tr)).toBe("");
		expect(stillFinishingShown(tr)).toBe(false);
	});

	it("(B) a late rejection goes through the normal error path: no select, translated copy shown (never the engine text), CREATE re-enabled", async () => {
		mockNetworksEngine.getRecentNetworks.mockResolvedValue(BEFORE);
		const { tr, promise } = await startAndMissDeadline();

		await renderer.act(async () => {
			deferredCommit!.reject(new Error("late boom"));
			await promise;
		});

		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(inlineErrorMessage(tr)).toBe("networkCreateFailed");
		expect(JSON.stringify(tr.toJSON())).not.toContain("late boom");
		expect(getCreateButton(tr).props.disabled).toBe(false);
		expect(stillFinishingShown(tr)).toBe(false);
	});

	it("(C) budget exhausted and a second reconcile that lands -> the normal tail", async () => {
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);
		const { tr, promise } = await startAndMissDeadline();

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(LATE_COMMIT_BUDGET_MS);
			await promise;
		});

		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(LANDED_REF);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(inlineErrorMessage(tr)).toBe("");
	});

	// WR-01 (62-88) deliberately supersedes 62-71 truth 3 ("the late commit still selects"): a
	// commit that lands up to LATE_COMMIT_BUDGET_MS after the officer left Add Network must NOT
	// re-point the session behind their back. The network is in recents; they select it from
	// Networks.
	it("(D, WR-01) screen unmounted while waiting: the late commit lands -> NOT auto-selected, no gate, no navigation", async () => {
		mockNetworksEngine.getRecentNetworks.mockResolvedValue(BEFORE);
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const { tr, promise } = await startAndMissDeadline();

		await renderer.act(async () => {
			tr.unmount();
		});
		await renderer.act(async () => {
			deferredCommit!.resolve({ init: LATE_REF });
			await promise;
		});

		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(mockGetCurrentUser).not.toHaveBeenCalled();
		expect(infoSpy).toHaveBeenCalledWith(
			"[network-create] late commit landed after leave; not auto-selecting",
		);
		infoSpy.mockRestore();
	});

	it("(D2, WR-01) screen unmounted while waiting: the budget runs out and the second reconcile finds the network -> NOT auto-selected", async () => {
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const { tr, promise } = await startAndMissDeadline();

		await renderer.act(async () => {
			tr.unmount();
		});
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(LATE_COMMIT_BUDGET_MS);
			await promise;
		});

		// Precondition: the second reconcile actually ran (otherwise "not selected" is vacuous).
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(3);
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(mockGetCurrentUser).not.toHaveBeenCalled();
		expect(infoSpy).toHaveBeenCalledWith(
			"[network-create] late commit landed after leave; not auto-selecting",
		);
		infoSpy.mockRestore();
	});

	it("(D3, WR-01) screen unmounted while waiting: the late commit FAILS -> no routing, no screen state, only the error class name is logged", async () => {
		mockNetworksEngine.getRecentNetworks.mockResolvedValue(BEFORE);
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const { tr, promise } = await startAndMissDeadline();

		await renderer.act(async () => {
			tr.unmount();
		});
		// A NO_KEY_PROVISIONED rejection is the one the device-signing handler routes (it would
		// navigate to ProvisionSigningKey), so "not navigated" proves the handler was not called.
		const rejection = Object.assign(new TypeError("secret late detail"), {
			code: "NO_KEY_PROVISIONED",
		});
		await renderer.act(async () => {
			deferredCommit!.reject(rejection);
			await promise;
		});

		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		// No setErrorMessage on an unmounted screen (React would log an act/unmounted warning) and
		// no full-error log line.
		expect(errorSpy).not.toHaveBeenCalled();
		const allLogged = [...infoSpy.mock.calls, ...errorSpy.mock.calls]
			.flat()
			.map((a) => (a instanceof Error ? a.message : String(a)))
			.join("\n");
		expect(allLogged).not.toContain("secret late detail");
		expect(infoSpy).toHaveBeenCalledWith(
			"[network-create] late commit failed after leave:",
			"TypeError",
		);
		infoSpy.mockRestore();
		errorSpy.mockRestore();
	});
});

describe("AddNetworkScreen — late first network (62-116)", () => {
	const LATE_REF: NetworkReference = {
		hash: "late-hash",
		name: "Test Net",
		primaryAuthorityDomainName: "",
		relays: [],
	};

	beforeEach(() => {
		jest.clearAllMocks();
		deferredCommit = undefined;
		mockIsNetworkSelected = undefined;
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockGetDeviceProvisioningRecord.mockResolvedValue(undefined);
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [] });
		mockNetworksEngine.getRecentNetworks.mockResolvedValue(BEFORE);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	async function leaveThenLand() {
		jest.useFakeTimers();
		armCreate({ kind: "deferred" });
		const tr = await renderScreen();
		const { promise } = await signAndPressCreateWithoutAwaiting(tr);
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
		});
		await renderer.act(async () => {
			tr.unmount();
		});
		await renderer.act(async () => {
			deferredCommit!.resolve({ init: LATE_REF });
			await promise;
		});
	}

	it("(N-2) no network selected, officer left: the late network IS selected; no goBack", async () => {
		mockIsNetworkSelected = () => false;
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(LATE_REF);
		expect(mockGoBack).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	it("(N-2b) late selection with no recovery key registered: the gate navigates to ProvisionSigningKey exactly once", async () => {
		mockIsNetworkSelected = () => false;
		mockGetDeviceProvisioningRecord.mockResolvedValue({ recoveryPublicKeyCompressedHex: RECOVERY_KEY });
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		infoSpy.mockRestore();
	});

	it("(N-2b) a User that already has the recovery key: the gate runs and does not navigate", async () => {
		mockIsNetworkSelected = () => false;
		mockGetDeviceProvisioningRecord.mockResolvedValue({ recoveryPublicKeyCompressedHex: RECOVERY_KEY });
		mockGetSummary.mockResolvedValue({
			id: "u1",
			activeKeys: [{ key: SIGNING_KEY }, { key: RECOVERY_KEY }],
		});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockGetCurrentUser).toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	it("(N-2b) a gate that rejects is logged with a fixed tag and class name only", async () => {
		mockIsNetworkSelected = () => false;
		// The gate swallows its own read failures; what can still reject is the navigation it issues.
		mockNavigate.mockImplementationOnce(() => {
			throw new TypeError("secret gate detail");
		});
		mockGetDeviceProvisioningRecord.mockResolvedValue({ recoveryPublicKeyCompressedHex: RECOVERY_KEY });
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		const logged = infoSpy.mock.calls.flat().map((a) => String(a)).join("\n");
		expect(logged).not.toContain("secret gate detail");
		expect(infoSpy).toHaveBeenCalledWith("[network-create] late recovery-key gate failed:", "TypeError");
		infoSpy.mockRestore();
	});

	it("(N-3) another network is already selected: not selected, gate does not run", async () => {
		mockIsNetworkSelected = () => true;
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGetCurrentUser).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	it("(N-3) a useApp lacking isNetworkSelected is treated as selected: never selects", async () => {
		mockIsNetworkSelected = undefined;
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		await leaveThenLand();
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	it("(N-4) a device-signing error still routes through the hook on a late failure (mounted)", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "deferred" });
		const tr = await renderScreen();
		const { promise } = await signAndPressCreateWithoutAwaiting(tr);
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
		});
		await renderer.act(async () => {
			deferredCommit!.reject(Object.assign(new Error("no key"), { code: "NO_KEY_PROVISIONED" }));
			await promise;
		});
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(inlineErrorMessage(tr)).toBe("");
	});

	/** Tags of AddNetworkScreen's own failure-path logs, read from the source so a renamed tag
	 * cannot pass vacuously. */
	function ownLogTags(): string[] {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src: string = require("fs").readFileSync(require("path").join(__dirname, "..", "AddNetworkScreen.tsx"), "utf8");
		const tags = new Set<string>(["[network-create] snapshot() failed"]);
		for (const m of src.matchAll(/console\.(?:warn|error)\(\s*"([^"]+)"/g)) tags.add(m[1]);
		return [...tags];
	}

	function matchedCalls(spies: jest.SpyInstance[]) {
		const tags = ownLogTags();
		return spies.flatMap((s) => s.mock.calls).filter((c) => typeof c[0] === "string" && tags.includes(c[0]));
	}

	/** Every text a logged value can carry, including an Error's message and stack (JSON.stringify of
	 * an Error is "{}", so a bare `console.error(err)` would otherwise scan clean). */
	function loggedText(arg: unknown, seen = new Set<unknown>()): string {
		if (arg instanceof Error) return [arg.name, arg.message, arg.stack ?? "", loggedText((arg as { cause?: unknown }).cause, seen)].join(" ");
		if (arg !== null && typeof arg === "object") {
			if (seen.has(arg)) return "";
			seen.add(arg);
			return Object.entries(arg as Record<string, unknown>)
				.map(([k, v]) => `${k} ${loggedText(v, seen)}`)
				.join(" ");
		}
		return String(arg);
	}

	it("(N-5) snapshot failure and create failure log only tags and class names", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
		const error = jest.spyOn(console, "error").mockImplementation(() => {});

		// (a) snapshot() rejects, the create itself lands.
		mockNetworksEngine.getRecentNetworks.mockRejectedValueOnce(new Error("secret snapshot detail"));
		armCreate({ kind: "resolve", ref: LATE_REF });
		let tr = await renderScreen();
		await pressSignThenCreate(tr);
		const snapshotCalls = matchedCalls([info, warn, error]).filter((c) => c[0] === "[network-create] snapshot() failed");
		expect(snapshotCalls.length).toBeGreaterThan(0);

		// (b) create fails with an engine message.
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);
		armCreate({ kind: "reject", error: new Error("secret create detail") });
		tr = await renderScreen();
		await pressSignThenCreate(tr);
		const createCalls = matchedCalls([info, warn, error]).filter((c) => c[0] === "handleCreate error:");
		expect(createCalls.length).toBeGreaterThan(0);

		// The tag-anchored calls carry strings only.
		for (const call of matchedCalls([info, warn, error])) {
			for (const arg of call) expect(typeof arg).toBe("string");
		}
		// WR-R6-04: the leak scan covers EVERY captured call on all three channels — any tag, a
		// template-literal first argument, or a bare error object — not only the tag-matched subset.
		const allCalls = [info, warn, error].flatMap((s) => s.mock.calls);
		expect(allCalls.length).toBeGreaterThan(0);
		for (const call of allCalls) {
			for (const arg of call) expect(loggedText(arg)).not.toContain("secret");
		}
		info.mockRestore();
		warn.mockRestore();
		error.mockRestore();
	});
});
