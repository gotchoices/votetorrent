/**
 * KeyholderScreen.overdue.test.tsx: the DKG round-deadline notice on the Keyholder screen.
 * Harness copied from KeyholderScreen.dkgStatus.test.tsx.
 */
import React from 'react';
import renderer from 'react-test-renderer';

const mockDriveKeyholderDkg = jest.fn();

jest.mock('../keyholder-dkg-driver', () => {
  const actual = jest.requireActual('../keyholder-dkg-driver');
  return { ...actual, driveKeyholderDkg: (...args: unknown[]) => mockDriveKeyholderDkg(...args) };
});

const KEYHOLDERS = [
  { invite: { name: 'Alice' }, result: { invokedId: 'u-a', isAccepted: true } },
  { invite: { name: 'Bea' }, result: { invokedId: 'u-b', isAccepted: true } },
];
const mockGetElectionDetails = jest.fn();
const mockElectionEngine = { getElectionDetails: mockGetElectionDetails };

jest.mock('../../../providers/AppProvider', () => ({ useApp: () => ({ getEngine: jest.fn(async () => undefined) }) }));
jest.mock('../../../engines/keyholder-vault', () => ({ resolveKeyholderKeyVault: () => ({}) }));
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { hours?: number; names?: string }) => (o ? `${key}|${o.hours}|${o.names}` : key),
  }),
}));

let mockRouteParams: any;
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: { accent: '#A', textSecondary: '#888', success: '#0F0', warning: '#FA0', error: '#F00' } }),
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => callback(), []);
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyholderScreenModule = require('../KeyholderScreen');
const KeyholderScreen = KeyholderScreenModule.default ?? KeyholderScreenModule.KeyholderScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<KeyholderScreen />);
  });
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return tr;
}
const has = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props?.testID === id).length > 0;
const outcome = (status: unknown, extra: object = {}) => ({ status, advanced: false, actions: [], ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetElectionDetails.mockResolvedValue({ election: { id: 'election-1' }, current: { keyholders: KEYHOLDERS } });
  mockRouteParams = { keyholder: KEYHOLDERS[0], electionEngine: mockElectionEngine };
});

describe('KeyholderScreen: DKG round-deadline notice (D-19 ruling)', () => {
  it('S1 names the overdue keyholder with the 24 hour wording', async () => {
    mockDriveKeyholderDkg.mockResolvedValue(outcome({ phase: 'in-progress', self: { userId: 'u-a' }, overdueUserIds: ['u-b'] }));
    const tr = await render();
    expect(has(tr, 'keyholder-dkg-overdue-notice')).toBe(true);
    expect(JSON.stringify(tr.toJSON())).toContain('dkgOverdueNotice|24|Bea');
  });

  it.each([[[]], [undefined]])('S2 overdue %j shows no notice and keeps the row', async (ids) => {
    mockDriveKeyholderDkg.mockResolvedValue(outcome({ phase: 'in-progress', self: { userId: 'u-a' }, overdueUserIds: ids }));
    const tr = await render();
    expect(has(tr, 'keyholder-dkg-overdue-notice')).toBe(false);
    expect(has(tr, 'keyholder-dkg-status-inProgress')).toBe(true);
  });

  it('S3 a complete DKG with a stale overdue list shows no notice', async () => {
    mockDriveKeyholderDkg.mockResolvedValue(outcome({ phase: 'complete', self: { userId: 'u-a' }, overdueUserIds: ['u-b'] }));
    expect(has(await render(), 'keyholder-dkg-overdue-notice')).toBe(false);
  });

  it('S4 a failed status read shows no notice and the unchanged error copy', async () => {
    mockDriveKeyholderDkg.mockResolvedValue(outcome(null, { error: { code: 'x', authDenied: false } }));
    const tr = await render();
    expect(has(tr, 'keyholder-dkg-overdue-notice')).toBe(false);
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderDkgError');
  });

  it('S6 the keyholder who just advanced is not flagged to themselves', async () => {
    mockDriveKeyholderDkg.mockResolvedValue(
      outcome({ phase: 'in-progress', self: { userId: 'u-a' }, overdueUserIds: ['u-a'] }, { advanced: true })
    );
    expect(has(await render(), 'keyholder-dkg-overdue-notice')).toBe(false);
  });
});
