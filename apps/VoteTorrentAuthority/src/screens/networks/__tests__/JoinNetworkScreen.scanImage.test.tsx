/**
 * JoinNetworkScreen.scanImage.test.tsx - Choose image inside the Authority's camera scanner, on Join
 * a network (the Scan button and the `JoinNetworkByScan` route), and beside the camera notice when
 * the camera cannot be used.
 *
 * A picked image is read by `engines/qr-image-decode` (mocked here; its own suite covers the native
 * pipeline) and its QR values go through the scanner's own check: a join code fills the field
 * exactly as a camera read does, an invitation or any other QR gets the camera's own banner. The
 * camera is paused while the picker is open and resumes after a cancel. The decoded values are the
 * QR the Invite voters card draws, read back with jsQR. Code text is compared with boolean
 * assertions only, so a failing matcher never prints a credential.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { AccessibilityInfo } from "react-native";
import { JOIN_CODE_FIXTURES } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import { resources } from "../../../i18n";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";
import { readDisplayedQr } from "../../__fixtures__/displayed-qr";
import { serializeInviteShare } from "../../invitations/invite-share";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock("../../../hooks/useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { name?: string }) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			if (typeof value !== "string") throw new Error("missing i18n key " + key);
			return opts && typeof opts.name === "string" ? value.replace("{{name}}", opts.name) : value;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").darkTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: jest.fn(), setParams: mockSetParams }),
	useFocusEffect: () => undefined,
}));
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: { partyId: "party-1" }, ownerTrust: "ok", refreshOwnerTrust: jest.fn(async () => undefined) }),
}));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { joinFromStrand: jest.fn() }, selectNetwork: jest.fn(async () => undefined) }),
}));
jest.mock("../../../engines/device-user", () => ({ getDeviceUser: async () => ({ id: "user-1" }) }));
const mockRun = jest.fn();
jest.mock("../../../engines/authority-network-join", () => ({
	runAuthorityNetworkJoin: (...a: unknown[]) => mockRun(...a),
	completeAuthorityJoin: jest.fn(),
}));
const mockAvailable = jest.fn(() => true);
const mockPick = jest.fn();
jest.mock("../../../engines/qr-image-decode", () => ({
	isQrImageDecodeAvailable: () => mockAvailable(),
	pickImageAndReadQrCodes: (deps: unknown) => mockPick(deps),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require("../JoinNetworkScreen");
const JoinNetworkScreen = ScreenModule.default;
const JoinNetworkByScanScreen = ScreenModule.JoinNetworkByScanScreen;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { judgeScannedValues, scanImageOutcome } = require("../JoinCodeScanner");

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__resetBarcodeScannerMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vc = require("../../../../__mocks__/react-native-vision-camera.js") as VcMock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs = require("../../../../__mocks__/react-native-vision-camera-barcode-scanner.js") as BsMock;

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;
const sample = JOIN_CODE_FIXTURES["v2-1-member"];
const JOIN_QR = readDisplayedQr(sample.text, 1080) as string;

function invitationText(): string {
	const priv = secp256k1.utils.randomSecretKey();
	return serializeInviteShare({
		invitePrivate: bytesToHex(priv),
		inviteKey: bytesToHex(secp256k1.getPublicKey(priv)),
		expiration: "2026-11-25T09:30:00.000Z",
		type: "k",
		name: "Kay Holder",
	});
}

type Inst = renderer.ReactTestInstance;
let tr: renderer.ReactTestRenderer | undefined;
async function mount(element: React.ReactElement): Promise<void> {
	await act(async () => {
		tr = renderer.create(element, { createNodeMock: () => ({}) });
	});
}
const root = () => (tr as renderer.ReactTestRenderer).root;
const cams = () => root().findAll((n) => (n.type as unknown) === "VisionCameraMock");
const hostById = (id: string): Inst | undefined => root().findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
function elWith(id: string, prop: string): Inst {
	const found = root().findAll((n) => n.props.testID === id && typeof n.props[prop] === "function")[0];
	if (!found) throw new Error("no element " + id + " with " + prop);
	return found;
}
function textOf(n: Inst): string {
	return n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}
const textById = (id: string) => {
	const h = hostById(id);
	return h ? textOf(h) : "";
};
const inputValue = () => (hostById("join-network-code-input")?.props.value ?? "") as string;
async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}
async function press(id: string): Promise<void> {
	await act(async () => {
		await elWith(id, "onPress").props.onPress();
	});
	await settle();
}
function isInside(childId: string, parentId: string): boolean {
	const parent = hostById(parentId);
	if (!parent) return false;
	return parent.findAll((n) => typeof n.type === "string" && n.props.testID === childId).length > 0;
}

beforeEach(() => {
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	for (const m of [mockNavigate, mockSetParams, mockRun, mockPick]) m.mockReset();
	mockAvailable.mockReset();
	mockAvailable.mockReturnValue(true);
	jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
});
afterEach(async () => {
	// Nothing a picked image holds reaches navigation, and a pick never joins by itself.
	expect(mockNavigate).not.toHaveBeenCalled();
	expect(mockSetParams).not.toHaveBeenCalled();
	expect(mockRun).not.toHaveBeenCalled();
	await act(async () => {
		tr?.unmount();
	});
	tr = undefined;
	jest.restoreAllMocks();
});

describe("Choose image inside the scanner (Join a network)", () => {
	it("GI-1: the Scan button's scanner shows Choose image inside it, next to Paste instead, with an accessible label", async () => {
		await mount(<JoinNetworkScreen />);
		expect(hostById("join-network-scan-image")).toBeUndefined();
		await press("join-network-scan");
		expect(cams()).toHaveLength(1);
		expect(isInside("join-network-scan-image", "join-network-scanner")).toBe(true);
		expect(isInside("join-network-scan-paste", "join-network-scanner")).toBe(true);
		const button = elWith("join-network-scan-image", "onPress");
		expect(button.props.accessibilityRole).toBe("button");
		expect(button.props.accessibilityLabel).toBe(en.scanImageLabel);
		expect(button.props.disabled).toBe(false);
		expect(textById("join-network-scan-image")).toBe(en.scanImageButton);
		expect(hostById("join-network-scan-image-unavailable")).toBeUndefined();
	});

	it("GI-2: a picked join code fills the field through the camera's path: preview, scanned notice, Join ready, no join", async () => {
		mockPick.mockResolvedValue({ kind: "decoded", values: ["not a code", JOIN_QR] });
		const capture = captureConsole();
		try {
			await mount(<JoinNetworkScreen />);
			await press("join-network-scan");
			await press("join-network-scan-image");
			expect(mockPick).toHaveBeenCalledTimes(1);
			expect(mockPick.mock.calls[0][0]).toEqual({ logTag: "[join]" });
			expect(cams()).toHaveLength(0);
			expect(inputValue() === sample.text).toBe(true);
			expect(textById("join-network-preview-name") === sample.name).toBe(true);
			expect(textById("join-network-preview-fingerprint") === sample.fingerprint).toBe(true);
			expect(textById("join-network-scan-status")).toBe(en.joinScanScanned);
			expect(elWith("join-network-submit", "onPress").props.disabled).toBe(false);
			expectNoSecretInConsole(capture, [sample.text]);
		} finally {
			capture.restore();
		}
	});

	it("GI-3: the JoinNetworkByScan route's scanner has Choose image too, and a picked join code fills the field", async () => {
		mockPick.mockResolvedValue({ kind: "decoded", values: [JOIN_QR] });
		await mount(<JoinNetworkByScanScreen />);
		expect(cams()).toHaveLength(1);
		expect(isInside("join-network-scan-image", "join-network-scanner")).toBe(true);
		await press("join-network-scan-image");
		expect(cams()).toHaveLength(0);
		expect(inputValue() === sample.text).toBe(true);
	});

	it("GI-4: a picked invitation gets the camera's invitation banner; the field stays empty and the camera resumes", async () => {
		const invite = invitationText();
		mockPick.mockResolvedValue({ kind: "decoded", values: [invite] });
		const capture = captureConsole();
		try {
			await mount(<JoinNetworkScreen />);
			await press("join-network-scan");
			await press("join-network-scan-image");
			expect(textById("join-network-scan-banner")).toBe(en.joinScanIsInvitation);
			expect(inputValue()).toBe("");
			expect(cams()).toHaveLength(1);
			expect(cams()[0].props.isActive).toBe(true);
			expectNoSecretInConsole(capture, [invite]);
		} finally {
			capture.restore();
		}
	});

	it("GI-5: any other QR gets the camera's not-a-join-code banner", async () => {
		mockPick.mockResolvedValue({ kind: "decoded", values: ["https://example.com/menu"] });
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		await press("join-network-scan-image");
		expect(textById("join-network-scan-banner")).toBe(en.joinScanNotJoinCode);
		expect(inputValue()).toBe("");
		// The same refusal a camera frame gets.
		await act(async () => {
			bs.__emitBarcodes([{ rawValue: "https://example.com/menu" }]);
		});
		expect(textById("join-network-scan-banner")).toBe(en.joinScanNotJoinCode);
	});

	it("GI-6: the camera pauses while the picker is open; a cancel resumes it and says no image was chosen", async () => {
		let finish: (v: unknown) => void = () => undefined;
		mockPick.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		expect(cams()[0].props.isActive).toBe(true);
		await act(async () => {
			elWith("join-network-scan-image", "onPress").props.onPress();
		});
		expect(cams()[0].props.isActive).toBe(false);
		expect(elWith("join-network-scan-image", "onPress").props.disabled).toBe(true);
		expect(hostById("join-network-scan-image-busy")).toBeDefined();
		// A frame the paused camera still delivers is ignored.
		await act(async () => {
			bs.__emitBarcodes([{ rawValue: JOIN_QR }]);
		});
		expect(inputValue()).toBe("");
		await act(async () => {
			finish({ kind: "cancelled" });
		});
		await settle();
		expect(cams()).toHaveLength(1);
		expect(cams()[0].props.isActive).toBe(true);
		expect(textById("join-network-scan-banner")).toBe(en.scanImageCancelled);
		expect(elWith("join-network-scan-image", "onPress").props.disabled).toBe(false);
		// Scanning works again after the cancel.
		await act(async () => {
			bs.__emitBarcodes([{ rawValue: JOIN_QR }]);
		});
		expect(inputValue() === sample.text).toBe(true);
	});

	it("GI-7: a picture with no QR code and an unreadable picture each get their own banner", async () => {
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		mockPick.mockResolvedValueOnce({ kind: "no-code" });
		await press("join-network-scan-image");
		expect(textById("join-network-scan-banner")).toBe(en.joinScanImageNoCode);
		mockPick.mockResolvedValueOnce({ kind: "unreadable" });
		await press("join-network-scan-image");
		expect(textById("join-network-scan-banner")).toBe(en.joinScanImageUnreadable);
		expect(new Set([en.scanImageCancelled, en.joinScanImageNoCode, en.joinScanImageUnreadable]).size).toBe(3);
		expect(inputValue()).toBe("");
		expect(cams()[0].props.isActive).toBe(true);
	});

	it("GI-8: a build without the image picker shows Choose image disabled with a sentence; scanning still works", async () => {
		mockAvailable.mockReturnValue(false);
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		const button = elWith("join-network-scan-image", "onPress");
		expect(button.props.disabled).toBe(true);
		expect(button.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
		expect(textById("join-network-scan-image-unavailable")).toBe(en.joinScanImageUnavailable);
		expect(mockPick).not.toHaveBeenCalled();
		await act(async () => {
			bs.__emitBarcodes([{ rawValue: JOIN_QR }]);
		});
		expect(inputValue() === sample.text).toBe(true);
	});

	it("GI-9: a pick that comes back after the scanner closed fills nothing", async () => {
		let finish: (v: unknown) => void = () => undefined;
		mockPick.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		await act(async () => {
			elWith("join-network-scan-image", "onPress").props.onPress();
		});
		await press("join-network-scan-close");
		await act(async () => {
			finish({ kind: "decoded", values: [JOIN_QR] });
		});
		await settle();
		expect(inputValue()).toBe("");
	});
});

describe("Choose image when the camera cannot be used", () => {
	it("GC-1: a blocked camera keeps Scan disabled, and the notice is followed by Choose image, which fills the field", async () => {
		vc.__setCameraPermissionStatus("denied");
		mockPick.mockResolvedValue({ kind: "decoded", values: [JOIN_QR] });
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(elWith("join-network-scan", "onPress").props.disabled).toBe(true);
		expect(textById("join-network-scan-status")).toContain(en.joinScanCameraBlocked);
		expect(hostById("join-network-scan-open-settings")).toBeDefined();
		const button = elWith("join-network-scan-status-image", "onPress");
		expect(button.props.accessibilityLabel).toBe(en.scanImageLabel);
		await press("join-network-scan-status-image");
		expect(cams()).toHaveLength(0);
		expect(inputValue() === sample.text).toBe(true);
		expect(textById("join-network-preview-name") === sample.name).toBe(true);
	});

	it("GC-2: a refused permission request offers Choose image; a picked invitation is refused with the same sentence as a scan", async () => {
		vc.__setCameraPermissionStatus("not-determined");
		vc.__setCameraPermissionRequestResult("not-determined");
		mockPick.mockResolvedValue({ kind: "decoded", values: [invitationText()] });
		await mount(<JoinNetworkScreen />);
		await press("join-network-scan");
		expect(textById("join-network-scan-status")).toBe(en.joinScanCameraDenied);
		await press("join-network-scan-status-image");
		expect(textById("join-network-image-notice")).toBe(en.joinScanIsInvitation);
		expect(inputValue()).toBe("");
	});

	it("GC-3: no camera offers Choose image; no QR, unreadable and cancelled each say so", async () => {
		vc.__setCameraDevice(undefined);
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(textById("join-network-scan-status")).toBe(en.joinScanCameraNone);
		for (const [result, key] of [
			[{ kind: "no-code" }, "joinScanImageNoCode"],
			[{ kind: "unreadable" }, "joinScanImageUnreadable"],
			[{ kind: "cancelled" }, "scanImageCancelled"],
		] as const) {
			mockPick.mockResolvedValueOnce(result);
			await press("join-network-scan-status-image");
			expect(textById("join-network-image-notice")).toBe(en[key]);
		}
		expect(inputValue()).toBe("");
	});

	it("GC-4: a build without the image picker offers no Choose image beside the camera notice", async () => {
		vc.__setCameraPermissionStatus("denied");
		mockAvailable.mockReturnValue(false);
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(textById("join-network-scan-status")).toContain(en.joinScanCameraBlocked);
		expect(hostById("join-network-scan-status-image")).toBeUndefined();
	});

	it("GC-5: with the camera ready, the screen itself shows no extra Choose image (it is inside the scanner)", async () => {
		await mount(<JoinNetworkScreen />);
		expect(hostById("join-network-scan-status-image")).toBeUndefined();
	});
});

describe("one check for a camera frame and a picked image", () => {
	it("J-1: judgeScannedValues takes the first value of the kind and names a refusal otherwise", () => {
		const invite = invitationText();
		expect(judgeScannedValues([undefined, "x", JOIN_QR], "join-code")).toEqual({ type: "accepted", value: JOIN_QR });
		expect(judgeScannedValues([invite], "join-code")).toEqual({ type: "other-kind" });
		expect(judgeScannedValues(["x"], "join-code")).toEqual({ type: "not-kind" });
		expect(judgeScannedValues([JOIN_QR, invite], "invitation")).toEqual({ type: "accepted", value: invite });
		expect(judgeScannedValues([JOIN_QR], "invitation")).toEqual({ type: "other-kind" });
	});

	it("J-2: scanImageOutcome maps every picker result to the accepted value or its own sentence", () => {
		expect(scanImageOutcome({ kind: "decoded", values: [JOIN_QR] }, "join-code")).toEqual({ type: "accepted", value: JOIN_QR });
		const keys = (["no-code", "unreadable", "cancelled", "unavailable"] as const).map(
			(kind) => (scanImageOutcome({ kind }, "join-code") as { key: string }).key,
		);
		expect(keys).toEqual(["joinScanImageNoCode", "joinScanImageUnreadable", "scanImageCancelled", "joinScanImageUnavailable"]);
		const inviteKeys = (["no-code", "unreadable", "unavailable"] as const).map(
			(kind) => (scanImageOutcome({ kind }, "invitation") as { key: string }).key,
		);
		expect(inviteKeys).toEqual(["inviteImageNoCode", "inviteImageUnreadable", "inviteImageUnavailable"]);
	});

	it("J-3: every new sentence exists in English and Spanish", () => {
		for (const key of ["scanImageButton", "scanImageLabel", "scanImageCancelled", "joinScanImageNoCode", "joinScanImageUnreadable", "joinScanImageUnavailable"]) {
			expect(typeof en[key] === "string" && en[key].length > 0).toBe(true);
			expect(typeof es[key] === "string" && es[key].length > 0 && es[key] !== en[key]).toBe(true);
		}
	});
});
