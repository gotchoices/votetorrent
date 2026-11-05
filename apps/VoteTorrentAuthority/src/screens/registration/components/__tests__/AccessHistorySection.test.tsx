/**
 * AccessHistorySection.test.tsx — render proof for the D-01 reviewer surface,
 * against the REAL MockRegistrationEngine via the relative `dist/` require
 * (BallotConfirmation.test.tsx / RegistrationPolicyScreen.test.tsx pattern),
 * NOT a `jest.fn()` engine stub. react-test-renderer ONLY.
 *
 * The real `MockNetworkEngine.getUser` (packages/vote-engine/src/network/
 * mock-network-engine.ts:234-236) returns a fresh `MockUserEngine` and
 * IGNORES its `userId` argument, so it structurally cannot express "two
 * different viewers with two different names" or "this id resolves to
 * nobody" — the two behaviours this suite must prove (tests 4 and 5). A
 * small purpose-built network double is used instead, in the same voice as
 * RegistrationPolicyScreen.test.tsx:220-232's justified hand-built double.
 */

import React from "react";
import renderer from "react-test-renderer";
import { StyleSheet } from "react-native";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them.
// ---------------------------------------------------------------------------
let mockRegistrationEngine: any;
let mockNetworkSlot: any;
let mockUserNames: Record<string, string>;

const mockNetworkDouble = {
  getUser: async (id: string) => {
    const name = mockUserNames[id];
    if (typeof name !== "string") return undefined;
    return { getSummary: async () => ({ name }) };
  },
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === "registration") return mockRegistrationEngine;
  if (name === "network") return mockNetworkSlot;
  return null;
});

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// Interpolation-echoing t(): the bare key when no options object is passed,
// and `key + "|" + JSON.stringify(options)` when one is, so a row's bound
// viewer/fields/timestamp values are assertable through the accessibilityLabel.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? key + "|" + JSON.stringify(options) : key,
  }),
}));

jest.mock("@react-navigation/native", () => ({
  // Distinct sentinel values for every color token so a color assertion can
  // never pass by accidental token equality.
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
}));

jest.mock("../../../../providers/AppProvider", () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, seven levels up
// from this file's `components/__tests__/` location (one deeper than
// RegistrationPolicyScreen.test.tsx's six, per this plan's tree_conventions
// path-depth correction).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require(
  "../../../../../../../packages/vote-engine/dist/registration/mock-registration-engine",
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AccessHistorySection } = require("../AccessHistorySection");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChipButton } = require("../../../../components/ChipButton");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ThemedText } = require("../../../../components/ThemedText");

// ---------------------------------------------------------------------------
// Recording proxy — wraps an engine so a test can assert a method's call
// count (including zero) without replacing its real implementation. Every
// invocation is forwarded to the underlying target via Reflect/apply, so the
// engine's own state keeps mutating for real.
// ---------------------------------------------------------------------------
function makeRecordingProxy<T extends object>(target: T): { proxy: T; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(target as any, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function") {
        return (...args: any[]) => {
          const key = String(prop);
          calls[key] = (calls[key] ?? 0) + 1;
          return value.apply(obj, args);
        };
      }
      return value;
    },
  });
  return { proxy: proxy as T, calls };
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state. */
const SEED_SIGN = async () => ({
  signature: "seed-sig",
  signerKey: "seed-key",
  signerUserId: "seed-user",
});

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Registers `registrantId` with a `RegistrantPrivate` row carrying three
 * sentinel private VALUES (ssn/dob/phone), then records one
 * `RegistrantAccessEvent` per requested entry via
 * `recordRegistrantAccessEvent`. Seeding the sentinel values is mandatory,
 * not decoration: 47-07 derives the trail's names allowlist from them, and
 * they are what test 8 proves can never reach the screen.
 */
async function seedRegistrantWithTrail(
  engine: any,
  args: { registrantId: string; events?: Array<{ viewerUserId: string; fields: string[] }> },
): Promise<void> {
  await engine.register(
    {
      registrant: { id: args.registrantId, authorityId: "auth-1", expiration: FUTURE },
      public: {},
      private: {
        expiration: FUTURE,
        details: [
          { name: "ssn", value: "000-00-0000" },
          { name: "dob", value: "1980-01-01" },
          { name: "phone", value: "555-0100" },
        ],
      },
    },
    SEED_SIGN,
  );
  for (const event of args.events ?? []) {
    await engine.recordRegistrantAccessEvent(args.registrantId, event.viewerUserId, event.fields);
  }
}

// ---------------------------------------------------------------------------
// Render / interaction helpers
// ---------------------------------------------------------------------------

async function flushTicks(count: number): Promise<void> {
  await renderer.act(async () => {
    for (let i = 0; i < count; i++) {
      await Promise.resolve();
    }
  });
}

async function renderSection(props: { registrantId: string; canView: boolean }): Promise<renderer.ReactTestRenderer> {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AccessHistorySection {...props} />);
  });
  await flushTicks(4);
  return tr;
}

/**
 * Fires the real handler on a testID-carrying control. `ChipButton` binds
 * `onPressIn`, NOT `onPress` — a helper that only checks `onPress` would
 * silently no-op. Asserting a non-empty candidate list BEFORE firing turns a
 * renamed/restructured control into a loud failure instead of a false-green
 * test (RegistrationPolicyScreen.test.tsx's `press` idiom).
 */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
  const wrapper = tr.root.findByProps({ testID });
  const candidates = wrapper.findAll(
    (node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
  );
  expect(candidates.length).toBeGreaterThan(0);
  const target = candidates[0]!;
  await renderer.act(async () => {
    if (typeof target.props.onPressIn === "function") target.props.onPressIn();
    else target.props.onPress();
  });
  await flushTicks(8);
}

/**
 * Resolves exactly one test instance for `testID`, using `{ deep: false }` —
 * `ThemedText` spreads `testID` onto its inner host `Text`, so a deep search
 * would double-count one logical node as two matches (composite ThemedText +
 * host Text), the same trap `RegistrantRow.test.tsx` documents. `deep: false`
 * stops at the first (outermost, composite) match, which is the one that
 * still carries `type`/`style` as passed to the JSX element.
 */
function findOne(tr: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
  const matches = tr.root.findAllByProps({ testID }, { deep: false });
  expect(matches.length).toBe(1);
  return matches[0]!;
}

function findAllTestID(tr: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance[] {
  return tr.root.findAllByProps({ testID }, { deep: false });
}

function existsTestID(tr: renderer.ReactTestRenderer, testID: string): boolean {
  return findAllTestID(tr, testID).length > 0;
}

function findErrorView(tr: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  return findOne(tr, "access-history-error");
}

function toggleIcon(tr: renderer.ReactTestRenderer): string | undefined {
  return tr.root.findByType(ChipButton).props.icon;
}

/** Finds every `ThemedText` node whose rendered `children` equals `text` exactly (i.e., an echoed i18n key, not an interpolated composite string). */
function themedTextsByChildren(tr: renderer.ReactTestRenderer, text: string): renderer.ReactTestInstance[] {
  return tr.root.findAllByType(ThemedText).filter((n) => n.props.children === text);
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockRegistrationEngine = undefined;
  mockNetworkSlot = mockNetworkDouble;
  mockUserNames = {};
  // Do NOT call jest.resetModules() — that would break the cached dist
  // require and the mock factory closures (BallotConfirmation.test.tsx's note).
});

describe("AccessHistorySection — D-01/D-02 reviewer surface", () => {
  // -------------------------------------------------------------------------
  // Test 1 — stale-dist guard
  // -------------------------------------------------------------------------

  it("stale-dist guard: MockRegistrationEngine exposes the D-01 access-trail methods on a fresh instance", () => {
    // A failure here means packages/vote-engine/dist/ is stale relative to
    // 47-07's engine-surface additions and must be rebuilt.
    const engine = new MockRegistrationEngine();
    expect(typeof engine.getRegistrantAccessEvents).toBe("function");
    expect(typeof engine.recordRegistrantAccessEvent).toBe("function");
  });

  // -------------------------------------------------------------------------
  // Test 2 — default-collapsed (D-01)
  // -------------------------------------------------------------------------

  it("D-01: default-collapsed — no body, no disclaimer, no rows, and no engine call until expanded", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-collapsed",
      events: [
        { viewerUserId: "u-viewer-a", fields: ["ssn"] },
        { viewerUserId: "u-viewer-b", fields: ["dob"] },
      ],
    });
    const { proxy, calls } = makeRecordingProxy(engine);
    mockRegistrationEngine = proxy;

    const tr = await renderSection({ registrantId: "r-collapsed", canView: true });

    expect(existsTestID(tr, "access-history-section")).toBe(true);
    expect(existsTestID(tr, "access-history-toggle")).toBe(true);
    expect(existsTestID(tr, "access-history-body")).toBe(false);
    expect(existsTestID(tr, "access-history-disclaimer")).toBe(false);
    expect(existsTestID(tr, "access-history-empty")).toBe(false);
    expect(
      tr.root.findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("access-history-row-"))
        .length,
    ).toBe(0);
    expect(toggleIcon(tr)).toBe("chevron-right");
    expect(calls.getRegistrantAccessEvents).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 3 — expand renders the disclaimer exactly once, neutral
  // -------------------------------------------------------------------------

  it("D-01: expanding renders the disclaimer exactly once, small/textSecondary, never warning/error, above the first row", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-disclaimer",
      events: [{ viewerUserId: "u-viewer-a", fields: ["ssn"] }],
    });
    mockRegistrationEngine = engine;

    const tr = await renderSection({ registrantId: "r-disclaimer", canView: true });
    await press(tr, "access-history-toggle");

    const disclaimerNodes = themedTextsByChildren(tr, "registrantAccessTrailDisclaimer");
    expect(disclaimerNodes.length).toBe(1);
    const disclaimer = disclaimerNodes[0]!;
    expect(disclaimer.props.type).toBe("small");
    const resolvedColor = StyleSheet.flatten(disclaimer.props.style).color;
    expect(resolvedColor).toBe("sentinel-textSecondary");
    expect(resolvedColor).not.toBe("sentinel-warning");
    expect(resolvedColor).not.toBe("sentinel-error");

    const text = treeText(tr);
    const disclaimerIndex = text.indexOf("access-history-disclaimer");
    const firstRowIndex = text.indexOf("access-history-row-0");
    expect(disclaimerIndex).toBeGreaterThanOrEqual(0);
    expect(firstRowIndex).toBeGreaterThanOrEqual(0);
    expect(disclaimerIndex).toBeLessThan(firstRowIndex);

    expect(toggleIcon(tr)).toBe("chevron-down");
  });

  // -------------------------------------------------------------------------
  // Test 4 — rows: content, order, typography (D-01/D-02)
  // -------------------------------------------------------------------------

  it("D-01/D-02: rows render field NAMES + viewer/UTC timestamp, newest first, exactly as the engine returned them", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-rows",
      events: [
        { viewerUserId: "u-viewer-one", fields: ["ssn"] },
        { viewerUserId: "u-viewer-two", fields: ["dob", "ssn"] },
      ],
    });
    mockRegistrationEngine = engine;
    mockUserNames = { "u-viewer-one": "Officer One", "u-viewer-two": "Officer Two" };

    const tr = await renderSection({ registrantId: "r-rows", canView: true });
    await press(tr, "access-history-toggle");
    await flushTicks(6);

    const rows = tr.root.findAll(
      (node) => typeof node.props.testID === "string" && /^access-history-row-\d+$/.test(node.props.testID),
      { deep: false },
    );
    expect(rows.length).toBe(2);

    const text = treeText(tr);
    const row1Index = text.indexOf("access-history-row-1");
    const row0Index = text.indexOf("access-history-row-0");
    expect(row1Index).toBeGreaterThanOrEqual(0);
    expect(row0Index).toBeGreaterThanOrEqual(0);
    expect(row1Index).toBeLessThan(row0Index);

    const fieldsNode = findOne(tr, "access-history-row-fields-1");
    expect(fieldsNode.props.type).toBe("tinyBold");
    expect(fieldsNode.props.children).toBe("dob, ssn");

    const metaNode = findOne(tr, "access-history-row-meta-1");
    expect(metaNode.props.type).toBe("tiny");
    expect(StyleSheet.flatten(metaNode.props.style).color).toBe("sentinel-textSecondary");
    expect(metaNode.props.children).toContain("Officer Two");
    expect(metaNode.props.children).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);

    const rowView = findOne(tr, "access-history-row-1");
    expect(rowView.props.accessibilityLabel).toContain("registrantAccessTrailRow");
    expect(rowView.props.accessibilityLabel).toContain("Officer Two");
    expect(rowView.props.accessibilityLabel).toContain("dob, ssn");
  });

  // -------------------------------------------------------------------------
  // Test 5 — unresolved viewer never blocks a row
  // -------------------------------------------------------------------------

  it("D-01: an unresolvable viewer degrades to a truncated id without blocking, delaying or erroring the row", async () => {
    // (a) mockUserNames empty -> the network double's getUser resolves undefined.
    const engineA = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engineA, {
      registrantId: "r-unresolved-a",
      events: [{ viewerUserId: "u-unresolved-001", fields: ["ssn"] }],
    });
    mockRegistrationEngine = engineA;
    mockUserNames = {};

    const trA = await renderSection({ registrantId: "r-unresolved-a", canView: true });
    await press(trA, "access-history-toggle");
    await flushTicks(6);

    const metaA = findOne(trA, "access-history-row-meta-0");
    expect(metaA.props.children).toContain("u-unr...");
    expect(existsTestID(trA, "access-history-row-0")).toBe(true);
    const errorViewA = findErrorView(trA);
    expect(errorViewA.findAllByType(ThemedText).length).toBe(0);

    // (b) mockGetEngine resolves null for "network" -> same result, no thrown rejection.
    const engineB = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engineB, {
      registrantId: "r-unresolved-b",
      events: [{ viewerUserId: "u-unresolved-002", fields: ["ssn"] }],
    });
    mockRegistrationEngine = engineB;
    mockNetworkSlot = null;

    const trB = await renderSection({ registrantId: "r-unresolved-b", canView: true });
    await press(trB, "access-history-toggle");
    await flushTicks(6);

    const metaB = findOne(trB, "access-history-row-meta-0");
    expect(metaB.props.children).toContain("u-unr...");
    const errorViewB = findErrorView(trB);
    expect(errorViewB.findAllByType(ThemedText).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 6 — empty state
  // -------------------------------------------------------------------------

  it("D-01: a registrant with a RegistrantPrivate row but zero recorded events renders the empty state, disclaimer still shown", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, { registrantId: "r-empty" });
    mockRegistrationEngine = engine;

    const tr = await renderSection({ registrantId: "r-empty", canView: true });
    await press(tr, "access-history-toggle");

    expect(existsTestID(tr, "access-history-empty")).toBe(true);
    const heading = themedTextsByChildren(tr, "registrantAccessTrailEmptyHeading");
    expect(heading.length).toBe(1);
    expect(heading[0]!.props.type).toBe("defaultSemiBold");

    const body = themedTextsByChildren(tr, "registrantAccessTrailEmptyBody");
    expect(body.length).toBe(1);
    expect(body[0]!.props.type).toBe("small");
    expect(StyleSheet.flatten(body[0]!.props.style).color).toBe("sentinel-textSecondary");

    expect(
      tr.root.findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("access-history-row-"))
        .length,
    ).toBe(0);

    expect(existsTestID(tr, "access-history-disclaimer")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7 — read failure degrades, re-expanding retries
  // -------------------------------------------------------------------------

  it("D-01: a failed read renders InlineError and leaves the rest intact; re-expanding retries and hasLoadedRef only latches on success", async () => {
    const failingEngine = {
      getRegistrantAccessEvents: async () => {
        throw new Error("access trail read failed");
      },
    };
    mockRegistrationEngine = failingEngine;

    const tr = await renderSection({ registrantId: "r-retry", canView: true });
    await press(tr, "access-history-toggle");

    const errorView = findOne(tr, "access-history-error");
    const errorTexts = errorView.findAllByType(ThemedText);
    expect(errorTexts.length).toBe(1);
    expect(errorTexts[0]!.props.children).toBe("errorLoadFailedGeneric");
    expect(JSON.stringify(errorTexts[0]!.props.children)).not.toContain("access trail read failed");
    expect(existsTestID(tr, "access-history-empty")).toBe(false);
    expect(
      tr.root.findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("access-history-row-"))
        .length,
    ).toBe(0);

    // Collapse, swap in a healthy engine with one seeded event, expand again.
    await press(tr, "access-history-toggle");
    expect(existsTestID(tr, "access-history-body")).toBe(false);

    const healthyEngine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(healthyEngine, {
      registrantId: "r-retry",
      events: [{ viewerUserId: "u-viewer-a", fields: ["ssn"] }],
    });
    mockRegistrationEngine = healthyEngine;

    await press(tr, "access-history-toggle");
    expect(existsTestID(tr, "access-history-row-0")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8 — T-47-02: no private VALUE reaches the tree
  // -------------------------------------------------------------------------

  it("T-47-02: no seeded private VALUE reaches the rendered tree, and no private/selective-tier method is ever invoked", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-novalue",
      events: [{ viewerUserId: "u-viewer-a", fields: ["ssn", "dob", "phone"] }],
    });
    const { proxy, calls } = makeRecordingProxy(engine);
    mockRegistrationEngine = proxy;

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const tr = await renderSection({ registrantId: "r-novalue", canView: true });
    await press(tr, "access-history-toggle");

    const json = JSON.stringify(tr.toJSON());
    expect(json).not.toContain("000-00-0000");
    expect(json).not.toContain("1980-01-01");
    expect(json).not.toContain("555-0100");
    expect(json).toContain("ssn");
    expect(json).toContain("dob");
    expect(json).toContain("phone");

    expect(calls.getRegistrantPrivate).toBeUndefined();
    expect(calls.getRegistrantSelective).toBeUndefined();
    expect(calls.getDisclosedSelective).toBeUndefined();

    const sentinels = ["000-00-0000", "1980-01-01", "555-0100"];
    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(" ");
        for (const sentinel of sentinels) {
          expect(joined).not.toContain(sentinel);
        }
      }
    }

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 9 — T-47-03: nothing on this surface claims the trail prevents anything
  // -------------------------------------------------------------------------

  it("T-47-03: only 47-02's pinned, already-proved-non-preventive copy reaches the tree, and no hardcoded prevention claim leaks in", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-copy",
      events: [{ viewerUserId: "u-viewer-a", fields: ["ssn"] }],
    });
    mockRegistrationEngine = engine;

    const tr = await renderSection({ registrantId: "r-copy", canView: true });
    await press(tr, "access-history-toggle");

    const text = treeText(tr);
    // Case-insensitive: ChipButton uppercases its label
    // (`label.toUpperCase()`), so the section-title key reaches the tree as
    // "REGISTRANTACCESSTRAILSECTIONTITLE" rather than its mixed-case source
    // form. Normalizing both sides to lower case keeps the assertion about
    // WHICH keys reached the tree, not about ChipButton's own display
    // transform.
    const foundKeys = new Set(
      Array.from(text.matchAll(/registrantaccesstrail[a-z]+/gi)).map((m) => m[0].toLowerCase()),
    );
    expect(foundKeys).toEqual(
      new Set(
        ["registrantAccessTrailSectionTitle", "registrantAccessTrailDisclaimer", "registrantAccessTrailRow"].map(
          (k) => k.toLowerCase(),
        ),
      ),
    );

    expect(text).not.toMatch(/\bprevent/i);
    expect(text).not.toMatch(/\bblocks? access/i);
    expect(text).not.toMatch(/\brestrict/i);
    expect(text).not.toMatch(/\bguarantee/i);
    expect(text).not.toMatch(/\bsafeguard/i);
  });

  // -------------------------------------------------------------------------
  // Test 10 — D-13 transitive gate
  // -------------------------------------------------------------------------

  it("D-13: canView=false renders nothing at all and makes no engine call — a legibility posture, not enforcement (T-47-04)", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-gated",
      events: [
        { viewerUserId: "u-viewer-a", fields: ["ssn"] },
        { viewerUserId: "u-viewer-b", fields: ["dob"] },
      ],
    });
    const { proxy, calls } = makeRecordingProxy(engine);
    mockRegistrationEngine = proxy;

    const tr = await renderSection({ registrantId: "r-gated", canView: false });

    expect(tr.toJSON()).toBeNull();
    expect(existsTestID(tr, "access-history-section")).toBe(false);
    expect(existsTestID(tr, "access-history-toggle")).toBe(false);
    expect(existsTestID(tr, "access-history-disclaimer")).toBe(false);
    expect(
      tr.root.findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("access-history-row-"))
        .length,
    ).toBe(0);
    expect(calls.getRegistrantAccessEvents).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 11 — collapse hides the body without re-fetching
  // -------------------------------------------------------------------------

  it("collapsing hides the body without re-fetching; a third expand reuses the already-loaded rows (call count stays 1)", async () => {
    const engine = new MockRegistrationEngine();
    await seedRegistrantWithTrail(engine, {
      registrantId: "r-recollapse",
      events: [{ viewerUserId: "u-viewer-a", fields: ["ssn"] }],
    });
    const { proxy, calls } = makeRecordingProxy(engine);
    mockRegistrationEngine = proxy;

    const tr = await renderSection({ registrantId: "r-recollapse", canView: true });

    await press(tr, "access-history-toggle");
    expect(existsTestID(tr, "access-history-body")).toBe(true);
    expect(calls.getRegistrantAccessEvents).toBe(1);

    await press(tr, "access-history-toggle");
    expect(existsTestID(tr, "access-history-body")).toBe(false);
    expect(toggleIcon(tr)).toBe("chevron-right");

    await press(tr, "access-history-toggle");
    expect(existsTestID(tr, "access-history-row-0")).toBe(true);
    expect(calls.getRegistrantAccessEvents).toBe(1);
  });
});
