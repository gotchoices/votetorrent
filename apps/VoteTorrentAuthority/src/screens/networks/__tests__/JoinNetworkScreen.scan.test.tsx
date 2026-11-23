/**
 * JoinNetworkScreen.scan.test.tsx - scan to join on the Authority (user ruling 2026-11-23).
 *
 * Flow under test: a Scan press (on this screen, or the Networks screen's Scan, which lands on the
 * `JoinNetworkByScan` route with the scanner already open) opens the camera; the camera reads the
 * Invite voters QR; the decoded network name and fingerprint show with Join ready; ONE Join tap
 * starts the join. A scan never joins by itself.
 *
 * The QR payload is not a hand-typed string: every scanned value comes from `readDisplayedQr`,
 * which builds the PNG the Invite voters card shows and reads it back with jsQR. The codes are
 * vote-engine's real-encoder fixtures. VisionCamera is the manual mock (copied from the Voter); its
 * `__` controls are reached by require() of the mock FILE. Code text is compared with boolean
 * assertions only, so a failing matcher never prints a credential.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { AccessibilityInfo, Linking } from "react-native";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { resources } from "../../../i18n";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";
import { DISPLAYED_QR_TARGETS_PX, displayedQrBase64, readDisplayedQr } from "../../__fixtures__/displayed-qr";
import { tryBuildQrPanel } from "../components/VoterInviteQrView";

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
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions, setParams: mockSetParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

const mockRefresh = jest.fn(async () => undefined);
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: { partyId: "party-1" }, ownerTrust: "ok", refreshOwnerTrust: mockRefresh }),
}));
const mockSelectNetwork = jest.fn(async () => undefined);
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { joinFromStrand: jest.fn() }, selectNetwork: mockSelectNetwork }),
}));
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1" }),
}));
const mockRun = jest.fn();
const mockComplete = jest.fn();
jest.mock("../../../engines/authority-network-join", () => ({
	runAuthorityNetworkJoin: (...a: unknown[]) => mockRun(...a),
	completeAuthorityJoin: (...a: unknown[]) => mockComplete(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require("../JoinNetworkScreen");
const JoinNetworkScreen = ScreenModule.default;
const JoinNetworkByScanScreen = ScreenModule.JoinNetworkByScanScreen;

interface VcMock {
	__setCameraDevice(d: unknown): void;
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__cameraPermissionRequestCount(): number;
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
const OK_NAMES: JoinCodeFixtureName[] = ["v2-1-member", "v2-2-members", "v2-6-members", "v2-non-ascii-name", "v1-legacy-1-member"];
const sample = JOIN_CODE_FIXTURES["v2-1-member"];

type Inst = renderer.ReactTestInstance;
let tr: renderer.ReactTestRenderer | undefined;

async function mount(element: React.ReactElement): Promise<renderer.ReactTestRenderer> {
	await act(async () => {
		tr = renderer.create(element, { createNodeMock: () => ({}) });
	});
	return tr as renderer.ReactTestRenderer;
}
const root = () => (tr as renderer.ReactTestRenderer).root;
const cams = () => root().findAll((n) => (n.type as unknown) === "VisionCameraMock");
function hostById(id: string): Inst | undefined {
	return root().findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
}
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
	if (!h) throw new Error("no host " + id);
	return textOf(h);
};
const inputValue = () => (hostById("join-network-code-input")?.props.value ?? "") as string;
const scanDisabled = () => elWith("join-network-scan", "onPress").props.disabled === true;

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}
async function pressScan(): Promise<void> {
	await act(async () => {
		elWith("join-network-scan", "onPress").props.onPress();
	});
	await settle();
}
async function emitScan(rawValue: string): Promise<void> {
	await act(async () => {
		bs.__emitBarcodes([{ rawValue }]);
	});
}
async function pressJoin(): Promise<void> {
	await act(async () => {
		elWith("join-network-submit", "onPress").props.onPress();
	});
	await settle();
}

beforeEach(() => {
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
	for (const m of [mockNavigate, mockGoBack, mockSetOptions, mockSetParams, mockRun, mockComplete]) m.mockReset();
	mockRun.mockResolvedValue({ ok: true, networkRef: { hash: sample.networkHash, name: sample.name, primaryAuthorityDomainName: "authority.example" } });
	mockComplete.mockResolvedValue({ trustSaved: true });
	jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
	jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
});

afterEach(async () => {
	// The scan flow never navigates onward and never puts anything in navigation state.
	expect(mockNavigate).not.toHaveBeenCalled();
	expect(mockSetParams).not.toHaveBeenCalled();
	expect(mockSetOptions).not.toHaveBeenCalled();
	await act(async () => {
		tr?.unmount();
	});
	tr = undefined;
	jest.restoreAllMocks();
});

describe("Q: the QR the Invite voters card shows reads back as the exact join code", () => {
	it.each(OK_NAMES)("Q-1 %s: both display sizes read back exactly, and the card's builder draws the same PNG", (name) => {
		const code = JOIN_CODE_FIXTURES[name].text;
		for (const target of DISPLAYED_QR_TARGETS_PX) {
			const read = readDisplayedQr(code, target);
			expect(read !== null && read === code).toBe(true);
			const card = tryBuildQrPanel(code, target);
			expect(card.ok && card.panel.base64 === displayedQrBase64(code, target)).toBe(true);
		}
	});
});

describe("S: scan to join", () => {
	it.each(OK_NAMES)(
		"S-1 %s: Scan opens the camera; the read fills the field, shows name and fingerprint with Join ready; one Join tap starts the join",
		async (name) => {
			const fx = JOIN_CODE_FIXTURES[name];
			const payload = readDisplayedQr(fx.text, 1080);
			expect(payload !== null).toBe(true);
			const capture = captureConsole();
			try {
				await mount(<JoinNetworkScreen />);
				expect(cams()).toHaveLength(0);
				expect(vc.__cameraPermissionRequestCount()).toBe(0);
				await pressScan();
				expect(cams()).toHaveLength(1);

				await emitScan(payload as string);
				expect(cams()).toHaveLength(0);
				expect(inputValue() === fx.text).toBe(true);
				expect(textById("join-network-preview-name") === fx.name).toBe(true);
				expect(textById("join-network-preview-fingerprint") === fx.fingerprint).toBe(true);
				expect(textById("join-network-scan-status")).toBe(en.joinScanScanned);
				expect(elWith("join-network-submit", "onPress").props.disabled).toBe(false);
				// A scan only fills the field.
				expect(mockRun).not.toHaveBeenCalled();

				await pressJoin();
				expect(mockRun).toHaveBeenCalledTimes(1);
				const decoded = decodeNetworkJoinCode(fx.text);
				expect(decoded.ok).toBe(true);
				const sent = (mockRun.mock.calls[0][0] as { code: unknown }).code;
				expect(decoded.ok && JSON.stringify(sent) === JSON.stringify(decoded.code)).toBe(true);
				expect(hostById("join-network-joined")).toBeDefined();
				expectNoSecretInConsole(capture, [fx.text]);
				for (const call of capture.calls()) {
					expect(call.every((a) => typeof a === "string" && !a.includes(fx.name) && !a.includes(fx.fingerprint))).toBe(true);
				}
			} finally {
				capture.restore();
			}
		},
	);

	it("S-2: the JoinNetworkByScan route opens the camera on arrival with no press, then scan -> preview -> one Join tap", async () => {
		const payload = readDisplayedQr(sample.text, 160 * 3) as string;
		await mount(<JoinNetworkByScanScreen />);
		expect(cams()).toHaveLength(1);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
		await emitScan(payload);
		expect(cams()).toHaveLength(0);
		expect(textById("join-network-preview-name") === sample.name).toBe(true);
		expect(textById("join-network-preview-fingerprint") === sample.fingerprint).toBe(true);
		expect(mockRun).not.toHaveBeenCalled();
		await pressJoin();
		expect(mockRun).toHaveBeenCalledTimes(1);
	});

	it("S-3: the plain JoinNetwork route opens no camera and asks for no permission", async () => {
		vc.__setCameraPermissionStatus("not-determined");
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(cams()).toHaveLength(0);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
	});

	it("S-4: a QR that is not a join code shows the banner and leaves the field empty; the scanner stays open", async () => {
		await mount(<JoinNetworkScreen />);
		await pressScan();
		await emitScan("https://example.org/not-a-join-code");
		expect(cams()).toHaveLength(1);
		expect(textById("join-network-scan-banner")).toBe(en.joinScanNotJoinCode);
		expect(inputValue()).toBe("");
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("S-5: Paste instead and Close return to the screen with the field unchanged", async () => {
		await mount(<JoinNetworkScreen />);
		for (const id of ["join-network-scan-paste", "join-network-scan-close"]) {
			await pressScan();
			expect(cams()).toHaveLength(1);
			await act(async () => {
				elWith(id, "onPress").props.onPress();
			});
			expect(cams()).toHaveLength(0);
			expect(inputValue()).toBe("");
		}
	});
});

describe("C: camera states point to paste", () => {
	it("C-1: not-determined -> the permission is asked only on the Scan press; a grant opens the camera", async () => {
		vc.__setCameraPermissionStatus("not-determined");
		await mount(<JoinNetworkScreen />);
		expect(vc.__cameraPermissionRequestCount()).toBe(0);
		await pressScan();
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(cams()).toHaveLength(1);
	});

	it("C-1b: arriving by the Networks screen's Scan (JoinNetworkByScan) with no decision yet asks once, and a grant opens the camera", async () => {
		vc.__setCameraPermissionStatus("not-determined");
		await mount(<JoinNetworkByScanScreen />);
		await settle();
		expect(vc.__cameraPermissionRequestCount()).toBe(1);
		expect(cams()).toHaveLength(1);
	});

	it("C-2: a refused request shows the denied sentence and keeps Scan enabled", async () => {
		vc.__setCameraPermissionStatus("not-determined");
		vc.__setCameraPermissionRequestResult("not-determined");
		await mount(<JoinNetworkScreen />);
		await pressScan();
		await settle();
		expect(cams()).toHaveLength(0);
		expect(textById("join-network-scan-status")).toBe(en.joinScanCameraDenied);
		expect(scanDisabled()).toBe(false);
	});

	it("C-3: a blocked permission disables Scan, says so, and offers Open Settings", async () => {
		vc.__setCameraPermissionStatus("denied");
		const open = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(scanDisabled()).toBe(true);
		expect(textById("join-network-scan-status")).toContain(en.joinScanCameraBlocked);
		await act(async () => {
			elWith("join-network-scan-open-settings", "onPress").props.onPress();
		});
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("C-4: no back camera disables Scan and says to paste", async () => {
		vc.__setCameraDevice(undefined);
		await mount(<JoinNetworkScreen />);
		await settle();
		expect(scanDisabled()).toBe(true);
		expect(textById("join-network-scan-status")).toBe(en.joinScanCameraNone);
	});

	it("C-5: a camera error closes the scanner and shows the failed sentence with Scan enabled", async () => {
		await mount(<JoinNetworkScreen />);
		await pressScan();
		const cam = cams()[0];
		await act(async () => {
			cam.props.onError(new Error("camera busy"));
		});
		expect(cams()).toHaveLength(0);
		expect(textById("join-network-scan-status")).toBe(en.joinScanCameraFailed);
		expect(scanDisabled()).toBe(false);
	});

	it("C-6: every camera sentence exists in both locales and points to paste", () => {
		const es = resources.es.translation as Record<string, string>;
		for (const key of ["joinScanCameraDenied", "joinScanCameraBlocked", "joinScanCameraNone", "joinScanCameraFailed"]) {
			expect(en[key]).toMatch(/paste the join code/i);
			expect(es[key]).toMatch(/pega el código de acceso/i);
		}
	});
});
