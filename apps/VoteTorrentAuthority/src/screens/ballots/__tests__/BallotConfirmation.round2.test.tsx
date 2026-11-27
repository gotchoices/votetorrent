/**
 * BallotConfirmation.round2.test.tsx — behaviour tests for the review round-2 screen fixes on
 * EditBallotScreen (gap8/WR-01, gap8/WR-03, gap6/WR-01, gap6/WR-02, gap7/IN-05, C12/O-09).
 *
 * Copies the minimal harness of BallotConfirmation.test.tsx (real BallotDraftProvider, real
 * MockElectionEngine from the rebuilt dist, `t` returns the key).
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { consoleTags, leakingCalls, nonLiteralConsoleFirstArgs, untaggedCalls } from '../../__fixtures__/log-content-scan';

let mockCurrentElectionEngine: unknown = null;
let mockReadOnly = false;
let mockNetworkEngine: unknown = null;
const mockBallotId = 'mock-ballot-id';
const BALLOT_ID = mockBallotId;

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@votetorrent/vote-engine/rn', () => ({}), { virtual: true });
jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));
// A STABLE getEngine: the screen's authority-load effect depends on it, so a fresh function per
// render would re-run the load forever.
const mockGetEngine = jest.fn(async () => mockNetworkEngine);
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));
const mockCreateDeviceSigner = jest.fn();
jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));
jest.mock('../../../hooks/useDeviceSigningErrorHandler', () => ({
  useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockDispatch = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      background: '#FFFFFF',
      card: '#F2F2F7',
      text: '#000000',
      border: '#C6C6C8',
      notification: '#FF3B30',
      error: '#FF3B30',
      textSecondary: '#888888',
      important: '#FF9500',
      success: '#34C759',
      accent: '#5856D6',
      warning: '#FF9500',
    },
  }),
  CommonActions: { navigate: (arg: unknown) => ({ type: 'NAVIGATE', payload: arg }) },
  useRoute: () => ({
    params: {
      electionId: 'test-election',
      electionTitle: 'Test Election',
      electionDate: '2026-12-01',
      electionEngine: mockCurrentElectionEngine,
      ballotId: mockBallotId,
      readOnly: mockReadOnly,
    },
  }),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
    dispatch: mockDispatch,
    setOptions: jest.fn(),
    setParams: mockSetParams,
  }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').useEffect(() => cb(), [cb]);
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockBallotConfirmationState, MockElectionEngine } = require(
  '../../../../../../packages/vote-engine/dist/election/mock-election-engine'
);

const STORED_DESCRIPTION = 'Stored ballot';
const SETTLE = 8;

function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
  return JSON.stringify(tr.toJSON()).toLowerCase().includes(text.toLowerCase());
}
const hasTestID = (tr: renderer.ReactTestRenderer, testID: string) =>
  tr.root.findAllByProps({ testID }).length > 0;

function newEngine() {
  const confirmState = new MockBallotConfirmationState();
  const engine = new MockElectionEngine(confirmState, 'officer-a');
  return { confirmState, engine };
}

async function propose(engine: any, authorityId = 'auth-1') {
  await engine.proposeBallot({
    id: BALLOT_ID,
    electionId: 'test-election',
    authorityId,
    description: STORED_DESCRIPTION,
    districts: [],
    questions: [],
  });
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BallotDraftProvider } = require('../providers/BallotDraftProvider');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Screen = require('../EditBallotScreen').default;
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(
      <BallotDraftProvider>
        <Screen />
      </BallotDraftProvider>
    );
  });
  await flush();
  return tr;
}

async function flush(n = SETTLE) {
  await renderer.act(async () => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  });
}

async function press(tr: renderer.ReactTestRenderer, testID: string) {
  const node = tr.root.findAllByProps({ testID })[0];
  await renderer.act(async () => {
    node.props.onPress();
    for (let i = 0; i < SETTLE; i++) await Promise.resolve();
  });
}

function form(tr: renderer.ReactTestRenderer) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BallotTemplateForm } = require('../components/BallotTemplateForm');
  return tr.root.findByType(BallotTemplateForm);
}

async function editDescription(tr: renderer.ReactTestRenderer, value: string) {
  await renderer.act(async () => {
    form(tr).props.onDescriptionChange(value);
  });
}

const formDescription = (tr: renderer.ReactTestRenderer): string => form(tr).props.description;

const state = (over: Partial<{ locked: boolean; confirmed: boolean; canWithdraw: boolean; ownTaskOpen: boolean }>) => ({
  locked: false,
  confirmed: false,
  canWithdraw: false,
  ownTaskOpen: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentElectionEngine = null;
  mockReadOnly = false;
  mockNetworkEngine = null;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('R2-1/R2-2 refused Propose and Submit explain themselves and reload the stored ballot (gap8/WR-01)', () => {
  it.each([
    ['locked', state({ locked: true, canWithdraw: true }), 'ballotProposeRefusedLocked'],
    ['confirmed', state({ confirmed: true }), 'ballotProposeRefusedConfirmed'],
  ])('R2-1 Propose refused (%s): copy shows, the stored description replaces the edit', async (_n, after, copy) => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    await editDescription(tr, 'My unsaved edit');
    expect(formDescription(tr)).toBe('My unsaved edit');

    const detailsSpy = jest.spyOn(engine, 'getBallotDetails');
    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue(after);
    engine.proposeBallot = jest.fn(async () => {
      throw new Error('refused');
    });
    await press(tr, 'edit-ballot-propose');

    expect(treeContainsText(tr, copy)).toBe(true);
    expect(treeContainsText(tr, 'ballotProposeFailed')).toBe(false);
    expect(detailsSpy).toHaveBeenCalled();
    expect(formDescription(tr)).toBe(STORED_DESCRIPTION);
  });

  it.each([
    ['locked', state({ locked: true, canWithdraw: true }), 'ballotSubmitRefusedLocked'],
    ['confirmed', state({ confirmed: true }), 'ballotSubmitRefusedConfirmed'],
  ])('R2-2 Submit refused (%s): copy shows and the draft is reloaded', async (_n, after, copy) => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    expect(formDescription(tr)).toBe(STORED_DESCRIPTION);
    // Submit is disabled while dirty (R2-8), so drive the handler through a clean draft and change
    // the stored row behind the screen instead: the reload must show the NEW stored description,
    // which only an applied reload can put in the form (REVIEW WR-R5-06).
    const CHANGED = 'Changed behind the screen';
    await engine.proposeBallot({
      id: BALLOT_ID,
      electionId: 'test-election',
      authorityId: 'auth-1',
      description: CHANGED,
      districts: [],
      questions: [],
    });
    expect(formDescription(tr)).toBe(STORED_DESCRIPTION);
    const detailsSpy = jest.spyOn(engine, 'getBallotDetails');
    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue(after);
    engine.submitBallotForConfirmation = jest.fn(async () => {
      throw new Error('refused');
    });
    await press(tr, 'edit-ballot-submit');

    expect(engine.submitBallotForConfirmation).toHaveBeenCalled();
    expect(treeContainsText(tr, copy)).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(false);
    expect(detailsSpy).toHaveBeenCalled();
    expect(formDescription(tr)).toBe(CHANGED);
  });
});

describe('R2-3..R2-5 lock reads are sequenced, busy-aware and time-limited (gap7/IN-05)', () => {
  const TIMEOUT_MS = 30_000;

  it('R2-3 a slow stale read can never overwrite a newer one', async () => {
    jest.useFakeTimers();
    const { engine } = newEngine();
    await propose(engine);
    let releaseFirst!: (v: any) => void;
    const spy = jest.spyOn(engine, 'getBallotConfirmationState');
    spy.mockImplementationOnce(() => new Promise((res) => { releaseFirst = res; }));
    spy.mockResolvedValueOnce(state({ locked: true, canWithdraw: true }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen();
    // The first read hangs until the timeout fails the screen closed; Retry starts the second read.
    await renderer.act(async () => {
      jest.advanceTimersByTime(TIMEOUT_MS + 1);
    });
    await flush();
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
    await press(tr, 'edit-ballot-state-retry');
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);

    // The OLD read finally answers "unlocked": it must not unlock the footer.
    await renderer.act(async () => {
      releaseFirst(state({ locked: false }));
    });
    await flush();
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
  });

  it('R2-4 Retry is disabled while its read is in flight and a second press starts no second read', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const spy = jest.spyOn(engine, 'getBallotConfirmationState');
    spy.mockRejectedValueOnce(new Error('boom'));
    let releaseRetry!: (v: any) => void;
    spy.mockImplementationOnce(() => new Promise((res) => { releaseRetry = res; }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen();
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
    const node = tr.root.findAllByProps({ testID: 'edit-ballot-state-retry' })[0];
    await renderer.act(async () => {
      node.props.onPress();
    });
    await flush();
    expect(tr.root.findAllByProps({ testID: 'edit-ballot-state-retry' })[0].props.disabled).toBe(true);
    await renderer.act(async () => {
      tr.root.findAllByProps({ testID: 'edit-ballot-state-retry' })[0].props.onPress();
    });
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);

    await renderer.act(async () => {
      releaseRetry(state({}));
    });
    await flush();
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
  });

  it('R2-5 a first read that never settles fails closed after the timeout, and a late success still restores the screen', async () => {
    jest.useFakeTimers();
    const { engine } = newEngine();
    await propose(engine);
    let release!: (v: any) => void;
    jest.spyOn(engine, 'getBallotConfirmationState').mockImplementationOnce(() => new Promise((res) => { release = res; }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen();
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(false);
    await renderer.act(async () => {
      jest.advanceTimersByTime(TIMEOUT_MS + 1);
    });
    await flush();
    expect(treeContainsText(tr, 'ballotStateLoadFailed')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);

    await renderer.act(async () => {
      release(state({}));
    });
    await flush();
    expect(treeContainsText(tr, 'ballotStateLoadFailed')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
  });
});

describe('R2-6 the ballot load failure renders translated copy only (C12 / O-09)', () => {
  it('a non-peer failure renders ballotLoadFailed, never engine text', async () => {
    const { engine } = newEngine();
    await propose(engine);
    jest.spyOn(engine, 'getBallotDetails').mockRejectedValue(new Error('Engine X requestId=abc'));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen();
    expect(treeContainsText(tr, 'ballotLoadFailed')).toBe(true);
    expect(treeContainsText(tr, 'requestId')).toBe(false);
    expect(treeContainsText(tr, 'Engine X')).toBe(false);
  });

  it('regression guard: a peer-unavailable failure still renders the peer copy', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const peerErr = Object.assign(new Error('Block abc is unavailable (cohort-unreachable)'), { name: 'BlockUnavailableError' });
    jest.spyOn(engine, 'getBallotDetails').mockRejectedValue(peerErr);
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen();
    expect(treeContainsText(tr, 'peerReadUnavailableBody')).toBe(true);
    expect(treeContainsText(tr, 'ballotLoadFailed')).toBe(false);
    expect(treeContainsText(tr, 'abc')).toBe(false);
  });
});

describe('R2-7 the screen logs only fixed tags and error class names (O-09)', () => {
  it('no Error object or message text reaches console.warn/error from this screen', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'EditBallotScreen.tsx'), 'utf8');
    const tags = consoleTags(src);
    expect(tags.size).toBeGreaterThan(0);
    // A log whose first argument is built at runtime (template literal, concatenation) fails here.
    expect(nonLiteralConsoleFirstArgs(src)).toEqual([]);

    const SECRET = 'SECRET-engine-text-requestId=zzz';
    const failures: Array<(engine: any) => void> = [
      (e) => jest.spyOn(e, 'getBallotDetails').mockRejectedValue(new Error(SECRET)),
      (e) => jest.spyOn(e, 'getBallotConfirmationState').mockRejectedValue(new Error(SECRET)),
    ];
    for (const arm of failures) {
      const { engine } = newEngine();
      await propose(engine);
      arm(engine);
      mockCurrentElectionEngine = engine;
      await renderScreen();
    }
    // propose / submit / withdraw failures
    for (const method of ['proposeBallot', 'submitBallotForConfirmation', 'withdrawBallotConfirmation'] as const) {
      const { engine } = newEngine();
      await propose(engine);
      if (method === 'withdrawBallotConfirmation') await engine.submitBallotForConfirmation(BALLOT_ID);
      mockCurrentElectionEngine = engine;
      const tr = await renderScreen();
      engine[method] = jest.fn(async () => {
        throw new Error(SECRET);
      });
      const id = method === 'proposeBallot' ? 'edit-ballot-propose' : method === 'submitBallotForConfirmation' ? 'edit-ballot-submit' : 'edit-ballot-withdraw';
      await press(tr, id);
    }

    // EVERY spied call, not only the tagged ones (REVIEW WR-R5-01).
    const calls = [...(console.warn as jest.Mock).mock.calls, ...(console.error as jest.Mock).mock.calls];
    expect(calls.some((c) => typeof c[0] === 'string' && tags.has(c[0]))).toBe(true);
    expect(untaggedCalls(calls, tags)).toEqual([]);
    expect(leakingCalls(calls, ['SECRET', 'requestId'])).toEqual([]);
    for (const call of calls) {
      for (const arg of call) expect(typeof arg).toBe('string');
    }
  });
});

describe('R2-8/R2-9 an unsaved ballot cannot be submitted (gap6/WR-01)', () => {
  it('R2-8 editing disables Submit with a hint to Propose first; reverting re-enables it', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const submitSpy = jest.spyOn(engine, 'submitBallotForConfirmation');
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    expect(tr.root.findAllByProps({ testID: 'edit-ballot-submit' })[0].props.disabled).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit-needs-propose')).toBe(false);

    await editDescription(tr, 'edited');
    expect(tr.root.findAllByProps({ testID: 'edit-ballot-submit' })[0].props.disabled).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit-needs-propose')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmitNeedsPropose')).toBe(true);
    await press(tr, 'edit-ballot-submit');
    expect(submitSpy).not.toHaveBeenCalled();

    await editDescription(tr, STORED_DESCRIPTION);
    expect(tr.root.findAllByProps({ testID: 'edit-ballot-submit' })[0].props.disabled).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit-needs-propose')).toBe(false);
  });

  it('R2-9 negative control: seeding the primary authority into a ballot with no stored authority is not an edit', async () => {
    const { engine } = newEngine();
    await propose(engine, '');
    mockCurrentElectionEngine = engine;
    mockNetworkEngine = {
      getAuthoritiesByName: jest.fn(async () => ({ buffer: [{ id: 'auth-primary', name: 'Primary' }] })),
      getDetails: jest.fn(async () => ({ network: { primaryAuthorityId: 'auth-primary' } })),
    };
    const tr = await renderScreen();
    await flush();
    expect(form(tr).props.authority).toBe('auth-primary'); // the seeding really happened
    expect(tr.root.findAllByProps({ testID: 'edit-ballot-submit' })[0].props.disabled).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit-needs-propose')).toBe(false);

    // and a real authority change IS an edit
    await renderer.act(async () => {
      form(tr).props.onAuthorityChange('auth-other');
    });
    expect(hasTestID(tr, 'edit-ballot-submit-needs-propose')).toBe(true);
  });
});

describe('R2-10 after a submit the officer sees where confirmation happens (gap6/WR-02)', () => {
  it('own task open: hint plus an Open Tasks control that opens the Tasks tab', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const spy = jest.spyOn(engine, 'getBallotConfirmationState');
    spy.mockResolvedValueOnce(state({}));
    spy.mockResolvedValue(state({ locked: true, canWithdraw: true, ownTaskOpen: true }));
    engine.submitBallotForConfirmation = jest.fn(async () => {});
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    await press(tr, 'edit-ballot-submit');

    expect(hasTestID(tr, 'edit-ballot-submitted-task-hint')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmittedOwnTaskHint')).toBe(true);
    expect(treeContainsText(tr, 'ballotOpenTasksLink')).toBe(true);
    await press(tr, 'edit-ballot-open-tasks');
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'NAVIGATE', payload: { name: 'Home', params: { screen: 'Tasks' } } });
  });

  it('no own task: the others-confirm hint and no link', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const spy = jest.spyOn(engine, 'getBallotConfirmationState');
    spy.mockResolvedValueOnce(state({}));
    spy.mockResolvedValue(state({ locked: true, canWithdraw: true, ownTaskOpen: false }));
    engine.submitBallotForConfirmation = jest.fn(async () => {});
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    await press(tr, 'edit-ballot-submit');

    expect(treeContainsText(tr, 'ballotSubmittedOthersHint')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmittedOwnTaskHint')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-open-tasks')).toBe(false);
  });
});

describe('R2-11/R2-12 Withdraw is offered only to the officer who submitted (gap8/WR-03)', () => {
  it('R2-11 locked with canWithdraw false shows the note, true shows Withdraw', async () => {
    const { engine } = newEngine();
    await propose(engine);
    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue(state({ locked: true, canWithdraw: false }));
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-out-for-confirmation')).toBe(true);
    expect(treeContainsText(tr, 'ballotOutForConfirmationNote')).toBe(true);

    const { engine: e2 } = newEngine();
    await propose(e2);
    jest.spyOn(e2, 'getBallotConfirmationState').mockResolvedValue(state({ locked: true, canWithdraw: true }));
    mockCurrentElectionEngine = e2;
    const tr2 = await renderScreen();
    expect(hasTestID(tr2, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr2, 'edit-ballot-out-for-confirmation')).toBe(false);
  });

  it('R2-12 through the mock: another officer submits behind the screen, this officer sees the note; the submitter still sees Withdraw', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen();
    engine.setCurrentUser('officer-b');
    await engine.submitBallotForConfirmation(BALLOT_ID);
    engine.setCurrentUser('officer-a');
    await press(tr, 'edit-ballot-submit');
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-out-for-confirmation')).toBe(true);

    const { engine: own } = newEngine();
    await propose(own);
    mockCurrentElectionEngine = own;
    const tr2 = await renderScreen();
    await press(tr2, 'edit-ballot-submit');
    expect(hasTestID(tr2, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr2, 'edit-ballot-out-for-confirmation')).toBe(false);
  });
});
