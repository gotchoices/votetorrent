/**
 * CreateElectionScreen — WR-02 (59-REVIEW-2): the screen's FIRST test file.
 *
 * Scope is deliberately the timeline ordering guard, not the whole screen.
 * That guard is the only defense between an officer and a signed, IMMUTABLE
 * out-of-order `ElectionRevision.Timeline` (`votetorrent.qsql` carries no
 * CHECK on the column at all), and CR-02 proved it can drift silently: every
 * ordering site in the repo had skipped `validation` for as long as that
 * member existed.
 *
 * WHY A SCREEN TEST AND NOT ONLY `timeline-order-guard.test.ts`: this screen
 * validates INLINE and returns early, well before any builder is constructed,
 * so the three vote-engine builder suites are no proxy for it — they are
 * unreachable from here. A unit test of `findTimelineOrderViolation` proves
 * the helper; only this file proves the screen actually calls it and refuses
 * to write.
 *
 * The accept-path control (last test) is load-bearing: without it, a screen
 * that rejected EVERY timeline would pass the two rejection tests.
 *
 * PATTERN SOURCE: RegistrationPolicyScreen.test.tsx — react-test-renderer,
 * module-scope jest.mock of every native / cross-cutting dep, an
 * interpolation-echoing `t()`. The testing-library packages are not
 * dependencies of this app.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { ElectionEvent } from "@votetorrent/vote-core";
import { InlineError } from "../../../components/InlineError";
import { CustomButton } from "../../../components/CustomButton";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { DateField } from "../../../components/DateField";
import type { ElectionRevisionFormValue } from "../components/ElectionRevisionForm";

// ---------------------------------------------------------------------------
// Module-level slots (`mock`-prefixed so babel-plugin-jest-hoist allows the
// factories below to close over them).
// ---------------------------------------------------------------------------
interface BuilderStub {
  setElection: jest.Mock<BuilderStub, [Record<string, unknown>]>;
  setRevision: jest.Mock<BuilderStub, [Record<string, unknown>]>;
  build: jest.Mock<Record<string, unknown>, []>;
}
const mockBuilderInstance: BuilderStub = {
  setElection: jest.fn((_election: Record<string, unknown>) => mockBuilderInstance),
  setRevision: jest.fn((_revision: Record<string, unknown>) => mockBuilderInstance),
  build: jest.fn(() => ({ election: {}, revision: {} })),
};
// A plain `function`, not an arrow: the screen calls this with `new`, and an
// arrow function is not constructible.
const mockBuilderCtor = jest.fn(function (..._args: unknown[]): BuilderStub {
  return mockBuilderInstance;
});

const mockElectionsEngine = {
  seedElectionSigning: jest.fn(async () => "signing-nonce"),
  peekNextTid: jest.fn(async () => 41),
  seedElectionRevisionSigning: jest.fn(async () => "revision-signing-nonce"),
  createElection: jest.fn(async () => undefined),
};

const mockNetworkEngine = {
  getDetails: jest.fn(async () => ({
    network: { primaryAuthorityId: "auth-1", name: "Test Network" },
  })),
  getPinnedAuthorities: jest.fn(async (): Promise<any[]> => []),
  getAuthoritiesByName: jest.fn(async (_name: string | undefined): Promise<any> => ({
    buffer: [{ id: "auth-0", name: "Other Auth" }, { id: "auth-1", name: "Lab Auth" }],
    offset: 0,
    firstBOF: true,
    lastEOF: true,
  })),
  nextAuthoritiesByName: jest.fn(async (): Promise<any> => ({ buffer: [], offset: 0, firstBOF: false, lastEOF: true })),
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === "elections") return mockElectionsEngine;
  if (name === "network") return mockNetworkEngine;
  return null;
});

const mockGoBack = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

// Only `ElectionsCreateElectionBuilder` is imported by this screen. Mocking the
// constructor is what lets the rejection tests assert the write path was never
// ENTERED — not merely that it failed somewhere downstream.
// The factory body runs while the screen module is being required — i.e. BEFORE
// this file's own `const` initializers, which babel-plugin-jest-hoist lifts the
// jest.mock call above. Referencing `mockBuilderCtor` directly here would bake
// in its TDZ value (`undefined`) forever; the indirection defers the lookup to
// call time.
jest.mock("@votetorrent/vote-engine", () => ({
  ElectionsCreateElectionBuilder: function (...args: unknown[]) {
    return mockBuilderCtor(...args);
  },
}));

jest.mock("../../../providers/SettingsProvider", () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

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
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock("../../../providers/AppProvider", () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("../../../engines/device-signer", () => ({
  createDeviceSigner: jest.fn(async () => async () => ({
    signature: "mock-sig",
    signerKey: "mock-key",
    signerUserId: "device-user-1",
  })),
}));

jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
  useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));

// The revision form is stubbed to a prop recorder: this suite drives the ten
// timeline dates through its `onChange`, which is exactly how the real form
// feeds the screen. Rendering the real form's date pickers would add a large
// surface with no bearing on the guard under test.
let mockFormProps: { value: ElectionRevisionFormValue; onChange: (v: ElectionRevisionFormValue) => void };
jest.mock("../components/ElectionRevisionForm", () => ({
  ElectionRevisionForm: (props: any) => {
    mockFormProps = props;
    return null;
  },
}));

import { CreateElectionScreen } from "../CreateElectionScreen";

// ---------------------------------------------------------------------------
// Fixtures. Fixed instants only — never Date.now() in an expectation.
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

/** Election date must be after the auto-computed ballotDeadline (now + 10 days). */
const ELECTION_DATE = new Date(NOW + 90 * DAY_MS).toISOString();
const REVISION_DEADLINE = new Date(NOW + 30 * DAY_MS).toISOString();

const iso = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

/** A fully ordered ten-date form — the baseline every case below perturbs. */
function orderedForm(): ElectionRevisionFormValue {
  return {
    registrationEnds: iso(2),
    ballotsFinal: iso(5),
    votingStarts: iso(10),
    accruingVotes: iso(11),
    hashingVotes: iso(12),
    releasingKeys: iso(13),
    tallyingStarts: iso(14),
    validation: iso(15),
    certificationStarts: iso(16),
    closed: iso(17),
    keyholders: ["Alice", "Bob"],
    threshold: 2,
    tags: [],
    instructions: "",
  };
}

async function renderAndSubmit(form: ElectionRevisionFormValue) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<CreateElectionScreen />);
  });

  // Core fields — all three are validated BEFORE the timeline guard, so the
  // guard is unreachable until they are filled.
  await act(async () => {
    tree.root.findByType(CustomTextInput).props.onChangeText("Test Election");
    const dateFields = tree.root.findAllByType(DateField);
    dateFields[0].props.onChange(ELECTION_DATE);
    dateFields[1].props.onChange(REVISION_DEADLINE);
    mockFormProps.onChange(form);
  });

  await act(async () => {
    await tree.root.findByType(CustomButton).props.onPress();
  });

  return tree;
}

function inlineErrors(tree: renderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(InlineError)
    .map((node) => node.props.message)
    .filter((message: string) => Boolean(message));
}

describe("CreateElectionScreen — timeline ordering guard (WR-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("CR-02: refuses to build when validation precedes tallyingStarts", async () => {
    const form = orderedForm();
    form[ElectionEvent.validation] = iso(13.5); // before tallyingStarts (day 14)

    const tree = await renderAndSubmit(form);

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockBuilderCtor).not.toHaveBeenCalled();
    expect(mockElectionsEngine.seedElectionSigning).not.toHaveBeenCalled();
    expect(mockElectionsEngine.createElection).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("CR-02: refuses to build when closed precedes certificationStarts", async () => {
    const form = orderedForm();
    form[ElectionEvent.closed] = iso(15.5); // before certificationStarts (day 16)

    const tree = await renderAndSubmit(form);

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockBuilderCtor).not.toHaveBeenCalled();
    expect(mockElectionsEngine.createElection).not.toHaveBeenCalled();
  });

  it("refuses to build when two chained events share an instant (>= semantics)", async () => {
    const form = orderedForm();
    form[ElectionEvent.hashingVotes] = form[ElectionEvent.accruingVotes];

    const tree = await renderAndSubmit(form);

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockBuilderCtor).not.toHaveBeenCalled();
  });

  it("control: an ordered timeline reaches the builder and createElection", async () => {
    const tree = await renderAndSubmit(orderedForm());

    expect(inlineErrors(tree)).toEqual([]);
    expect(mockBuilderCtor).toHaveBeenCalledTimes(1);
    expect(mockElectionsEngine.createElection).toHaveBeenCalledTimes(1);
    // The signed payload carries the full ten-event map, in chain order.
    const signedTimeline = mockBuilderInstance.setRevision.mock.calls[0]![0]
      .timeline as Record<ElectionEvent, number>;
    expect(signedTimeline[ElectionEvent.validation]).toBe(NOW + 15 * DAY_MS);
    expect(signedTimeline[ElectionEvent.closed]).toBe(NOW + 17 * DAY_MS);
  });
});

// UAT 62 N: the header read "Authority: <network name>". It names the AUTHORITY, falling back to
// its id only when the authority row cannot be read.
describe("CreateElectionScreen — authority header", () => {
  function authorityText(tree: renderer.ReactTestRenderer): string {
    return tree.root.findByProps({ testID: "create-election-authority" }).props.children;
  }

  it("shows the primary authority's name, not the network name", async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<CreateElectionScreen />);
    });
    expect(authorityText(tree)).toBe("Lab Auth");
    expect(JSON.stringify(tree.toJSON())).not.toContain("Test Network");
  });

  it("falls back to the authority id when the authority lookup fails", async () => {
    mockNetworkEngine.getAuthoritiesByName.mockRejectedValueOnce(new Error("offline"));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<CreateElectionScreen />);
    });
    expect(authorityText(tree)).toBe("auth-1");
  });
});
