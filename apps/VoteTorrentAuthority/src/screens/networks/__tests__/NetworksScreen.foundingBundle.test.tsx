/**
 * NetworksScreen.foundingBundle.test.tsx — E-1..E-6 (D-35, D-36).
 *
 * Mounts the REAL NetworksScreen with its REAL FoundingBundleExportCard and REAL
 * LifecycleConfirmCard. `t()` resolves against the REAL `resources`; `useTheme()` returns the
 * REAL `lightTheme.colors`. `device-signer`, `device-user`, `react-native`'s `Share.share` and
 * `useApp` are mocked.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { lightTheme } from "../../../theme/themes";
import { resources } from "../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: jest.fn() }),
}));

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ReactForMock = require("react");
	return {
		useTheme: () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { lightTheme: theme } = require("../../../theme/themes");
			return theme;
		},
		useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
		useFocusEffect: (cb: () => void | (() => void)) => {
			ReactForMock.useEffect(() => cb(), []);
		},
	};
});

let mockRecentNetworks: Array<{ hash: string; name: string; primaryAuthorityDomainName: string }> = [];
const callOrder: string[] = [];
const mockOpen = jest.fn(async (...args: unknown[]) => {
	callOrder.push("open");
	return {} as unknown;
});
const mockExportFoundingBundle = jest.fn(async (...args: unknown[]) => {
	callOrder.push("exportFoundingBundle");
	return { bundle: {}, text: "BUNDLE-TEXT", fileName: "founding-bundle.json" };
});
const mockNetworksEngine = {
	getRecentNetworks: jest.fn(async () => mockRecentNetworks),
	open: mockOpen,
	exportFoundingBundle: mockExportFoundingBundle,
};
const mockSelectNetwork = jest.fn(async () => undefined);
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: mockSelectNetwork }),
}));

const mockCreateDeviceSigner = jest.fn(async (...args: unknown[]) => {
	callOrder.push("createDeviceSigner");
	return jest.fn(async () => ({ signerUserId: "user-1", signerKey: "key-1", signature: "sig" }));
});
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: () => mockCreateDeviceSigner(),
}));

const mockGetDeviceUser = jest.fn(async () => {
	callOrder.push("getDeviceUser");
	return { id: "user-1", name: "Officer One", activeKeys: [{ key: "key-1", type: "ed25519" }] };
});
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: () => mockGetDeviceUser(),
}));

const mockWriteShareFile = jest.fn(async (..._args: unknown[]) => "file:///cache/founding-bundle.json");
jest.mock("@votetorrent/attestation-native", () => {
	const actual = jest.requireActual("@votetorrent/attestation-native");
	return {
		...actual,
		writeShareFile: (...a: unknown[]) => mockWriteShareFile(...a),
		shareFileAndroid: jest.fn(async () => undefined),
	};
});
jest.mock("@react-native-documents/picker", () => ({
	saveDocuments: jest.fn(async () => []),
	errorCodes: { OPERATION_CANCELED: "OPERATION_CANCELED" },
	isErrorWithCode: (e: any) => typeof e?.code === "string",
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NetworksScreenModule = require("../NetworksScreen");
const NetworksScreen = NetworksScreenModule.default ?? NetworksScreenModule.NetworksScreen;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share } = require("react-native");

const NETWORK_A = { hash: "hashA", name: "Network A", primaryAuthorityDomainName: "a.example" };
const NETWORK_B = { hash: "hashB", name: "Network B", primaryAuthorityDomainName: "b.example" };

async function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<NetworksScreen />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return tr;
}

function findByProps(tr: renderer.ReactTestRenderer, predicate: (props: Record<string, unknown>) => boolean) {
	return tr.root.findAll((n) => {
		try {
			return predicate(n.props as Record<string, unknown>);
		} catch {
			return false;
		}
	});
}

function findButton(tr: renderer.ReactTestRenderer, title: string) {
	const matches = findByProps(tr, (p) => p.title === title && typeof p.onPress === "function");
	expect(matches.length).toBeGreaterThan(0);
	return matches[0];
}

/** True if `testID` appears anywhere within `node` (inclusive). */
function containsTestID(node: unknown, testID: string): boolean {
	if (node == null || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some((n) => containsTestID(n, testID));
	const n = node as { props?: Record<string, unknown>; children?: unknown[] };
	if (n.props?.testID === testID) return true;
	return (n.children ?? []).some((c) => containsTestID(c, testID));
}

function findJsonByTestID(node: unknown, testID: string, path: unknown[] = []): { node: any; path: any[] } | null {
	if (node == null || typeof node === "string") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findJsonByTestID(child, testID, path);
			if (found) return found;
		}
		return null;
	}
	const n = node as { props?: Record<string, unknown>; children?: unknown[] };
	if (n.props && n.props.testID === testID) return { node, path };
	if (n.children) {
		for (const child of n.children) {
			const found = findJsonByTestID(child, testID, [...path, node]);
			if (found) return found;
		}
	}
	return null;
}

beforeEach(() => {
	jest.clearAllMocks();
	jest.useRealTimers();
	mockCurrentLocale = "en";
	mockRecentNetworks = [NETWORK_A, NETWORK_B];
	callOrder.length = 0;
	mockOpen.mockImplementation(async () => {
		callOrder.push("open");
		return {} as unknown;
	});
	mockExportFoundingBundle.mockImplementation(async () => {
		callOrder.push("exportFoundingBundle");
		return { bundle: {}, text: "BUNDLE-TEXT", fileName: "founding-bundle.json" };
	});
	mockCreateDeviceSigner.mockImplementation(async () => {
		callOrder.push("createDeviceSigner");
		return jest.fn(async () => ({ signerUserId: "user-1", signerKey: "key-1", signature: "sig" }));
	});
	mockGetDeviceUser.mockImplementation(async () => {
		callOrder.push("getDeviceUser");
		return { id: "user-1", name: "Officer One", activeKeys: [{ key: "key-1", type: "ed25519" }] };
	});
});

describe("E-1: export entry geometry and accessibility", () => {
	it("each row's export entry is a 44x44+ button, full opacity, icon column sizes to its buttons", async () => {
		const tr = await renderScreen();
		const found = findJsonByTestID(tr.toJSON(), `founding-export-entry-${NETWORK_A.hash}`)!;
		expect(found).toBeTruthy();
		expect(found.node.props.accessibilityRole).toBe("button");
		expect(found.node.props.accessibilityLabel).toBe(resources.en.translation.networkFoundingExportButton);

		const flat = StyleSheet.flatten(found.node.props.style) as Record<string, unknown>;
		expect(flat.minWidth as number).toBeGreaterThanOrEqual(44);
		expect(flat.minHeight as number).toBeGreaterThanOrEqual(44);
		expect(flat.opacity).not.toBe(0.4);

		// The icon column has no fixed height, so every button fits inside it: a fixed 80 held two
		// 44 targets and let the third draw underneath Import Network. No hidden overflow either.
		const iconColumn = found.path[found.path.length - 1] as any;
		const columnFlat = StyleSheet.flatten(iconColumn.props?.style) as Record<string, unknown>;
		expect(columnFlat.height).toBeUndefined();
		expect(columnFlat.maxHeight).toBeUndefined();
		expect(columnFlat.overflow).not.toBe("hidden");
		const columnButtons = (iconColumn.children ?? []) as any[];
		expect(columnButtons).toHaveLength(3);
		for (const button of columnButtons) {
			const buttonFlat = StyleSheet.flatten(button.props?.style) as Record<string, unknown>;
			expect(buttonFlat.minWidth as number).toBeGreaterThanOrEqual(44);
			expect(buttonFlat.minHeight as number).toBeGreaterThanOrEqual(44);
		}
	});
});

describe("E-2: pressing the export entry renders the confirm card directly after its row; dismiss removes it; only one at a time", () => {
	it("renders confirming card with the four resource strings, dismiss removes it", async () => {
		const tr = await renderScreen();
		const entry = findJsonByTestID(tr.toJSON(), `founding-export-entry-${NETWORK_A.hash}`)!;
		const entryComponent = findByProps(tr, (p) => p.testID === `founding-export-entry-${NETWORK_A.hash}`)[0];

		await act(async () => {
			(entryComponent.props as any).onPress();
		});

		const title = findJsonByTestID(tr.toJSON(), "founding-export-title")!;
		const body = findJsonByTestID(tr.toJSON(), "founding-export-body")!;
		expect(title.node.children).toEqual([resources.en.translation.networkFoundingExportConfirmHeading]);
		expect(body.node.children).toEqual([resources.en.translation.networkFoundingExportConfirmBody]);

		// Positional proof: the card must be the NEXT sibling directly after NETWORK_A's own row
		// (not appended after the whole list) — this is the rung m8 proves.
		const card = findJsonByTestID(tr.toJSON(), "founding-export-card")!;
		const cardParent = card.path[card.path.length - 1] as any;
		const siblings = cardParent.children as unknown[];
		const cardIndex = siblings.indexOf(card.node);
		expect(cardIndex).toBeGreaterThan(0);
		expect(containsTestID(siblings[cardIndex - 1], `founding-export-entry-${NETWORK_A.hash}`)).toBe(true);
		// And NETWORK_B's row (the next network in the list) must NOT precede the card.
		expect(containsTestID(siblings[cardIndex - 1], `founding-export-entry-${NETWORK_B.hash}`)).toBe(false);

		const confirmButton = findButton(tr, resources.en.translation.networkFoundingExportShareButton);
		expect(confirmButton).toBeTruthy();
		const dismissButton = findButton(tr, resources.en.translation.networkFoundingExportCancelButton);
		expect(dismissButton).toBeTruthy();

		await act(async () => {
			(dismissButton.props as any).onPress();
		});
		expect(findJsonByTestID(tr.toJSON(), "founding-export-card")).toBeNull();
	});

	it("opening a second row's card replaces the first (only one card at a time)", async () => {
		const tr = await renderScreen();
		const entryA = findByProps(tr, (p) => p.testID === `founding-export-entry-${NETWORK_A.hash}`)[0];
		const entryB = findByProps(tr, (p) => p.testID === `founding-export-entry-${NETWORK_B.hash}`)[0];

		await act(async () => {
			(entryA.props as any).onPress();
		});
		expect(findJsonByTestID(tr.toJSON(), "founding-export-title")!.node.children).toEqual([
			resources.en.translation.networkFoundingExportConfirmHeading,
		]);

		await act(async () => {
			(entryB.props as any).onPress();
		});
		// Still exactly one confirm card in the tree (B's), proving A's card unmounted.
		let count = 0;
		function countTestID(node: unknown): void {
			if (node == null || typeof node === "string") return;
			if (Array.isArray(node)) {
				node.forEach(countTestID);
				return;
			}
			const n = node as { props?: Record<string, unknown>; children?: unknown[] };
			if (n.props?.testID === "founding-export-card") count++;
			(n.children ?? []).forEach(countTestID);
		}
		countTestID(tr.toJSON());
		expect(count).toBe(1);
	});
});

async function openAndConfirm(tr: renderer.ReactTestRenderer, networkRef = NETWORK_A) {
	const entry = findByProps(tr, (p) => p.testID === `founding-export-entry-${networkRef.hash}`)[0];
	await act(async () => {
		(entry.props as any).onPress();
	});
	const confirmButton = findButton(tr, resources.en.translation.networkFoundingExportShareButton);
	await act(async () => {
		(confirmButton.props as any).onPress();
		await Promise.resolve();
	});
}

describe("E-3: confirm -> generating -> export call order -> file written -> ready -> Done closes", () => {
	it("calls createDeviceSigner, getDeviceUser, open(ref,user,false), exportFoundingBundle, writes the file once, shows ready, Done closes the card and the row remains", async () => {
		const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });

		const tr = await renderScreen();
		await openAndConfirm(tr);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(callOrder).toEqual(["createDeviceSigner", "getDeviceUser", "open", "exportFoundingBundle"]);
		expect(mockOpen).toHaveBeenCalledWith(NETWORK_A, { id: "user-1", name: "Officer One", activeKeys: [{ key: "key-1", type: "ed25519" }] }, false);
		expect(mockExportFoundingBundle).toHaveBeenCalledWith(NETWORK_A.hash, {
			userId: "user-1",
			signerKey: "key-1",
			sign: expect.any(Function),
		});
		expect(mockWriteShareFile).toHaveBeenCalledTimes(1);
		expect(mockWriteShareFile).toHaveBeenCalledWith("founding-bundle.json", "BUNDLE-TEXT");
		expect(shareSpy).not.toHaveBeenCalled();

		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-ready")).toBeTruthy();
		const done = findByProps(tr, (p) => p.testID === "founding-export-done" && p.title !== undefined)[0];
		await act(async () => {
			(done.props as any).onPress();
		});

		expect(findJsonByTestID(tr.toJSON(), "founding-export-card")).toBeNull();
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-ready")).toBeNull();
		expect(findJsonByTestID(tr.toJSON(), `founding-export-entry-${NETWORK_A.hash}`)).toBeTruthy();
		shareSpy.mockRestore();
	});
});

describe("E-4: exportFoundingBundle rejection (not-founding-officer) -> error state, logged token only", () => {
	it("renders the error body with retry/dismiss and logs only the code", async () => {
		const spy = jest.spyOn(console, "info").mockImplementation(() => {});
		mockExportFoundingBundle.mockImplementation(async () => {
			throw Object.assign(new Error("not a founding officer"), { code: "not-founding-officer" });
		});

		const tr = await renderScreen();
		await openAndConfirm(tr);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const errorBody = findJsonByTestID(tr.toJSON(), "founding-export-body-error")!;
		expect(errorBody).toBeTruthy();
		const flat = StyleSheet.flatten(errorBody.node.children[0].props.style) as Record<string, unknown>;
		expect(flat.color).toBe(lightTheme.colors.error);
		expect(errorBody.node.children[0].props.numberOfLines).toBeUndefined();
		expect(errorBody.node.children[0].children).toEqual([resources.en.translation.networkFoundingExportError]);

		expect(findButton(tr, resources.en.translation.networkFoundingExportShareButton)).toBeTruthy();
		expect(findButton(tr, resources.en.translation.networkFoundingExportCancelButton)).toBeTruthy();

		const tokenCalls = spy.mock.calls.filter((c) => String(c[0]).includes("not-founding-officer"));
		expect(tokenCalls.length).toBeGreaterThanOrEqual(1);
		spy.mockRestore();
	});
});

describe("E-5: createDeviceSigner CANCELED closes silently; file write rejection -> error; open() timeout -> error", () => {
	it("E-5a: createDeviceSigner rejecting with code CANCELED closes the card silently (no error text)", async () => {
		mockCreateDeviceSigner.mockImplementation(async () => {
			throw Object.assign(new Error("user canceled"), { code: "CANCELED" });
		});

		const tr = await renderScreen();
		await openAndConfirm(tr);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(findJsonByTestID(tr.toJSON(), "founding-export-card")).toBeNull();
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeNull();
		expect(JSON.stringify(tr.toJSON())).not.toContain(resources.en.translation.networkFoundingExportError);
	});

	it("E-5b: a file write failure leads to the error state", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		mockWriteShareFile.mockRejectedValueOnce(new Error("write failed"));
		const tr = await renderScreen();
		await openAndConfirm(tr);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeTruthy();
		info.mockRestore();
	});

	it("E-5c: open() exceeding 45000ms leads to the error state (fake timers)", async () => {
		jest.useFakeTimers();
		mockOpen.mockImplementation(
			() =>
				new Promise(() => {
					/* never resolves */
				}),
		);

		const tr = await renderScreen();
		const entry = findByProps(tr, (p) => p.testID === `founding-export-entry-${NETWORK_A.hash}`)[0];
		await act(async () => {
			(entry.props as any).onPress();
		});
		const confirmButton = findButton(tr, resources.en.translation.networkFoundingExportShareButton);
		await act(async () => {
			(confirmButton.props as any).onPress();
		});

		await act(async () => {
			jest.advanceTimersByTime(45001);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeTruthy();
		jest.useRealTimers();
	});
});

// Signer codes raised INSIDE sign() during the export (the real on-device seam: the biometric prompt
// runs inside the signer callback, after createDeviceSigner has resolved). mockExportFoundingBundle
// models the post-62-91 engine: it awaits exporter.sign(...) and lets the rejection propagate
// unchanged. These pass against the card's existing routing (it was already correct; the RED half of
// this gap is 62-91 Task 1's engine specs), so no RED-first claim is made here.
describe("E-5d..g: signer codes raised inside sign() are routed by code", () => {
	const exportRejectingFromSign = (rejection: unknown) => {
		mockCreateDeviceSigner.mockImplementation(async () => {
			callOrder.push("createDeviceSigner");
			return jest.fn(async () => {
				throw rejection;
			});
		});
		mockExportFoundingBundle.mockImplementation(async (...args: unknown[]) => {
			const opts = args.find((a) => typeof (a as { sign?: unknown })?.sign === "function") as
				| { sign: (d: Uint8Array) => Promise<unknown> }
				| undefined;
			// Fall back to the signer passed positionally, whatever the engine signature is.
			const sign = opts?.sign ?? (args.find((a) => typeof a === "function") as ((d: Uint8Array) => Promise<unknown>) | undefined);
			if (!sign) throw new Error("test seam: no sign callback passed to exportFoundingBundle");
			await sign(new Uint8Array(32));
			return { bundle: {}, text: "BUNDLE-TEXT", fileName: "founding-bundle.json" };
		});
	};
	const run = async () => {
		const tr = await renderScreen();
		await openAndConfirm(tr);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		return tr;
	};

	it("E-5d: sign() rejecting CANCELED closes the card silently, no navigate", async () => {
		exportRejectingFromSign(Object.assign(new Error("user canceled"), { code: "CANCELED" }));
		const tr = await run();
		expect(mockExportFoundingBundle).toHaveBeenCalled();
		expect(findJsonByTestID(tr.toJSON(), "founding-export-card")).toBeNull();
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeNull();
		expect(JSON.stringify(tr.toJSON())).not.toContain(resources.en.translation.networkFoundingExportError);
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it("E-5e: sign() rejecting KEY_INVALIDATED_REASSOCIATE opens ProvisionSigningKey and closes the card", async () => {
		exportRejectingFromSign(Object.assign(new Error("desync"), { code: "KEY_INVALIDATED_REASSOCIATE" }));
		const tr = await run();
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "invalidated" });
		expect(findJsonByTestID(tr.toJSON(), "founding-export-card")).toBeNull();
	});

	it("E-5f: sign() rejecting LOCKOUT shows the lockout copy under the generic heading", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		exportRejectingFromSign(Object.assign(new Error("locked"), { code: "LOCKOUT" }));
		const tr = await run();
		const { CODE_TO_CLASS, DEVICE_SIGNING_ERROR_COPY_KEY } = require("../../../utils/deviceSigningError");
		const copyKey = DEVICE_SIGNING_ERROR_COPY_KEY[CODE_TO_CLASS.LOCKOUT] as string;
		const lockoutCopy = (resources.en.translation as Record<string, string>)[copyKey];
		expect(typeof lockoutCopy).toBe("string");
		const json = JSON.stringify(tr.toJSON());
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeTruthy();
		expect(json).toContain(resources.en.translation.networkFoundingExportError);
		expect(json).toContain(lockoutCopy);
		expect(mockNavigate).not.toHaveBeenCalled();
		info.mockRestore();
	});

	it("E-5g (negative control): an engine signature-self-check shows the generic error, no navigate, card stays open", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		mockExportFoundingBundle.mockImplementation(async () => {
			throw Object.assign(new Error("self check"), { name: "FoundingBundleExportError", code: "signature-self-check" });
		});
		const tr = await run();
		// The error body is the open card (it stays open with retry/dismiss).
		expect(findJsonByTestID(tr.toJSON(), "founding-export-body-error")).toBeTruthy();
		expect(JSON.stringify(tr.toJSON())).toContain(resources.en.translation.networkFoundingExportError);
		expect(mockNavigate).not.toHaveBeenCalled();
		info.mockRestore();
	});
});

describe("E-6: Import Network button renders with zero and with recent networks, navigates to ImportFoundingBundle", () => {
	it("renders and navigates with zero recent networks", async () => {
		mockRecentNetworks = [];
		const tr = await renderScreen();
		const importButton = findButton(tr, resources.en.translation.networkFoundingImportButton);
		expect(importButton).toBeTruthy();
		await act(async () => {
			(importButton.props as any).onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("ImportFoundingBundle");
	});

	it("renders and navigates with two recent networks", async () => {
		mockRecentNetworks = [NETWORK_A, NETWORK_B];
		const tr = await renderScreen();
		const importButton = findButton(tr, resources.en.translation.networkFoundingImportButton);
		expect(importButton).toBeTruthy();
		await act(async () => {
			(importButton.props as any).onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith("ImportFoundingBundle");
	});
});

describe("V-1 (spike 100): each row's Invite voters entry opens that row's invite card", () => {
	it("is a labelled button, and opens the card (here: no CadreNode yet, so the card's error body)", async () => {
		const tr = await renderScreen();
		const entry = findByProps(tr, (p) => p.testID === `voter-invite-entry-${NETWORK_A.hash}`)[0];
		expect(entry.props.accessibilityRole).toBe("button");
		expect(entry.props.accessibilityLabel).toBe("Invite voters");
		await act(async () => {
			entry.props.onPress();
		});
		for (let i = 0; i < 6; i++) {
			// eslint-disable-next-line no-await-in-loop
			await act(async () => {
				await Promise.resolve();
			});
		}
		expect(findJsonByTestID(tr.toJSON(), "voter-invite-body-error")).toBeTruthy();
	});
});
