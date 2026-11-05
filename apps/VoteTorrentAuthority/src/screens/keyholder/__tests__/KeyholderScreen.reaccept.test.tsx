/**
 * KeyholderScreen.reaccept.test.tsx: "Must accept again" and the officer's explanation (M2, M3).
 * Harness copied from KeyholderScreen.dkgStatus.test.tsx.
 */
import React from 'react';
import renderer from 'react-test-renderer';

const mockDriveKeyholderDkg = jest.fn();

jest.mock('../keyholder-dkg-driver', () => {
  const actual = jest.requireActual('../keyholder-dkg-driver');
  return { ...actual, driveKeyholderDkg: (...args: unknown[]) => mockDriveKeyholderDkg(...args) };
});

const AGAIN = { invite: { name: 'Alice' }, sent: { state: 'accepted-earlier-revision', expiration: '' } };
const KEYHOLDERS = [AGAIN, { invite: { name: 'Bea' }, result: { invokedId: 'u-b', isAccepted: true } }];
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
  mockDriveKeyholderDkg.mockResolvedValue(outcome({ phase: 'not-started', self: { userId: 'u-a' } }));
});


const text = (tr: renderer.ReactTestRenderer, id: string) => JSON.stringify(tr.root.findAll((n) => n.props?.testID === id)[0]?.props.children);

describe('KeyholderScreen: re-accept explanation (62-142)', () => {
  it('M2 a keyholder who must accept again shows the status, the officer note and keeps the Invite button', async () => {
    const tr = await render();
    expect(text(tr, 'keyholder-invite-status')).toContain('keyholderStatusAcceptAgain');
    expect(has(tr, 'keyholder-reaccept-officer-note')).toBe(true);
    expect(text(tr, 'keyholder-reaccept-officer-note')).toContain('keyholderReacceptOfficerNote');
    expect(JSON.stringify(tr.toJSON())).toContain('"invite"');
  });

  it('M3 any other state shows no note', async () => {
    mockRouteParams = { keyholder: KEYHOLDERS[1], electionEngine: mockElectionEngine };
    mockGetElectionDetails.mockResolvedValue({ election: { id: 'election-1' }, current: { keyholders: [KEYHOLDERS[1]] } });
    const tr = await render();
    expect(has(tr, 'keyholder-reaccept-officer-note')).toBe(false);
  });
});
