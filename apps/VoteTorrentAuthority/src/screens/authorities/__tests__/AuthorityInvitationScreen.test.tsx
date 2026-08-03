/**
 * AuthorityInvitationScreen.test.tsx — INV-02/04/05 screen-layer coverage.
 *
 * Phase 39 plan 39-04 (DEBT-09 test-coverage backfill, todo
 * 2026-06-24-inv-02-04-05-test-coverage). No jest coverage previously existed
 * for this screen (21-14 was UAT-only). Scaffolded from
 * RevokeKeyScreen.test.tsx (react-test-renderer + mock*-prefixed module
 * slots, no @testing-library).
 *
 * Pins two invariants:
 *   INV-02 (send mode): onSend calls createAuthorityInvite(name) then
 *     saveInviteWithSigning(invite, 'iad', signer), and the resulting share
 *     text contains the ephemeral invitePrivate (the invitee's only path to
 *     accept — D-05/D-06).
 *   INV-04/05 (accept mode, accept + decline): navigation.goBack() is called
 *     ONLY when respondToInvite resolves; on a thrown/rejected
 *     respondToInvite, goBack is NOT called and errorMessage is set (rendered
 *     by <InlineError>). Same success-gated-navigation contract for both
 *     onAccept and onDecline.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mutable module-level slots (prefixed `mock` so jest.mock factories may
// reference them per the jest babel transform's hoist-safe naming rule).
// ---------------------------------------------------------------------------
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

let mockRouteParams: { mode: 'send' | 'accept'; invitationId?: string } = { mode: 'send' };

// Signer echoes nothing meaningful — INV-02 only asserts on the CALL, not the
// signature bytes (that binding is covered engine-side).
const mockSigner = jest.fn(async () => ({
  signature: 'sig',
  signerKey: 'device-pub-key',
  signerUserId: 'user-1',
}));

const mockCreateAuthorityInvite = jest.fn();
const mockSaveInviteWithSigning = jest.fn(async () => {});
const mockAuthorityEngine = {
  createAuthorityInvite: mockCreateAuthorityInvite,
  saveInviteWithSigning: mockSaveInviteWithSigning,
};

const mockOpenAuthority = jest.fn(async () => mockAuthorityEngine);
const mockGetNetworkDetails = jest.fn(async () => ({
  network: { primaryAuthorityId: 'authority-1' },
}));
const mockNetworkEngine = {
  getDetails: mockGetNetworkDetails,
  openAuthority: mockOpenAuthority,
};
const mockOpen = jest.fn(async () => mockNetworkEngine);
const mockGetRecentNetworks = jest.fn(async () => [{ id: 'network-1' }]);
const mockNetworksEngine = {
  getRecentNetworks: mockGetRecentNetworks,
  open: mockOpen,
};

// getEngine<T>(name) — dispatch by engine name. 'network' backs the header
// load effect (best-effort; failures there must not block onSend).
const mockRespondToInvite = jest.fn(async () => {});
const mockGetAuthorityInvite = jest.fn(async () => undefined);
const mockInvitationEngine = {
  respondToInvite: mockRespondToInvite,
  getAuthorityInvite: mockGetAuthorityInvite,
};
const mockDefaultUserEngine = { get: jest.fn(async () => ({ name: 'Device User' })) };
const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'network') return mockNetworkEngine;
  if (name === 'invitations') return mockInvitationEngine;
  if (name === 'defaultUser') return mockDefaultUserEngine;
  return undefined;
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine, networksEngine: mockNetworksEngine }),
}));

jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: jest.fn(async () => mockSigner),
}));
jest.mock('../../../engines/device-user', () => ({
  getOrCreateDeviceUser: jest.fn(async () => ({ id: 'user-1', name: 'Device User' })),
}));

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
    },
  }),
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: mockSetOptions }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AuthorityInvitationModule = require('../AuthorityInvitationScreen');
const AuthorityInvitationScreen = AuthorityInvitationModule.default ?? AuthorityInvitationModule.AuthorityInvitationScreen;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AuthorityInvitationScreen />);
  });
  // Flush the mount-time loadNetwork/loadInvite effects.
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return tr;
}

function buttonByTitle(tr: renderer.ReactTestRenderer, title: string) {
  return tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === 'function')[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = { mode: 'send' };
  mockCreateAuthorityInvite.mockReturnValue({
    invitePrivate: 'ephemeral-private-hex',
    inviteKey: 'invite-key-hex',
    inviteSignature: 'invite-sig',
    expiration: '2027-01-01T00:00:00.000Z',
    type: 'a',
    name: 'New Authority',
  });
  mockSaveInviteWithSigning.mockResolvedValue(undefined);
  mockRespondToInvite.mockResolvedValue(undefined);
});

describe('AuthorityInvitationScreen — INV-02 (send mode real invitePrivate sharing)', () => {
  it('onSend calls createAuthorityInvite then saveInviteWithSigning("iad") and the share text contains invitePrivate', async () => {
    const tr = await render();

    await renderer.act(async () => {
      // CustomTextInput title=t("name") — set the authority name (send-mode form).
      const nameInput = tr.root.findAll(
        (n) => n.props?.title === 'name' && typeof n.props?.onChangeText === 'function',
      )[0];
      nameInput.props.onChangeText('New Authority');
    });

    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
      await Promise.resolve();
    });

    expect(mockCreateAuthorityInvite).toHaveBeenCalledWith('New Authority');
    expect(mockSaveInviteWithSigning).toHaveBeenCalledTimes(1);
    const [invitePassed, scopePassed, signerPassed] = mockSaveInviteWithSigning.mock.calls[0];
    expect(invitePassed).toEqual(
      expect.objectContaining({ invitePrivate: 'ephemeral-private-hex' }),
    );
    expect(scopePassed).toBe('iad');
    expect(signerPassed).toBe(mockSigner);

    // The rendered share text (selectable ThemedText) must contain invitePrivate —
    // the invitee's only path to reconstruct the ephemeral key and accept (D-06).
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitePrivate');
    expect(rendered).toContain('ephemeral-private-hex');
  });
});

describe('AuthorityInvitationScreen — INV-04/05 (accept mode success-gated navigation)', () => {
  beforeEach(() => {
    mockRouteParams = { mode: 'accept', invitationId: 'invite-1' };
  });

  it('onAccept navigates back on a successful respondToInvite', async () => {
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).toHaveBeenCalledWith('invite-1', true, undefined);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('onAccept does NOT navigate back and sets errorMessage when respondToInvite throws', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('accept rejected by server'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('accept rejected by server');
  });

  it('onDecline navigates back on a successful respondToInvite', async () => {
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'reject').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).toHaveBeenCalledWith('invite-1', false, undefined);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('onDecline does NOT navigate back and sets errorMessage when respondToInvite throws', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('decline rejected by server'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'reject').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('decline rejected by server');
  });
});
