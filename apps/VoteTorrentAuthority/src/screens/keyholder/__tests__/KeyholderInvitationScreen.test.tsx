/**
 * KeyholderInvitationScreen.test.tsx — INV-04/05 screen-layer coverage.
 *
 * Phase 39 plan 39-04 (DEBT-09 test-coverage backfill, todo
 * 2026-06-24-inv-02-04-05-test-coverage). No jest coverage previously existed
 * for this screen (21-14 was UAT-only). Scaffolded from
 * RevokeKeyScreen.test.tsx / AuthorityInvitationScreen.test.tsx (same
 * react-test-renderer + mock*-prefixed module slots convention).
 *
 * KeyholderInvitationScreen's send path (INV-03) calls the un-gated
 * `electionEngine.inviteKeyholder` directly — there is no
 * createXInvite/saveInviteWithSigning device-signer ceremony here (WR-04:
 * no fabricated inviteSignature), so this file covers the shared
 * success-gated-navigation contract only (INV-04/05, accept + decline):
 * navigation.goBack() is called ONLY when respondToInvite resolves; on a
 * thrown/rejected respondToInvite, goBack is NOT called and errorMessage is
 * set (rendered by <InlineError>).
 */

import React from 'react';
import renderer from 'react-test-renderer';

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

const mockRouteParams: { mode: 'send' | 'accept'; invitationId?: string } = {
  mode: 'accept',
  invitationId: 'invite-1',
};

const mockRespondToInvite = jest.fn(async () => {});
const mockGetKeyholderInvite = jest.fn(async () => undefined);
const mockInvitationEngine = {
  respondToInvite: mockRespondToInvite,
  getKeyholderInvite: mockGetKeyholderInvite,
};

const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'invitations') return mockInvitationEngine;
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
const KeyholderInvitationModule = require('../KeyholderInvitationScreen');
const KeyholderInvitationScreen =
  KeyholderInvitationModule.default ?? KeyholderInvitationModule.KeyholderInvitationScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<KeyholderInvitationScreen />);
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
  mockRespondToInvite.mockResolvedValue(undefined);
});

describe('KeyholderInvitationScreen — INV-04/05 (accept mode success-gated navigation)', () => {
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
    mockRespondToInvite.mockRejectedValueOnce(new Error('keyholder accept rejected'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholder accept rejected');
  });

  it('onDecline navigates back on a successful respondToInvite', async () => {
    const tr = await render();

    // KeyholderInvitationScreen's SignatureTaskFooter uses rejectLabel=t("decline").
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).toHaveBeenCalledWith('invite-1', false, undefined);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('onDecline does NOT navigate back and sets errorMessage when respondToInvite throws', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('keyholder decline rejected'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholder decline rejected');
  });
});
