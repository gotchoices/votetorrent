/**
 * ProvisionSigningKeyScreen.test.tsx — 49-10 (D-14/D-16/D-18) screen-layer coverage, rewritten by
 * 49-17 (Gap A provisioning closure + the attested-key defect).
 *
 * HEADER NOTE (49-17): the first-run happy-path assertions below intentionally changed from the
 * original 49-10 suite. The old suite asserted `addKey` received `provisionDeviceKey`'s
 * PRE-attestation `publicKeyCompressedHex` and that the whole ceremony ran unconditionally with no
 * network guard — both encode the two faults 49-17 closes (the circular network dependency and the
 * discarded-key defect, see `49-17-PLAN.md`'s objective). Do NOT "restore" those old assertions; a
 * future reader who does so is reintroducing a silent signature-verification failure
 * (`UserKey.SignatureValid` rejects closed, and `verify()` swallows exceptions, so the failure is
 * invisible without this suite's fixtures deliberately using DIFFERENT pre/post-attestation hex
 * values).
 *
 * DEVICE-PROOF HONESTY: jest cannot exercise the real Android Keystore or the real
 * `BiometricPrompt` — this suite proves the JS-side wiring and rendering against a faked native
 * module ONLY. That the ceremony works on real hardware is D-24 leg 1 (49-13/49-18) and leg 3
 * (49-14), not this file.
 *
 * The native TurboModule bridge is faked the same way `device-signer.hardware.test.ts` and
 * `real-attestation-producer.test.ts` fake it: react-native's `TurboModuleRegistry.getEnforcing`
 * is overridden for the `'AttestationNative'` name only, via a Proxy, so the REAL screen module
 * (including its own lazy `getNative()`) is exercised, not a stand-in.
 */

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	// device-signer.ts (imported by this screen for its two alias constants) imports the app's
	// `i18n` singleton at module scope, which calls `i18n.use(initReactI18next).init(...)` at ITS
	// OWN module scope — this mock must supply a real-shaped plugin object or that call throws
	// before this file's own assertions ever run. Mirrors KeyholderInvitationScreen.test.tsx's
	// identical fix (49-07).
	initReactI18next: { type: "3rdParty", init: () => {} },
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockRouteParams: { reason: "first-run" | "invalidated" } = { reason: "first-run" };
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

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
	useRoute: () => ({ params: mockRouteParams }),
	useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

// Mirrors the REAL engine's own behavior (user-engine.ts addKey): when a `sign` callback is
// passed, it is invoked with a digest — so this fake must call it too, or the signWithDeviceKey/
// signWithRecoveryKey call inside this screen's own callback would never fire.
const mockAddKey = jest.fn(async (_key: unknown, sign?: (digest: Uint8Array) => Promise<unknown>) => {
	if (sign) await sign(new Uint8Array([1, 2, 3]));
});
const mockRevokeKey = jest.fn(
	async (_key: string, _signature: { signerKey: string; signature: string; signerUserId: string }) => {},
);
const mockGetRevokeKeyDigest = jest.fn(async (_key: string) => new Uint8Array([9, 9, 9]));
const mockGetSummary = jest.fn(async () => ({
	id: "user-1",
	name: "Officer One",
	activeKeys: [] as Array<{ key: string; type: string; expiration: number }>,
}));
const mockUserEngine = {
	addKey: mockAddKey,
	revokeKey: mockRevokeKey,
	getRevokeKeyDigest: mockGetRevokeKeyDigest,
	getSummary: mockGetSummary,
};
const mockGetCurrentUser = jest.fn(async () => mockUserEngine);
const mockNetworkEngine = { getCurrentUser: mockGetCurrentUser };
const mockDefaultUserGet = jest.fn(async () => ({ name: "Config Default Name" }));
const mockDefaultUserEngine = { get: mockDefaultUserGet };
let networkEngineRejects = false;
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === "defaultUser") return mockDefaultUserEngine;
	if (name === "network") {
		if (networkEngineRejects) throw new Error("no network context");
		return mockNetworkEngine;
	}
	throw new Error(`unexpected getEngine name in test: ${name}`);
});

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

const mockPersistProvisionedDeviceUser = jest.fn(async (_displayName: string, publicKeyCompressedHex: string, _options?: { userId?: string }) => ({
	id: "user-1",
	name: "Officer One",
	activeKeys: [{ key: publicKeyCompressedHex, type: "P", expiration: Date.now() }],
}));
const mockPersistDeviceProvisioningRecord = jest.fn(async (_record: unknown) => {});
let mockDeviceUserFixture: { id: string; name: string; activeKeys: Array<{ key: string }> } | undefined;
let mockProvisioningRecordFixture: { recoveryPublicKeyCompressedHex: string } | undefined;
const mockGetDeviceUser = jest.fn(async () => mockDeviceUserFixture);
const mockGetDeviceProvisioningRecord = jest.fn(async () => mockProvisioningRecordFixture);
// 49-14 follow-up: the recovery-in-progress marker (device-user.ts). Exposed as real jest.fn()s
// (not just no-op stubs) so this suite's own recovery-marker tests can assert call order/count.
const mockMarkRecoveryInProgress = jest.fn(async () => {});
const mockClearRecoveryInProgress = jest.fn(async () => {});

jest.mock("../../../engines/device-user", () => ({
	persistProvisionedDeviceUser: (displayName: string, publicKeyCompressedHex: string, options?: { userId?: string }) =>
		// Forward only the arguments actually passed, so first-run assertions stay two-argument.
		options === undefined
			? mockPersistProvisionedDeviceUser(displayName, publicKeyCompressedHex)
			: mockPersistProvisionedDeviceUser(displayName, publicKeyCompressedHex, options),
	persistDeviceProvisioningRecord: (record: unknown) => mockPersistDeviceProvisioningRecord(record),
	getDeviceUser: () => mockGetDeviceUser(),
	getDeviceProvisioningRecord: () => mockGetDeviceProvisioningRecord(),
	markRecoveryInProgress: () => mockMarkRecoveryInProgress(),
	clearRecoveryInProgress: () => mockClearRecoveryInProgress(),
}));

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` — see device-signer.hardware.test.ts's
// identical comment: react-native's index.js exports most modules as lazy getters, and spreading
// forces every one to evaluate eagerly. A Proxy defers property access to exactly what the code
// under test reads.
jest.mock("react-native", () => {
	const actual: Record<string, unknown> = jest.requireActual("react-native");
	const attestationNativeFake = {
		provisionDeviceKey: jest.fn(),
		provisionRecoveryKey: jest.fn(),
		produceAttestation: jest.fn(),
		signWithDeviceKey: jest.fn(),
		signWithRecoveryKey: jest.fn(),
	};
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown };
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === "getEnforcing") {
				return (name: string) => (name === "AttestationNative" ? attestationNativeFake : target.getEnforcing(name));
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	// Platform.OS is set per test via __setPlatformOS (never inherited from the jest preset's "ios").
	let platformOS = "ios";
	const platformProxy = new Proxy(actual.Platform as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop === "OS") return platformOS;
			return Reflect.get(target, prop, receiver);
		},
	});
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === "TurboModuleRegistry") return turboModuleRegistryProxy;
			if (prop === "Platform") return platformProxy;
			if (prop === "__setPlatformOS") return (os: string) => { platformOS = os; };
			if (prop === "__attestationNativeFake") return attestationNativeFake;
			return Reflect.get(target, prop, receiver);
		},
	});
});

import React from "react";
import renderer from "react-test-renderer";

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __setPlatformOS: setPlatformOS } = require("react-native") as {
	__setPlatformOS: (os: string) => void;
	__attestationNativeFake: {
		provisionDeviceKey: jest.Mock;
		provisionRecoveryKey: jest.Mock;
		produceAttestation: jest.Mock;
		signWithDeviceKey: jest.Mock;
		signWithRecoveryKey: jest.Mock;
	};
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ProvisionSigningKeyModule = require("../ProvisionSigningKeyScreen");
const ProvisionSigningKeyScreen = ProvisionSigningKeyModule.default;

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ProvisionSigningKeyScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

function primaryButton(tr: renderer.ReactTestRenderer) {
	const wrapper = tr.root.findByProps({ testID: "signing-key-provisioning-primary-button" });
	const candidates = wrapper.findAll((node) => typeof node.props.onPress === "function");
	expect(candidates.length).toBeGreaterThan(0);
	return candidates[0]!;
}

async function press(tr: renderer.ReactTestRenderer, node: ReturnType<typeof primaryButton>): Promise<void> {
	await renderer.act(async () => {
		node.props.onPress();
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { reason: "first-run" };
	mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
	mockGetCurrentUser.mockResolvedValue(mockUserEngine);
	mockDefaultUserGet.mockResolvedValue({ name: "Config Default Name" });
	networkEngineRejects = false;
	mockDeviceUserFixture = undefined;
	mockProvisioningRecordFixture = undefined;
});

// Deliberately DIFFERENT pre/post-attestation hex values throughout this suite — the whole point
// of T-49-KEY's fixture design (49-17-PLAN.md): a test using the SAME value on both sides could
// never distinguish "registered the right key" from "registered the wrong key that happens to be
// identical".
const PRE_ATTESTATION_SIGNING_HEX = "aa" + "11".repeat(32);
const POST_ATTESTATION_SIGNING_HEX = "cc" + "33".repeat(32);
const RECOVERY_HEX = "bb" + "22".repeat(32);

function mockHappyPathNative(): void {
	nativeFake.provisionDeviceKey.mockResolvedValue({
		publicKeyBase64: "SIGNING-SPKI-DER-BASE64",
		publicKeyCompressedHex: PRE_ATTESTATION_SIGNING_HEX,
	});
	nativeFake.provisionRecoveryKey.mockResolvedValue({
		publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
		publicKeyCompressedHex: RECOVERY_HEX,
	});
	nativeFake.produceAttestation.mockResolvedValue({
		certificateChainBase64: ["leaf-cert", "intermediate-cert"],
		publicKeyCompressedHex: POST_ATTESTATION_SIGNING_HEX,
	});
	nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });
}

describe("ProvisionSigningKeyScreen — 49-17 first-run stage 1 (network-independent, attested-key correctness)", () => {
	it("(a) runs the native ceremony in order and persists BEFORE any network engine call", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionDeviceKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_SIGNING_KEY_V1");
		expect(nativeFake.provisionRecoveryKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1");
		expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1);
		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledTimes(1);
		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledTimes(1);

		const order = [
			nativeFake.provisionDeviceKey.mock.invocationCallOrder[0]!,
			nativeFake.provisionRecoveryKey.mock.invocationCallOrder[0]!,
			nativeFake.produceAttestation.mock.invocationCallOrder[0]!,
			mockPersistDeviceProvisioningRecord.mock.invocationCallOrder[0]!,
			mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!,
		];
		const sorted = [...order].sort((a, b) => a - b);
		expect(order).toEqual(sorted);

		// No engine call (network resolution) happens until AFTER stage 1 fully persists.
		const firstNetworkCallOrder = mockGetCurrentUser.mock.invocationCallOrder[0];
		expect(firstNetworkCallOrder).toBeDefined();
		expect(firstNetworkCallOrder!).toBeGreaterThan(mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!);

		// `defaultUser` IS resolved during stage 1 (LocalStorage-only, never network-scoped) —
		// assert it was used for the display name, not a network User summary.
		expect(mockDefaultUserGet).toHaveBeenCalled();
		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Config Default Name", expect.any(String));
	});

	it("(b) registers the POST-attestation key, never the pre-attestation key — fails if the discarded value is used", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Config Default Name", POST_ATTESTATION_SIGNING_HEX);
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalledWith(
			expect.any(String),
			PRE_ATTESTATION_SIGNING_HEX,
		);
	});

	it("(c) persists the provisioning record with the recovery key, the ATTESTED signing key, the alias, and the cert chain", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				recoveryPublicKeyCompressedHex: RECOVERY_HEX,
				attestedPublicKeyCompressedHex: POST_ATTESTATION_SIGNING_HEX,
				signingKeyAlias: "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1",
				certificateChainBase64: ["leaf-cert", "intermediate-cert"],
			}),
		);
	});

	it("(d) lands on the awaiting-network state (no InlineError) when no network User resolves", async () => {
		mockHappyPathNative();
		networkEngineRejects = true;

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningAwaitingNetworkHeading");
		expect(json).not.toContain("deviceSigningError");

		const continueButton = tr.root.findByProps({ testID: "signing-key-provisioning-continue-button" });
		const pressable = continueButton.findAll((node) => typeof node.props.onPress === "function")[0]!;
		await renderer.act(async () => pressable.props.onPress());
		expect(mockGoBack).toHaveBeenCalled();
	});

	it("(h) [49-14 follow-up] lands on network-user-unresolved (NOT awaiting-network) when the network resolves but getCurrentUser rejects — a resolved-network/missing-User-row failure must not be masqueraded as no-network", async () => {
		mockHappyPathNative();
		mockGetCurrentUser.mockRejectedValueOnce(new Error("User not found"));

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningNetworkUserUnresolvedHeading");
		expect(json).not.toContain("signingKeyProvisioningAwaitingNetworkHeading");
	});

	it("(i) [49-14 follow-up] lands on network-user-unresolved when the network resolves but getCurrentUser resolves undefined (no throw)", async () => {
		mockHappyPathNative();
		mockGetCurrentUser.mockResolvedValueOnce(undefined as unknown as typeof mockUserEngine);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningNetworkUserUnresolvedHeading");
	});

	it("(j) [49-14 follow-up] the network-user-unresolved retry button re-invokes resolution and can reach success on a subsequent call", async () => {
		mockHappyPathNative();
		mockGetCurrentUser.mockRejectedValueOnce(new Error("User not found"));
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() },
				{ key: RECOVERY_HEX, type: "P", expiration: Date.now() },
			],
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));
		expect(JSON.stringify(tr.toJSON())).toContain("signingKeyProvisioningNetworkUserUnresolvedHeading");

		// Second call to getCurrentUser (the retry) resolves normally via the default mock.
		const retryButton = tr.root.findByProps({ testID: "signing-key-provisioning-retry-button" });
		const pressable = retryButton.findAll((node) => typeof node.props.onPress === "function")[0]!;
		await renderer.act(async () => pressable.props.onPress());
		for (let i = 0; i < 6; i++) {
			// eslint-disable-next-line no-await-in-loop
			await renderer.act(async () => {
				await Promise.resolve();
			});
		}

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(e) re-entry on an already-locally-provisioned device never re-runs the native ceremony", async () => {
		mockDeviceUserFixture = {
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX }],
		};
		mockProvisioningRecordFixture = { recoveryPublicKeyCompressedHex: RECOVERY_HEX };
		// Both keys already registered network-side too, so stage 2 is a full no-op — isolates
		// this test to ONLY the stage-1 idempotency claim (stage 2's own reconciliation coverage
		// lives in the "stage 2 reconciliation" describe block below).
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() },
				{ key: RECOVERY_HEX, type: "P", expiration: Date.now() },
			],
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled();
		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
		expect(nativeFake.produceAttestation).not.toHaveBeenCalled();
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).not.toHaveBeenCalled();
		expect(mockAddKey).not.toHaveBeenCalled();
	});

	it("(f) a CANCELED rejection during stage 1 renders no InlineError and re-enables the button", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		const button = primaryButton(tr);
		await press(tr, button);

		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("deviceSigningError");
		const buttonAfter = primaryButton(tr);
		expect(buttonAfter.props.disabled).toBeFalsy();
	});

	it("(g) a LOCKOUT_PERMANENT rejection renders the deviceSigningErrorLockoutPermanent copy", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(
			Object.assign(new Error("locked"), { code: "LOCKOUT_PERMANENT" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("deviceSigningErrorLockoutPermanent");
	});
});

describe("ProvisionSigningKeyScreen — 49-17 first-run stage 2 (reconcile against the network User)", () => {
	// Every case here starts from an already-locally-provisioned device (stage 1 already ran on a
	// prior visit) so only stage 2's reconciliation is under test.
	beforeEach(() => {
		mockDeviceUserFixture = {
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX }],
		};
		mockProvisioningRecordFixture = { recoveryPublicKeyCompressedHex: RECOVERY_HEX };
	});

	it("(a) signing key present, recovery missing: exactly one signed addKey call for the recovery key", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
		expect(mockAddKey).toHaveBeenCalledTimes(1);
		const [key, sign] = mockAddKey.mock.calls[0]!;
		expect((key as { key: string }).key).toBe(RECOVERY_HEX);
		expect(typeof sign).toBe("function");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(b) empty activeKeys: two addKey calls in order — bootstrap (no sign) then signed", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockAddKey).toHaveBeenCalledTimes(2);
		const [firstKey, firstSign] = mockAddKey.mock.calls[0]!;
		expect((firstKey as { key: string }).key).toBe(POST_ATTESTATION_SIGNING_HEX);
		expect(firstSign).toBeUndefined();
		const [secondKey, secondSign] = mockAddKey.mock.calls[1]!;
		expect((secondKey as { key: string }).key).toBe(RECOVERY_HEX);
		expect(typeof secondSign).toBe("function");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(c) both keys present: no addKey call, success renders", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() },
				{ key: RECOVERY_HEX, type: "P", expiration: Date.now() },
			],
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockAddKey).not.toHaveBeenCalled();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(d) the signed insert's signerKey is the ATTESTED signing key, never a pre-attestation value", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		let capturedSignature: { signerKey: string } | undefined;
		mockAddKey.mockImplementationOnce(async (_key: unknown, sign?: (d: Uint8Array) => Promise<unknown>) => {
			if (sign) capturedSignature = (await sign(new Uint8Array([1, 2, 3]))) as { signerKey: string };
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(capturedSignature?.signerKey).toBe(POST_ATTESTATION_SIGNING_HEX);
		expect(capturedSignature?.signerKey).not.toBe(PRE_ATTESTATION_SIGNING_HEX);
	});

	it("(e) a fresh user engine is resolved between the two writes — getCurrentUser called at least twice", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockGetCurrentUser.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("(f) never re-calls provisionRecoveryKey on a return visit", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
	});

	it("(g) a cancellation raised by signWithDeviceKey returns silently to idle, no InlineError, local record intact", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockRejectedValue(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("deviceSigningError");
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).not.toHaveBeenCalled();
	});
});

const OLD_SIGNING_KEY_HEX = "cc" + "33".repeat(32);
const NEW_SIGNING_KEY_HEX = "dd" + "44".repeat(32);
const RECOVERY_KEY_HEX = "ee" + "55".repeat(32);

describe("ProvisionSigningKeyScreen — 49-10 recovery variant (D-16) and D-18 terminal state", () => {
	beforeEach(() => {
		mockRouteParams = { reason: "invalidated" };
		// 49-14 follow-up: the recovery key MUST already be a registered, active UserKey for this
		// ceremony to be reachable at all — UserKey.DeleteValid requires BOTH a valid signer
		// (clause 1) AND that the revoked row not be the user's LAST key (clause 2), which
		// together mean revoking OLD_SIGNING_KEY_HEX is only ever legal when RECOVERY_KEY_HEX is
		// ALREADY present as a second active key. This is the realistic post-49-17 precondition
		// state (first-run stage 2 already registered the recovery key on a prior visit) — the
		// UNregistered-recovery-key state is its own dedicated describe block below, proving the
		// new fail-fast precondition check, not silently modeled as the happy path here.
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: OLD_SIGNING_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
				{ key: RECOVERY_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
			],
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
	});

	it("(a) the recovery happy path signs with signWithRecoveryKey (never signWithDeviceKey), registers the replacement key, then revokes the old one", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled();
		expect(nativeFake.signWithRecoveryKey).toHaveBeenCalled();
		for (const call of nativeFake.signWithRecoveryKey.mock.calls) {
			expect(call[0]).toBe("VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1");
		}

		expect(mockRevokeKey).toHaveBeenCalledTimes(1);
		expect(mockRevokeKey.mock.calls[0]![0]).toBe(OLD_SIGNING_KEY_HEX);
		const revokeSignature = mockRevokeKey.mock.calls[0]![1] as { signerKey: string; signature: string };
		expect(revokeSignature.signerKey).toBe(RECOVERY_KEY_HEX);
		expect(revokeSignature.signature).toBe("cafebabe");

		expect(mockAddKey).toHaveBeenCalledTimes(1);
		const addedKey = mockAddKey.mock.calls[0]![0] as { key: string };
		expect(addedKey.key).toBe(NEW_SIGNING_KEY_HEX);
		expect(typeof mockAddKey.mock.calls[0]![1]).toBe("function");

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Officer One", NEW_SIGNING_KEY_HEX, { userId: "user-1" });

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(f) R1/R2: recovery keeps the network user's id and name end to end (one identity)", async () => {
		mockGetSummary.mockResolvedValue({
			id: "net-user-1",
			name: "Una Tester",
			activeKeys: [
				{ key: OLD_SIGNING_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
				{ key: RECOVERY_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
			],
		});
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Una Tester", NEW_SIGNING_KEY_HEX, {
			userId: "net-user-1",
		});
		const revokeSignature = mockRevokeKey.mock.calls[0]![1] as { signerUserId: string };
		expect(revokeSignature.signerUserId).toBe("net-user-1");
	});

	it("(c) refreshes the provisioning record with the new attested key and an EMPTY certificateChainBase64 — no produceAttestation on this path", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.produceAttestation).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				recoveryPublicKeyCompressedHex: RECOVERY_KEY_HEX,
				attestedPublicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
				signingKeyAlias: "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1",
				certificateChainBase64: [],
			}),
		);
	});

	it("(b) a NO_DEVICE_CREDENTIAL rejection renders the no-recovery heading/body and ZERO buttons", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockRejectedValue(
			Object.assign(new Error("no device credential"), { code: "NO_DEVICE_CREDENTIAL" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningNoRecoveryHeading");
		expect(json).toContain("signingKeyProvisioningNoRecoveryBody");

		// D-18: no action affordance at all — assert the rendered button COUNT, not just the
		// absence of a specific testID (a stray pressable elsewhere would still be a lie).
		const pressables = tr.root.findAll((node) => typeof node.props.onPress === "function");
		expect(pressables.length).toBe(0);

		// 49-14 follow-up: this exact failure mode (interrupted AFTER the Keystore alias
		// regenerated, BEFORE local metadata resynced) is precisely what the in-progress marker
		// exists to protect against. It must stay SET here, never cleared.
		expect(mockMarkRecoveryInProgress).toHaveBeenCalledTimes(1);
		expect(mockClearRecoveryInProgress).not.toHaveBeenCalled();
	});

	it("(b2) 49-21 — a RECOVERY_UNSUPPORTED_OS rejection renders the recovery-unsupported-os heading/body and ZERO buttons, distinct from the no-recovery pair", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockRejectedValue(
			Object.assign(new Error("recovery unsupported on this OS version"), { code: "RECOVERY_UNSUPPORTED_OS" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningRecoveryUnsupportedOsHeading");
		expect(json).toContain("signingKeyProvisioningRecoveryUnsupportedOsBody");

		// The two terminal states must never collapse into one — this is the assertion that keeps
		// a regression from silently telling an API<30 officer to restore a screen lock they never
		// removed.
		expect(json).not.toContain("signingKeyProvisioningNoRecoveryHeading");

		// D-26a rescope: no action affordance at all — assert the rendered button COUNT, not just
		// the absence of a specific testID (a stray pressable elsewhere would still be a lie).
		const pressables = tr.root.findAll((node) => typeof node.props.onPress === "function");
		expect(pressables.length).toBe(0);

		// The ceremony was interrupted after the Keystore alias may already have been regenerated —
		// same reasoning as the (b) NO_DEVICE_CREDENTIAL case above: the in-progress marker must
		// stay SET, never cleared.
		expect(mockMarkRecoveryInProgress).toHaveBeenCalledTimes(1);
		expect(mockClearRecoveryInProgress).not.toHaveBeenCalled();
	});

	// 49-14 follow-up (interrupted-handleRecovery Keystore/metadata desync — the PREVENTION half
	// of the fix, plus the Device-A rescue-path precondition).
	describe("(d) 49-14 follow-up — recovery-in-progress marker", () => {
		function mockRecoveryHappyPathNative(): void {
			nativeFake.provisionDeviceKey.mockResolvedValue({
				publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
				publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
			});
			nativeFake.provisionRecoveryKey.mockResolvedValue({
				publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
				publicKeyCompressedHex: RECOVERY_KEY_HEX,
			});
			nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });
		}

		it("marks recovery in progress immediately after the Keystore alias regenerates, BEFORE either persistence write", async () => {
			mockRecoveryHappyPathNative();

			const tr = await renderScreen();
			await press(tr, primaryButton(tr));

			expect(mockMarkRecoveryInProgress).toHaveBeenCalledTimes(1);
			const markOrder = mockMarkRecoveryInProgress.mock.invocationCallOrder[0]!;
			const provisionOrder = nativeFake.provisionDeviceKey.mock.invocationCallOrder[0]!;
			const persistUserOrder = mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!;
			const persistRecordOrder = mockPersistDeviceProvisioningRecord.mock.invocationCallOrder[0]!;

			expect(markOrder).toBeGreaterThan(provisionOrder);
			expect(markOrder).toBeLessThan(persistUserOrder);
			expect(markOrder).toBeLessThan(persistRecordOrder);
		});

		it("clears the marker only once BOTH persistProvisionedDeviceUser and persistDeviceProvisioningRecord complete", async () => {
			mockRecoveryHappyPathNative();

			const tr = await renderScreen();
			await press(tr, primaryButton(tr));

			expect(mockClearRecoveryInProgress).toHaveBeenCalledTimes(1);
			const clearOrder = mockClearRecoveryInProgress.mock.invocationCallOrder[0]!;
			const persistUserOrder = mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!;
			const persistRecordOrder = mockPersistDeviceProvisioningRecord.mock.invocationCallOrder[0]!;

			expect(clearOrder).toBeGreaterThan(persistUserOrder);
			expect(clearOrder).toBeGreaterThan(persistRecordOrder);

			const json = JSON.stringify(tr.toJSON());
			expect(json).toContain("signingKeyProvisioningSuccessHeading");
		});

		it("never marks recovery in progress on the first-run path (only handleRecovery touches the marker)", async () => {
			mockRouteParams = { reason: "first-run" };
			mockHappyPathNative();

			const tr = await renderScreen();
			await press(tr, primaryButton(tr));

			expect(mockMarkRecoveryInProgress).not.toHaveBeenCalled();
			expect(mockClearRecoveryInProgress).not.toHaveBeenCalled();
		});
	});

	// 49-14 follow-up (root-caused on real hardware, Device A — see 49-14-PROOF-LOG.md's
	// "Follow-up session — prerequisite diagnosis" section): the two NEW failure modes this
	// session closed. Neither reached a `BiometricPrompt` on real hardware — both are detected
	// before any Keystore mutation.
	describe("(e) 49-14 follow-up — recovery-key precondition and invalidation", () => {
		it("fails fast with RECOVERY_KEY_NOT_REGISTERED when the recovery key is not yet an active UserKey, touching NEITHER the Keystore nor the in-progress marker", async () => {
			// Overrides this describe block's own beforeEach: the network User has ONLY the old
			// signing key active — the exact state measured on Device A this session
			// (`activeKeys=[{"key":"02186e2d...","type":"P",...}]`, recovery key absent).
			mockGetSummary.mockResolvedValue({
				id: "user-1",
				name: "Officer One",
				activeKeys: [{ key: OLD_SIGNING_KEY_HEX, type: "P", expiration: Date.now() + 1000 }],
			});
			nativeFake.provisionRecoveryKey.mockResolvedValue({
				publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
				publicKeyCompressedHex: RECOVERY_KEY_HEX,
			});

			const tr = await renderScreen();
			await press(tr, primaryButton(tr));

			// Detected BEFORE any Keystore mutation or in-progress marker — the whole point of
			// checking this precondition first.
			expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled();
			expect(mockMarkRecoveryInProgress).not.toHaveBeenCalled();
			expect(mockRevokeKey).not.toHaveBeenCalled();
			expect(mockAddKey).not.toHaveBeenCalled();

			const json = JSON.stringify(tr.toJSON());
			expect(json).toContain("deviceSigningErrorRecoveryKeyNotRegistered");
			// Never the generic biometric-error copy — that collapse is exactly the masking this
			// follow-up exists to prevent (T-49-USER-7).
			expect(json).not.toContain("deviceSigningErrorGeneric");
		});

		it("surfaces RECOVERY_KEY_INVALIDATED (native's provisionRecoveryKey reject) as its own distinct inline copy, never the generic biometric-error message", async () => {
			nativeFake.provisionRecoveryKey.mockRejectedValue(
				Object.assign(new Error("recovery key permanently invalidated"), {
					code: "RECOVERY_KEY_INVALIDATED",
				}),
			);

			const tr = await renderScreen();
			await press(tr, primaryButton(tr));

			// The rejection fires on the very first native call this function makes — nothing
			// past it should ever run.
			expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled();
			expect(mockMarkRecoveryInProgress).not.toHaveBeenCalled();

			const json = JSON.stringify(tr.toJSON());
			expect(json).toContain("deviceSigningErrorRecoveryKeyInvalidated");
			expect(json).not.toContain("deviceSigningErrorGeneric");
		});
	});
});

describe("ProvisionSigningKeyScreen — D-14 boot invariant", () => {
	it("AppProvider.tsx never references this route — no boot-time redirect exists", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		const appProviderSource = fs.readFileSync(
			path.join(__dirname, "..", "..", "..", "providers", "AppProvider.tsx"),
			"utf8",
		);
		expect(appProviderSource).not.toContain("ProvisionSigningKey");
	});
});

describe("ProvisionSigningKeyScreen network-user-unresolved (UAT 62 Q)", () => {
	it("explains both causes and offers Accept an Invitation alongside Try Again", async () => {
		mockHappyPathNative();
		mockGetCurrentUser.mockRejectedValueOnce(new Error("User not found"));

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningNetworkUserUnresolvedBody");
		expect(tr.root.findByProps({ testID: "signing-key-provisioning-retry-button" })).toBeTruthy();

		const inviteButton = tr.root.findByProps({ testID: "signing-key-provisioning-accept-invitation-button" });
		const pressable = inviteButton.findAll((node) => typeof node.props.onPress === "function")[0]!;
		await renderer.act(async () => pressable.props.onPress());
		expect(mockNavigate).toHaveBeenCalledWith("AcceptInvitation");
	});
});

// The digest handed to native depends on the platform (UAT 62 test 22): iOS native signs its input as the
// final ECDSA hash, so it receives sha256(digest); Android's SHA256withECDSA hashes itself, so it receives
// the digest. Asserted for all three native sign calls this screen makes.
describe.each(["ios", "android"] as const)("ProvisionSigningKeyScreen native sign input on %s", (platform) => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { createHash } = require("crypto") as typeof import("crypto");
	const expected = (d: number[]) => {
		const raw = Buffer.from(Uint8Array.from(d));
		return (platform === "ios" ? createHash("sha256").update(raw).digest() : raw).toString("base64");
	};

	beforeEach(() => {
		setPlatformOS(platform);
	});
	afterEach(() => {
		setPlatformOS("ios");
	});

	it("first-run recovery-key addKey: signWithDeviceKey receives the platform input", async () => {
		mockDeviceUserFixture = { id: "user-1", name: "Officer One", activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX }] };
		mockProvisioningRecordFixture = { recoveryPublicKeyCompressedHex: RECOVERY_HEX };
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1);
		expect(nativeFake.signWithDeviceKey.mock.calls[0]![1]).toBe(expected([1, 2, 3]));
	});

	it("recovery: revoke and replacement addKey both hand signWithRecoveryKey the platform input", async () => {
		mockRouteParams = { reason: "invalidated" };
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: OLD_SIGNING_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
				{ key: RECOVERY_KEY_HEX, type: "P", expiration: Date.now() + 1000 },
			],
		});
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const digests = nativeFake.signWithRecoveryKey.mock.calls.map((c: unknown[]) => c[1]);
		expect(digests).toContain(expected([9, 9, 9]));
		expect(digests).toContain(expected([1, 2, 3]));
		expect(digests).toHaveLength(2);
	});
});
