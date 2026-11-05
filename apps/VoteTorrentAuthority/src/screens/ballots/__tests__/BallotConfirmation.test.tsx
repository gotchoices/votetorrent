/**
 * BallotConfirmation.test.tsx — RTL coverage for D-03/D-05/D-09 (31-05), rewritten by
 * 62-55 (UAT 62 test 13).
 *
 * The earlier suite mocked BallotDraftProvider with a pre-seeded id, rendered only
 * CreateBallotScreen, and used a mock engine that never checked the ProposedBallot row,
 * so it passed a Submit button that failed on device. This suite instead:
 *   - uses the REAL BallotDraftProvider and a REAL MockElectionEngine (rebuilt dist),
 *   - proposes the ballot through the engine first, then renders EditBallotScreen,
 *   - asserts CreateBallotScreen offers Propose only.
 *
 * Covers: submit/withdraw/confirmed/readOnly footer states on EditBallotScreen, the lazy
 * device-signer wiring (never invoked at threshold 1), mapped error copy (never engine
 * text), and the engine-contract confirm path.
 *
 * Mock wiring follows 31-04 contract exactly:
 *   new MockBallotConfirmationState() → new MockElectionEngine(confirmState)
 *   → new MockSignatureTasksEngine(electionEngine)
 *
 * The ballot ID in the pending MOCK_BALLOT_SIGNATURE_TASK is 'mock-ballot-id'.
 *
 * Uses react-test-renderer — same pattern as other tests in this workspace.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mutable module-level engine slot (prefixed `mock` so jest.mock factories can
// reference it — the jest babel transform allows `mock*` variable access).
// ---------------------------------------------------------------------------
let mockCurrentElectionEngine: unknown = null;
let mockReadOnly = false;
const mockBallotId = 'mock-ballot-id';
const BALLOT_ID = mockBallotId;

// ---------------------------------------------------------------------------
// Module mocks (all heavy native deps)
// ---------------------------------------------------------------------------

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// @votetorrent/vote-core: do NOT mock — the jest.config.js moduleNameMapper
// resolves it to the real dist (../node_modules/@votetorrent/vote-core/dist/src/index.js)
// which provides ElectionType, ElectionEvent, etc. needed by the mock engine dist files.

jest.mock('@votetorrent/vote-engine/rn', () => ({}), { virtual: true });

// SettingsProvider
jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// AppProvider — no network engine needed for these ballot-screen tests.
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({
    getEngine: jest.fn(async () => null),
  }),
}));

// 62-11 (D-08): device-signer — spied so tests can assert the lazy factory is never invoked
// by a threshold-1 (mock) engine, and the module-level mockCreateDeviceSigner lets the
// jest.mock factory below reference it (mock*-prefixed variable, same convention as
// mockCurrentElectionEngine above).
const mockCreateDeviceSigner = jest.fn();
jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));

// 62-11: useDeviceSigningErrorHandler — a module-level jest.fn so each test can control its
// returned outcome ({ handled, message? }). Reassigned (not just mock-reset) per test via the
// `let` binding below, since the factory reads the CURRENT value at call time.
let mockHandleDeviceSigningError: jest.Mock = jest.fn(() => ({ handled: false }));
jest.mock('../../../hooks/useDeviceSigningErrorHandler', () => ({
  useDeviceSigningErrorHandler: () => mockHandleDeviceSigningError,
}));

// ---------------------------------------------------------------------------
// Navigation mock — useFocusEffect calls the callback synchronously.
// useRoute exposes the mutable `mockCurrentElectionEngine` slot so per-test
// engine injection works without re-mocking.
// ---------------------------------------------------------------------------
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();

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
    setOptions: jest.fn(),
    setParams: mockSetParams,
  }),
  // useFocusEffect: effect-based, mirroring the real hook.
  useFocusEffect: (cb: () => void | (() => void)) => {
    // Run on focus (mount / callback change) via an effect, like the real hook. A bare
    // synchronous call on every render loops forever now that the focus read sets an object.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').useEffect(() => cb(), [cb]);
  },
}));

// ---------------------------------------------------------------------------
// Import the MockElectionEngine and MockBallotConfirmationState.
// The app's node_modules/@votetorrent/vote-engine is a symlink to
// packages/vote-engine (workspace portal). We use a relative path to the dist
// file so Jest's resolver can find it (the package.json exports field only
// exposes the root index — subpaths need direct dist-file access).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockBallotConfirmationState, MockElectionEngine } = require(
  '../../../../../../packages/vote-engine/dist/election/mock-election-engine'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
  const json = JSON.stringify(tr.toJSON()).toLowerCase();
  return json.includes(text.toLowerCase());
}

function newEngine() {
  const confirmState = new MockBallotConfirmationState();
  const engine = new MockElectionEngine(confirmState);
  return { confirmState, engine };
}

async function propose(engine: any, id = BALLOT_ID) {
  await engine.proposeBallot({
    id,
    electionId: 'test-election',
    authorityId: 'auth-1',
    description: 'Test ballot',
    districts: [],
    questions: [],
  });
}

async function renderScreen(screen: 'Edit' | 'Create'): Promise<renderer.ReactTestRenderer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BallotDraftProvider } = require('../providers/BallotDraftProvider');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = screen === 'Edit' ? require('../EditBallotScreen') : require('../CreateBallotScreen');
  const Screen = mod.default;

  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(
      <BallotDraftProvider>
        <Screen />
      </BallotDraftProvider>
    );
  });
  await renderer.act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
  return tr;
}

async function press(tr: renderer.ReactTestRenderer, testID: string) {
  const node = tr.root.findAllByProps({ testID })[0];
  await renderer.act(async () => {
    node.props.onPress();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const hasTestID = (tr: renderer.ReactTestRenderer, testID: string) =>
  tr.root.findAllByProps({ testID }).length > 0;

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentElectionEngine = null;
  mockReadOnly = false;
  mockCreateDeviceSigner.mockReset();
  mockHandleDeviceSigningError = jest.fn(() => ({ handled: false }));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('EditBallotScreen — submit / withdraw on the persisted ballot (62-55)', () => {
  it('unlocked + unconfirmed: Propose and Submit render; Submit calls the engine once with a lazy signer, then only Withdraw remains and the form is disabled', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const submitSpy = jest.spyOn(engine, 'submitBallotForConfirmation');
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);

    await press(tr, 'edit-ballot-submit');

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledWith(BALLOT_ID, expect.any(Function));
    // Threshold-1 property: the lazy signer is never invoked when the engine does not call it.
    expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
    expect(await engine.getBallotConfirmationState(BALLOT_ID)).toEqual({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true }); // gap8/WR-03: the state carries canWithdraw/ownTaskOpen (default mock user submitted)
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
  });

  it('locked on open: the footer is visible with Withdraw; pressing it calls withdraw and Propose/Submit return', async () => {
    const { engine } = newEngine();
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);
    const withdrawSpy = jest.spyOn(engine, 'withdrawBallotConfirmation');
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);

    await press(tr, 'edit-ballot-withdraw');

    expect(withdrawSpy).toHaveBeenCalledWith(BALLOT_ID);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
  });

  it('confirmed: neither Submit nor Withdraw nor Propose renders', async () => {
    const { engine } = newEngine();
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);
    engine.markBallotConfirmed(BALLOT_ID);
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
  });

  it('readOnly preview: no footer at all', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    mockReadOnly = true;

    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
  });

  it('submit failure with engine text renders ballotSubmitFailed and never the engine text', async () => {
    const { engine } = newEngine();
    await propose(engine);
    engine.submitBallotForConfirmation = jest.fn(async () => {
      throw new Error('ElectionEngine.submitBallotForConfirmation: ProposedBallot not found: x');
    });
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    await press(tr, 'edit-ballot-submit');

    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(true);
    expect(treeContainsText(tr, 'ProposedBallot not found')).toBe(false);
    expect(treeContainsText(tr, 'ElectionEngine.')).toBe(false);
  });

  it('withdraw failure renders ballotWithdrawFailed, never engine text', async () => {
    const { engine } = newEngine();
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);
    engine.withdrawBallotConfirmation = jest.fn(async () => {
      throw new Error('engine-withdraw-internal');
    });
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    await press(tr, 'edit-ballot-withdraw');

    expect(treeContainsText(tr, 'ballotWithdrawFailed')).toBe(true);
    expect(treeContainsText(tr, 'engine-withdraw-internal')).toBe(false);
  });

  it('propose failure renders ballotProposeFailed, never engine text', async () => {
    const { engine } = newEngine();
    await propose(engine);
    engine.proposeBallot = jest.fn(async () => {
      throw new Error('engine-propose-internal');
    });
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    await press(tr, 'edit-ballot-propose');

    expect(treeContainsText(tr, 'ballotProposeFailed')).toBe(true);
    expect(treeContainsText(tr, 'engine-propose-internal')).toBe(false);
  });

  it('a device-signing error is routed to the hook; raw text never renders and the screen does not lock', async () => {
    const { engine } = newEngine();
    await propose(engine);
    const thrown = Object.assign(new Error('raw-signer-text'), { code: 'KEY_INVALIDATED' });
    engine.submitBallotForConfirmation = jest.fn(async () => {
      throw thrown;
    });
    mockHandleDeviceSigningError = jest.fn(() => ({ handled: true }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    await press(tr, 'edit-ballot-submit');

    expect(mockHandleDeviceSigningError).toHaveBeenCalledWith(thrown);
    expect(treeContainsText(tr, 'raw-signer-text')).toBe(false);
    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
  });

  it('an unhandled signing outcome with a mapped message shows the mapped copy, not raw text', async () => {
    const { engine } = newEngine();
    await propose(engine);
    engine.submitBallotForConfirmation = jest.fn(async () => {
      throw new Error('raw-signer-text-2');
    });
    mockHandleDeviceSigningError = jest.fn(() => ({ handled: false, message: 'mapped-copy' }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    await press(tr, 'edit-ballot-submit');

    expect(treeContainsText(tr, 'mapped-copy')).toBe(true);
    expect(treeContainsText(tr, 'raw-signer-text-2')).toBe(false);
  });
});

describe('EditBallotScreen — fails closed on an unknown confirmation state (CR-03, WR-03)', () => {
  const noFooter = (tr: renderer.ReactTestRenderer) => {
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
  };

  it('first read rejects: no Propose/Submit/Withdraw, mapped copy and Retry show, form disabled', async () => {
    const { engine } = newEngine();
    await propose(engine);
    jest.spyOn(engine, 'getBallotConfirmationState').mockRejectedValueOnce(new Error('boom-secret'));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    noFooter(tr);
    expect(treeContainsText(tr, 'ballotStateLoadFailed')).toBe(true);
    expect(treeContainsText(tr, 'boom-secret')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
    // Locked-case parity: the add-question affordance is withdrawn.
    expect(treeContainsText(tr, 'addQuestion')).toBe(false);
    // Fixed string + error class name only, never the raw message.
    expect(console.warn).toHaveBeenCalledWith('getBallotConfirmationState failed', 'Error');
  });

  it('Retry re-reads; an unlocked result restores Propose and Submit and clears the error', async () => {
    const { engine } = newEngine();
    await propose(engine);
    jest.spyOn(engine, 'getBallotConfirmationState').mockRejectedValueOnce(new Error('boom'));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    noFooter(tr);
    await press(tr, 'edit-ballot-state-retry');

    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(false);
    expect(treeContainsText(tr, 'ballotStateLoadFailed')).toBe(false);
  });

  it('a Retry that finds the ballot locked shows Withdraw only', async () => {
    const { engine } = newEngine();
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);
    jest.spyOn(engine, 'getBallotConfirmationState').mockRejectedValueOnce(new Error('boom'));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    noFooter(tr);
    await press(tr, 'edit-ballot-state-retry');
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
  });

  it('a successful first read followed by a failing re-focus read fails closed again', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BallotDraftProvider } = require('../providers/BallotDraftProvider');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Screen = require('../EditBallotScreen').default;
    const element = (
      <BallotDraftProvider>
        <Screen />
      </BallotDraftProvider>
    );
    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(element);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);

    // Re-focus: the effect-based useFocusEffect mock re-runs when the callback identity
    // changes, which a new engine reference under the route provokes.
    const { engine: engine2 } = newEngine();
    await propose(engine2);
    jest.spyOn(engine2, 'getBallotConfirmationState').mockRejectedValue(new Error('boom'));
    mockCurrentElectionEngine = engine2;
    await renderer.act(async () => {
      tr.update(<BallotDraftProvider><Screen /></BallotDraftProvider>);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    noFooter(tr);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
  });

  it('the refresh read after Submit rejecting fails closed (no Propose/Submit/Withdraw, Retry shows)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);

    jest.spyOn(engine, 'getBallotConfirmationState').mockRejectedValue(new Error('boom'));
    await press(tr, 'edit-ballot-submit');

    noFooter(tr);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
    expect(treeContainsText(tr, 'ballotStateLoadFailed')).toBe(true);
  });

  it('while the first read is pending the form is disabled and no footer renders', async () => {
    const { engine } = newEngine();
    await propose(engine);
    // gap8/WR-03: the state carries canWithdraw/ownTaskOpen
    let release!: (v: Awaited<ReturnType<typeof engine.getBallotConfirmationState>>) => void;
    jest
      .spyOn(engine, 'getBallotConfirmationState')
      .mockImplementationOnce(() => new Promise((res) => { release = res; }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    noFooter(tr);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(false);
    expect(treeContainsText(tr, 'addQuestion')).toBe(false);

    await renderer.act(async () => {
      release({ locked: false, confirmed: false, canWithdraw: false, ownTaskOpen: false });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
  });

  it('two synchronous Submit presses call submitBallotForConfirmation exactly once (WR-03 latch)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    let finish!: () => void;
    const submitSpy = jest
      .spyOn(engine, 'submitBallotForConfirmation')
      .mockImplementation(() => new Promise<void>((res) => { finish = res; }));
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Edit');
    const node = tr.root.findAllByProps({ testID: 'edit-ballot-submit' })[0];
    await renderer.act(async () => {
      node.props.onPress();
      node.props.onPress();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    await renderer.act(async () => {
      finish();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
  });
});

describe('EditBallotScreen — re-reads the lock after a refused Propose or Submit (WR-04)', () => {
  const SUBMIT_REFUSAL = 'ElectionEngine.submitBallotForConfirmation: This ballot is already submitted for confirmation.';
  const PROPOSE_REFUSAL = 'ElectionEngine.proposeBallot: This ballot is out for confirmation and cannot be edited. Withdraw it first.';

  it('E1 stale Submit: refused as already submitted -> footer swaps to Withdraw, says why (gap8/WR-01)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);

    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: false });
    engine.submitBallotForConfirmation = jest.fn(async () => { throw new Error(SUBMIT_REFUSAL); });
    await press(tr, 'edit-ballot-submit');

    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmitRefusedLocked')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(false);
  });

  it('E2 stale Propose: refused as out for confirmation -> Withdraw renders, the refusal is explained and the stored ballot replaces the unsaved edit (gap8/WR-01)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BallotTemplateForm } = require('../components/BallotTemplateForm');
    await renderer.act(async () => {
      tr.root.findByType(BallotTemplateForm).props.onDescriptionChange('unsaved edit');
    });

    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: false });
    engine.proposeBallot = jest.fn(async () => { throw new Error(PROPOSE_REFUSAL); });
    await press(tr, 'edit-ballot-propose');

    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(treeContainsText(tr, 'ballotProposeRefusedLocked')).toBe(true);
    expect(treeContainsText(tr, 'ballotProposeFailed')).toBe(false);
    expect(tr.root.findByType(BallotTemplateForm).props.description).toBe('Test ballot');
  });

  it('E3 refusal into confirmed: no footer buttons, the refusal is explained (gap8/WR-01)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');

    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false });
    engine.submitBallotForConfirmation = jest.fn(async () => { throw new Error('ElectionEngine.submitBallotForConfirmation: This ballot is already confirmed.'); });
    await press(tr, 'edit-ballot-submit');

    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(treeContainsText(tr, 'ballotSubmitRefusedConfirmed')).toBe(true);
    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(false);
  });

  it('E4 positive control: a non-lock failure with the ballot still unlocked keeps the failure copy and both buttons', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');

    engine.submitBallotForConfirmation = jest.fn(async () => { throw new Error('some other failure'); });
    await press(tr, 'edit-ballot-submit');

    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);
  });

  it('E5 through the real mock engine: another officer submits, then Submit is refused and this officer sees the note, not Withdraw (gap8/WR-03)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(true);

    engine.setCurrentUser('officer-b');
    await engine.submitBallotForConfirmation(BALLOT_ID); // another officer, behind the screen's back
    engine.setCurrentUser('mock-officer');
    await press(tr, 'edit-ballot-submit');

    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-out-for-confirmation')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(treeContainsText(tr, 'ballotSubmitFailed')).toBe(false);
  });

  it('E6 a refresh that rejects after a refused Submit fails closed (no Propose/Submit/Withdraw, Retry shows)', async () => {
    const { engine } = newEngine();
    await propose(engine);
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');

    jest.spyOn(engine, 'getBallotConfirmationState').mockRejectedValue(new Error('boom'));
    engine.submitBallotForConfirmation = jest.fn(async () => { throw new Error(SUBMIT_REFUSAL); });
    await press(tr, 'edit-ballot-submit');

    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-state-retry')).toBe(true);
  });

  it('E7 reached-but-unfinalized pin (T-62-62-08): locked footer; a refused Withdraw shows ballotWithdrawFailed and never offers Propose/Submit', async () => {
    const { engine } = newEngine();
    await propose(engine);
    // The fake models the read-before-reach race: the real engine reports canWithdraw:false once it reads a reached session.
    jest.spyOn(engine, 'getBallotConfirmationState').mockResolvedValue({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: false });
    engine.withdrawBallotConfirmation = jest.fn(async () => {
      throw new Error('ElectionEngine.withdrawBallotConfirmation: This ballot is already confirmed and can no longer be withdrawn.');
    });
    mockCurrentElectionEngine = engine;
    const tr = await renderScreen('Edit');
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);

    await press(tr, 'edit-ballot-withdraw');

    expect(treeContainsText(tr, 'ballotWithdrawFailed')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-withdraw')).toBe(true);
    expect(hasTestID(tr, 'edit-ballot-propose')).toBe(false);
    expect(hasTestID(tr, 'edit-ballot-submit')).toBe(false);
  });
});

describe('CreateBallotScreen — Propose only (62-55)', () => {
  it('renders Propose and no Submit for confirmation / Withdraw, even with a draft id present', async () => {
    const { engine } = newEngine();
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Create');
    expect(treeContainsText(tr, 'propose')).toBe(true);
    expect(treeContainsText(tr, 'submitForConfirmation')).toBe(false);
    expect(treeContainsText(tr, 'withdrawConfirmation')).toBe(false);
  });

  it('propose failure renders ballotProposeFailed, never engine text', async () => {
    const { engine } = newEngine();
    engine.proposeBallot = jest.fn(async () => {
      throw new Error('engine-propose-internal');
    });
    mockCurrentElectionEngine = engine;

    const tr = await renderScreen('Create');
    const btn = tr.root.findAllByProps({ accessibilityLabel: 'propose' })[0];
    await renderer.act(async () => {
      btn.props.onPress();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(treeContainsText(tr, 'ballotProposeFailed')).toBe(true);
    expect(treeContainsText(tr, 'engine-propose-internal')).toBe(false);
  });
});

describe('BallotConfirmation — engine contract confirm path (D-09/D-10)', () => {
  it('confirmed via markBallotConfirmed hook after propose + submit', async () => {
    const { engine, confirmState } = newEngine();
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);
    engine.markBallotConfirmed(BALLOT_ID);
    const cs = await engine.getBallotConfirmationState(BALLOT_ID);
    expect(cs).toEqual({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false }); // gap8/WR-03
    expect(confirmState.get(BALLOT_ID)).toBe('confirmed');
  });

  it('confirmed via paired completeSignature — shared state object drives the flip', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MockSignatureTasksEngine } = require(
      '../../../../../../packages/vote-engine/dist/tasks/mock-signature-tasks-engine'
    );
    const { engine } = newEngine();
    const tasksEngine = new MockSignatureTasksEngine(engine);
    await propose(engine);
    await engine.submitBallotForConfirmation(BALLOT_ID);

    const tasks = await tasksEngine.getRequestedSignatures(true);
    const ballotTask = tasks.find((t: { signatureType: string }) => t.signatureType === 'ballot');
    expect(ballotTask).toBeDefined();
    await tasksEngine.completeSignature(ballotTask, {
      isAccepted: true,
      signature: { signature: 'mock-sig', signerKey: 'mock-key', signerUserId: 'mock-user' },
    });
    expect((await engine.getBallotConfirmationState(BALLOT_ID)).confirmed).toBe(true);
    const remaining = await tasksEngine.getRequestedSignatures(true);
    expect(remaining.some((t: { signatureType: string }) => t.signatureType === 'ballot')).toBe(false);
  });
});
