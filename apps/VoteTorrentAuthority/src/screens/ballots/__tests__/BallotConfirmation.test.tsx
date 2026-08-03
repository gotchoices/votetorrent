/**
 * BallotConfirmation.test.tsx — RTL coverage for D-03/D-05/D-09 (31-05).
 *
 * Covers:
 *   (a) submit → locked: electionEngine.getBallotConfirmationState returns locked after submit,
 *       and CreateBallotScreen UI shows the Withdraw button (i18n key: withdrawConfirmation)
 *   (b) withdraw → unlocked: state reverts, Submit button re-appears
 *   (c) confirmed badge path — reach confirmed=true by an explicit named path:
 *       - directly via electionEngine.markBallotConfirmed (hook)
 *       - via MockSignatureTasksEngine.completeSignature (paired engines over shared confirmState)
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

// BallotDraftProvider — seed ballot id so the screen has a stable ballot to submit.
jest.mock('../providers/BallotDraftProvider', () => ({
  useBallotDraft: () => ({
    ballotDraft: {
      id: 'mock-ballot-id',
      electionId: 'test-election',
      description: '',
      districts: [],
      questions: [],
    },
    setBallotDraft: jest.fn(),
    addQuestion: jest.fn(),
    updateQuestion: jest.fn(),
    removeQuestion: jest.fn(),
  }),
}));

// AppProvider — no network engine needed for these ballot-screen tests.
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({
    getEngine: jest.fn(async () => null),
  }),
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
    },
  }),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
    setOptions: jest.fn(),
    setParams: mockSetParams,
  }),
  // useFocusEffect: call the callback immediately (synchronous focus in tests).
  useFocusEffect: (cb: () => void | (() => void)) => { cb(); },
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

/**
 * Serialize the rendered tree to JSON and search for a text string.
 * CustomButton renders its title via .toUpperCase() — so we search
 * case-insensitively to match both the i18n key and its uppercased form.
 */
function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
  const json = JSON.stringify(tr.toJSON()).toLowerCase();
  return json.includes(text.toLowerCase());
}

async function renderCreateBallotScreen(): Promise<renderer.ReactTestRenderer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CreateBallotModule = require('../CreateBallotScreen');
  const CreateBallotScreen =
    CreateBallotModule.default ?? CreateBallotModule.CreateBallotScreen;

  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<CreateBallotScreen />);
  });
  // Flush async effects (useFocusEffect + useEffect promise resolution).
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return tr;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentElectionEngine = null;
  // Do NOT reset modules — the top-level require for MockElectionEngine/MockSignatureTasksEngine
  // must remain cached across tests; resetModules would break mock factory closures.
});

describe('BallotConfirmation — D-03/D-05/D-09 RTL coverage', () => {

  // -------------------------------------------------------------------------
  // (a) submit → locked
  // -------------------------------------------------------------------------

  it('(a) submit → locked: getBallotConfirmationState returns locked after submitBallotForConfirmation', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Initially unlocked.
    const before = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(before.locked).toBe(false);
    expect(before.confirmed).toBe(false);

    // Submit.
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');

    // After submit: locked=true, confirmed=false.
    const after = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(after.locked).toBe(true);
    expect(after.confirmed).toBe(false);
  });

  it('(a) submit → locked UI: when engine is locked, Withdraw button shown and Submit hidden', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Pre-submit so the screen opens in locked state.
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');

    // Inject the locked engine.
    mockCurrentElectionEngine = electionEngine;
    const tr = await renderCreateBallotScreen();

    // Withdraw action should be visible (i18n key echoed by mock t()).
    expect(treeContainsText(tr, 'withdrawConfirmation')).toBe(true);
    // Submit action should NOT be visible when locked.
    expect(treeContainsText(tr, 'submitForConfirmation')).toBe(false);
  });

  it('(a) edit-lock: Propose button is disabled when the ballot is locked', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Pre-submit (locked).
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');
    mockCurrentElectionEngine = electionEngine;
    const tr = await renderCreateBallotScreen();

    // In the locked UI, the Propose button should not appear (footer shows Withdraw instead).
    expect(treeContainsText(tr, 'propose')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (b) withdraw → unlocked
  // -------------------------------------------------------------------------

  it('(b) withdraw → unlocked: getBallotConfirmationState returns unlocked after withdraw', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    await electionEngine.submitBallotForConfirmation('mock-ballot-id');
    await electionEngine.withdrawBallotConfirmation('mock-ballot-id');

    const after = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(after.locked).toBe(false);
    expect(after.confirmed).toBe(false);
  });

  it('(b) withdraw → unlocked UI: Submit button shown, Withdraw hidden when unlocked', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Unlocked (default state).
    mockCurrentElectionEngine = electionEngine;
    const tr = await renderCreateBallotScreen();

    // Submit button should be present (ballot id exists + engine present).
    expect(treeContainsText(tr, 'submitForConfirmation')).toBe(true);
    // Withdraw button should NOT be present when unlocked.
    expect(treeContainsText(tr, 'withdrawConfirmation')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (c) confirmed badge path — explicit named paths
  // -------------------------------------------------------------------------

  it('(c) confirmed via markBallotConfirmed hook — explicit named path (D-10)', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Submit then confirm via the explicit hook.
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');
    electionEngine.markBallotConfirmed('mock-ballot-id');

    const cs = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(cs.confirmed).toBe(true);
    expect(cs.locked).toBe(false);
    // The shared confirmState object reflects the flip.
    expect(confirmState.get('mock-ballot-id')).toBe('confirmed');
  });

  it('(c) pending ballot shows Proposed state, confirmed ballot shows Confirmed state', async () => {
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);

    // Propose a ballot.
    await electionEngine.proposeBallot({
      id: 'mock-ballot-id',
      electionId: 'test-election',
      authorityId: 'auth-1',
      description: 'Test ballot',
      districts: [],
      questions: [],
    });

    // Pending (not confirmed) state.
    const pendingState = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(pendingState.confirmed).toBe(false);
    expect(confirmState.get('mock-ballot-id')).toBe('proposed');

    // Confirm via the explicit named path.
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');
    electionEngine.markBallotConfirmed('mock-ballot-id');

    const confirmedState = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(confirmedState.confirmed).toBe(true);
    expect(confirmState.get('mock-ballot-id')).toBe('confirmed');
  });

  it('(c) confirmed via paired completeSignature — shared state object drives the flip (D-09/D-10)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MockSignatureTasksEngine } = require(
      '../../../../../../packages/vote-engine/dist/tasks/mock-signature-tasks-engine'
    );

    // Wire mocks per 31-04 contract.
    const confirmState = new MockBallotConfirmationState();
    const electionEngine = new MockElectionEngine(confirmState);
    const tasksEngine = new MockSignatureTasksEngine(electionEngine);

    // Submit ballot so it is in 'submitted' state.
    await electionEngine.submitBallotForConfirmation('mock-ballot-id');

    // Get the pending ballot signature task.
    const tasks = await tasksEngine.getRequestedSignatures(true);
    const ballotTask = tasks.find((t: { signatureType: string }) => t.signatureType === 'ballot');
    expect(ballotTask).toBeDefined();

    // Complete with accepted=true — this calls markBallotConfirmed internally.
    await tasksEngine.completeSignature(ballotTask, {
      isAccepted: true,
      signature: {
        signature: 'mock-sig',
        signerKey: 'mock-key',
        signerUserId: 'mock-user',
      },
    });

    // The shared confirmState is flipped to 'confirmed' via MockElectionEngine.
    const cs = await electionEngine.getBallotConfirmationState('mock-ballot-id');
    expect(cs.confirmed).toBe(true);

    // The ballot task is removed from the pending inbox (D-09).
    const remaining = await tasksEngine.getRequestedSignatures(true);
    const stillHasBallotTask = remaining.some(
      (t: { signatureType: string }) => t.signatureType === 'ballot'
    );
    expect(stillHasBallotTask).toBe(false);
  });

});
