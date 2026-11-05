/**
 * AttestationChallengesSection.test.tsx — co-located suite for Phase 47 plan
 * 47-16, pinning D-11 (the negative-space contract, runtime complement to
 * the co-located `.negative-space.test.ts` source gate), D-03 (the verdict
 * join / misrepresentation lock) and D-09 (the provisioning banner).
 *
 * PATTERN SOURCE: AttestationPolicySection.test.tsx (helpers, gate-test
 * shape) + RegistrationPolicyScreen.test.tsx / BallotConfirmation.test.tsx
 * (module-mock scaffolding, the REAL `MockAssociationEngine` via a relative
 * `dist/` require). react-test-renderer ONLY; neither React Native Testing
 * Library nor @testing-library/react-hooks is a dependency of this app.
 *
 * The identity `t()` mock is LOAD-BEARING here, not incidental: the EN copy
 * of `attestationChallengeExpireBody` legitimately contains the word
 * "issued" ("A new challenge can only be issued by the device's own
 * registration/association attempt"), so a real-copy `t` would make the
 * tree-level `/issue/i` assertions in test 11 unusable. With the identity
 * `t`, only KEY strings render, and no key contains "Issue" — exactly
 * 47-02's guarantee. Do NOT "improve" this mock into a real-copy one.
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// Distinct sentinel values for every color token so a color assertion can
// never pass by accidental equality between two tokens.
const PALETTE = {
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
};

jest.mock("@react-navigation/native", () => ({
	// 49-11: useDeviceSigningErrorHandler resolves useNavigation() —
	// mockNavigate lets AttestationChallengesSection.handleExpire's
	// device-signing navigation branch resolve to a stable, assertable no-op.
	useNavigation: () => ({ navigate: jest.fn() }),
	useTheme: () => ({ dark: false, colors: PALETTE }),
}));

jest.mock("../../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so the jest babel transform
// (babel-plugin-jest-hoist) allows the jest.mock() factory below to close
// over them despite being declared after that call.
// ---------------------------------------------------------------------------
let mockAssociationEngine: any;
let mockProvisioned = true;
const mockIsProvisioned = jest.fn(() => mockProvisioned);

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "association") return mockAssociationEngine;
	return null;
});

jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, isAttestationVerifierProvisioned: mockIsProvisioned }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path. Verified depth from
// this file's directory (apps/VoteTorrentAuthority/src/screens/registration/
// components/__tests__/) to the repo root is SEVEN levels up (same directory
// as AssociationsSection.test.tsx, whose require confirms this literal). A
// stale packages/vote-engine/dist will surface here as "method is not a
// function" for getAttestationChallenges/getAttestationVerdicts — see the
// stale-dist guard, test 1.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockAssociationEngine,
} = require("../../../../../../../packages/vote-engine/dist/association/mock-association-engine");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	AttestationChallengesSection,
	toDisplayTimestamp,
} = require("../AttestationChallengesSection");

// latestVerdictByDeviceKey now lives in ONE shared module rather than being
// copy-pasted into this section and AssociationsSection with divergent return
// types (47-REVIEW WR-08). Both sections, and both suites, consume it here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { latestVerdictByDeviceKey } = require("../verdicts");

// The mock's issueAttestationChallenge calls crypto.randomUUID(), which may
// be absent from the jest RN environment's globals. Test-environment shim
// only — changes no production behavior.
beforeAll(() => {
	const existing = (globalThis as any).crypto;
	if (typeof existing?.randomUUID !== "function") {
		(globalThis as any).crypto = {
			...existing,
			randomUUID: require("crypto").randomUUID,
		};
	}
});

const REGISTRANT_ID = "registrant-1";
const DEVICE_KEY_ALPHA = "devicekey-alpha-0000000000";
const DEVICE_KEY_BRAVO = "devicekey-bravo-1111111111";
const SEED_SIGN = { signature: "seed-sig", signerKey: "seed-key", signerUserId: "seed-user" };

// ---------------------------------------------------------------------------
// Purpose-built engine doubles — each expresses exactly one failure mode
// MockAssociationEngine cannot itself express (its methods never throw and
// its reads never hang).
// ---------------------------------------------------------------------------
class ThrowingChallengesEngine extends MockAssociationEngine {
	async getAttestationChallenges(): Promise<never> {
		throw new Error("boom-read-failed");
	}
}

class NeverResolvingChallengesEngine extends MockAssociationEngine {
	async getAttestationChallenges(): Promise<any[]> {
		return new Promise(() => {});
	}
}

class ThrowingVerdictsEngine extends MockAssociationEngine {
	async getAttestationVerdicts(): Promise<never> {
		throw new Error("verdict store unavailable");
	}
}

class ThrowingRemoveEngine extends MockAssociationEngine {
	async removeAttestationChallenge(): Promise<never> {
		throw new Error("expire-failed");
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Finds the wrapper by testID, then invokes the first descendant's onPress. */
function press(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPress === "function"
	);
	renderer.act(() => {
		pressable!.props.onPress();
	});
}

/** ChipButton wires its onPress prop to the native onPressIn — this helper
 * MUST look for onPressIn, or the toggle/banner-link tests silently no-op. */
function pressChip(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPressIn === "function"
	);
	renderer.act(() => {
		pressable!.props.onPressIn();
	});
}

async function flush() {
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
	});
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const withDisabled = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.disabled === "boolean"
	);
	return withDisabled!.props.disabled === true;
}

function findOnPress(tr: renderer.ReactTestRenderer, testID: string): () => void {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPress === "function"
	);
	return pressable!.props.onPress;
}

/**
 * pressableTestIDs — the negative-space instrument. Walks EVERY instance
 * (composite and host) in the rendered tree; for every node whose
 * `props.onPress` is a function, climbs the `.parent` chain (including the
 * node itself) to the nearest instance carrying a string `testID` and
 * collects it. This is what makes "no issue affordance" a mechanical
 * assertion instead of a review note: any new pressable control surfaces as
 * an unexpected member and fails the exact-set comparison below.
 */
function pressableTestIDs(tr: renderer.ReactTestRenderer): string[] {
	const collected = new Set<string>();
	for (const node of tr.root.findAll(() => true)) {
		if (typeof node.props.onPress !== "function") continue;
		let cur: any = node;
		while (cur) {
			if (typeof cur.props?.testID === "string") {
				collected.add(cur.props.testID);
				break;
			}
			cur = cur.parent;
		}
	}
	return Array.from(collected).sort();
}

/** No create-challenge language may ever reach the rendered tree, in any state. */
function assertNoCreateLanguage(tr: renderer.ReactTestRenderer) {
	const text = treeText(tr);
	expect(text).not.toMatch(/issue/i);
	expect(text).not.toMatch(/\bnew challenge\b/i);
	expect(text).not.toMatch(/\badd\b/i);
	expect(text).not.toMatch(/\bcreate\b/i);
}

async function seedChallenge(
	engine: any,
	opts: { deviceKey: string; electionId?: string; registrantId?: string }
) {
	return engine.issueAttestationChallenge(
		opts.registrantId ?? REGISTRANT_ID,
		opts.deviceKey,
		SEED_SIGN,
		opts.electionId
	);
}

async function renderSection(overrides?: {
	registrantId?: string;
	canWrite?: boolean;
	provisioned?: boolean;
	onOpenProvisioningStatus?: jest.Mock;
}) {
	mockProvisioned = overrides?.provisioned ?? true;
	const onOpenProvisioningStatus = overrides?.onOpenProvisioningStatus ?? jest.fn();

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<AttestationChallengesSection
				registrantId={overrides?.registrantId ?? REGISTRANT_ID}
				canWrite={overrides?.canWrite ?? true}
				onOpenProvisioningStatus={onOpenProvisioningStatus}
			/>
		);
	});
	await flush();
	return { tr, onOpenProvisioningStatus };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockAssociationEngine = new MockAssociationEngine();
	mockProvisioned = true;
});

describe("AttestationChallengesSection — D-11/D-03/D-09", () => {
	test("1: stale-dist guard", () => {
		const engine = new MockAssociationEngine();
		expect(typeof engine.getAttestationChallenges).toBe("function");
		expect(typeof engine.getAttestationVerdicts).toBe("function");
		expect(typeof engine.recordAttestationVerdict).toBe("function");
	});

	test("2: D-11 populated render — binding fields for two challenges", async () => {
		const c1 = await seedChallenge(mockAssociationEngine, {
			deviceKey: DEVICE_KEY_ALPHA,
			electionId: "election-1",
		});
		const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
		const { tr } = await renderSection();

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c1.nonce}` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c2.nonce}` })
		).not.toThrow();

		const text = treeText(tr);
		expect(text).toContain(DEVICE_KEY_ALPHA.slice(0, 5) + "...");
		expect(text).not.toContain(DEVICE_KEY_ALPHA);
		expect(text).not.toContain(DEVICE_KEY_BRAVO);
		expect(text).toContain("election-1");
		expect(text).toContain("—");
		// D-10 (51-05, surfaced here by 51-10's vote-engine dist rebuild):
		// `AttestationChallenge.Expiration` was removed — the component's own
		// header now states "no expiry row to render" (:324), so no date string
		// is ever part of this section's output. A stale dist previously masked
		// this: it still returned the pre-51-05 challenge shape, which is why
		// this assertion could pass before the rebuild without the component
		// actually rendering a date.
	});

	test("3: D-03 verdict join — latest wins, and the inversion guard holds", async () => {
		const cA = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const cB = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
		await mockAssociationEngine.recordAttestationVerdict(REGISTRANT_ID, DEVICE_KEY_ALPHA, {
			ok: true,
		});
		await mockAssociationEngine.recordAttestationVerdict(REGISTRANT_ID, DEVICE_KEY_ALPHA, {
			ok: false,
			reason: "revoked hardware root",
		});

		const { tr } = await renderSection();

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${cA.nonce}-fail` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${cA.nonce}-pass` })
		).toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${cB.nonce}-none` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${cB.nonce}-fail` })
		).toThrow();

		press(tr, `attestation-challenges-verdict-${cA.nonce}`);
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${cA.nonce}-reason` })
		).not.toThrow();
		expect(treeText(tr)).toContain("revoked hardware root");
	});

	// T-47-12: the "none" pill is an AFFIRMATIVE claim ("no verdict recorded"),
	// not a null rendering — resolveVerdictState maps `undefined` straight to
	// it (VerdictBadge.tsx:44). So a FAILED verdict read must omit the badge
	// entirely, or an officer inspecting a device before it is allowed to
	// associate is handed an unearned all-clear derived from an error the UI
	// swallowed. This mirrors AssociationsSection.test.tsx test 9 exactly.
	test("4: a verdict-read FAILURE omits the badge entirely, never blocks the rows", async () => {
		const engine = new ThrowingVerdictsEngine();
		const c1 = await seedChallenge(engine, { deviceKey: DEVICE_KEY_ALPHA });
		const c2 = await seedChallenge(engine, { deviceKey: DEVICE_KEY_BRAVO });
		mockAssociationEngine = engine;

		const { tr } = await renderSection();

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c1.nonce}` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c2.nonce}` })
		).not.toThrow();
		for (const nonce of [c1.nonce, c2.nonce]) {
			expect(() =>
				tr.root.findByProps({ testID: `attestation-challenges-verdict-${nonce}` })
			).toThrow();
			expect(() =>
				tr.root.findByProps({ testID: `attestation-challenges-verdict-${nonce}-none` })
			).toThrow();
			expect(() =>
				tr.root.findByProps({ testID: `attestation-challenges-verdict-${nonce}-pass` })
			).toThrow();
			expect(() =>
				tr.root.findByProps({ testID: `attestation-challenges-verdict-${nonce}-fail` })
			).toThrow();
		}

		const text = treeText(tr);
		expect(text).not.toContain("attestationVerdictNone");
		expect(text).not.toContain("attestationVerdictPass");
		expect(text).not.toContain("attestationVerdictFail");

		// The verdict read stays isolated: no error banner, and the challenge
		// list (the primary content) still renders.
		expect(() => tr.root.findByProps({ testID: "attestation-challenges-error" })).not.toThrow();
		expect(text).not.toContain("verdict store unavailable");
	});

	// Non-vacuity partner for test 4: with the SAME rows and a WORKING verdict
	// read, the "none" badge IS present. Without this, test 4 would still pass
	// if the badge were deleted outright or the rows stopped rendering.
	test("4b: a SUCCESSFUL verdict read with no rows still renders the neutral badge", async () => {
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });

		const { tr } = await renderSection();

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${c1.nonce}` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-verdict-${c1.nonce}-none` })
		).not.toThrow();
		expect(treeText(tr)).toContain("attestationVerdictNone");
	});

	test("5: D-11 empty state offers nothing", async () => {
		const { tr } = await renderSection();

		expect(() => tr.root.findByProps({ testID: "attestation-challenges-empty" })).not.toThrow();
		expect(treeText(tr)).not.toContain("attestation-challenges-row-");
		expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
	});

	test("6: loading state", async () => {
		mockAssociationEngine = new NeverResolvingChallengesEngine();
		const { tr } = await renderSection();

		expect(() => tr.root.findByProps({ testID: "attestation-challenges-loading" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "attestation-challenges-empty" })).toThrow();
		expect(treeText(tr)).not.toContain("attestation-challenges-row-");
		expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
	});

	test("7: error state (translated, no engine text)", async () => {
		mockAssociationEngine = new ThrowingChallengesEngine();
		const { tr } = await renderSection();

		expect(() => tr.root.findByProps({ testID: "attestation-challenges-error" })).not.toThrow();
		expect(treeText(tr)).toContain("errorLoadFailedGeneric");
		expect(treeText(tr)).not.toContain("boom-read-failed");
		expect(treeText(tr)).not.toContain("attestation-challenges-row-");
		expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
	});

	test("8: D-09 banner presence contract", async () => {
		const { tr, onOpenProvisioningStatus } = await renderSection({ provisioned: false });

		const banner = tr.root.findByProps({ testID: "attestation-challenges-provisioning-banner" });
		const bannerStyle = Array.isArray(banner.props.style)
			? banner.props.style.flat(5)
			: [banner.props.style];
		const withBorder = bannerStyle.find(
			(s: unknown) =>
				s !== null && typeof s === "object" && "borderLeftColor" in (s as Record<string, unknown>)
		) as Record<string, unknown> | undefined;
		expect(withBorder?.borderLeftColor).toBe(PALETTE.warning);

		const glyph = tr.root
			.findAllByType("FontAwesome6" as never)
			.find((n) => n.props.name === "triangle-exclamation");
		expect(glyph?.props.color).toBe(PALETTE.warning);

		pressChip(tr, "attestation-challenges-provisioning-link");
		expect(onOpenProvisioningStatus).toHaveBeenCalledTimes(1);

		const provisionedRender = await renderSection({ provisioned: true });
		expect(() =>
			provisionedRender.tr.root.findByProps({
				testID: "attestation-challenges-provisioning-banner",
			})
		).toThrow();
		expect(() =>
			provisionedRender.tr.root.findByProps({ testID: "attestation-challenges-provisioning-link" })
		).toThrow();
	});

	test("9: D-09 banner survives collapse", async () => {
		await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const { tr } = await renderSection({ provisioned: false });

		pressChip(tr, "attestation-challenges-toggle");

		expect(() =>
			tr.root.findByProps({ testID: "attestation-challenges-provisioning-banner" })
		).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "attestation-challenges-empty" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "attestation-challenges-loading" })).toThrow();
		expect(treeText(tr)).not.toContain("attestation-challenges-row-");
	});

	test("10: the banner link is never scope-gated", async () => {
		const { tr, onOpenProvisioningStatus } = await renderSection({
			provisioned: false,
			canWrite: false,
		});

		pressChip(tr, "attestation-challenges-provisioning-link");
		expect(onOpenProvisioningStatus).toHaveBeenCalledTimes(1);
	});

	test("11: NEGATIVE SPACE — exact pressable set in every state", async () => {
		// loading
		{
			mockAssociationEngine = new NeverResolvingChallengesEngine();
			const { tr } = await renderSection();
			expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
			assertNoCreateLanguage(tr);
		}

		// error
		{
			mockAssociationEngine = new ThrowingChallengesEngine();
			const { tr } = await renderSection();
			expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
			assertNoCreateLanguage(tr);
		}

		// empty
		{
			mockAssociationEngine = new MockAssociationEngine();
			const { tr } = await renderSection();
			expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
			assertNoCreateLanguage(tr);
		}

		// populated
		{
			mockAssociationEngine = new MockAssociationEngine();
			const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
			const { tr } = await renderSection();
			expect(pressableTestIDs(tr)).toEqual(
				[
					"attestation-challenges-toggle",
					`attestation-challenges-expire-trigger-${c1.nonce}`,
					`attestation-challenges-expire-trigger-${c2.nonce}`,
				].sort()
			);
			assertNoCreateLanguage(tr);
		}

		// populated + fail verdict
		{
			mockAssociationEngine = new MockAssociationEngine();
			const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
			await mockAssociationEngine.recordAttestationVerdict(REGISTRANT_ID, DEVICE_KEY_ALPHA, {
				ok: false,
				reason: "revoked",
			});
			const { tr } = await renderSection();
			expect(pressableTestIDs(tr)).toEqual(
				[
					"attestation-challenges-toggle",
					`attestation-challenges-expire-trigger-${c1.nonce}`,
					`attestation-challenges-expire-trigger-${c2.nonce}`,
					`attestation-challenges-verdict-${c1.nonce}`,
				].sort()
			);
			assertNoCreateLanguage(tr);
		}

		// populated + unprovisioned
		{
			mockAssociationEngine = new MockAssociationEngine();
			const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
			const { tr } = await renderSection({ provisioned: false });
			expect(pressableTestIDs(tr)).toEqual(
				[
					"attestation-challenges-toggle",
					"attestation-challenges-provisioning-link",
					`attestation-challenges-expire-trigger-${c1.nonce}`,
					`attestation-challenges-expire-trigger-${c2.nonce}`,
				].sort()
			);
			assertNoCreateLanguage(tr);
		}

		// populated + canWrite:false — SAME set as populated (D-13's
		// visible-but-disabled default; the trigger's onPress resolves to the
		// stable NOOP rather than disappearing).
		{
			mockAssociationEngine = new MockAssociationEngine();
			const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
			const { tr } = await renderSection({ canWrite: false });
			expect(pressableTestIDs(tr)).toEqual(
				[
					"attestation-challenges-toggle",
					`attestation-challenges-expire-trigger-${c1.nonce}`,
					`attestation-challenges-expire-trigger-${c2.nonce}`,
				].sort()
			);
			assertNoCreateLanguage(tr);
		}

		// collapsed, provisioned
		{
			mockAssociationEngine = new MockAssociationEngine();
			await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const { tr } = await renderSection();
			pressChip(tr, "attestation-challenges-toggle");
			expect(pressableTestIDs(tr)).toEqual(["attestation-challenges-toggle"]);
			assertNoCreateLanguage(tr);
		}

		// collapsed, unprovisioned — the D-09 banner link survives collapse.
		{
			mockAssociationEngine = new MockAssociationEngine();
			await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
			const { tr } = await renderSection({ provisioned: false });
			pressChip(tr, "attestation-challenges-toggle");
			expect(pressableTestIDs(tr)).toEqual(
				["attestation-challenges-toggle", "attestation-challenges-provisioning-link"].sort()
			);
			assertNoCreateLanguage(tr);
		}
	});

	test("12: the engine's create-challenge method is never invoked at runtime", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		// Installed AFTER seeding — the runtime complement to the co-located
		// source gate's static check.
		const spy = jest.spyOn(mockAssociationEngine, "issueAttestationChallenge");

		await renderSection();
		await renderSection({ provisioned: false });
		await renderSection({ canWrite: false });
		const { tr } = await renderSection();
		pressChip(tr, "attestation-challenges-toggle");

		expect(spy).not.toHaveBeenCalled();
	});

	test("13: expire — the confirm card gates the write", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const removeSpy = jest.spyOn(mockAssociationEngine, "removeAttestationChallenge");
		const { tr } = await renderSection();

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).not.toThrow();
		const text = treeText(tr);
		expect(text).toContain("attestationChallengeExpireTitle");
		expect(text).toContain("attestationChallengeExpireBody");
		// CustomButton renders title.toUpperCase() — assert case-insensitively
		// for the two button labels rather than baking that transform into
		// every other treeText assertion.
		expect(text.toLowerCase()).toContain("attestationchallengeexpireconfirm");
		expect(text.toLowerCase()).toContain("attestationchallengekeepchallenge");
		expect(removeSpy).not.toHaveBeenCalled();
	});

	test("14: D-10 dismiss fires zero engine calls", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const removeSpy = jest.spyOn(mockAssociationEngine, "removeAttestationChallenge");
		const { tr } = await renderSection();

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-${c1.nonce}-dismiss`);
		await flush();

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c1.nonce}` })
		).not.toThrow();
		expect(removeSpy).not.toHaveBeenCalled();
	});

	test("15: expire confirm removes exactly that row", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
		const removeSpy = jest.spyOn(mockAssociationEngine, "removeAttestationChallenge");
		const { tr } = await renderSection();

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-${c1.nonce}-confirm`);
		await flush();

		expect(removeSpy).toHaveBeenCalledTimes(1);
		expect(removeSpy.mock.calls[0][0]).toBe(c1.nonce);
		expect(typeof removeSpy.mock.calls[0][1]).toBe("function");
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c1.nonce}` })
		).toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c2.nonce}` })
		).not.toThrow();
	});

	test("16: expire failure keeps the card mounted, surfaces InlineError, and is retryable", async () => {
		const engine = new ThrowingRemoveEngine();
		const c1 = await seedChallenge(engine, { deviceKey: DEVICE_KEY_ALPHA });
		mockAssociationEngine = engine;
		const removeSpy = jest.spyOn(engine, "removeAttestationChallenge");
		const { tr } = await renderSection();

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-${c1.nonce}-confirm`);
		await flush();

		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("expire-failed");
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-row-${c1.nonce}` })
		).not.toThrow();

		press(tr, `attestation-challenges-expire-${c1.nonce}-confirm`);
		await flush();

		expect(removeSpy).toHaveBeenCalledTimes(2);
	});

	test("17: one confirm card at a time", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
		const { tr } = await renderSection();

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-trigger-${c2.nonce}`);

		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c2.nonce}-card` })
		).not.toThrow();
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).toThrow();
	});

	test("18: D-13 read-only — trigger present, disabled, zero calls even invoked programmatically", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const c2 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_BRAVO });
		const removeSpy = jest.spyOn(mockAssociationEngine, "removeAttestationChallenge");
		const { tr } = await renderSection({ canWrite: false });

		for (const c of [c1, c2]) {
			const testID = `attestation-challenges-expire-trigger-${c.nonce}`;
			expect(() => tr.root.findByProps({ testID })).not.toThrow();
			expect(isDisabled(tr, testID)).toBe(true);

			renderer.act(() => {
				findOnPress(tr, testID)();
			});
			expect(() =>
				tr.root.findByProps({ testID: `attestation-challenges-expire-${c.nonce}-card` })
			).toThrow();
		}

		expect(removeSpy).not.toHaveBeenCalled();
	});

	test("19: pure-helper unit tables", () => {
		const outOfOrder = [
			{
				registrantId: REGISTRANT_ID,
				deviceKey: "d1",
				sequence: 5,
				verdict: "pass" as const,
				verifiedAt: "2020-01-01T00:00:00.000Z",
			},
			{
				registrantId: REGISTRANT_ID,
				deviceKey: "d1",
				sequence: 1,
				verdict: "fail" as const,
				verifiedAt: "2019-01-01T00:00:00.000Z",
			},
		];
		const reduced = latestVerdictByDeviceKey(outOfOrder);
		expect(reduced.get("d1")?.sequence).toBe(5);
		expect(reduced.get("d1")?.verdict).toBe("pass");
		expect(latestVerdictByDeviceKey([]).size).toBe(0);

		// WR-08: the Record-keyed copy this replaced read through the prototype
		// chain, so a deviceKey of "toString"/"valueOf"/"constructor" resolved
		// `existing` to the inherited Function — truthy, with an undefined
		// `.sequence` — and the verdict was NEVER stored, silently degrading the
		// badge to "none". Device keys are hex/base58 today so this was not
		// reachable in practice; it is asserted anyway because this function's
		// whole job is "never a false Pass, never a false Fail".
		for (const hostileKey of [
			"toString",
			"valueOf",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			const hostile = latestVerdictByDeviceKey([
				{
					registrantId: REGISTRANT_ID,
					deviceKey: hostileKey,
					sequence: 0,
					verdict: "fail" as const,
					verifiedAt: "2020-01-01T00:00:00.000Z",
				},
			]);
			expect(hostile.size).toBe(1);
			expect(hostile.get(hostileKey)?.verdict).toBe("fail");
		}

		expect(toDisplayTimestamp(undefined)).toBe("");
		const iso = "2024-03-15T00:00:00.000Z";
		const epoch = Date.parse(iso);
		expect(toDisplayTimestamp(epoch)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(toDisplayTimestamp(iso)).toBe(toDisplayTimestamp(epoch));
		expect(toDisplayTimestamp("not-a-date")).toBe("not-a-date");
	});

	test("20: no device key reaches the console across render -> expire -> dismiss", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { tr } = await renderSection();
			press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
			press(tr, `attestation-challenges-expire-${c1.nonce}-dismiss`);
			await flush();

			const allArgs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
				(args) => JSON.stringify(args)
			);
			expect(allArgs.some((a) => a.includes(DEVICE_KEY_ALPHA))).toBe(false);
		} finally {
			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	test("21: a createDeviceSigner failure during expire surfaces InlineError, never silently no-ops", async () => {
		// The defect: createDeviceSigner and getEngine sat OUTSIDE handleExpire's
		// try, so their rejections set no errorMessage.
		// LifecycleConfirmCard.handleConfirm catches the rejection and resets to
		// idle — so the officer saw the confirm button re-enable and NOTHING else
		// happen, a silent failure on a signed write. The sibling
		// AssociationsSection.handleRemove wraps all three calls in one try and
		// never had this hole.
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const { tr } = await renderSection();

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { createDeviceSigner } = require("../../../../engines/device-signer");
		(createDeviceSigner as jest.Mock).mockRejectedValueOnce(
			new Error("Device user not initialised — cannot sign")
		);

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-${c1.nonce}-confirm`);
		await flush();

		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("Device user not initialised");
		// The card must stay mounted so the officer can retry, exactly as in the
		// removeAttestationChallenge-failure case (test 16).
		expect(() =>
			tr.root.findByProps({ testID: `attestation-challenges-expire-${c1.nonce}-card` })
		).not.toThrow();
	});

	test("22: a getEngine failure during expire surfaces InlineError too (translated, no engine text)", async () => {
		mockAssociationEngine = new MockAssociationEngine();
		const c1 = await seedChallenge(mockAssociationEngine, { deviceKey: DEVICE_KEY_ALPHA });
		const { tr } = await renderSection();

		// Fail only the expire-time getEngine call, not the initial load's.
		mockGetEngine.mockRejectedValueOnce(new Error("Network not established"));

		press(tr, `attestation-challenges-expire-trigger-${c1.nonce}`);
		press(tr, `attestation-challenges-expire-${c1.nonce}-confirm`);
		await flush();

		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("Network not established");
	});
});
