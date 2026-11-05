/**
 * O-01 (A4): after a successful Replace Signing Key the intake key is renewed (once, after the
 * recovery-in-progress marker clears); a failed renewal still reports success and tells the officer.
 * Preamble copied from ProvisionSigningKeyScreen.test.tsx (faked native module).
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

const mockResolveDeviceSigner = jest.fn();
const mockRenew = jest.fn<Promise<string>, [unknown]>();
jest.mock("../../registration/officer-intake-key", () => ({
	renewOfficerIntakeKeyAfterKeyReplacement: (deps: unknown) => mockRenew(deps),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, resolveDeviceSigner: mockResolveDeviceSigner }),
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
	return tr;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

const OLD_KEY = "cc" + "33".repeat(32);
const NEW_KEY = "dd" + "44".repeat(32);
const REC_KEY = "ee" + "55".repeat(32);

function seedRecovery(): void {
	mockRouteParams = { reason: "invalidated" };
	mockGetSummary.mockResolvedValue({
		id: "user-1",
		name: "Officer One",
		activeKeys: [
			{ key: OLD_KEY, type: "P", expiration: Date.now() + 1000 },
			{ key: REC_KEY, type: "P", expiration: Date.now() + 1000 },
		],
	});
	nativeFake.provisionDeviceKey.mockResolvedValue({ publicKeyBase64: "N", publicKeyCompressedHex: NEW_KEY });
	nativeFake.provisionRecoveryKey.mockResolvedValue({ publicKeyBase64: "R", publicKeyCompressedHex: REC_KEY });
	nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });
}

async function runRecovery(tr: renderer.ReactTestRenderer): Promise<void> {
	const wrapper = tr.root.findByProps({ testID: "signing-key-provisioning-primary-button" });
	await renderer.act(async () => {
		wrapper.findAll((n) => typeof n.props.onPress === "function")[0]!.props.onPress();
	});
	await flush();
}

beforeEach(() => {
	jest.clearAllMocks();
	mockGetCurrentUser.mockResolvedValue(mockUserEngine);
	networkEngineRejects = false;
	mockDeviceUserFixture = undefined;
	mockProvisioningRecordFixture = undefined;
	mockRenew.mockResolvedValue("not-needed");
});

describe("ProvisionSigningKeyScreen intake renewal after key replacement (A4)", () => {
	it("renewed: renewal is called exactly once AFTER clearRecoveryInProgress, success screen, no notice", async () => {
		seedRecovery();
		mockRenew.mockResolvedValue("renewed");
		const tr = await renderScreen();
		await runRecovery(tr);
		expect(mockRenew).toHaveBeenCalledTimes(1);
		expect(mockRenew.mock.invocationCallOrder[0]!).toBeGreaterThan(mockClearRecoveryInProgress.mock.invocationCallOrder[0]!);
		const deps = mockRenew.mock.calls[0]![0] as { getEngine: unknown; createSigner: unknown };
		expect(deps.getEngine).toBe(mockGetEngine);
		expect(deps.createSigner).toBe(mockResolveDeviceSigner);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
		expect(json).not.toContain("signing-key-intake-renewal-failed");
	});

	it("failed: still the success screen, plus the renewal-failed notice", async () => {
		seedRecovery();
		mockRenew.mockResolvedValue("failed");
		const tr = await renderScreen();
		await runRecovery(tr);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
		expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" }).length).toBeGreaterThan(0);
		expect(json).toContain("officerIntakeRenewalFailedBody");
	});

	it("not-needed: no notice", async () => {
		seedRecovery();
		const tr = await renderScreen();
		await runRecovery(tr);
		// WR-R6-06 positive anchors: the recovery reached success and the renewal actually ran.
		expect(JSON.stringify(tr.toJSON())).toContain("signingKeyProvisioningSuccessHeading");
		expect(mockRenew).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(tr.toJSON())).not.toContain("officerIntakeRenewalFailedBody");
	});

	it("WR-R3-06: a renewal that never settles does not hold the success screen; after 30 s the notice appears", async () => {
		jest.useFakeTimers();
		try {
			seedRecovery();
			mockRenew.mockImplementation(() => new Promise<string>(() => undefined));
			const tr = await renderScreen();
			await runRecovery(tr);
			expect(mockRenew).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(tr.toJSON())).toContain("signingKeyProvisioningSuccessHeading");
			expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" })).toHaveLength(0);

			await renderer.act(async () => {
				jest.advanceTimersByTime(29_999);
			});
			expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" })).toHaveLength(0);
			await renderer.act(async () => {
				jest.advanceTimersByTime(1);
			});
			expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" }).length).toBeGreaterThan(0);
			expect(JSON.stringify(tr.toJSON())).toContain("signingKeyProvisioningSuccessHeading");
		} finally {
			jest.useRealTimers();
		}
	});

	it("WR-R3-06: a slow renewal that later succeeds replaces the timed-out notice, and the outcome is logged at info", async () => {
		jest.useFakeTimers();
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			seedRecovery();
			let settle!: (outcome: string) => void;
			mockRenew.mockImplementation(
				() =>
					new Promise<string>((resolve) => {
						settle = resolve;
					})
			);
			const tr = await renderScreen();
			await runRecovery(tr);
			await renderer.act(async () => {
				jest.advanceTimersByTime(30_000);
			});
			expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" }).length).toBeGreaterThan(0);

			await renderer.act(async () => {
				settle("renewed");
			});
			await flush();
			expect(tr.root.findAllByProps({ testID: "signing-key-intake-renewal-failed" })).toHaveLength(0);
			expect(infoSpy).toHaveBeenCalledWith("[intake-renewal] outcome=renewed");
			expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes("[intake-renewal]"))).toHaveLength(0);
		} finally {
			infoSpy.mockRestore();
			warnSpy.mockRestore();
			jest.useRealTimers();
		}
	});

	it("first-run provisioning never calls renewal", async () => {
		mockRouteParams = { reason: "first-run" };
		nativeFake.provisionDeviceKey.mockResolvedValue({ publicKeyBase64: "N", publicKeyCompressedHex: NEW_KEY });
		nativeFake.provisionRecoveryKey.mockResolvedValue({ publicKeyBase64: "R", publicKeyCompressedHex: REC_KEY });
		nativeFake.produceAttestation.mockResolvedValue({ certificateChainBase64: ["l"], publicKeyCompressedHex: NEW_KEY });
		const tr = await renderScreen();
		await runRecovery(tr);
		// WR-R6-06 positive anchor: first-run provisioning completed (the success screen rendered).
		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalled();
		expect(JSON.stringify(tr.toJSON())).toContain("signingKeyProvisioningSuccessHeading");
		expect(mockRenew).not.toHaveBeenCalled();
	});
});
