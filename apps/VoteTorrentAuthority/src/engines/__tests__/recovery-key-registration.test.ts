import {
	needsRecoveryKeyRegistration,
	deviceNeedsRecoveryKeyRegistration,
	shouldPromptRecoveryKeyRegistration,
} from "../recovery-key-registration";
import { getDeviceProvisioningRecord } from "../device-user";

jest.mock("../device-user", () => ({
	getDeviceProvisioningRecord: jest.fn(),
}));

const mockGetRecord = getDeviceProvisioningRecord as jest.MockedFunction<
	typeof getDeviceProvisioningRecord
>;

// The exact pair measured on both fleet devices (49-14 proof log §G.3): the
// provisioning record held the recovery key while activeKeys held only the signing key.
const RECOVERY = "030a52df56ee0151548b4f6922774d5ca70ef5d9a50a212583b71cc02da0622243";
const SIGNING = "036f83ade69db2d99111aa57fa28f2140be076cd1e1044a24ea1b0d40092d663a2";

describe("needsRecoveryKeyRegistration", () => {
	it("reports the gap when the recovery key is absent from activeKeys", () => {
		// This is the measured device state, verbatim.
		expect(needsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }] }, RECOVERY)).toBe(true);
	});

	it("reports no gap once the recovery key is registered", () => {
		expect(
			needsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }, { key: RECOVERY }] }, RECOVERY),
		).toBe(false);
	});

	it("reports no gap when the device has no recovery key to register", () => {
		expect(needsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }] }, undefined)).toBe(false);
	});

	it("reports no gap when the network user did not resolve", () => {
		// user-unresolved is a DISTINCT condition the provisioning screen surfaces itself;
		// this gate must not misreport it as a registration gap.
		expect(needsRecoveryKeyRegistration(undefined, RECOVERY)).toBe(false);
	});

	it("treats an absent activeKeys array as a gap, not a crash", () => {
		expect(needsRecoveryKeyRegistration({}, RECOVERY)).toBe(true);
	});
});

describe("deviceNeedsRecoveryKeyRegistration", () => {
	beforeEach(() => jest.resetAllMocks());

	it("reads the provisioning record and reports the measured gap", async () => {
		mockGetRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY,
		} as Awaited<ReturnType<typeof getDeviceProvisioningRecord>>);
		await expect(
			deviceNeedsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }] }),
		).resolves.toBe(true);
	});

	it("reports no gap when the device was never locally provisioned", async () => {
		mockGetRecord.mockResolvedValue(undefined);
		await expect(
			deviceNeedsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }] }),
		).resolves.toBe(false);
	});

	it("never throws a storage failure into the create/join path", async () => {
		mockGetRecord.mockRejectedValue(new Error("AsyncStorage unavailable"));
		await expect(
			deviceNeedsRecoveryKeyRegistration({ activeKeys: [{ key: SIGNING }] }),
		).resolves.toBe(false);
	});
});

describe("shouldPromptRecoveryKeyRegistration", () => {
	beforeEach(() => jest.resetAllMocks());

	it("prompts when the resolved user is missing the recovery key", async () => {
		mockGetRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY,
		} as Awaited<ReturnType<typeof getDeviceProvisioningRecord>>);
		await expect(
			shouldPromptRecoveryKeyRegistration(async () => ({ activeKeys: [{ key: SIGNING }] })),
		).resolves.toBe(true);
	});

	it("does not prompt when no network user resolves", async () => {
		mockGetRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY,
		} as Awaited<ReturnType<typeof getDeviceProvisioningRecord>>);
		await expect(shouldPromptRecoveryKeyRegistration(async () => undefined)).resolves.toBe(false);
	});

	it("swallows a resolver rejection rather than failing the create path", async () => {
		mockGetRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY,
		} as Awaited<ReturnType<typeof getDeviceProvisioningRecord>>);
		await expect(
			shouldPromptRecoveryKeyRegistration(async () => {
				throw new Error("network engine unavailable");
			}),
		).resolves.toBe(false);
	});
});
