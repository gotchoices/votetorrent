/**
 * RegistrantDetailScreen.accessTrail.test.tsx — the Phase 47 END-TO-END gate
 * for D-14 (reveal -> accumulate -> flush across unmount AND `AppState`
 * background, driven through the real shipped screen).
 *
 * Same harness as `RegistrantDetailScreen.integration.test.tsx` — the
 * `mock`-prefixed real `dist/` engine slots, the `mockGetEngine` dispatcher,
 * and `seedRegistrant()` — reused verbatim rather than inventing a second
 * scaffold, per the plan's explicit instruction.
 *
 * `47-13-PLAN.md`'s single most important fact, restated here because every
 * test in this file either proves it or depends on it: **the flush is a
 * DELTA**. `access-trail-visit.ts`'s `createAccessTrailVisit` marks names as
 * `handedOff` BEFORE the awaited `record(...)` call, so a background flush
 * followed later by an unmount flush produces TWO recorder calls carrying
 * DISJOINT name sets, never a duplicate and never a single merged row. A
 * "one row per screen visit" assertion would be asserting the WRONG shape
 * and would fail against CORRECT code — test 4 below is the load-bearing
 * proof of this, through the real screen.
 *
 * `useAccessTrailVisit.test.tsx` (47-13, Task 2) already proves the HOOK in
 * isolation against an injected recorder. This suite does not duplicate
 * those assertions — it proves the SCREEN binds a real
 * `recordRegistrantAccessEvent` to that hook, with a real registrant id and
 * a real viewer id, reading the engine's own stored rows back as
 * independent proof alongside the spy.
 */

import React from "react";
import renderer from "react-test-renderer";
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them.
// ---------------------------------------------------------------------------

const REGISTRANT_ID = "reg-1";
const AUTHORITY_ID = "auth-1";
const FUTURE_ISO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

// Private-tier VALUE sentinels — never used in a test title.
const SSN_VALUE = "123-45-6789";
const DOB_VALUE = "1980-01-01";
const PHONE_VALUE = "555-0142";

interface TestOfficer {
	userId: string;
	authorityId: string;
	title: string;
	scopes: string[];
}
// An ungated officer renders no private rows and therefore cannot reveal
// anything — this suite needs the 'vrg' officer for every test.
let mockOfficers: TestOfficer[] = [
	{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] },
];
const mockGetAdminDetails = jest.fn(async () => ({ admin: { officers: mockOfficers } }));
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => ({ getAdminDetails: mockGetAdminDetails })),
};

let mockRegistrationEngine: any;
let mockAssociationEngine: any;
let mockAuthorityConfigEngine: any;

// A minimal, NON-real elections fixture — deliberately NOT MockElectionsEngine
// (see the integration suite's comment: it logs on every getElections() call
// and would poison the never-log assertion this suite also carries).
let mockElections: Array<{ id: string }> = [];
const mockElectionsEngine = {
	getElections: jest.fn(async () => mockElections),
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "association") return mockAssociationEngine;
	if (name === "authorityConfig") return mockAuthorityConfigEngine;
	if (name === "network") return mockNetworkEngine;
	if (name === "elections") return mockElectionsEngine;
	return null;
});

// ---------------------------------------------------------------------------
// Module mocks — module scope, before any import of the screen. Identical to
// RegistrantDetailScreen.integration.test.tsx.
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("react-i18next", () => ({
	...jest.requireActual("react-i18next"),
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key +
					"|" +
					Object.entries(options)
						.map(([k, v]) => k + "=" + String(v))
						.join(",")
				: key,
	}),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();

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
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
		setParams: mockSetParams,
	}),
	useRoute: () => ({ params: { registrantId: REGISTRANT_ID, authorityId: AUTHORITY_ID } }),
}));

jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, isAttestationVerifierProvisioned: () => true }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engines — required by relative dist path, six levels up.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require(
	"../../../../../../packages/vote-engine/dist/registration/mock-registration-engine",
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockAssociationEngine } = require(
	"../../../../../../packages/vote-engine/dist/association/mock-association-engine",
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockAuthorityConfigEngine } = require(
	"../../../../../../packages/vote-engine/dist/authority-config/mock-authority-config-engine",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED_SIGN = async () => ({
	signature: "seed-sig",
	signerKey: "seed-key",
	signerUserId: "seed-user",
});

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const RegistrantDetailScreenModule = require("../RegistrantDetailScreen");
	const RegistrantDetailScreen = RegistrantDetailScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<RegistrantDetailScreen />);
	});
	await flushTicks(12);
	return tr;
}

/** Finds `registrant-detail-private-toggle-{name}` and presses it inside `act`. */
async function revealField(tr: renderer.ReactTestRenderer, name: string): Promise<void> {
	const toggle = tr.root.findByProps({ testID: `registrant-detail-private-toggle-${name}` });
	await renderer.act(async () => {
		toggle.props.onPress();
	});
	await flushTicks(2);
}

async function seedRegistrant(): Promise<void> {
	await mockRegistrationEngine.register(
		{
			registrant: { id: REGISTRANT_ID, authorityId: AUTHORITY_ID, expiration: FUTURE_ISO },
			public: { lastName: "Vasquez", firstName: "Ada", district: "D-7", extraFields: [] },
			private: {
				expiration: FUTURE_ISO,
				details: [
					{ name: "ssn", value: SSN_VALUE },
					{ name: "dob", value: DOB_VALUE },
					{ name: "phone", value: PHONE_VALUE },
				],
			},
			selective: {
				expiration: FUTURE_ISO,
				details: [
					{ name: "email", value: "ada@example.test" },
					{ name: "street", value: "12 Elm" },
					{ name: "county", value: "Marion" },
				],
			},
		},
		SEED_SIGN,
	);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let capturedAppStateHandler: ((state: AppStateStatus) => void) | undefined;
let removeSpy: jest.Mock;

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockAssociationEngine = new MockAssociationEngine();
	mockAuthorityConfigEngine = new MockAuthorityConfigEngine();
	mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
	mockElections = [];
	capturedAppStateHandler = undefined;
	removeSpy = jest.fn();

	// A targeted spy, not a wholesale `jest.mock('react-native', ...)` — the
	// RN preset already supplies a working AppState, and the spy
	// additionally lets this suite assert the subscription was REMOVED
	// (test 8), which a module-level mock would obscure.
	jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, handler: (s: AppStateStatus) => void) => {
		capturedAppStateHandler = handler;
		return { remove: removeSpy } as never;
	}) as typeof AppState.addEventListener);
	// Do NOT call jest.resetModules() — see the integration suite's note.
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe("RegistrantDetailScreen.accessTrail — the D-14 delta-flush E2E gate", () => {
	it("D-14: revealing two fields and unmounting flushes exactly one event carrying both NAMES", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");
		await revealField(tr, "dob");

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(1);
		expect(recordSpy).toHaveBeenCalledWith(REGISTRANT_ID, "device-user-1", ["dob", "ssn"]);

		const events = await mockRegistrationEngine.getRegistrantAccessEvents(REGISTRANT_ID);
		expect(events.length).toBe(1);
		expect(events[0].registrantId).toBe(REGISTRANT_ID);
		expect(events[0].viewerUserId).toBe("device-user-1");
		expect(events[0].fields).toEqual(["dob", "ssn"]);
	});

	it("D-14: revealing the same field three times contributes its name exactly once", async () => {
		// 47-12 emits onReveal on EVERY masked-to-revealed edge and offers no
		// retraction — the Set in access-trail-visit.ts is what makes this
		// true. Re-masking deliberately does NOT retract the name: the
		// officer already saw it.
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn"); // reveal
		await revealField(tr, "ssn"); // re-mask
		await revealField(tr, "ssn"); // reveal
		await revealField(tr, "ssn"); // re-mask
		await revealField(tr, "ssn"); // reveal

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(1);
		expect(recordSpy).toHaveBeenCalledWith(REGISTRANT_ID, "device-user-1", ["ssn"]);
	});

	it("D-14: backgrounding the app flushes without unmounting", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(1);
		expect(recordSpy).toHaveBeenCalledWith(REGISTRANT_ID, "device-user-1", ["ssn"]);
		// Still mounted — a background flush must not tear down the screen.
		expect(() => tr.root.findByProps({ testID: "registrant-detail-private-tier" })).not.toThrow();
	});

	it("D-14 DELTA CONTRACT: background then unmount produces TWO rows with DISJOINT names", async () => {
		// THE load-bearing test in this file. access-trail-visit.ts marks
		// names as `handedOff` BEFORE the awaited `record(...)` write, so a
		// visit split by a backgrounding produces two recorder calls, each
		// carrying only the names revealed since the LAST flush — never a
		// merged "everything revealed this visit" row, and never a
		// duplicate. A "one row per screen visit" assertion here would be
		// asserting the WRONG shape and would fail against CORRECT code; the
		// honest invariant is "no name recorded twice, no revealed name
		// dropped by the split", not "exactly one row".
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");

		// Deliberately SYNCHRONOUS and back-to-back — background trigger, the
		// dob reveal (via the raw prop, bypassing the async `revealField`
		// helper), and unmount all fire in the same JS turn with NO `await`
		// between them. This is what actually distinguishes "mark handedOff
		// BEFORE the awaited record() call" from "mark handedOff AFTER":
		// with no intervening microtask tick, the second (unmount) flush's
		// pending-names computation runs before the first (background)
		// flush's `record(...)` promise has had any chance to settle. Only
		// the BEFORE-await marking is synchronous enough to be visible here
		// — an AFTER-await marking would still be unmarked when the second
		// flush computes its own pending set, producing `["dob","ssn"]`
		// instead of `["dob"]` on the second call.
		renderer.act(() => {
			capturedAppStateHandler?.("background");
			const dobToggle = tr.root.findByProps({ testID: "registrant-detail-private-toggle-dob" });
			dobToggle.props.onPress();
			tr.unmount();
		});
		await flushTicks(6);

		expect(recordSpy.mock.calls.map((c) => c[2])).toEqual([["ssn"], ["dob"]]);

		const events = await mockRegistrationEngine.getRegistrantAccessEvents(REGISTRANT_ID);
		expect(events.length).toBe(2);
		const allNames = events.flatMap((e: { fields: string[] }) => e.fields);
		// Disjoint: the union has no duplicate, and both revealed names appear.
		expect(new Set(allNames).size).toBe(allNames.length);
		expect(new Set(allNames)).toEqual(new Set(["ssn", "dob"]));
	});

	it("D-14: an inactive transition does not flush; a background transition does", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");

		await renderer.act(async () => {
			capturedAppStateHandler?.("inactive");
			await Promise.resolve();
		});
		await flushTicks(2);
		expect(recordSpy).toHaveBeenCalledTimes(0);

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(4);
		expect(recordSpy).toHaveBeenCalledTimes(1);
	});

	it("D-14: a visit with no reveal flushes nothing on either trigger", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(4);

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(0);
		const events = await mockRegistrationEngine.getRegistrantAccessEvents(REGISTRANT_ID);
		expect(events.length).toBe(0);
	});

	it("D-14: two separate mounts are two visits", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");

		const tr1 = await renderScreen();
		await revealField(tr1, "ssn");
		await renderer.act(async () => {
			tr1.unmount();
		});
		await flushTicks(4);

		const tr2 = await renderScreen();
		await revealField(tr2, "dob");
		await renderer.act(async () => {
			tr2.unmount();
		});
		await flushTicks(4);

		expect(recordSpy.mock.calls.map((c) => c[2])).toEqual([["ssn"], ["dob"]]);
	});

	it("D-14: the AppState subscription is removed on unmount", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(removeSpy).toHaveBeenCalledTimes(1);
		expect(recordSpy).toHaveBeenCalledTimes(1);

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(2);
		// No additional call — the removed subscription means the captured
		// handler firing post-unmount reaches no live effect.
		expect(recordSpy).toHaveBeenCalledTimes(1);
	});

	it("D-14/T-47-02: the flush payload carries names ONLY — never a value", async () => {
		await seedRegistrant();
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await revealField(tr, "ssn");
		await revealField(tr, "dob");
		await revealField(tr, "phone");

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		const serialized = JSON.stringify(recordSpy.mock.calls);
		expect(serialized).not.toContain(SSN_VALUE);
		expect(serialized).not.toContain(DOB_VALUE);
		expect(serialized).not.toContain(PHONE_VALUE);
		expect(recordSpy.mock.calls[0]![2]).toEqual(["dob", "phone", "ssn"]);
	});

	it("D-14: a failing recorder is accepted loss — no retry, no crash, no console", async () => {
		// This is the accepted loss being asserted, not a defect. Re-sending
		// 'ssn' on the next flush would be a retry queue, which D-14 rules
		// out. The trail is never described here as preventing anything.
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
		try {
			await seedRegistrant();
			const recordSpy = jest
				.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent")
				.mockRejectedValueOnce(new Error("recorder rejected"));

			const tr = await renderScreen();

			await revealField(tr, "ssn");

			await expect(
				(async () => {
					await renderer.act(async () => {
						capturedAppStateHandler?.("background");
						await Promise.resolve();
					});
					await flushTicks(4);
				})(),
			).resolves.not.toThrow();

			await revealField(tr, "dob");

			await renderer.act(async () => {
				tr.unmount();
			});
			await flushTicks(4);

			expect(recordSpy).toHaveBeenCalledTimes(2);
			// The first (rejected) call carried ['ssn'] — gone for good, no
			// retry. The second call's argument is exactly ['dob'], not
			// ['dob','ssn'].
			expect(recordSpy.mock.calls[0]![2]).toEqual(["ssn"]);
			expect(recordSpy.mock.calls[1]![2]).toEqual(["dob"]);

			for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
				expect(spy).toHaveBeenCalledTimes(0);
			}
		} finally {
			logSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
			infoSpy.mockRestore();
			debugSpy.mockRestore();
		}
	});
});
