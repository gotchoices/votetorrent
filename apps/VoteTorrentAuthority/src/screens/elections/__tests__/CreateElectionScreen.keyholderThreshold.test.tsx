/**
 * CreateElectionScreen - the keyholder policy guard. A policy below 2-of-2 can never generate a
 * key (and a threshold of 1 lets one keyholder unlock results alone), so it is refused before
 * any engine call or device-signer resolution.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { ElectionEvent } from "@votetorrent/vote-core";
import { createDeviceSigner } from "../../../engines/device-signer";
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

describe("CreateElectionScreen - keyholder policy guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function expectNoWrite() {
    expect(mockGetEngine).not.toHaveBeenCalledWith("elections");
    expect(mockBuilderCtor).not.toHaveBeenCalled();
    expect(mockElectionsEngine.createElection).not.toHaveBeenCalled();
    expect(createDeviceSigner).not.toHaveBeenCalled();
  }

  it("refuses one keyholder at 1-of-1 before any engine call", async () => {
    const tree = await renderAndSubmit({ ...orderedForm(), keyholders: ["Alice"], threshold: 1 });
    expect(inlineErrors(tree)).toEqual(["keyholderPolicyTooFewKeyholders"]);
    expectNoWrite();
  });

  it("refuses two keyholders at 1-of-2", async () => {
    const tree = await renderAndSubmit({ ...orderedForm(), threshold: 1 });
    expect(inlineErrors(tree)).toEqual(["keyholderPolicyThresholdTooLow"]);
    expectNoWrite();
  });

  it("refuses a threshold above the count", async () => {
    const tree = await renderAndSubmit({ ...orderedForm(), threshold: 3 });
    expect(inlineErrors(tree)).toEqual(["keyholderPolicyThresholdAboveCount"]);
    expectNoWrite();
  });

  it("refuses two keyholders with the same name before any engine call", async () => {
    const tree = await renderAndSubmit({ ...orderedForm(), keyholders: ["Kay", " kay "] });
    expect(inlineErrors(tree)).toEqual(["keyholderPolicyDuplicateName"]);
    expectNoWrite();
  });

  it("control: 2-of-2 reaches the engine", async () => {
    const tree = await renderAndSubmit(orderedForm());
    expect(inlineErrors(tree)).toEqual([]);
    expect(mockElectionsEngine.createElection).toHaveBeenCalledTimes(1);
  });
});
