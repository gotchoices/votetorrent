/**
 * RegistrationPolicyScreen.test.tsx — the VALIDATION Wave-0 screen integration
 * suite for Phase 46 (46-09), covering D-02 (District field), D-03 (compound
 * 'district' audience gate), D-04/D-05 (reconciliation + repair), D-07
 * (tri-state attestation), D-10 (scope-gated read-only render), D-13
 * (warn-don't-block confirmation) and D-14 (immediate per-row apply).
 *
 * PATTERN SOURCE: apps/VoteTorrentAuthority/src/screens/ballots/__tests__/BallotConfirmation.test.tsx
 * — a REAL MockRegistrationEngine instance imported via a relative `dist/`
 * require, NOT AdministratorInvitationScreen.test.tsx's `jest.fn()`-mock
 * pattern. react-test-renderer ONLY; the testing-library packages for React
 * Native and for React Hooks are NOT dependencies of this app.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * `MockRegistrationEngine.addElectionRegistrationField` and
 * `addElectionDisclosurePolicy` are `Map.set` — an UPSERT. The real engine's
 * equivalents are plain `insert into` against an `(ElectionId, FieldName)`
 * primary key, so an in-place tier/requirement/audience edit MUST be executed
 * as remove-then-add (two separate 'mel'-signed calls — 46-08 T-46-08-01).
 * Because the mock upserts, a single bare `add` on an existing row silently
 * succeeds there too. THIS SUITE THEREFORE PASSES WHETHER OR NOT 46-08's
 * remove-then-add sequencing is correct — it is structurally blind to that
 * entire defect class. The D-14 test below (test 15) asserts the *callback
 * contract* only (one remove, then one add, in that order) and states plainly
 * that this proves call sequencing, NOT that the real engine accepts the
 * sequence. Real-engine proof is routed to 46-10's device run, and 46-10's
 * single signed write is an add-of-a-new-field, which does not exercise the
 * *edit* path either — an edit against the real engine remains unproven after
 * this phase unless 46-10 or a follow-up performs one. Making
 * MockRegistrationEngine throw on duplicate keys is a CANDIDATE FOLLOW-UP
 * ONLY, deliberately not done here — it would change a shared fixture every
 * other suite in this workspace depends on.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so the jest babel transform
// (babel-plugin-jest-hoist) allows the jest.mock() factories below to close
// over them despite being declared outside the factory's own scope.
// ---------------------------------------------------------------------------
let mockCurrentElectionEngine: any = null;

interface TestOfficer {
  userId: string;
  authorityId: string;
  title: string;
  scopes: string[];
}
let mockOfficers: TestOfficer[] = [];

const mockGetAdminDetails = jest.fn(async () => ({ admin: { officers: mockOfficers } }));

let mockRegistrationEngine: any;

const mockNetworkEngine = {
  openAuthority: jest.fn(async () => ({ getAdminDetails: mockGetAdminDetails })),
};

// The getEngine dispatcher: serves the current real MockRegistrationEngine
// instance for "registration" and the network-engine fixture (officer lookup
// chain) for "network" — everything else resolves null.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === "registration") return mockRegistrationEngine;
  if (name === "network") return mockNetworkEngine;
  return null;
});

// ---------------------------------------------------------------------------
// Module mocks — all heavy native / cross-cutting deps, module scope, before
// any import of the screen (mirrors BallotConfirmation.test.tsx exactly).
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// react-i18next: an interpolation-ECHOING t(), load-bearing for the D-10
// scope-naming test — it returns the bare key with no options, and
// `key + "|" + String(options.scope)` when an options object carries a
// `scope` field, so a test can prove scopeDescriptions.mel was actually bound
// rather than merely that some key rendered.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { scope?: string }) =>
      options && "scope" in options ? key + "|" + String(options.scope) : key,
  }),
}));

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();

jest.mock("@react-navigation/native", () => ({
  // Distinct sentinel values for every color token so a color assertion can
  // never pass by accidental equality between two tokens.
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
  // useFocusEffect: call the callback synchronously (simulating focus on mount).
  useFocusEffect: (cb: () => void | (() => void)) => {
    cb();
  },
  useRoute: () => ({
    params: {
      electionEngine: mockCurrentElectionEngine,
      electionId: "test-election",
      authorityId: "auth-1",
    },
  }),
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
  useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, exactly six levels
// up, matching BallotConfirmation.test.tsx. NOT `@votetorrent/vote-engine` —
// the package's `exports` field blocks this subpath. 46-01 rebuilds
// vote-engine's dist/; without that rebuild the attestation methods this
// suite needs are invisible to this require (see the stale-dist guard below).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require(
  "../../../../../../packages/vote-engine/dist/registration/mock-registration-engine",
);

// ---------------------------------------------------------------------------
// Election-engine fixture. `registrationEnds` is the only registration
// member of ElectionEvent — there is no registrationOpens/registrationCloses
// member on ElectionEvent itself (those are Timeline.tsx display labels
// mapped onto this one member). Default registrationEndsAt is one day in the
// PAST (window CLOSED) so D-13's card stays off unless a test opts in.
// getElectionRegistrants is stubbed to [] (D-08), so D-13's rosterNonEmpty
// leg can never be exercised by this suite — the window leg (below) is the
// only reachable trigger.
// ---------------------------------------------------------------------------
interface ElectionEngineFixtureOptions {
  districts?: string[];
  registrationEndsAt?: number;
}

function makeElectionEngine(options: ElectionEngineFixtureOptions) {
  const districts = options.districts ?? [];
  const registrationEndsAt = options.registrationEndsAt ?? Date.now() - 86400000;
  return {
    getBallots: jest.fn(async () => [{ id: "b1" }]),
    getBallotDetails: jest.fn(async (id: string) => ({ ballot: { id, districts } })),
    getElectionDetails: jest.fn(async () => ({
      election: {},
      current: { timeline: { registrationEnds: registrationEndsAt } },
    })),
  };
}

// ---------------------------------------------------------------------------
// Gap 4 (46-VERIFICATION.md, D-14 retry recovery) — purpose-built
// partial-failure ElectionRegistrationField double.
//
// MockRegistrationEngine's remove* is a Map.delete, which NEVER throws on a
// missing key (confirmed by direct read of mock-registration-engine.ts — NOT
// modified by this plan). That is exactly why the 174/174-green mock-backed
// suite could not see this defect class: the real engine's
// removeElectionRegistrationField (registration-engine.ts:950-952) throws an
// Error when the row is not found. This double is a plain object literal
// (no class, no `implements` clause — mockGetEngine returns `any`) whose
// remove* reproduces that throw-on-missing-row contract verbatim in intent,
// and whose add* rejects exactly once via an explicit call counter (not a
// jest mock-implementation queue, so the once-only behavior stays legible at
// the call site). It exposes only the methods RegistrationPolicyScreen's
// loadPolicy/onChangeField actually call, plus snapshot() so assertions can
// read engine state directly instead of inferring it from the render tree.
// ---------------------------------------------------------------------------
interface PartialFailureFieldRow {
  electionId: string;
  fieldName: string;
  tier: string;
  requirement: string;
}

function makePartialFailureRegistrationEngine(seed: PartialFailureFieldRow[]) {
  const fields = new Map<string, PartialFailureFieldRow>();
  for (const row of seed) fields.set(row.fieldName, row);

  let addCallCount = 0;

  return {
    async getElectionRegistrationFields(electionId: string): Promise<PartialFailureFieldRow[]> {
      return Array.from(fields.values()).filter((f) => f.electionId === electionId);
    },
    // Rejects on its FIRST invocation only — every later invocation (the
    // Retry) sets the row for real. Driven from a counter, not a jest
    // mock-implementation queue.
    async addElectionRegistrationField(field: PartialFailureFieldRow, _sign: unknown): Promise<void> {
      addCallCount += 1;
      if (addCallCount === 1) {
        throw new Error("partial-failure double: add rejected (simulated)");
      }
      fields.set(field.fieldName, field);
    },
    // Mirrors registration-engine.ts:950-952 in intent: throws when the row
    // is absent, deletes otherwise. This is the behavior MockRegistrationEngine
    // structurally cannot express (Map.delete never throws).
    async removeElectionRegistrationField(electionId: string, fieldName: string, _sign: unknown): Promise<void> {
      if (!fields.has(fieldName)) {
        throw new Error(
          `removeElectionRegistrationField: ElectionRegistrationField not found for electionId=${electionId}, fieldName=${fieldName}`,
        );
      }
      fields.delete(fieldName);
    },
    // Every other read loadPolicy invokes — a missing method here would
    // surface as a load error, not a silent pass, so each is present.
    async getElectionDisclosurePolicies(_electionId: string) {
      return [];
    },
    async getElectionAttestationPolicy(_electionId: string) {
      return undefined;
    },
    async getElectionRegistrants(_electionId: string) {
      return [];
    },
    snapshot(): PartialFailureFieldRow[] {
      return Array.from(fields.values());
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state (bypasses createDeviceSigner). */
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
  const RegistrationPolicyScreenModule = require("../RegistrationPolicyScreen");
  const RegistrationPolicyScreen =
    RegistrationPolicyScreenModule.default ?? RegistrationPolicyScreenModule.RegistrationPolicyScreen;

  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<RegistrationPolicyScreen />);
  });

  // Flush AT LEAST four ticks — this screen's load chain is deeper than a
  // typical screen: registration engine acquisition -> 3 policy reads ->
  // getBallots -> Promise.all of getBallotDetails -> registrants length ->
  // getElectionDetails, PLUS useCurrentOfficerScopes' own device-user ->
  // network engine -> openAuthority -> getAdminDetails walk.
  await flushTicks(6);

  return tr;
}

/**
 * Fires the real handler on a write control reachable under `testID`.
 *
 * ChipButton binds `onPressIn`, NOT `onPress`, and forwards no testID of its
 * own — the testID lives on writeWrap's wrapping View, which itself carries
 * neither handler. A press helper that only checks `onPress` on the exact
 * testID node finds nothing and silently no-ops, letting every press-driven
 * test pass vacuously. Asserting a non-empty candidate list BEFORE firing
 * turns a renamed/restructured control into a loud failure instead.
 */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
  const wrapper = tr.root.findByProps({ testID });
  const candidates = wrapper.findAll(
    (node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
  );
  expect(candidates.length).toBeGreaterThan(0);
  const target = candidates[0]!;
  await renderer.act(async () => {
    if (typeof target.props.onPressIn === "function") {
      target.props.onPressIn();
    } else {
      target.props.onPress();
    }
  });
  await flushTicks(4);
}

/**
 * The D-10 read-only variant of `press` — used ONLY where an EMPTY candidate
 * list is the CORRECT outcome. `findByProps` itself is the "control still
 * present" assertion (it throws if the testID is missing). ChipButton-backed
 * controls (writeWrap) genuinely have no live handler when canWrite is false
 * (onPress is set to `undefined`, not a no-op). AttestationPolicySection's
 * CustomButton controls instead bind a stable NOOP — RN's `disabled` prop
 * alone does not stop a directly-invoked (non-touch-driven) onPress
 * reference from firing, so NOOP exists specifically to make a direct
 * programmatic call safe. Either way, firing whatever is found here must
 * produce zero engine calls.
 */
function attemptPress(tr: renderer.ReactTestRenderer, testID: string): void {
  const wrapper = tr.root.findByProps({ testID });
  const candidates = wrapper.findAll(
    (node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
  );
  candidates.forEach((c) => {
    if (typeof c.props.onPressIn === "function") c.props.onPressIn();
    else if (typeof c.props.onPress === "function") c.props.onPress();
  });
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
  expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
  expect(() => tr.root.findByProps({ testID })).toThrow();
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

/**
 * Recursively find a node in the tr.toJSON() tree by its testID prop.
 *
 * NOT `tr.root.findByProps(...)` directly: a TestInstance carries a `parent`
 * back-reference into the live fiber tree, and JSON.stringify on it throws
 * "Converting circular structure to JSON" (confirmed empirically). The
 * `.toJSON()` tree is plain data (type/props/children only, no back-refs), so
 * this is the safe subtree-scoping primitive — the same pattern
 * RegistrationFieldsSection.test.tsx / DisclosurePolicySection.test.tsx use.
 */
function findJsonNodeByTestID(node: unknown, testID: string): unknown {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonNodeByTestID(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const n = node as { props?: { testID?: string }; children?: unknown };
  if (n.props?.testID === testID) return n;
  if (n.children) return findJsonNodeByTestID(n.children, testID);
  return null;
}

/** Seeds an ElectionRegistrationField directly through the mock's own engine surface. */
async function seedField(
  engine: any,
  args: { fieldName: string; tier: string; requirement: string },
): Promise<void> {
  await engine.addElectionRegistrationField(
    { electionId: "test-election", fieldName: args.fieldName, tier: args.tier, requirement: args.requirement },
    SEED_SIGN,
  );
}

/** Seeds an ElectionDisclosurePolicy directly through the mock's own engine surface. */
async function seedDisclosure(
  engine: any,
  args: { fieldName: string; audience: string },
): Promise<void> {
  await engine.addElectionDisclosurePolicy(
    { electionId: "test-election", fieldName: args.fieldName, audience: args.audience },
    SEED_SIGN,
  );
}

/**
 * Spies on all six 'mel'-signed write methods WITHOUT replacing their
 * implementation — the mock's state must keep mutating for real so the
 * screen's post-write loadPolicy() reload observes real changes.
 */
function spyWrites(engine: any) {
  return {
    addElectionRegistrationField: jest.spyOn(engine, "addElectionRegistrationField"),
    removeElectionRegistrationField: jest.spyOn(engine, "removeElectionRegistrationField"),
    addElectionDisclosurePolicy: jest.spyOn(engine, "addElectionDisclosurePolicy"),
    removeElectionDisclosurePolicy: jest.spyOn(engine, "removeElectionDisclosurePolicy"),
    setElectionAttestationPolicy: jest.spyOn(engine, "setElectionAttestationPolicy"),
    removeElectionAttestationPolicy: jest.spyOn(engine, "removeElectionAttestationPolicy"),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockRegistrationEngine = new MockRegistrationEngine();
  mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["mel"] }];
  mockCurrentElectionEngine = makeElectionEngine({});
  // Do NOT call jest.resetModules() — that would break the cached dist
  // require and the mock factory closures (the same note
  // BallotConfirmation.test.tsx carries).
});

describe("RegistrationPolicyScreen — VALIDATION Wave 0 (D-02/D-03/D-04/D-05/D-07/D-10/D-13/D-14)", () => {

  // -------------------------------------------------------------------------
  // Stale-dist guard
  // -------------------------------------------------------------------------

  it("stale-dist guard: MockRegistrationEngine exposes the attestation trio on a fresh instance", () => {
    // A failure here means packages/vote-engine/dist/ is stale relative to
    // 46-01's engine-surface additions and must be rebuilt — this makes a
    // stale dist fail loudly and legibly here instead of surfacing as an
    // obscure downstream render error deep inside this suite.
    const engine = new MockRegistrationEngine();
    expect(typeof engine.setElectionAttestationPolicy).toBe("function");
    expect(typeof engine.getElectionAttestationPolicy).toBe("function");
    expect(typeof engine.removeElectionAttestationPolicy).toBe("function");
  });

  // -------------------------------------------------------------------------
  // D-07 tri-state attestation
  // -------------------------------------------------------------------------

  it("D-07: not-configured is a real state — reachable with no row present (T-46-02)", async () => {
    const tr = await renderScreen();
    present(tr, "attestation-state-not-configured");
    // The fail-closed default MUST be a distinct UI state the read never
    // synthesizes — collapsing "no row" into either explicit state would
    // silently invert D-07's fail-closed rule.
    absent(tr, "attestation-state-required");
    absent(tr, "attestation-state-not-required");
    absent(tr, "attestation-action-revert");
  });

  it("D-07: required (set) renders the required state only", async () => {
    await mockRegistrationEngine.setElectionAttestationPolicy("test-election", true, SEED_SIGN);
    const tr = await renderScreen();
    present(tr, "attestation-state-required");
    absent(tr, "attestation-state-not-configured");
    absent(tr, "attestation-state-not-required");
    present(tr, "attestation-action-revert");
  });

  it("D-07: not-required (set) renders the not-required state only", async () => {
    await mockRegistrationEngine.setElectionAttestationPolicy("test-election", false, SEED_SIGN);
    const tr = await renderScreen();
    present(tr, "attestation-state-not-required");
    absent(tr, "attestation-state-not-configured");
    absent(tr, "attestation-state-required");
    present(tr, "attestation-action-revert");
  });

  // -------------------------------------------------------------------------
  // D-10 scope gate
  // -------------------------------------------------------------------------

  it("D-10: an officer holding 'mel' sees neither read-only banner", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["mel"] }];
    const tr = await renderScreen();
    absent(tr, "registration-policy-readonly-banner");
    absent(tr, "registration-policy-readonly-no-officer-banner");
  });

  it("D-10: an officer WITHOUT 'mel' sees the scoped banner naming Manage Elections", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Clerk", scopes: ["ceb"] }];
    const tr = await renderScreen();
    present(tr, "registration-policy-readonly-banner");
    absent(tr, "registration-policy-readonly-no-officer-banner");
    // The interpolation-echoing t() proves scopeDescriptions.mel ("Manage
    // Elections") was actually bound into the translated string, not merely
    // that some key rendered.
    expect(treeText(tr)).toContain("registrationPolicyReadOnlyBanner|Manage Elections");
  });

  it("D-10: a device with no matching Officer row sees the DISTINCT no-officer banner", async () => {
    mockOfficers = [];
    const tr = await renderScreen();
    present(tr, "registration-policy-readonly-no-officer-banner");
    absent(tr, "registration-policy-readonly-banner");
    // scopes === undefined (no matching officer) and scopes === [] (an
    // officer holding zero scopes) are two distinct facts and must never
    // collapse to one banner (T-46-03).
  });

  it("D-10: the read-only render fires ZERO writes while every control stays present", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Clerk", scopes: ["ceb"] }];
    await mockRegistrationEngine.addElectionRegistrationField(
      { electionId: "test-election", fieldName: "LastName", tier: "public", requirement: "required" },
      SEED_SIGN,
    );

    const addField = jest.spyOn(mockRegistrationEngine, "addElectionRegistrationField");
    const removeField = jest.spyOn(mockRegistrationEngine, "removeElectionRegistrationField");
    const addDisclosure = jest.spyOn(mockRegistrationEngine, "addElectionDisclosurePolicy");
    const removeDisclosure = jest.spyOn(mockRegistrationEngine, "removeElectionDisclosurePolicy");
    const setAttestation = jest.spyOn(mockRegistrationEngine, "setElectionAttestationPolicy");
    const removeAttestation = jest.spyOn(mockRegistrationEngine, "removeElectionAttestationPolicy");

    const tr = await renderScreen();

    // Press every write control reachable in this read-only render. Controls
    // stay PRESENT (findByProps does not throw) even though canWrite=false.
    attemptPress(tr, "registration-field-tier-LastName-selective");
    attemptPress(tr, "registration-field-requirement-LastName-optional");
    attemptPress(tr, "registration-field-remove-LastName");
    attemptPress(tr, "attestation-action-require");
    attemptPress(tr, "attestation-action-dont-require");

    // T-46-03: this pins the UI affordance ONLY. The real control is the
    // DB-side 'mel'-scoped AdminSignature CHECK on all three policy tables —
    // no assertion here may be read as a canWrite=false render itself
    // preventing a write; only a rejected signed mutation against the real
    // engine proves that.
    const totalCalls =
      addField.mock.calls.length +
      removeField.mock.calls.length +
      addDisclosure.mock.calls.length +
      removeDisclosure.mock.calls.length +
      setAttestation.mock.calls.length +
      removeAttestation.mock.calls.length;
    expect(totalCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // D-02 District field
  // -------------------------------------------------------------------------

  it("D-02: District is offered, visually separated, and rendered once declared", async () => {
    const tr1 = await renderScreen();
    present(tr1, "registration-field-picker-known");
    present(tr1, "registration-field-picker-divider");
    present(tr1, "registration-field-picker-district");
    present(tr1, "registration-field-district-hint");

    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    const tr2 = await renderScreen();
    present(tr2, "registration-field-row-District");
  });

  // -------------------------------------------------------------------------
  // D-03 compound 'district' audience gate — proven at the SCREEN level via
  // the screen's own N+1 getBallots -> getBallotDetails read. The remaining
  // two truth-table legs (Leg B alone; both legs closed) are proven at the
  // component level by 46-06's DisclosurePolicySection.test.tsx and are not
  // duplicated here.
  // -------------------------------------------------------------------------

  it("D-03: the compound gate is OPEN when both legs hold, proven via the screen's own N+1 read", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    mockCurrentElectionEngine = makeElectionEngine({ districts: ["D1"] });

    const tr = await renderScreen();
    present(tr, "disclosure-audience-Address-district");
    expect(mockCurrentElectionEngine.getBallotDetails).toHaveBeenCalled();
  });

  it("D-03: the compound gate is CLOSED (chip ABSENT, not disabled) when Leg A alone fails", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    mockCurrentElectionEngine = makeElectionEngine({ districts: [] });

    const tr = await renderScreen();
    absent(tr, "disclosure-audience-Address-district");
    present(tr, "disclosure-audience-Address-everyone");
    expect(tr.root.findAllByProps({ testID: "disclosure-district-unavailable-hint" }, { deep: false }).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-04/D-05 reconciliation + repair
  // -------------------------------------------------------------------------

  it("D-04/D-05: an orphan disclosure is flagged, its repair removes the row on the real mock, and the flag clears", async () => {
    await seedDisclosure(mockRegistrationEngine, { fieldName: "ZipCode", audience: "everyone" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    present(tr, "registration-policy-issues-card");
    present(tr, "registration-policy-issue-orphan-ZipCode");

    await press(tr, "registration-policy-issue-repair-remove-ZipCode");

    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [electionIdArg, fieldNameArg, signArg] = spies.removeElectionDisclosurePolicy.mock.calls[0]!;
    expect(electionIdArg).toBe("test-election");
    expect(fieldNameArg).toBe("ZipCode");
    expect(typeof signArg).toBe("function");

    const remaining = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(remaining).toEqual([]);

    absent(tr, "registration-policy-issue-orphan-ZipCode");
  });

  it("D-04/D-05: an audience-less selective field is flagged, its repair sets an audience on the real mock, and the flag clears", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    present(tr, "registration-policy-issue-no-audience-Address");

    // Reveal the inline Everyone/District choice first — it is never defaulted.
    await press(tr, "registration-policy-issue-repair-set-audience-Address");
    await press(tr, "registration-policy-issue-audience-Address-everyone");

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [payload, signArg] = spies.addElectionDisclosurePolicy.mock.calls[0]!;
    expect(payload).toEqual({ electionId: "test-election", fieldName: "Address", audience: "everyone" });
    expect(typeof signArg).toBe("function");

    const rows = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(rows.length).toBe(1);

    absent(tr, "registration-policy-issue-no-audience-Address");
  });

  it("clean state: a selective field with its matching disclosure renders no issues card", async () => {
    // The control that stops the two tests above from passing on an
    // always-on card.
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    await seedDisclosure(mockRegistrationEngine, { fieldName: "Address", audience: "everyone" });

    const tr = await renderScreen();
    absent(tr, "registration-policy-issues-card");
  });

  // -------------------------------------------------------------------------
  // D-14 — call sequencing only (T-46-09-01, see the header's declared blind
  // spot). MockRegistrationEngine's addElectionRegistrationField is a Map.set
  // upsert, so a single bare `add` on an existing LastName row would ALSO
  // succeed here — this test cannot and does not distinguish that from the
  // correct remove-then-add sequence. It asserts the CALLBACK CONTRACT only:
  // one edit produces exactly one remove followed by exactly one add against
  // the mock, and nothing else. A green run here does not prove policy editing works
  // against the real engine's plain-insert (ElectionId, FieldName) PK —
  // that proof is routed to 46-10's device run, and 46-10's
  // add-a-new-field write does not exercise this edit path either. Do NOT
  // "fix" this by making the mock throw on duplicate keys — that changes a
  // shared fixture every other suite in this workspace depends on; it is a
  // candidate follow-up only.
  // -------------------------------------------------------------------------

  it("D-14: one tier edit fires exactly one remove then one add, and nothing else — CALL SEQUENCING ONLY", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");

    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(1);
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledWith(
      "test-election",
      "LastName",
      expect.any(Function),
    );

    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(1);
    const [addPayload] = spies.addElectionRegistrationField.mock.calls[0]!;
    expect(addPayload).toEqual({
      electionId: "test-election",
      fieldName: "LastName",
      tier: "selective",
      requirement: "required", // unchanged requirement carried through
    });

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.setElectionAttestationPolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionAttestationPolicy).toHaveBeenCalledTimes(0);

    expect(spies.removeElectionRegistrationField.mock.invocationCallOrder[0]).toBeLessThan(
      spies.addElectionRegistrationField.mock.invocationCallOrder[0]!,
    );
  });

  // -------------------------------------------------------------------------
  // D-13 warn-don't-block confirmation. All three tests here open the
  // registration window explicitly (makeElectionEngine's registrationEndsAt
  // in the future) — the rosterNonEmpty leg CANNOT be exercised because
  // getElectionRegistrants is stubbed to [] (D-08), so the window leg is the
  // only trigger this suite can drive.
  // -------------------------------------------------------------------------

  it("D-13: the confirmation card appears before the first write and the write is withheld", async () => {
    mockCurrentElectionEngine = makeElectionEngine({ registrationEndsAt: Date.now() + 86400000 });
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");

    present(tr, "registration-policy-confirm-card");
    present(tr, "registration-policy-confirm-proceed");
    present(tr, "registration-policy-confirm-keep");

    // The write is PENDING the officer's decision, not applied.
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(0);
  });

  it("D-13: Proceed Anyway releases exactly the pending write and stays acknowledged for the session", async () => {
    mockCurrentElectionEngine = makeElectionEngine({ registrationEndsAt: Date.now() + 86400000 });
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");
    await press(tr, "registration-policy-confirm-proceed");

    absent(tr, "registration-policy-confirm-card");
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(1);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(1);

    // A second edit, same session, must NOT reopen the card — confirmAcknowledged
    // is session-sticky once Proceed Anyway has been pressed.
    await press(tr, "registration-field-requirement-LastName-optional");
    absent(tr, "registration-policy-confirm-card");
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(2);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(2);
  });

  it("D-13: Keep Current Policy withholds the write, resets the row, and the card can return", async () => {
    mockCurrentElectionEngine = makeElectionEngine({ registrationEndsAt: Date.now() + 86400000 });
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");
    // Keep does NOT resolve or reject the pending write's promise by design
    // (46-08) — the abandoned write is deliberately left unsettled, so this
    // test must not await it.
    await press(tr, "registration-policy-confirm-keep");

    absent(tr, "registration-policy-confirm-card");
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.setElectionAttestationPolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionAttestationPolicy).toHaveBeenCalledTimes(0);

    // The sectionEpoch remount reset the row status back to idle; the row is
    // still rendered (LastName never actually became selective).
    present(tr, "registration-field-row-LastName");

    // Pressing the edit control again must reopen the card — Keep did NOT
    // set confirmAcknowledged.
    await press(tr, "registration-field-tier-LastName-selective");
    present(tr, "registration-policy-confirm-card");
  });

  it("D-13 control: with the registration window CLOSED, an edit fires immediately and the card never renders", async () => {
    // mockCurrentElectionEngine stays at the beforeEach default (window closed) —
    // this is the control that stops the three tests above from passing on an
    // always-on card.
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");

    absent(tr, "registration-policy-confirm-card");
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(1);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // gap 5 (46-VERIFICATION.md, D-13/CR-04 displaced-write closure, 46-14).
  // A field with tier:'selective' renders in BOTH the Fields section and the
  // Disclosure section (DisclosurePolicySection.selectiveFields), giving this
  // test one control in each section without needing two seeded fields.
  // -------------------------------------------------------------------------

  it("D-13: a second edit while the card is open settles the displaced write instead of stranding its row", async () => {
    mockCurrentElectionEngine = makeElectionEngine({ registrationEndsAt: Date.now() + 86400000 });
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();

    // Press a fields control — the D-13 card opens and the tier-change write
    // is parked in pendingWriteRef, not yet fired.
    await press(tr, "registration-field-tier-Address-public");
    present(tr, "registration-policy-confirm-card");

    // Press a disclosure control while the card is still open. This is the
    // cross-section displacement case: the card renders inline directly
    // above the Fields section while every section stays mounted and
    // interactive, so a second edit from a DIFFERENT section still displaces
    // the first write parked in the single-slot pendingWriteRef.
    await press(tr, "disclosure-audience-Address-everyone");

    // The displaced fields write settled into error rather than hanging —
    // its row reached Couldn't-save + a working Retry.
    present(tr, "registration-field-retry-Address");
    const statusNode = findJsonNodeByTestID(tr.toJSON(), "registration-field-status-Address");
    expect(JSON.stringify(statusNode)).not.toContain("registrationPolicyRowSaving");

    // Neither write has actually reached the engine yet — both are still
    // gated behind the (now second, disclosure) pending write awaiting the
    // officer's decision.
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(0);

    // Proceed Anyway releases ONLY the most recent (disclosure) pending
    // write — the displaced fields edit is not silently applied alongside it.
    await press(tr, "registration-policy-confirm-proceed");

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(0);
    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(0);

    // The D-13 roster leg cannot be exercised here because
    // getElectionRegistrants is stubbed to [] (D-08/D-09, deferred to Phase
    // 47) — the registration-window leg above is the only reachable trigger,
    // matching the three existing D-13 tests in this file.
  });

});

// ---------------------------------------------------------------------------
// Gap 4 closure (46-VERIFICATION.md, D-14 retry recovery, 46-13). This suite
// installs makePartialFailureRegistrationEngine — NOT MockRegistrationEngine
// — as the module-level mockRegistrationEngine slot, so it proves the thing
// the DECLARED BLIND SPOT at the top of this file says the rest of the suite
// cannot: that Retry recovers after a remove-then-add edit whose remove
// committed and whose add failed, against an engine whose remove throws on a
// missing row exactly like the real registration-engine.ts does. It does
// NOT prove T-46-08-01's remove-then-add PK-collision class against the
// real engine — that class concerns the FIRST add attempt colliding with an
// existing PK row on a plain `insert into`, a different failure shape from
// the SECOND (add-rejected) leg this test exercises, and remains routed to a
// real-engine run per 46-VALIDATION.md and the 46-08/46-10 SUMMARYs.
// ---------------------------------------------------------------------------
describe("RegistrationPolicyScreen — gap 4 (D-14 retry recovery, 46-13)", () => {
  it("Retry after a half-applied tier edit eventually succeeds against an engine whose remove throws on a missing row", async () => {
    const partialFailureEngine = makePartialFailureRegistrationEngine([
      { electionId: "test-election", fieldName: "LastName", tier: "public", requirement: "required" },
    ]);
    // Installed per-test into the module-level slot; beforeEach resets it to
    // a fresh MockRegistrationEngine before every test, so this cannot leak.
    mockRegistrationEngine = partialFailureEngine;

    const removeSpy = jest.spyOn(partialFailureEngine, "removeElectionRegistrationField");
    const addSpy = jest.spyOn(partialFailureEngine, "addElectionRegistrationField");

    const tr = await renderScreen();
    present(tr, "registration-field-row-LastName");

    // First press: onChangeField's fresh existence read finds the row, removes
    // it (committing on the double), then the add rejects (the double's
    // first-call-only failure). runSignedWrite's finally still reloads the
    // policy on this failure branch.
    await press(tr, "registration-field-tier-LastName-selective");

    // The double holds ZERO registration fields — the remove really committed.
    expect(partialFailureEngine.snapshot()).toEqual([]);

    // The field vanished from `fields`, so the normal row is gone — but the
    // orphan-error row (Task 2) keeps the Couldn't-save message and Retry
    // reachable. This proves both that loadPolicy ran on the failure branch
    // (Task 1) and that the recovery affordance survived the row's disappearance
    // (Task 2).
    absent(tr, "registration-field-row-LastName");
    present(tr, "registration-field-orphan-error-LastName");
    present(tr, "registration-field-orphan-error-retry-LastName");

    // Press Retry. onChangeField's existence re-read now finds no row, SKIPS
    // the remove (the row is genuinely absent), and calls add — which
    // succeeds this time because the double's rejection is first-call-only.
    await press(tr, "registration-field-orphan-error-retry-LastName");

    // No rejection escaped: the orphan-error row is gone, the normal row is
    // back, and the double holds the fully-applied edit.
    absent(tr, "registration-field-orphan-error-LastName");
    present(tr, "registration-field-row-LastName");
    expect(partialFailureEngine.snapshot()).toEqual([
      { electionId: "test-election", fieldName: "LastName", tier: "selective", requirement: "required" },
    ]);

    // Across the WHOLE failure-then-retry sequence, removeElectionRegistrationField
    // was called exactly once — the second attempt (Retry) skipped the
    // already-committed remove instead of replaying it into a throw. A second
    // call here would mean the identical op was replayed: the defect gap 4 closes.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Gap 1 closure (46-VERIFICATION.md gap 1, 46-REVIEW.md CR-01, a REGRESSION
// 46-12 itself introduced, closed by 46-15). onRemoveDisclosure passed the
// caller-supplied fieldName (the FIELD row's casing) straight to
// removeElectionDisclosurePolicy, which does an exact-match PK read against
// the real engine and throws on a case-skewed miss. MockRegistrationEngine's
// removeElectionDisclosurePolicy is a Map.delete that never throws — it
// silently removes NOTHING on a wrong-cased key, so the row survives in
// getElectionDisclosurePolicies afterward. That miss is sufficient to prove
// this gap: every test below asserts BOTH the exact argument the delete was
// keyed on AND the resulting engine state, never just that a delete fired.
// ---------------------------------------------------------------------------
describe("RegistrationPolicyScreen — gap 1 (CR-01 stored-casing disclosure delete, 46-15)", () => {
  it("the delete is keyed on the STORED casing, not the field row's casing", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    // Deliberate case skew: the disclosure row is stored lower-cased while
    // the field row is 'Address'.
    await seedDisclosure(mockRegistrationEngine, { fieldName: "address", audience: "everyone" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "disclosure-remove-Address");

    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [electionIdArg, fieldNameArg] = spies.removeElectionDisclosurePolicy.mock.calls[0]!;
    expect(electionIdArg).toBe("test-election");
    // The delete's PK argument must be the STORED casing ('address'), not
    // the field row's casing ('Address') the press originated from. This is
    // the load-bearing assertion the plan requires — the argument's value,
    // not merely that the spy was called.
    expect(fieldNameArg).toBe("address");

    // Independent proof the row is genuinely gone from the engine, not
    // merely that a delete was attempted.
    const remaining = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(remaining).toEqual([]);
  });

  it("after the case-skewed remove, the screen reflects that the row is gone", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    await seedDisclosure(mockRegistrationEngine, { fieldName: "address", audience: "everyone" });

    const tr = await renderScreen();
    await press(tr, "disclosure-remove-Address");

    // Subtree-scoped, per the anti-vacuity rule — never a whole-tree
    // toContain check, since both audience labels are always present
    // somewhere as chip labels.
    const currentNode = findJsonNodeByTestID(tr.toJSON(), "disclosure-current-audience-Address");
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain("registrationPolicyAudienceNotSet");
    expect(currentJson).not.toContain("registrationPolicyAudienceEveryone");

    absent(tr, "disclosure-remove-Address");

    // Independent proof of the same fact from a different angle: the row's
    // removal makes Address a selective field with no audience row, which
    // is exactly what the Policy Issues card flags (D-04/D-05).
    present(tr, "registration-policy-issue-no-audience-Address");
  });

  it("matched-casing control: a same-cased remove is still keyed on that casing (guards against a blanket-lowercase fix)", async () => {
    // Without this control, an implementation that lower-cased EVERY PK
    // argument (instead of resolving the stored casing) would pass the two
    // tests above while silently breaking this one.
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    await seedDisclosure(mockRegistrationEngine, { fieldName: "Address", audience: "everyone" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "disclosure-remove-Address");

    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [electionIdArg, fieldNameArg] = spies.removeElectionDisclosurePolicy.mock.calls[0]!;
    expect(electionIdArg).toBe("test-election");
    expect(fieldNameArg).toBe("Address");

    const remaining = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(remaining).toEqual([]);
  });
});

describe("RegistrationPolicyScreen — gap 2 (CR-02 in-flight double-press guard, 46-16)", () => {
  it("screen level, picker chip: double-pressing while its add is in flight fires addElectionRegistrationField exactly once (PROBE B)", async () => {
    // Replaces the implementation entirely (unlike spyWrites) so the mock's
    // state stops mutating — that is intended: the write must stay in flight.
    const addSpy = jest
      .spyOn(mockRegistrationEngine, "addElectionRegistrationField")
      .mockImplementation(() => new Promise<void>(() => {}));

    const tr = await renderScreen();

    // Explicit flush between presses (beyond press()'s own internal flush) so
    // the screen's createDeviceSigner -> getEngine -> add chain is genuinely
    // mid-flight and loadPolicy() has not re-run.
    await press(tr, "registration-field-picker-lastname");
    await flushTicks(6);
    await press(tr, "registration-field-picker-lastname");
    await flushTicks(6);

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]![0]).toEqual({
      electionId: "test-election",
      fieldName: "LastName",
      tier: "public",
      requirement: "required",
    });
  });

  it("screen level, Issues-card repair chip: double-pressing while its repair is in flight fires removeElectionDisclosurePolicy exactly once (PROBE A)", async () => {
    // An orphan disclosure with no matching field, so the Policy Issues card
    // renders registration-policy-issue-orphan-ZipCode.
    await seedDisclosure(mockRegistrationEngine, { fieldName: "ZipCode", audience: "everyone" });

    // Stub ONLY removeElectionDisclosurePolicy. After 46-15 the repair path
    // first performs a getElectionDisclosurePolicies read inside the op to
    // resolve the stored PK casing — leaving that read intact is required, or
    // the resolver returns undefined and the delete is legitimately skipped
    // (which would make this test vacuous).
    const removeSpy = jest
      .spyOn(mockRegistrationEngine, "removeElectionDisclosurePolicy")
      .mockImplementation(() => new Promise<void>(() => {}));

    const tr = await renderScreen();
    present(tr, "registration-policy-issue-orphan-ZipCode");

    await press(tr, "registration-policy-issue-repair-remove-ZipCode");
    await flushTicks(6);
    await press(tr, "registration-policy-issue-repair-remove-ZipCode");
    await flushTicks(6);

    expect(removeSpy).toHaveBeenCalledTimes(1);

    // Subtree-scoped, per the anti-vacuity rule: prove the repair really is
    // in flight (the guard is being exercised in its intended state), not
    // that the test accidentally proves nothing.
    const statusNode = findJsonNodeByTestID(tr.toJSON(), "registration-policy-issue-status-ZipCode");
    const statusJson = JSON.stringify(statusNode);
    expect(statusJson).toContain("registrationPolicyRowSaving");
  });
});

describe("RegistrationPolicyScreen — 46-UAT test 12 (repair chip must survive its own success)", () => {
  // Found by driving the real app on a Pixel_8, not by this suite: a repair
  // that SUCCEEDS left issueStatus[fieldName] pinned at "saving" (WR-03, which
  // 46-REVIEW.md assessed as a cosmetic stale label). 46-16 later added
  // `if (issueStatus[fieldName] === "saving") return;` to runIssueWrite as the
  // CR-02 double-press guard — and that guard then matched the stale status,
  // silently swallowing every LATER repair press for the field.
  //
  // Why no existing test caught it: 46-16's PROBE A/B assert call counts within
  // ONE press cycle, deliberately holding the write in flight forever. Nothing
  // exercised repair -> SUCCESS -> re-flag -> repair again across one mount.

  // NOTE — a companion test asserting "the status node no longer says Saving…"
  // immediately after a successful repair was written first and DELETED: it is
  // structurally vacuous. A successful repair removes the flagged row from the
  // card entirely, so `registration-policy-issue-status-<field>` does not exist
  // to inspect, and `JSON.stringify(undefined)` satisfies `.not.toContain(...)`
  // whether or not the status was ever cleared. It stayed GREEN under the
  // mutation below. The press-through test is the only sound formulation: the
  // stale status is observable ONLY through the behaviour it blocks.

  it("the SAME field's repair chip still fires a write when the issue re-appears in one screen session", async () => {
    // The device repro, verbatim: repair the audience (succeeds, flag clears),
    // remove the disclosure from the Disclosure section (field is re-flagged),
    // then press the repair again. Before the fix the second press was a silent
    // no-op — no confirmation, no write, no error.
    await seedField(mockRegistrationEngine, {
      fieldName: "LastName",
      tier: "selective",
      requirement: "required",
    });

    const spies = spyWrites(mockRegistrationEngine);
    const tr = await renderScreen();

    // --- repair #1: succeeds, issue clears ---
    await press(tr, "registration-policy-issue-repair-set-audience-LastName");
    await flushTicks(6);
    await press(tr, "registration-policy-issue-audience-LastName-everyone");
    await flushTicks(6);
    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    absent(tr, "registration-policy-issue-no-audience-LastName");

    // --- re-flag the SAME field through the Disclosure section's own control ---
    await press(tr, "disclosure-remove-LastName");
    await flushTicks(6);
    present(tr, "registration-policy-issue-no-audience-LastName");

    // --- repair #2: must actually fire, not be swallowed by the stale guard ---
    await press(tr, "registration-policy-issue-repair-set-audience-LastName");
    await flushTicks(6);
    await press(tr, "registration-policy-issue-audience-LastName-everyone");
    await flushTicks(6);

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(2);
    // And the repair really took effect, not merely got called.
    absent(tr, "registration-policy-issue-no-audience-LastName");
  });
});
