/**
 * ImportFoundingBundleScreen.test.tsx — M-1, S-1..S-9 (D-35, D-36, D-37).
 *
 * Mounts the REAL screen. `t()` resolves against the REAL `resources` from `src/i18n/index.ts`
 * for both `en` and `es` (mirrors `ThresholdProgressNote.test.tsx`'s `mockCurrentLocale`
 * convention); `useTheme()` returns the REAL `lightTheme.colors`. Geometry assertions walk the
 * RENDERED JSON tree (`StyleSheet.flatten`), mirroring `ThresholdProgressNote.test.tsx`'s
 * `findJsonByTestID`/ancestor-walk and `button-radius-padding.test.tsx`'s flatten convention.
 * Button PRESSES go through `tr.root.findAll` against the `CustomButton` REACT element (its
 * `onPress` prop is the real handler) — `CustomButton`'s rendered `TouchableOpacity` host node
 * does not expose a callable `onPress` prop in the JSON tree (Pressability consumes it
 * internally), only `accessibilityLabel`/`accessibilityRole`/style, which the JSON assertions use.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { lightTheme } from "../../../theme/themes";
import { resources } from "../../../i18n";
import { mapFoundingImportResult, isCompleteFingerprintInput } from "../foundingBundleState";
import type { FoundingBundleImportResult } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockCurrentLocale: "en" | "es" = "en";

// WR-R3-07: the IME inset the screen must add under forced edge-to-edge (0 = keyboard dismissed).
let mockKeyboardInset = 0;
jest.mock("../../../hooks/useKeyboardInset", () => ({
	useKeyboardInset: () => mockKeyboardInset,
}));

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
// Recorded so a test can simulate a RE-focus (UAT 62 P2b) by invoking the latest callback.
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../../theme/themes");
		return theme;
	},
	useNavigation: () => ({ navigate: mockNavigate }),
	// First focus on mount, like the real hook.
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

let mockNetworksEngine: { importFoundingBundle: jest.Mock; inspectFoundingBundle?: jest.Mock } | undefined;
const mockSelectNetwork = jest.fn(async () => undefined);
// Tests that only care about the import result get a default "valid file" inspection.
const mockDefaultInspect = jest.fn(async () => ({ ok: true, networkName: "Test Network" }));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		networksEngine: mockNetworksEngine
			? { inspectFoundingBundle: mockDefaultInspect, ...mockNetworksEngine }
			: undefined,
		selectNetwork: mockSelectNetwork,
	}),
}));

const mockGetDeviceUser = jest.fn(async () => ({ id: "user-1" }));
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: () => mockGetDeviceUser(),
}));

const mockPickFoundingBundleFile = jest.fn();
jest.mock("../../../engines/pick-founding-bundle-file", () => ({
	pickFoundingBundleFile: (...args: unknown[]) => mockPickFoundingBundleFile(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ImportFoundingBundleScreen = require("../ImportFoundingBundleScreen").default;

const NETWORK_REF = { hash: "netHash1", name: "Test Network", primaryAuthorityDomainName: "authority.example" };

// The file's fingerprint. The picked text below carries it ONLY inside its digest, so any app code
// that derived a fingerprint from the file would produce this value.
const F = "a1b2 c3d4 e5f6 0718";
const F_COMPACT = "a1b2c3d4e5f60718";
const BUNDLE_TEXT = JSON.stringify({
	formatVersion: 1,
	digest: Buffer.concat([Buffer.from(F_COMPACT, "hex"), Buffer.alloc(24)]).toString("base64url"),
});

function okResult(outcome: "replayed" | "already-present"): FoundingBundleImportResult {
	return { ok: true, outcome, fingerprint: F, networkRef: NETWORK_REF as any, network: {} as any };
}
function anchorResult(reason: "anchor-mismatch" | "anchor-required"): FoundingBundleImportResult {
	return { ok: false, reason, category: "invalid-bundle", detail: "fixed" };
}
/** An engine whose import compares the typed anchor with F, like the real one. */
function comparingEngine() {
	return {
		inspectFoundingBundle: jest.fn(async () => ({ ok: true, networkName: "Test Network" })),
		importFoundingBundle: jest.fn(async (_text: string, _user: unknown, options?: { expectedFingerprint?: string }) => {
			const typed = options?.expectedFingerprint;
			if (typeof typed !== "string") return anchorResult("anchor-required");
			const norm = typed.toLowerCase().replace(/[\s-]+/g, "");
			return norm === F_COMPACT ? okResult("replayed") : anchorResult("anchor-mismatch");
		}),
	};
}
function alreadyJoinedResult(): FoundingBundleImportResult {
	return { ok: false, reason: "already-joined", category: "already-joined", networkRef: NETWORK_REF as any };
}
function invalidBundleResult(): FoundingBundleImportResult {
	return { ok: false, reason: "signature-invalid", category: "invalid-bundle", detail: "d" };
}
function errorResult(): FoundingBundleImportResult {
	return { ok: false, reason: "target-open-failed", category: "error", detail: "d" };
}

async function mount() {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<ImportFoundingBundleScreen />);
	});
	return tr;
}

/** Finds the CustomButton REACT element (not its rendered host node) by its resolved title. */
function findButton(tr: renderer.ReactTestRenderer, title: string) {
	const matches = tr.root.findAll(
		(n) => typeof (n.props as any)?.title === "string" && (n.props as any).title === title && typeof (n.props as any).onPress === "function",
	);
	expect(matches.length).toBeGreaterThan(0);
	return matches[0];
}

async function pressButton(tr: renderer.ReactTestRenderer, title: string) {
	const button = findButton(tr, title);
	await act(async () => {
		(button.props as any).onPress();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

function findJsonByTestID(
	node: unknown,
	testID: string,
	path: unknown[] = [],
): { node: any; path: any[] } | null {
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

/** True if any descendant (inclusive) carries accessibilityRole === 'button'. */
function hasButtonDescendant(node: unknown): boolean {
	if (node == null || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some(hasButtonDescendant);
	const n = node as { props?: Record<string, unknown>; children?: unknown[] };
	if (n.props?.accessibilityRole === "button") return true;
	return (n.children ?? []).some(hasButtonDescendant);
}

const STATES = ["idle", "picking", "validating", "invalidSignature", "alreadyJoined", "success", "genericError"];

beforeEach(() => {
	jest.clearAllMocks();
	// clearAllMocks keeps unconsumed *Once values; drop them so one test's queue never leaks into the next.
	mockSelectNetwork.mockReset();
	mockSelectNetwork.mockImplementation(async () => undefined);
	mockCurrentLocale = "en";
	mockKeyboardInset = 0;
	mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
	mockGetDeviceUser.mockImplementation(async () => ({ id: "user-1" } as any));
});

describe("M-1: mapFoundingImportResult — exhaustive 62-16 category map", () => {
	it("ok replayed -> success (carries networkRef)", () => {
		expect(mapFoundingImportResult(okResult("replayed"))).toEqual({ state: "success", networkRef: NETWORK_REF, fingerprint: F });
	});
	it("ok already-present -> success (carries networkRef)", () => {
		expect(mapFoundingImportResult(okResult("already-present"))).toEqual({
			state: "success",
			networkRef: NETWORK_REF,
			fingerprint: F,
		});
	});
	it("category already-joined -> alreadyJoined (carries networkRef)", () => {
		expect(mapFoundingImportResult(alreadyJoinedResult())).toEqual({
			state: "alreadyJoined",
			networkRef: NETWORK_REF,
		});
	});
	it("category invalid-bundle -> invalidSignature", () => {
		expect(mapFoundingImportResult(invalidBundleResult())).toEqual({ state: "invalidSignature" });
	});
	it("category error -> genericError", () => {
		expect(mapFoundingImportResult(errorResult())).toEqual({ state: "genericError" });
	});
	it("reason anchor-mismatch -> fingerprintMismatch, anchor-required -> anchorRequired (before the category branch)", () => {
		expect(mapFoundingImportResult(anchorResult("anchor-mismatch"))).toEqual({ state: "fingerprintMismatch" });
		expect(mapFoundingImportResult(anchorResult("anchor-required"))).toEqual({ state: "anchorRequired" });
	});
	it("isCompleteFingerprintInput: 16 hex after lowercasing and stripping spaces/dashes", () => {
		expect(isCompleteFingerprintInput("A1B2-C3D4 e5f6 0718")).toBe(true);
		expect(isCompleteFingerprintInput("a1b2c3d4e5f6071")).toBe(false);
		expect(isCompleteFingerprintInput("a1b2c3d4e5f60718a")).toBe(false);
		expect(isCompleteFingerprintInput("g1b2c3d4e5f60718")).toBe(false);
	});
});

describe("S-1: each of the seven states renders exactly one body and none of the other six", () => {
	it("idle renders only founding-import-body-idle", async () => {
		const tr = await mount();
		const json = tr.toJSON();
		for (const state of STATES) {
			const found = findJsonByTestID(json, `founding-import-body-${state}`);
			if (state === "idle") expect(found).toBeTruthy();
			else expect(found).toBeNull();
		}
	});

	it("every one of the seven states renders a DISTINCT testID (no two states share a body) — this is the rung m4 proves", async () => {
		const observedTestIDs: Record<string, string> = {};

		async function reach(state: string, engineResult: FoundingBundleImportResult | "hold-validating"): Promise<void> {
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			mockNetworksEngine =
				engineResult === "hold-validating"
					? { importFoundingBundle: jest.fn(() => new Promise(() => {})) }
					: { importFoundingBundle: jest.fn(async () => engineResult) };
			const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
			const json = tr.toJSON();
			// Find whichever of the seven testIDs actually rendered.
			for (const candidate of STATES) {
				const found = findJsonByTestID(json, `founding-import-body-${candidate}`);
				if (found) {
					observedTestIDs[state] = `founding-import-body-${candidate}`;
					return;
				}
			}
			throw new Error(`reach(${state}): no founding-import-body-* testID rendered`);
		}

		// idle and picking need their own direct paths (no engine result applies).
		{
			const tr = await mount();
			observedTestIDs.idle = findJsonByTestID(tr.toJSON(), "founding-import-body-idle") ? "founding-import-body-idle" : "MISSING";
		}
		{
			let resolvePick!: (v: unknown) => void;
			mockPickFoundingBundleFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
			const tr = await mount();
			await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
			observedTestIDs.picking = findJsonByTestID(tr.toJSON(), "founding-import-body-picking")
				? "founding-import-body-picking"
				: "MISSING";
			await act(async () => {
				resolvePick({ kind: "cancelled" });
				await Promise.resolve();
			});
		}

		await reach("validating", "hold-validating");
		await reach("invalidSignature", invalidBundleResult());
		await reach("alreadyJoined", alreadyJoinedResult());
		await reach("success", okResult("replayed"));
		await reach("genericError", errorResult());

		const values = Object.values(observedTestIDs);
		expect(new Set(values).size).toBe(values.length);
		for (const state of STATES) {
			expect(observedTestIDs[state]).toBe(`founding-import-body-${state}`);
		}
	});
});

describe("S-2: idle -> picking flow, guarded against a double tap", () => {
	it("idle shows the Choose File button (accent); pressing it moves to picking (empty body); a concurrent second call does not invoke the picker twice", async () => {
		let resolvePick!: (v: unknown) => void;
		mockPickFoundingBundleFile.mockReturnValue(
			new Promise((resolve) => {
				resolvePick = resolve;
			}),
		);

		const tr = await mount();
		const idleBody = findJsonByTestID(tr.toJSON(), "founding-import-body-idle")!.node;
		const buttonHost = idleBody.children.find((c: any) => c?.props?.accessibilityRole === "button");
		expect(buttonHost.props.accessibilityLabel).toBe(resources.en.translation.networkFoundingImportChooseFileButton);
		const flat = StyleSheet.flatten(buttonHost.props.style) as Record<string, unknown>;
		expect(flat.backgroundColor).toBe(lightTheme.colors.accent);

		const button = findButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
		await act(async () => {
			(button.props as any).onPress();
			(button.props as any).onPress();
			await Promise.resolve();
		});

		expect(mockPickFoundingBundleFile).toHaveBeenCalledTimes(1);
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-picking")).toBeTruthy();

		await act(async () => {
			resolvePick({ kind: "cancelled" });
			await Promise.resolve();
		});
	});
});

describe("S-3: validating shows the validating copy and contains no pressable element", () => {
	it("renders networkFoundingImportValidating with no button", async () => {
		let resolvePick!: (v: unknown) => void;
		mockPickFoundingBundleFile.mockReturnValue(
			new Promise((resolve) => {
				resolvePick = resolve;
			}),
		);
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(
				() =>
					new Promise(() => {
						/* never resolves — hold at validating */
					}),
			),
		};

		const tr = await mount();
		await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
		await act(async () => {
			resolvePick({ kind: "picked", text: "bundle-text" });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		await completeJoin(tr);

		const validatingBody = findJsonByTestID(tr.toJSON(), "founding-import-body-validating")!.node;
		expect(validatingBody).toBeTruthy();
		const text = validatingBody.children[0];
		expect(text.children).toEqual([resources.en.translation.networkFoundingImportValidating]);
		expect(hasButtonDescendant(validatingBody)).toBe(false);
	});
});

describe("S-4: the picked text is inspected, then (after the typed fingerprint) passed unchanged to the import", () => {
	it("inspects first; Join calls importFoundingBundle(text, deviceUser, { expectedFingerprint }) exactly once, no expectedDigest", async () => {
		mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "SENTINEL-BUNDLE-TEXT" });
		mockGetDeviceUser.mockResolvedValue({ id: "user-xyz" } as any);
		const engine = comparingEngine();
		mockNetworksEngine = engine;

		const tr = await mount();
		await pressButton(tr, CHOOSE());
		expect(engine.inspectFoundingBundle).toHaveBeenCalledWith("SENTINEL-BUNDLE-TEXT");
		expect(engine.importFoundingBundle).not.toHaveBeenCalled();

		await completeJoin(tr, "A1B2-C3D4 e5f6 0718");
		expect(engine.importFoundingBundle).toHaveBeenCalledTimes(1);
		const [text, user, options] = engine.importFoundingBundle.mock.calls[0] as any[];
		expect(text).toBe("SENTINEL-BUNDLE-TEXT");
		expect(user).toEqual({ id: "user-xyz" });
		expect(typeof options.expectedFingerprint).toBe("string");
		expect(options.expectedFingerprint.toLowerCase().replace(/[\s-]+/g, "")).toBe(F_COMPACT);
		expect(options).not.toHaveProperty("expectedDigest");
	});
});

describe("S-4b: typed fingerprint step — nothing from the file is shown before the engine accepts the typed value", () => {
	async function reachConfirm() {
		mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: BUNDLE_TEXT });
		const engine = comparingEngine();
		mockNetworksEngine = engine;
		const tr = await mount();
		await pressButton(tr, CHOOSE());
		return { tr, engine };
	}
	function expectNoDisclosure(tr: renderer.ReactTestRenderer) {
		const json = JSON.stringify(tr.toJSON()).toLowerCase();
		expect(json).not.toContain(F);
		expect(json).not.toContain(F_COMPACT);
		for (const group of F.split(" ")) expect(json).not.toContain(group);
	}

	it("shows the confirm body with heading, body, network name and a Join that is disabled until 16 hex", async () => {
		const { tr } = await reachConfirm();
		const body = findJsonByTestID(tr.toJSON(), "founding-import-body-confirm")!;
		expect(body).toBeTruthy();
		const json = JSON.stringify(body.node);
		expect(json).toContain(resources.en.translation.networkFoundingImportFingerprintHeading);
		expect(json).toContain(resources.en.translation.networkFoundingImportFingerprintBody);
		expect(json).toContain("Test Network");
		const join = () => findButton(tr, JOIN());
		expect((join().props as any).disabled).toBe(true);
		await typeFingerprint(tr, "0000 1111 22");
		expect((join().props as any).disabled).toBe(true);
		await typeFingerprint(tr, "0000 1111 2222 3333");
		expect((join().props as any).disabled).toBe(false);
	});

	it("WR-R3-07: with the keyboard open the confirm body is padded by the IME inset and taps reach Join", async () => {
		mockKeyboardInset = 320;
		const { tr } = await reachConfirm();
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-confirm")).toBeTruthy();
		const scroll = tr.root.findAll((n) => n.props?.testID === "founding-import-scroll" && n.props?.contentContainerStyle !== undefined)[0]!;
		expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
		expect(scroll.props.contentContainerStyle.paddingBottom).toBe(0 + 16 + 320);

		mockKeyboardInset = 0;
		await typeFingerprint(tr, "0000");
		const after = tr.root.findAll((n) => n.props?.testID === "founding-import-scroll" && n.props?.contentContainerStyle !== undefined)[0]!;
		expect(after.props.contentContainerStyle.paddingBottom).toBe(16);
	});

	it("never renders the file's fingerprint (full or by group): empty, partial, and after a wrong attempt", async () => {
		const { tr, engine } = await reachConfirm();
		expectNoDisclosure(tr);
		await typeFingerprint(tr, "0000 11");
		expectNoDisclosure(tr);
		await completeJoin(tr, "0000 1111 2222 3333");
		expect(engine.importFoundingBundle).toHaveBeenCalledTimes(1);
		expectNoDisclosure(tr);
	});

	it("wrong value: anchor-mismatch shows the mismatch copy, stays on confirm with the input cleared, joins nothing", async () => {
		const { tr } = await reachConfirm();
		await completeJoin(tr, "0000 1111 2222 3333");
		const body = findJsonByTestID(tr.toJSON(), "founding-import-body-confirm")!;
		expect(body).toBeTruthy();
		expect(JSON.stringify(body.node)).toContain(resources.en.translation.networkFoundingImportFingerprintMismatch);
		const inputs = tr.root.findAll((n) => n.props.testID === INPUT_ID && typeof n.props.onChangeText === "function");
		expect((inputs[0].props as any).value).toBe("");
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it("right value (different case/spacing): joins, selects the network, and only then shows the confirmed fingerprint", async () => {
		const { tr } = await reachConfirm();
		mockSelectNetwork.mockImplementationOnce(() => new Promise(() => {}));
		await completeJoin(tr, "A1B2-C3D4 E5F6-0718");
		const body = findJsonByTestID(tr.toJSON(), "founding-import-body-success")!;
		expect(body).toBeTruthy();
		const json = JSON.stringify(body.node);
		expect(json).toContain(resources.en.translation.networkFoundingImportFingerprintConfirmed);
		expect(json).toContain(F);
		expect(mockSelectNetwork).toHaveBeenCalledWith(NETWORK_REF);
	});

	it("an inspection failure never reaches the import: invalid-bundle -> invalidSignature, error -> genericError", async () => {
		mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: BUNDLE_TEXT });
		for (const [category, testID] of [
			["invalid-bundle", "invalidSignature"],
			["error", "genericError"],
		] as const) {
			const engine = {
				inspectFoundingBundle: jest.fn(async () => ({ ok: false, reason: "malformed", category, detail: "d" })),
				importFoundingBundle: jest.fn(),
			};
			mockNetworksEngine = engine;
			const tr = await mount();
			await pressButton(tr, CHOOSE());
			expect(findJsonByTestID(tr.toJSON(), `founding-import-body-${testID}`)).toBeTruthy();
			expect(engine.importFoundingBundle).not.toHaveBeenCalled();
		}
	});

	it("anchor-required has its own translated copy (en and es)", async () => {
		for (const locale of ["en", "es"] as const) {
			mockCurrentLocale = locale;
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: BUNDLE_TEXT });
			mockNetworksEngine = {
				inspectFoundingBundle: jest.fn(async () => ({ ok: true, networkName: "N" })),
				importFoundingBundle: jest.fn(async () => anchorResult("anchor-required")),
			};
			const tr = await mount();
			await pressButton(tr, resources[locale].translation.networkFoundingImportChooseFileButton);
			await typeFingerprint(tr, F);
			await pressButton(tr, resources[locale].translation.networkFoundingImportJoinButton);
			const body = findJsonByTestID(tr.toJSON(), "founding-import-body-anchorRequired")!;
			expect(body).toBeTruthy();
			expect(JSON.stringify(body.node)).toContain(resources[locale].translation.networkFoundingImportAnchorRequired);
		}
	});

	it("Choose another file on the confirm body goes back to picking", async () => {
		const { tr } = await reachConfirm();
		let resolvePick!: (v: unknown) => void;
		mockPickFoundingBundleFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
		await pressButton(tr, resources.en.translation.networkFoundingImportChooseAnotherFileButton);
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-picking")).toBeTruthy();
		await act(async () => {
			resolvePick({ kind: "cancelled" });
			await Promise.resolve();
		});
	});
});

const CHOOSE = () => resources.en.translation.networkFoundingImportChooseFileButton;
const JOIN = () => resources.en.translation.networkFoundingImportJoinButton;
const INPUT_ID = "founding-import-fingerprint-input";

async function typeFingerprint(tr: renderer.ReactTestRenderer, value: string) {
	const inputs = tr.root.findAll((n) => n.props.testID === INPUT_ID && typeof n.props.onChangeText === "function");
	expect(inputs.length).toBeGreaterThan(0);
	await act(async () => {
		(inputs[0].props as any).onChangeText(value);
	});
}

/** On the confirm body: type the exporter's fingerprint and press Join. */
async function completeJoin(tr: renderer.ReactTestRenderer, value: string = F) {
	expect(findJsonByTestID(tr.toJSON(), "founding-import-body-confirm")).toBeTruthy();
	await typeFingerprint(tr, value);
	await pressButton(tr, JOIN());
}

/** Pick, and (when the file passed the validity check) type F and join. */
async function pickAndResolve(pickResult: unknown) {
	mockPickFoundingBundleFile.mockResolvedValue(pickResult);
	const tr = await mount();
	await pressButton(tr, CHOOSE());
	if (findJsonByTestID(tr.toJSON(), "founding-import-body-confirm")) await completeJoin(tr);
	return tr;
}

describe("S-5: invalidSignature and genericError bodies — geometry + EN/ES full text", () => {
	for (const locale of ["en", "es"] as const) {
		it(`invalidSignature (${locale}): first child, full text, colors.error, no clipping, Choose Another File follows`, async () => {
			mockCurrentLocale = locale;
			mockNetworksEngine = { importFoundingBundle: jest.fn(async () => invalidBundleResult()) };
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			const tr = await mount();
			await pressButton(tr, resources[locale].translation.networkFoundingImportChooseFileButton);
			await typeFingerprint(tr, F);
			await pressButton(tr, resources[locale].translation.networkFoundingImportJoinButton);

			const json = tr.toJSON();
			const found = findJsonByTestID(json, "founding-import-body-invalidSignature")!;
			// Body is the first child of its immediate parent (the ScrollView's content wrapper).
			const parent = found.path[found.path.length - 1] as any;
			expect(parent.children[0]).toBe(found.node);

			const [textNode, buttonNode] = found.node.children;
			expect(textNode.props.numberOfLines).toBeUndefined();
			expect(textNode.props.ellipsizeMode).toBeUndefined();
			const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
			expect(flat.position).not.toBe("absolute");
			expect(flat.color).toBe(lightTheme.colors.error);
			expect(textNode.children).toEqual([resources[locale].translation.networkFoundingImportInvalidSignature]);

			expect(buttonNode.props.accessibilityLabel).toBe(
				resources[locale].translation.networkFoundingImportChooseAnotherFileButton,
			);

			const ancestors = [...found.path, found.node];
			for (const ancestor of ancestors) {
				const aFlat = (StyleSheet.flatten([
					(ancestor as any).props?.style,
					(ancestor as any).props?.contentContainerStyle,
				]) ?? {}) as Record<string, unknown>;
				expect(aFlat.height).toBeUndefined();
				expect(aFlat.maxHeight).toBeUndefined();
				expect(aFlat.overflow).not.toBe("hidden");
			}
		});

		it(`genericError (${locale}): first child, full text, colors.error, no clipping, Choose Another File follows`, async () => {
			mockCurrentLocale = locale;
			mockNetworksEngine = { importFoundingBundle: jest.fn(async () => errorResult()) };
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			const tr = await mount();
			await pressButton(tr, resources[locale].translation.networkFoundingImportChooseFileButton);
			await typeFingerprint(tr, F);
			await pressButton(tr, resources[locale].translation.networkFoundingImportJoinButton);

			const json = tr.toJSON();
			const found = findJsonByTestID(json, "founding-import-body-genericError")!;
			const parent = found.path[found.path.length - 1] as any;
			expect(parent.children[0]).toBe(found.node);

			const [textNode, buttonNode] = found.node.children;
			expect(textNode.props.numberOfLines).toBeUndefined();
			expect(textNode.props.ellipsizeMode).toBeUndefined();
			const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
			expect(flat.position).not.toBe("absolute");
			expect(flat.color).toBe(lightTheme.colors.error);
			expect(textNode.children).toEqual([resources[locale].translation.networkFoundingImportGenericError]);
			expect(buttonNode.props.accessibilityLabel).toBe(
				resources[locale].translation.networkFoundingImportChooseAnotherFileButton,
			);

			const ancestors = [...found.path, found.node];
			for (const ancestor of ancestors) {
				const aFlat = (StyleSheet.flatten([
					(ancestor as any).props?.style,
					(ancestor as any).props?.contentContainerStyle,
				]) ?? {}) as Record<string, unknown>;
				expect(aFlat.height).toBeUndefined();
				expect(aFlat.maxHeight).toBeUndefined();
				expect(aFlat.overflow).not.toBe("hidden");
			}
		});
	}
});

describe("S-6: alreadyJoined — textSecondary, only control is View Network -> NetworkDetails", () => {
	it("renders the alreadyJoined body with no Choose File / import-again control", async () => {
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => alreadyJoinedResult()) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });

		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-alreadyJoined")!;
		const [textNode, buttonNode] = found.node.children;
		const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
		expect(flat.color).toBe(lightTheme.colors.textSecondary);
		expect(textNode.children).toEqual([resources.en.translation.networkFoundingImportAlreadyJoined]);

		expect(buttonNode.props.accessibilityLabel).toBe(resources.en.translation.networkFoundingImportViewNetworkButton);
		expect(found.node.children).toHaveLength(2);

		await pressButton(tr, resources.en.translation.networkFoundingImportViewNetworkButton);
		expect(mockNavigate).toHaveBeenCalledWith("NetworkDetails", { networkRef: NETWORK_REF });
	});
});

describe("S-7: success — colors.success, selectNetwork awaited then navigate Home; rejection leaves success body, no navigation", () => {
	it("navigates Home after a successful selectNetwork", async () => {
		mockSelectNetwork.mockResolvedValueOnce(undefined);
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-success")!;
		const flat = StyleSheet.flatten(found.node.children[0].props.style) as Record<string, unknown>;
		expect(flat.color).toBe(lightTheme.colors.success);
		expect(found.node.children[0].children).toEqual([resources.en.translation.networkFoundingImportSuccess]);
		expect(mockSelectNetwork).toHaveBeenCalledWith(NETWORK_REF);
		expect(mockNavigate).toHaveBeenCalledWith("Home");
	});

	it("a selectNetwork rejection leaves the success body and does not navigate", async () => {
		mockSelectNetwork.mockRejectedValueOnce(new Error("boom"));
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-success")).toBeTruthy();
		expect(mockNavigate).not.toHaveBeenCalledWith("Home");
	});
});

describe("S-8: terminal state mapping", () => {
	it("cancelled returns to idle", async () => {
		const tr = await pickAndResolve({ kind: "cancelled" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-idle")).toBeTruthy();
	});
	it("too-large maps to invalidSignature", async () => {
		const tr = await pickAndResolve({ kind: "too-large" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-invalidSignature")).toBeTruthy();
	});
	it("unreadable maps to genericError", async () => {
		const tr = await pickAndResolve({ kind: "unreadable", reason: "picker-error" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
	it("an importFoundingBundle throw maps to genericError", async () => {
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(async () => {
				throw new Error("boom");
			}),
		};
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
	it("an absent networksEngine maps to genericError", async () => {
		mockNetworksEngine = undefined;
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
});

describe("S-9: no console call leaks a sentinel planted in the bundle text or the network hash", () => {
	it("console.info never contains the sentinel bundle text or hash", async () => {
		const spy = jest.spyOn(console, "info").mockImplementation(() => {});
		const sentinel = "SENTINEL-DO-NOT-LOG-ME-12345";
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(async () => ({
				ok: false,
				reason: "signature-invalid",
				category: "invalid-bundle",
				detail: sentinel,
			})),
		};
		await pickAndResolve({ kind: "picked", text: sentinel });

		for (const call of spy.mock.calls) {
			const joined = call.map((a) => String(a)).join(" ");
			expect(joined).not.toContain(sentinel);
			expect(joined).not.toContain(NETWORK_REF.hash);
		}
		spy.mockRestore();
	});
});

/** Sum of left padding across a body's ancestors (padding / paddingHorizontal / paddingLeft). */
function leftGutter(path: any[]): number {
	let total = 0;
	for (const ancestor of path) {
		const flat = (StyleSheet.flatten([ancestor.props?.style, ancestor.props?.contentContainerStyle]) ?? {}) as Record<string, number>;
		total += flat.paddingLeft ?? flat.paddingHorizontal ?? flat.padding ?? 0;
	}
	return total;
}

describe("S-10: every state body sits inside the 16dp screen gutter with message/button spacing (UAT 62 O)", () => {
	const cases: Array<[string, () => FoundingBundleImportResult]> = [
		["invalidSignature", invalidBundleResult],
		["genericError", errorResult],
		["alreadyJoined", alreadyJoinedResult],
		["success", () => okResult("replayed")],
	];
	for (const [state, result] of cases) {
		it(`${state}: >= 16dp left gutter and a gap between message and button`, async () => {
			// Only the success state calls selectNetwork; a queued Once on any other state would leak.
			if (state === "success") mockSelectNetwork.mockImplementationOnce(() => new Promise(() => {}));
			mockNetworksEngine = { importFoundingBundle: jest.fn(async () => result()) };
			const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
			const found = findJsonByTestID(tr.toJSON(), `founding-import-body-${state}`)!;
			expect(found).toBeTruthy();
			expect(leftGutter(found.path)).toBeGreaterThanOrEqual(16);
			const bodyFlat = StyleSheet.flatten(found.node.props.style) as Record<string, number>;
			expect(bodyFlat.gap).toBeGreaterThanOrEqual(8);
		});
	}

	it("idle: the Choose File body is inside the gutter too", async () => {
		const tr = await mount();
		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-idle")!;
		expect(leftGutter(found.path)).toBeGreaterThanOrEqual(16);
	});
});

describe("S-11: a failed post-import select never strands the officer (UAT 62 P2)", () => {
	async function settle() {
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("NO_KEY_PROVISIONED routes to the first-run provisioning ceremony", async () => {
		mockSelectNetwork.mockRejectedValueOnce(
			Object.assign(new Error("getOrCreateDeviceUser: no device signing key provisioned"), { code: "NO_KEY_PROVISIONED" }),
		);
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(mockNavigate).not.toHaveBeenCalledWith("Home");
		// UAT 62 P2b: the routed case keeps View Network too — the ceremony's CONTINUE pops back here.
		expect(findJsonByTestID(tr.toJSON(), "founding-import-success-view-network")).toBeTruthy();
	});

	async function refocus() {
		const callbacks = mockFocusCallbacks.splice(0);
		await act(async () => {
			callbacks.slice(-1).forEach((cb) => cb());
		});
		await settle();
	}

	it("UAT 62 P2b: back from the NO_KEY_PROVISIONED ceremony, the select is retried once and lands Home", async () => {
		mockSelectNetwork.mockRejectedValueOnce(
			Object.assign(new Error("getOrCreateDeviceUser: no device signing key provisioned"), { code: "NO_KEY_PROVISIONED" }),
		);
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);

		// Provisioning done; its CONTINUE pops back to this screen.
		mockSelectNetwork.mockResolvedValueOnce(undefined);
		await refocus();

		expect(mockSelectNetwork).toHaveBeenCalledTimes(2);
		expect(mockSelectNetwork).toHaveBeenLastCalledWith(NETWORK_REF);
		expect(mockNavigate).toHaveBeenCalledWith("Home");

		// Once only: a later focus does not select again.
		await refocus();
		expect(mockSelectNetwork).toHaveBeenCalledTimes(2);
	});

	it("UAT 62 P2b: a failed retry is not routed again and View Network stays", async () => {
		const noKey = () =>
			Object.assign(new Error("getOrCreateDeviceUser: no device signing key provisioned"), { code: "NO_KEY_PROVISIONED" });
		mockSelectNetwork.mockRejectedValueOnce(noKey()).mockRejectedValueOnce(noKey());
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();
		await refocus();

		expect(mockSelectNetwork).toHaveBeenCalledTimes(2);
		expect(mockNavigate.mock.calls.filter(([route]) => route === "ProvisionSigningKey")).toHaveLength(1);
		expect(mockNavigate).not.toHaveBeenCalledWith("Home");
		expect(findJsonByTestID(tr.toJSON(), "founding-import-success-view-network")).toBeTruthy();
	});

	it("a non-routed failure does not retry on re-focus", async () => {
		mockSelectNetwork.mockRejectedValueOnce(new Error("boom"));
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();
		await refocus();
		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
	});

	it("any other select failure shows View Network, which opens NetworkDetails", async () => {
		mockSelectNetwork.mockRejectedValueOnce(new Error("boom"));
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();

		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-success")!;
		expect(found.node.children[0].children).toEqual([resources.en.translation.networkFoundingImportSuccess]);
		expect(findJsonByTestID(tr.toJSON(), "founding-import-success-view-network")).toBeTruthy();
		await pressButton(tr, resources.en.translation.networkFoundingImportViewNetworkButton);
		expect(mockNavigate).toHaveBeenCalledWith("NetworkDetails", { networkRef: NETWORK_REF });
		expect(mockNavigate).not.toHaveBeenCalledWith("ProvisionSigningKey", expect.anything());
	});

	it("a successful select shows no View Network button", async () => {
		mockSelectNetwork.mockImplementationOnce(() => new Promise(() => {}));
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await settle();
		expect(findJsonByTestID(tr.toJSON(), "founding-import-success-view-network")).toBeNull();
	});
});
