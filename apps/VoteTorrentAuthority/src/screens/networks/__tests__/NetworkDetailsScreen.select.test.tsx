/**
 * NetworkDetailsScreen SELECT failure handling (UAT 62 P1, fresh Pixel_8 second device). SELECT on
 * a device with no signing key rendered getOrCreateDeviceUser's raw developer message, internal
 * decision id included. The failure now routes through useDeviceSigningErrorHandler
 * (NO_KEY_PROVISIONED -> ProvisionSigningKey first-run); anything else shows translated copy.
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

const mockSelectNetwork = jest.fn();
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

const mockGate = jest.fn(async () => false);
jest.mock('../../../hooks/useRecoveryKeyRegistrationGate', () => ({
  useRecoveryKeyRegistrationGate: () => mockGate,
}));

jest.mock('../components/NetworkDetailsComponent', () => () => null);
jest.mock('../../../components/AuthorizationSection', () => ({ AuthorizationSection: () => null }));
jest.mock('../components/ProposedChangesCard', () => ({ ProposedChangesCard: () => null }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NetworkDetailsScreen } = require('../NetworkDetailsScreen');

const DEV_TEXT =
  'getOrCreateDeviceUser: no device signing key provisioned for "Device User" — hardware key provisioning requires the biometric ProvisionSigningKeyScreen ceremony (D-14).';

async function renderAndSelect() {
  let tr!: renderer.ReactTestRenderer;
  await act(async () => {
    tr = renderer.create(<NetworkDetailsScreen />);
  });
  const select = tr.root.findAll((n) => n.props?.title === 'select' && typeof n.props?.onPress === 'function')[0];
  await act(async () => {
    await select.props.onPress();
  });
  return tr;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEngine.mockImplementation(async () => {
    throw new Error('not under test');
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('NetworkDetailsScreen SELECT', () => {
  it('routes a NO_KEY_PROVISIONED failure to the first-run provisioning ceremony and shows no raw text', async () => {
    mockSelectNetwork.mockRejectedValueOnce(Object.assign(new Error(DEV_TEXT), { code: 'NO_KEY_PROVISIONED' }));
    const tr = await renderAndSelect();
    expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'first-run' });
    const json = JSON.stringify(tr.toJSON());
    expect(json).not.toContain('getOrCreateDeviceUser');
    expect(json).not.toContain('D-14');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('shows translated generic copy, never error.message, for any other failure', async () => {
    mockSelectNetwork.mockRejectedValueOnce(new Error('strand open failed: internal detail'));
    const tr = await renderAndSelect();
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('networkSelectFailed');
    expect(json).not.toContain('internal detail');
    expect(mockNavigate).not.toHaveBeenCalledWith('ProvisionSigningKey', expect.anything());
  });

  it('goes back after a successful select when no recovery-key registration is due', async () => {
    mockSelectNetwork.mockResolvedValueOnce(undefined);
    await renderAndSelect();
    expect(mockGate).toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalled();
  });
});

describe('NetworkDetailsScreen load failures', () => {
  async function renderOnly() {
    let tr!: renderer.ReactTestRenderer;
    await act(async () => {
      tr = renderer.create(<NetworkDetailsScreen />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return tr;
  }

  it('shows translated copy when the network details fail to load', async () => {
    mockGetEngine.mockRejectedValueOnce(new Error('ElectionEngine.something raw'));
    const json = JSON.stringify((await renderOnly()).toJSON());
    expect(json).toContain('networkDetailsLoadFailed');
    expect(json).not.toContain('ElectionEngine');
  });

  it('shows translated copy when the primary authority fails to load', async () => {
    const networkEngine = {
      getDetails: async () => ({ network: { primaryAuthorityId: 'a-1', name: 'Net' } }),
      getCurrentUser: async () => undefined,
    };
    mockGetEngine.mockImplementation(async (name: string) => {
      if (name === 'network') return networkEngine;
      throw new Error('ElectionEngine.something raw');
    });
    const json = JSON.stringify((await renderOnly()).toJSON());
    expect(json).toContain('networkDetailsLoadFailed');
    expect(json).not.toContain('ElectionEngine');
  });
});
