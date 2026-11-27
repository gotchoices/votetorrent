/**
 * EditElectionScreen — WR-02 (59-REVIEW-2): the screen's FIRST test file.
 *
 * Companion to `CreateElectionScreen.timelineOrder.test.tsx`; see that file's
 * header for why the guard needs screen-level coverage and why the three
 * vote-engine builder suites are no substitute for it. This screen matters
 * separately because its guard is a SECOND hand-typed copy of the same chain
 * (now both call the shared `findTimelineOrderViolation`), it runs on a
 * revision proposed against an ALREADY-SIGNED election, and its early return
 * must also clear `proposing` — a guard that returned without doing so would
 * leave the Propose button disabled forever with no way back.
 *
 * PATTERN SOURCE: RegistrationPolicyScreen.test.tsx (react-test-renderer,
 * module-scope mocks, echoing `t()`), plus its `useRoute` params idiom for
 * the per-election engine this screen loads its cached details from.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { ElectionEvent, ElectionType } from "@votetorrent/vote-core";
import { InlineError } from "../../../components/InlineError";
import { CustomButton } from "../../../components/CustomButton";
import type { ElectionRevisionFormValue } from "../components/ElectionRevisionForm";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-01T00:00:00.000Z").getTime();
const ms = (days: number) => NOW + days * DAY_MS;
const iso = (days: number) => new Date(ms(days)).toISOString();

const mockElectionsEngine = {
  // The `init` parameter is declared (not inferred away) so the control test can
  // read the proposed payload back off `.mock.calls`.
  adjustElection: jest.fn(async (_init: Record<string, any>) => undefined),
};

const mockElectionEngine = {
  getElectionDetails: jest.fn(async () => ({
    election: {
      id: "election-1",
      authorityId: "auth-1",
      title: "Test Election",
      date: ms(90),
      revisionDeadline: ms(30),
      ballotDeadline: ms(10),
      type: ElectionType.official,
    },
    current: {
      revision: 3,
      timeline: {
        registrationEnds: ms(2),
        ballotsFinal: ms(5),
        votingStarts: ms(10),
        accruingVotes: ms(11),
        hashingVotes: ms(12),
        releasingKeys: ms(13),
        tallyingStarts: ms(14),
        validation: ms(15),
        certificationStarts: ms(16),
        closed: ms(17),
      },
      keyholders: [{ invite: { name: "Alice" } }, { invite: { name: "Bob" } }],
      keyholderThreshold: 2,
      tags: [],
      instructions: "",
    },
  })),
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === "elections") return mockElectionsEngine;
  return null;
});

const mockGoBack = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  // The per-election engine arrives as a route param (EUI-01: loaded ONCE in
  // the screen's own useEffect, never re-fetched by handlePropose).
  useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

jest.mock("../../../providers/AppProvider", () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

let mockFormProps: { value: ElectionRevisionFormValue; onChange: (v: ElectionRevisionFormValue) => void };
jest.mock("../components/ElectionRevisionForm", () => ({
  ElectionRevisionForm: (props: any) => {
    mockFormProps = props;
    return null;
  },
}));

import EditElectionScreen from "../EditElectionScreen";

/**
 * Mount, let the cached-details load settle, optionally perturb the seeded
 * form, then press Propose. Returns the tree AND the Propose button node so a
 * caller can assert the `proposing` flag was released.
 */
async function renderAndPropose(
  perturb?: (form: ElectionRevisionFormValue) => ElectionRevisionFormValue
) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<EditElectionScreen />);
  });

  if (perturb) {
    await act(async () => {
      mockFormProps.onChange(perturb({ ...mockFormProps.value }));
    });
  }

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

describe("EditElectionScreen — timeline ordering guard (WR-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("seeds the form from the loaded revision (the guard's input is real data, not a blank form)", async () => {
    await renderAndPropose();
    expect(mockFormProps.value.validation).toBe(iso(15));
    expect(mockFormProps.value.closed).toBe(iso(17));
  });

  it("CR-02: refuses to propose when validation precedes tallyingStarts", async () => {
    const tree = await renderAndPropose((form) => ({ ...form, validation: iso(13.5) }));

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockElectionsEngine.adjustElection).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it("CR-02: refuses to propose when closed precedes certificationStarts", async () => {
    const tree = await renderAndPropose((form) => ({ ...form, closed: iso(15.5) }));

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockElectionsEngine.adjustElection).not.toHaveBeenCalled();
  });

  it("refuses to propose when two chained events share an instant (>= semantics)", async () => {
    const tree = await renderAndPropose((form) => ({ ...form, hashingVotes: form.accruingVotes }));

    expect(inlineErrors(tree)).toEqual(["errTimelineOrder"]);
    expect(mockElectionsEngine.adjustElection).not.toHaveBeenCalled();
  });

  it("releases the proposing flag on rejection, so the officer can correct and retry", async () => {
    const tree = await renderAndPropose((form) => ({ ...form, validation: iso(13.5) }));

    expect(tree.root.findByType(CustomButton).props.disabled).toBe(false);
  });

  it("refuses a keyholder policy below 2-of-2 before any engine call", async () => {
    const tree = await renderAndPropose((form) => ({ ...form, threshold: 1 }));

    expect(inlineErrors(tree)).toEqual(["keyholderPolicyThresholdTooLow"]);
    expect(mockGetEngine).not.toHaveBeenCalledWith("elections");
    expect(mockElectionsEngine.adjustElection).not.toHaveBeenCalled();
  });

  it("control: the seeded, ordered timeline reaches adjustElection", async () => {
    const tree = await renderAndPropose();

    expect(inlineErrors(tree)).toEqual([]);
    expect(mockElectionsEngine.adjustElection).toHaveBeenCalledTimes(1);
    const init = mockElectionsEngine.adjustElection.mock.calls[0]![0] as any;
    expect(init.revision.timeline[ElectionEvent.validation]).toBe(ms(15));
    expect(init.revision.timeline[ElectionEvent.closed]).toBe(ms(17));
    // Revision increments from the loaded one; the election id is carried through.
    expect(init.revision.revision).toBe(4);
    expect(init.revision.electionId).toBe("election-1");
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
