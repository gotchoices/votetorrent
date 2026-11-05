/**
 * FoundingBundleExportCard.file.test.tsx — the file handoff after the single biometric export
 * (D-35, D-36, D-37). Real LifecycleConfirmCard and real i18n resources; the native file seam,
 * the document picker, Share, device-signer/device-user and useApp are mocked.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { Platform } from "react-native";
import { resources } from "../../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../../../theme/themes");
		return theme;
	},
}));

const mockExport = jest.fn();
const mockNetworksEngine = { open: jest.fn(async () => ({})), exportFoundingBundle: (...a: unknown[]) => mockExport(...a) };
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine }),
}));

const mockCreateSigner = jest.fn();
jest.mock("../../../../engines/device-signer", () => ({ createDeviceSigner: () => mockCreateSigner() }));
jest.mock("../../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "O", activeKeys: [{ key: "key-1", type: "ed25519" }] }),
}));

const mockWrite = jest.fn();
const mockShareAndroid = jest.fn();
jest.mock("@votetorrent/attestation-native", () => {
	const actual = jest.requireActual("@votetorrent/attestation-native");
	return {
		...actual,
		writeShareFile: (...a: unknown[]) => mockWrite(...a),
		shareFileAndroid: (...a: unknown[]) => mockShareAndroid(...a),
	};
});

const mockSave = jest.fn();
// `loadFails` makes the picker module itself fail to load (its TurboModule absent from the binary).
// jest never caches a factory that throws, but it DOES cache the first successful load for the rest
// of the file, so the load-failure test is declared FIRST in this file (before any test has loaded
// the picker) and counts `loadThrows` to prove the require really threw. `jest.resetModules()` and
// `jest.isolateModules` are not used: the first loads a second React for later tests, and the second
// still falls through to the file-wide mock cache.
const mockPickerState = { loadFails: false, loadThrows: 0 };
jest.mock("@react-native-documents/picker", () => {
	if (mockPickerState.loadFails) {
		mockPickerState.loadThrows += 1;
		throw new Error("RNDocumentPicker TurboModule is not registered");
	}
	return {
		saveDocuments: (...a: unknown[]) => mockSave(...a),
		errorCodes: { OPERATION_CANCELED: "OPERATION_CANCELED" },
		isErrorWithCode: (e: any) => typeof e?.code === "string",
	};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FoundingBundleExportCard } = require("../FoundingBundleExportCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FileShareError } = require("@votetorrent/attestation-native");

const T = resources.en.translation;
const REF = { hash: "hashA", name: "Network A", primaryAuthorityDomainName: "a.example" };
const URI = "file:///cache/founding-bundle.json";
const FILE = "founding-bundle.json";
const TEXT = "BUNDLE-TEXT-SECRET";
const FP = "a1b2 c3d4 e5f6 0718";

function setOS(os: "android" | "ios") {
	Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
}

const flush = async () => {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
};

function byTestID(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAll((n) => n.props.testID === id && n.props.title !== undefined && typeof n.props.onPress === "function");
}
function exists(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAll((n) => n.props.testID === id).length > 0;
}
async function press(tr: renderer.ReactTestRenderer, id: string) {
	await act(async () => {
		(byTestID(tr, id)[0].props as any).onPress();
	});
	await flush();
}

async function renderReady(onClose = jest.fn()) {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<FoundingBundleExportCard networkRef={REF} onClose={onClose} />);
	});
	const confirm = tr.root.findAll(
		(n) => n.props.title === T.networkFoundingExportShareButton && typeof n.props.onPress === "function",
	);
	await act(async () => {
		(confirm[0].props as any).onPress();
	});
	await flush();
	return { tr, onClose };
}

let shareSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	setOS("android");
	shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
	mockCreateSigner.mockImplementation(async () => jest.fn());
	mockExport.mockImplementation(async () => ({ bundle: {}, text: TEXT, fileName: FILE, fingerprint: FP }));
	mockWrite.mockImplementation(async () => URI);
	mockShareAndroid.mockImplementation(async () => undefined);
	mockSave.mockImplementation(async () => [{ uri: "content://x", name: FILE, error: null }]);
});

afterEach(() => {
	shareSpy.mockRestore();
	mockPickerState.loadFails = false;
});

// Declared first on purpose: see the picker mock above (the first successful load is cached).
describe("IN-07: Save to this phone when the picker module cannot load", () => {
	it("stays ready with an inline error and no unhandled rejection", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const { tr } = await renderReady();
			mockPickerState.loadFails = true;
			mockPickerState.loadThrows = 0;
			let pending!: Promise<unknown>;
			await act(async () => {
				pending = (byTestID(tr, "founding-export-save-file")[0].props as any).onPress();
			});
			await expect(pending).resolves.toBeUndefined();
			await flush();
			// Both the save prologue's require and the catch's cancel check hit the failing load.
			expect(mockPickerState.loadThrows).toBe(2);
			expect(mockSave).not.toHaveBeenCalled();
			// A save failure keeps the written file: still ready, with an inline error.
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(exists(tr, "founding-export-body-error")).toBe(false);
			expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaveFailed);
			expect(info).toHaveBeenCalledWith("[founding-bundle] export: failed");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			info.mockRestore();
		}
	});
});

describe("FoundingBundleExportCard file handoff", () => {
	it("1: android ready state after a single export and file write", async () => {
		const { tr } = await renderReady();
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);
		expect(mockExport).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledWith(FILE, TEXT);
		expect(byTestID(tr, "founding-export-share-file")).toHaveLength(1);
		expect(byTestID(tr, "founding-export-save-file")).toHaveLength(1);
		expect(byTestID(tr, "founding-export-done")).toHaveLength(1);
	});

	it("2: Share file uses the Android file share, never the text share", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-share-file");
		expect(mockShareAndroid).toHaveBeenCalledTimes(1);
		expect(mockShareAndroid).toHaveBeenCalledWith(URI, {
			mimeType: "application/json",
			subject: FILE,
			dialogTitle: T.networkFoundingExportShareButton,
		});
		expect(shareSpy).not.toHaveBeenCalled();
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
	});

	it("3: Save to this phone saves the file; a cancel stays ready with no error", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-save-file");
		expect(mockSave).toHaveBeenCalledWith({ sourceUris: [URI], fileName: FILE, mimeType: "application/json" });
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaved);

		mockSave.mockImplementation(async () => {
			throw Object.assign(new Error("cancel"), { code: "OPERATION_CANCELED" });
		});
		await press(tr, "founding-export-save-file");
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
		expect(exists(tr, "founding-export-body-error")).toBe(false);
	});

	it("4: share then save reuse the single export and signer", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-share-file");
		await press(tr, "founding-export-save-file");
		expect(mockExport).toHaveBeenCalledTimes(1);
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledTimes(1);
	});

	it("5: ios shows Share file and Done only; Share file uses the url share", async () => {
		setOS("ios");
		const { tr } = await renderReady();
		expect(byTestID(tr, "founding-export-save-file")).toHaveLength(0);
		expect(byTestID(tr, "founding-export-done")).toHaveLength(1);
		await press(tr, "founding-export-share-file");
		expect(shareSpy).toHaveBeenCalledWith({ url: URI, title: FILE });
		expect(mockShareAndroid).not.toHaveBeenCalled();
	});

	it("6a: unavailable seam falls back to the text share with a visible notice", async () => {
		mockWrite.mockImplementation(async () => {
			throw new FileShareError("unavailable", "no native");
		});
		const { tr } = await renderReady();
		expect(shareSpy).toHaveBeenCalledTimes(1);
		expect(shareSpy.mock.calls[0][0]).toEqual({ message: TEXT, title: FILE });
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportTextFallback);
	});

	it("6b: any other file error goes to the error state with no text share", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		mockWrite.mockImplementation(async () => {
			throw new FileShareError("write-failed", "disk");
		});
		const { tr } = await renderReady();
		expect(exists(tr, "founding-export-body-error")).toBe(true);
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportError);
		expect(shareSpy).not.toHaveBeenCalled();
		expect(JSON.stringify(tr.toJSON())).not.toContain(T.networkFoundingExportTextFallback);
		info.mockRestore();
	});

	it("7: no rendered text contains the bundle text, hash or file uri; the file name may appear", async () => {
		const { tr } = await renderReady();
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain(TEXT);
		expect(json).not.toContain(URI);
		expect(json).not.toContain(REF.hash);
		expect(json).toContain(FILE);
	});

	describe("WR-05: every share rejection is reported inline and keeps the file", () => {
		let info: jest.SpyInstance;
		beforeEach(() => {
			info = jest.spyOn(console, "info").mockImplementation(() => {});
		});
		afterEach(() => {
			info.mockRestore();
		});

		it("ios: a Share.share rejection stays ready with an inline error and is logged", async () => {
			setOS("ios");
			const { tr } = await renderReady();
			shareSpy.mockRejectedValue(new Error("cannot present"));
			await press(tr, "founding-export-share-file");
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(exists(tr, "founding-export-body-error")).toBe(false);
			expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportShareFailed);
			expect(info).toHaveBeenCalledWith("[founding-bundle] export: failed");
		});

		it("ios: a dismissed share sheet stays ready with no error", async () => {
			setOS("ios");
			const { tr } = await renderReady();
			shareSpy.mockResolvedValue({ action: "dismissedAction" });
			await press(tr, "founding-export-share-file");
			expect(shareSpy).toHaveBeenCalledWith({ url: URI, title: FILE });
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(exists(tr, "founding-export-body-error")).toBe(false);
		});

		it("android: a share-failed FileShareError stays ready with an inline error", async () => {
			const { tr } = await renderReady();
			mockShareAndroid.mockImplementation(async () => {
				throw new FileShareError("share-failed", "no activity");
			});
			await press(tr, "founding-export-share-file");
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportShareFailed);
			expect(info).toHaveBeenCalledWith("[founding-bundle] export: share-failed");
		});

		it("android: a plain Error from the file share stays ready with an inline error", async () => {
			const { tr } = await renderReady();
			mockShareAndroid.mockImplementation(async () => {
				throw new Error("bridge exploded");
			});
			await press(tr, "founding-export-share-file");
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportShareFailed);
			expect(info).toHaveBeenCalledWith("[founding-bundle] export: failed");
		});

		it("unmounted before the share rejection settles: no state update", async () => {
			const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
			try {
				let rejectShare!: (e: unknown) => void;
				const { tr } = await renderReady();
				mockShareAndroid.mockImplementation(
					() =>
						new Promise<void>((_resolve, reject) => {
							rejectShare = reject;
						}),
				);
				let pending!: Promise<unknown>;
				await act(async () => {
					pending = (byTestID(tr, "founding-export-share-file")[0].props as any).onPress();
				});
				await act(async () => {
					tr.unmount();
				});
				rejectShare(new FileShareError("share-failed", "late"));
				await expect(pending).resolves.toBeUndefined();
				await flush();
				expect(info).toHaveBeenCalledWith("[founding-bundle] export: share-failed");
				expect(errSpy).not.toHaveBeenCalled();
			} finally {
				errSpy.mockRestore();
			}
		});
	});

	describe("IN-07: a user cancel is still not an error", () => {
		it("a user cancel from the picker stays ready with no error", async () => {
			const { tr } = await renderReady();
			mockSave.mockImplementation(async () => {
				throw Object.assign(new Error("cancel"), { code: "OPERATION_CANCELED" });
			});
			await press(tr, "founding-export-save-file");
			expect(exists(tr, "founding-export-body-ready")).toBe(true);
			expect(exists(tr, "founding-export-body-error")).toBe(false);
		});
	});

	it("Done closes the card", async () => {
		const { tr, onClose } = await renderReady();
		await press(tr, "founding-export-done");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

// Signer codes raised inside sign() (the prompt runs there). These pass against today's card routing;
// the RED half of this gap is the engine specs, so no RED-first claim is made here.
describe("signer codes raised inside sign() during export", () => {
	const rejectFromSign = (code: string) => {
		mockCreateSigner.mockImplementation(async () =>
			jest.fn(async () => {
				throw Object.assign(new Error(code), { code });
			}),
		);
		mockExport.mockImplementation(async (_hash: string, opts: { sign: (d: Uint8Array) => Promise<unknown> }) => {
			await opts.sign(new Uint8Array(32));
			return { bundle: {}, text: TEXT, fileName: FILE, fingerprint: FP };
		});
	};

	it("CANCELED closes the card without an error", async () => {
		rejectFromSign("CANCELED");
		const { tr, onClose } = await renderReady();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(exists(tr, "founding-export-body-error")).toBe(false);
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it("KEY_INVALIDATED_REASSOCIATE navigates to ProvisionSigningKey and closes", async () => {
		rejectFromSign("KEY_INVALIDATED_REASSOCIATE");
		const { onClose } = await renderReady();
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "invalidated" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("the exporter reads the fingerprint out", () => {
	it("ready shows the label, the fingerprint and the help (file path)", async () => {
		const { tr } = await renderReady();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(T.networkFoundingExportFingerprintLabel);
		expect(json).toContain(T.networkFoundingExportFingerprintHelp);
		const node = tr.root.findAll((n) => n.props.testID === "founding-export-fingerprint" && typeof n.type === "string");
		expect(node).toHaveLength(1);
		expect(JSON.stringify(node[0].props.children)).toContain(FP);
	});

	it("the text-fallback ready body shows them too", async () => {
		mockWrite.mockImplementation(async () => {
			throw new FileShareError("unavailable", "no native");
		});
		const { tr } = await renderReady();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(T.networkFoundingExportTextFallback);
		expect(json).toContain(T.networkFoundingExportFingerprintLabel);
		expect(json).toContain(FP);
	});
});

describe("REVIEW/IN-09: a share or save failure keeps the written file", () => {
	let info: jest.SpyInstance;
	beforeEach(() => {
		info = jest.spyOn(console, "info").mockImplementation(() => {});
	});
	afterEach(() => {
		info.mockRestore();
	});

	it("android: a failed share stays ready; the retry shares the SAME uri with no new signature or export", async () => {
		const { tr } = await renderReady();
		mockShareAndroid.mockImplementationOnce(async () => {
			throw new FileShareError("share-failed", "no activity");
		});
		await press(tr, "founding-export-share-file");
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportShareFailed);

		await press(tr, "founding-export-share-file");
		expect(mockShareAndroid).toHaveBeenCalledTimes(2);
		expect(mockShareAndroid.mock.calls[1][0]).toBe(URI);
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);
		expect(mockExport).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(tr.toJSON())).not.toContain(T.networkFoundingExportShareFailed);
	});

	it("a save failure (per-file error result) stays ready with the save-failed copy", async () => {
		const { tr } = await renderReady();
		mockSave.mockImplementation(async () => [{ uri: "content://x", name: FILE, error: "disk full" }]);
		await press(tr, "founding-export-save-file");
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
		expect(exists(tr, "founding-export-body-error")).toBe(false);
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaveFailed);
		expect(JSON.stringify(tr.toJSON())).not.toContain(T.networkFoundingExportSaved);
	});

	it("a saved file clears an earlier inline failure", async () => {
		const { tr } = await renderReady();
		mockSave.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		await press(tr, "founding-export-save-file");
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaveFailed);
		await press(tr, "founding-export-save-file");
		expect(JSON.stringify(tr.toJSON())).not.toContain(T.networkFoundingExportSaveFailed);
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaved);
	});
});

describe("initial/G3 WR-09: a card that unmounted while its network was opening does nothing", () => {
	async function startExport(onClose: jest.Mock) {
		let tr!: renderer.ReactTestRenderer;
		await act(async () => {
			tr = renderer.create(<FoundingBundleExportCard networkRef={REF} onClose={onClose} />);
		});
		const confirm = tr.root.findAll(
			(n) => n.props.title === T.networkFoundingExportShareButton && typeof n.props.onPress === "function",
		);
		await act(async () => {
			(confirm[0].props as any).onPress();
		});
		return tr;
	}

	it("open resolves after unmount: no export, no share, no onClose; the other card stays", async () => {
		let resolveOpen!: (v: unknown) => void;
		mockNetworksEngine.open.mockImplementationOnce(() => new Promise((resolve) => (resolveOpen = resolve)) as any);
		const closeA = jest.fn();
		const trA = await startExport(closeA);
		await flush();
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);

		await act(async () => {
			trA.unmount();
		});
		let trB!: renderer.ReactTestRenderer;
		await act(async () => {
			trB = renderer.create(<FoundingBundleExportCard networkRef={REF} onClose={jest.fn()} />);
		});

		await act(async () => {
			resolveOpen({});
		});
		await flush();
		expect(mockExport).not.toHaveBeenCalled();
		expect(shareSpy).not.toHaveBeenCalled();
		expect(mockWrite).not.toHaveBeenCalled();
		expect(closeA).not.toHaveBeenCalled();
		expect(exists(trB, "founding-export-body-ready")).toBe(false);
		expect(JSON.stringify(trB.toJSON())).toContain(T.networkFoundingExportConfirmHeading);
	});

	it("a handled signing error after unmount does not close another card", async () => {
		let rejectOpen!: (e: unknown) => void;
		mockNetworksEngine.open.mockImplementationOnce(
			() => new Promise((_resolve, reject) => (rejectOpen = reject)) as any,
		);
		const closeA = jest.fn();
		const trA = await startExport(closeA);
		await flush();
		await act(async () => {
			trA.unmount();
		});
		await act(async () => {
			rejectOpen(Object.assign(new Error("CANCELED"), { code: "CANCELED" }));
		});
		await flush();
		expect(closeA).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it("the text fallback never shares after an unmount during the file write", async () => {
		let rejectWrite!: (e: unknown) => void;
		mockWrite.mockImplementation(() => new Promise((_resolve, reject) => (rejectWrite = reject)));
		const trA = await startExport(jest.fn());
		await flush();
		expect(mockExport).toHaveBeenCalledTimes(1);
		await act(async () => {
			trA.unmount();
		});
		await act(async () => {
			rejectWrite(new FileShareError("unavailable", "no native"));
		});
		await flush();
		expect(shareSpy).not.toHaveBeenCalled();
	});
});
