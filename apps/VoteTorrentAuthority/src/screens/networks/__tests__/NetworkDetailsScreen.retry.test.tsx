/**
 * NetworkDetailsScreen: a failed load offers Try Again that re-runs BOTH loads (N-6), and
 * the deferred-select path still brings the founder to recovery-key registration (N-2c).
 */

import React from 'react';
import renderer, { act } from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: { text: '#T', textSecondary: '#TS', card: '#CA', accent: '#AC', success: '#SU', error: '#ER', light: '#LI', dark: '#DA' },
  }),
  useRoute: () => ({ params: { networkRef: { hash: 'net-1', name: 'Net' } } }),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

const mockSelectNetwork = jest.fn(async (..._a: any[]) => undefined);
const mockGetEngine = jest.fn(async (..._args: any[]): Promise<any> => {
  throw new Error('not under test');
});
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({
    getEngine: mockGetEngine,
    selectNetwork: mockSelectNetwork,
    resolveDeviceSigner: jest.fn(),
  }),
}));

const RECOVERY_KEY = '036d541206f2fb5d6c67e0a39b615eebf8ada784a8b12dcab550c901305b6fcf3a';
const SIGNING_KEY = '03f450ccccbaefd2efe218d8eb8c2f84677aaed1fa7bc19b9dbcac96e6ef7d86ab';
// The REAL recovery-key gate runs here (N-2c): only its device record read is mocked.
jest.mock('../../../engines/device-user', () => ({
  getDeviceProvisioningRecord: async () => ({ recoveryPublicKeyCompressedHex: '036d541206f2fb5d6c67e0a39b615eebf8ada784a8b12dcab550c901305b6fcf3a' }),
}));

jest.mock('../components/NetworkDetailsComponent', () => () => null);
jest.mock('../../../components/AuthorizationSection', () => ({ AuthorizationSection: () => null }));
jest.mock('../components/ProposedChangesCard', () => ({ ProposedChangesCard: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NetworkDetailsScreen } = require('../NetworkDetailsScreen');

async function renderScreen() {
  let tr!: renderer.ReactTestRenderer;
  await act(async () => {
    tr = renderer.create(<NetworkDetailsScreen />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return tr;
}

function find(tr: renderer.ReactTestRenderer, pred: (p: any) => boolean) {
  return tr.root.findAll((n) => {
    try {
      return pred(n.props);
    } catch {
      return false;
    }
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('NetworkDetailsScreen retry', () => {
  it('N-6: a failed first load offers Try Again that re-runs the network load then the primary-authority load', async () => {
    const authorityEngine = {
      getDetails: jest.fn(async () => ({ id: 'a-1' })),
      getAdminDetails: jest.fn(async () => ({})),
    };
    const networkEngine = {
      getDetails: jest.fn(async () => ({ network: { primaryAuthorityId: 'a-1', name: 'Net Loaded' } })),
      getCurrentUser: async () => undefined,
    };
    let failFirst = true;
    mockGetEngine.mockImplementation(async (name: string) => {
      if (name === 'network') {
        if (failFirst) {
          failFirst = false;
          throw new Error('ElectionEngine raw');
        }
        return networkEngine;
      }
      return authorityEngine;
    });

    const tr = await renderScreen();
    expect(JSON.stringify(tr.toJSON())).toContain('networkDetailsLoadFailed');
    const retry = find(tr, (p) => p.testID === 'network-details-retry' && typeof p.onPress === 'function');
    expect(retry.length).toBeGreaterThan(0);
    expect(find(tr, (p) => p.title === 'loadRetryButton').length).toBeGreaterThan(0);

    await act(async () => {
      await retry[0].props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(networkEngine.getDetails).toHaveBeenCalledTimes(1);
    expect(authorityEngine.getDetails).toHaveBeenCalled();
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('Net Loaded');
    expect(json).not.toContain('networkDetailsLoadFailed');
    expect(find(tr, (p) => p.testID === 'network-details-retry').length).toBe(0);
  });

  it('WR-R3-09: a slow failure of a superseded primary-authority load never re-raises the error over a later success', async () => {
    let rejectStale!: (e: Error) => void;
    let authorityCalls = 0;
    const authorityEngine = {
      getDetails: jest.fn(async () => {
        authorityCalls += 1;
        if (authorityCalls === 1) throw new Error('first authority read failed');
        if (authorityCalls === 2) {
          return new Promise((_resolve, reject) => {
            rejectStale = reject;
          });
        }
        return { id: 'a-1' };
      }),
      getAdminDetails: jest.fn(async () => ({})),
    };
    const networkEngine = {
      getDetails: jest.fn(async () => ({ network: { primaryAuthorityId: 'a-1', name: 'Net Loaded' } })),
      getCurrentUser: async () => undefined,
    };
    mockGetEngine.mockImplementation(async (name: string) => (name === 'network' ? networkEngine : authorityEngine));

    const tr = await renderScreen();
    await act(async () => {
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('networkDetailsLoadFailed');
    const retry = find(tr, (p) => p.testID === 'network-details-retry' && typeof p.onPress === 'function');
    await act(async () => {
      await retry[0].props.onPress();
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    // The run against the new details succeeded.
    expect(authorityCalls).toBe(3);
    expect(JSON.stringify(tr.toJSON())).not.toContain('networkDetailsLoadFailed');

    // The superseded run (started against the old details) now fails late.
    await act(async () => {
      rejectStale(new Error('late stale failure'));
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).not.toContain('networkDetailsLoadFailed');
    expect(find(tr, (p) => p.testID === 'network-details-retry').length).toBe(0);
  });

  it('WR-R3-09: a network-load failure is not erased when the primary-authority load starts', async () => {
    const authorityEngine = {
      getDetails: jest.fn(async () => ({ id: 'a-1' })),
      getAdminDetails: jest.fn(async () => ({})),
    };
    // The details land, then the current-user read fails: the authority load starts AFTER the
    // network load has already recorded its error.
    const networkEngine = {
      getDetails: jest.fn(async () => ({ network: { primaryAuthorityId: 'a-1', name: 'Net Loaded' } })),
      getCurrentUser: async () => {
        throw new Error('current user read failed');
      },
    };
    mockGetEngine.mockImplementation(async (name: string) => (name === 'network' ? networkEngine : authorityEngine));

    const tr = await renderScreen();
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(authorityEngine.getAdminDetails).toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('networkDetailsLoadFailed');
    expect(find(tr, (p) => p.testID === 'network-details-retry').length).toBeGreaterThan(0);
  });

  it('N-2c: Select on a network whose User has no recovery key navigates to ProvisionSigningKey (the deferred-select gate)', async () => {
    const networkEngine = {
      getDetails: async () => ({ network: { name: 'Net' } }),
      getCurrentUser: async () => ({ getSummary: async () => ({ id: 'u1', activeKeys: [{ key: SIGNING_KEY }] }) }),
    };
    mockGetEngine.mockImplementation(async () => networkEngine);
    const tr = await renderScreen();
    const select = find(tr, (p) => p.title === 'select' && typeof p.onPress === 'function')[0];
    await act(async () => {
      await select.props.onPress();
    });
    expect(mockSelectNetwork).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'first-run' });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(RECOVERY_KEY).toBeTruthy();
  });
});
