/**
 * A description typed while the primary authority resolves must survive the authority default.
 *
 * 64-53 (`intake-ballot-retry`, 2026-10-16): the description filled into CreateBallot reset to empty
 * when the screen's authority load completed; the retry that waited for the load was fine. The
 * authority-default effect wrote `{ ...ballotDraft, authority }` from the draft of ITS render, so a
 * keystroke handled after that render committed but before its passive effects ran was queued
 * first and then overwritten by the effect's stale copy.
 *
 * The keystroke is driven from the (mocked) form's layout effect on exactly that commit: layout
 * effects run before the commit's passive effects, which is the window a real keystroke lands in on
 * a starved JS thread. The REAL BallotDraftProvider is used.
 */

import React from 'react';
import renderer from 'react-test-renderer';

const PRIMARY = 'authority-primary';
const mockNeedle = 'Needle description typed during the authority load';

let mockResolveDetails: ((d: unknown) => void) | null = null;
let mockTypeOnNextCommit = false;
const mockFormProps: { latest: Record<string, any> | null } = { latest: null };

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@votetorrent/vote-engine/rn', () => ({}), { virtual: true });
jest.mock('../../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));

const mockEngine = {
  getDetails: () =>
    new Promise((resolve) => {
      mockResolveDetails = resolve;
    }),
};
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));
const mockGetEngine = jest.fn(async () => mockEngine);
jest.mock('../../../utils/loadAuthoritiesWithRetry', () => ({
  loadAuthoritiesWithRetry: jest.fn(async () => [{ id: 'authority-primary', name: 'Primary' }]),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: { card: '#F2F2F7', success: '#34C759' } }),
  useRoute: () => ({ params: { electionId: 'test-election', electionTitle: 'T', electionDate: '2026-12-01' } }),
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setParams: jest.fn() }),
}));

jest.mock('../components/BallotTemplateForm', () => ({
  BallotTemplateForm: (props: Record<string, any>) => {
    mockFormProps.latest = props;
    require('react').useLayoutEffect(() => {
      if (mockTypeOnNextCommit) {
        mockTypeOnNextCommit = false;
        props.onDescriptionChange(mockNeedle);
      }
    });
    return null;
  },
}));

const CreateBallotScreen = require('../CreateBallotScreen').default;
const { BallotDraftProvider } = require('../providers/BallotDraftProvider');

async function flush(turns = 10) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mockResolveDetails = null;
  mockTypeOnNextCommit = false;
  mockFormProps.latest = null;
});

describe('CreateBallotScreen — authority default vs. typed description', () => {
  it('keeps a description typed between the authority-resolved commit and its effects', async () => {
    await renderer.act(async () => {
      renderer.create(
        <BallotDraftProvider>
          <CreateBallotScreen />
        </BallotDraftProvider>,
      );
      await flush();
    });
    expect(mockResolveDetails).not.toBeNull();

    await renderer.act(async () => {
      mockTypeOnNextCommit = true;
      mockResolveDetails!({ network: { primaryAuthorityId: PRIMARY } });
      await flush();
    });

    expect(mockTypeOnNextCommit).toBe(false);
    expect(mockFormProps.latest!.authority).toBe(PRIMARY);
    expect(mockFormProps.latest!.description).toBe(mockNeedle);
  });

  it('keeps a description typed after the authority default landed (guard)', async () => {
    await renderer.act(async () => {
      renderer.create(
        <BallotDraftProvider>
          <CreateBallotScreen />
        </BallotDraftProvider>,
      );
      await flush();
    });
    await renderer.act(async () => {
      mockResolveDetails!({ network: { primaryAuthorityId: PRIMARY } });
      await flush();
    });
    await renderer.act(async () => {
      mockFormProps.latest!.onDescriptionChange(mockNeedle);
    });

    expect(mockFormProps.latest!.authority).toBe(PRIMARY);
    expect(mockFormProps.latest!.description).toBe(mockNeedle);
  });
});
