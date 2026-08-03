/**
 * AdministratorInvitationScreen.test.tsx — INV-02/04/05 screen-layer coverage.
 *
 * Phase 39 plan 39-04 (DEBT-09 test-coverage backfill, todo
 * 2026-06-24-inv-02-04-05-test-coverage). No jest coverage previously existed
 * for this screen (21-14 was UAT-only). Scaffolded from
 * RevokeKeyScreen.test.tsx / AuthorityInvitationScreen.test.tsx (same
 * react-test-renderer + mock*-prefixed module slots convention).
 *
 * Pins two invariants (Admin analog of INV-02/04/05):
 *   INV-02 (send mode): onSend calls createOfficerInvite({...}) then
 *     saveInviteWithSigning(invite, 'rad', signer), and the resulting share
 *     text contains the ephemeral invitePrivate (D-05/D-06).
 *   INV-04/05 (accept mode, accept + decline): navigation.goBack() is called
 *     ONLY when respondToInvite resolves; on a thrown/rejected
 *     respondToInvite, goBack is NOT called and errorMessage is set (rendered
 *     by <InlineError>).
 */

import React from 'react';
import renderer from 'react-test-renderer';

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

let mockRouteParams: {
  mode: 'send' | 'accept';
  invitationId?: string;
  authority?: { id: string };
} = { mode: 'send', authority: { id: 'authority-1' } };

const mockCreateOfficerInvite = jest.fn();
const mockSaveInviteWithSigning = jest.fn(async () => {});
const mockAuthorityEngine = {
  createOfficerInvite: mockCreateOfficerInvite,
  saveInviteWithSigning: mockSaveInviteWithSigning,
};

const mockGetNetworkDetails = jest.fn(async () => ({ network: { name: 'Test Network' } }));
const mockNetworkEngine = { getDetails: mockGetNetworkDetails };

const mockRespondToInvite = jest.fn(async () => {});
const mockGetOfficerInvite = jest.fn(async () => undefined);
const mockInvitationEngine = {
  respondToInvite: mockRespondToInvite,
  getOfficerInvite: mockGetOfficerInvite,
};

// getEngine<T>(name, initParams?) — dispatch by engine name; 'authority' is
// keyed by authority.id (AdministratorInvitationScreen passes it as initParams).
const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'network') return mockNetworkEngine;
  if (name === 'invitations') return mockInvitationEngine;
  if (name === 'authority') return mockAuthorityEngine;
  return undefined;
});

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
  useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: jest.fn(async () => ({
    signature: 'sig',
    signerKey: 'device-pub-key',
    signerUserId: 'user-1',
  })),
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
const AdministratorInvitationModule = require('../AdministratorInvitationScreen');
const AdministratorInvitationScreen =
  AdministratorInvitationModule.default ?? AdministratorInvitationModule.AdministratorInvitationScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AdministratorInvitationScreen />);
  });
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
  mockRouteParams = { mode: 'send', authority: { id: 'authority-1' } };
  mockCreateOfficerInvite.mockReturnValue({
    invitePrivate: 'admin-ephemeral-private-hex',
    inviteKey: 'admin-invite-key-hex',
    inviteSignature: 'admin-invite-sig',
    expiration: '2027-01-01T00:00:00.000Z',
    type: 'o',
    name: 'New Officer',
    title: 'Clerk',
  });
  mockSaveInviteWithSigning.mockResolvedValue(undefined);
  mockRespondToInvite.mockResolvedValue(undefined);
});

describe('AdministratorInvitationScreen — INV-02 (send mode real invitePrivate sharing)', () => {
  it('onSend calls createOfficerInvite then saveInviteWithSigning("rad") and the share text contains invitePrivate', async () => {
    const tr = await render();

    await renderer.act(async () => {
      const nameInput = tr.root.findAll(
        (n) => n.props?.title === 'name' && typeof n.props?.onChangeText === 'function',
      )[0];
      nameInput.props.onChangeText('New Officer');
    });
    await renderer.act(async () => {
      const titleInput = tr.root.findAll(
        (n) => n.props?.title === 'title' && typeof n.props?.onChangeText === 'function',
      )[0];
      titleInput.props.onChangeText('Clerk');
    });

    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
      await Promise.resolve();
    });

    expect(mockCreateOfficerInvite).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Officer', title: 'Clerk' }),
    );
    expect(mockSaveInviteWithSigning).toHaveBeenCalledTimes(1);
    const [invitePassed, scopePassed] = mockSaveInviteWithSigning.mock.calls[0];
    expect(invitePassed).toEqual(
      expect.objectContaining({ invitePrivate: 'admin-ephemeral-private-hex' }),
    );
    expect(scopePassed).toBe('rad');

    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitePrivate');
    expect(rendered).toContain('admin-ephemeral-private-hex');
  });
});

describe('AdministratorInvitationScreen — INV-04/05 (accept mode success-gated navigation)', () => {
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
    mockRespondToInvite.mockRejectedValueOnce(new Error('admin accept rejected'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('admin accept rejected');
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
    mockRespondToInvite.mockRejectedValueOnce(new Error('admin decline rejected'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'reject').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('admin decline rejected');
  });
});
