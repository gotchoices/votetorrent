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
import { Alert, Share, StyleSheet } from 'react-native';
import { globalStyles } from '../../../theme/styles';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { stashInviteShare } from '../../invitations/invite-share-handoff';

// ---------------------------------------------------------------------------
// Mutable module-level slots (prefixed `mock` so jest.mock factories may
// reference them per the jest babel transform's hoist-safe naming rule).
// ---------------------------------------------------------------------------
function makeShare(type: string) {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  return {
    invitePrivate,
    text: JSON.stringify({ invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), expiration: 'x', type, name: 'Invitee' }),
  };
}
const mockResolveInviteSlot = jest.fn(async (_key: string, _type: string): Promise<any> => ({ status: 'live', cid: 'slot-cid-1' }));

const mockGoBack = jest.fn();
// Every navigation call the screen can make is recorded, so "no param holds the private key" is
// checked against what the SCREEN writes (setParams, onward navigation), not against the route
// params only this test writes (REVIEW WR-R5-09).
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockDispatch = jest.fn();
const mockUsePreventRemove = jest.fn();
const mockCopyToClipboard = jest.fn(async (_text: string) => true);
jest.mock('../../../utils/copyToClipboard', () => ({ copyToClipboard: (text: string) => mockCopyToClipboard(text) }));
/** What the stack does on Back: run the guard callback when it is armed, otherwise pop. */
function pressBack() {
  const calls = mockUsePreventRemove.mock.calls;
  const [prevent, cb] = calls[calls.length - 1];
  if (prevent) {
    renderer.act(() => {
      cb({ data: { action: { type: 'GO_BACK' } } });
    });
  } else {
    mockGoBack();
  }
}
function lastPrevent(): boolean {
  const calls = mockUsePreventRemove.mock.calls;
  return calls[calls.length - 1][0];
}
function leaveButtons(): Array<{ text: string; style?: string; onPress?: () => void }> {
  const calls = (Alert.alert as jest.Mock).mock.calls;
  return calls[calls.length - 1][2];
}
/** Navigation calls whose arguments carry a 64-hex secret or the given private key. */
function navigationLeaks(invitePrivate: string): string[] {
  const out: string[] = [];
  const all: Array<[string, jest.Mock]> = [
    ['navigate', mockNavigate],
    ['setParams', mockSetParams],
    ['replace', mockReplace],
    ['push', mockPush],
    ['dispatch', mockDispatch],
  ];
  for (const [name, fn] of all) {
    for (const call of fn.mock.calls) {
      const text = JSON.stringify(call) ?? '';
      if (/[0-9a-f]{64}/i.test(text) || text.includes(invitePrivate)) out.push(`${name}: ${text.slice(0, 120)}`);
    }
  }
  return out;
}
const mockSetOptions = jest.fn();

let mockRouteParams: { mode: 'send' | 'accept'; shareToken?: string } = { mode: 'send' };

// Signer echoes nothing meaningful — INV-02 only asserts on the CALL, not the
// signature bytes (that binding is covered engine-side).
const mockSigner = jest.fn(async () => ({
  signature: 'sig',
  signerKey: 'device-pub-key',
  signerUserId: 'user-1',
}));

const mockCreateAuthorityInvite = jest.fn();
const mockSaveInviteWithSigning = jest.fn(async (..._args: any[]) => {});
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
const mockGetAuthorityInvite = jest.fn(async (_cid: string): Promise<any> => undefined);
const mockInvitationEngine = {
  resolveInviteSlot: mockResolveInviteSlot,
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
jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: jest.fn(async () => true) }));

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
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').useEffect(cb, [cb]);
  },
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: mockNavigate,
    setOptions: mockSetOptions,
    setParams: mockSetParams,
    replace: mockReplace,
    push: mockPush,
    dispatch: mockDispatch,
  }),
  usePreventRemove: (prevent: boolean, cb: (e: unknown) => void) => mockUsePreventRemove(prevent, cb),
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
  it('WR-R3-08: a double tap on Send in one frame saves one invitation', async () => {
    const tr = await render();
    await renderer.act(async () => {
      const nameInput = tr.root.findAll(
        (n) => n.props?.title === 'name' && typeof n.props?.onChangeText === 'function',
      )[0];
      nameInput.props.onChangeText('New Name');
    });
    const onPress = buttonByTitle(tr, 'send').props.onPress;
    await renderer.act(async () => {
      await Promise.all([onPress(), onPress()]);
    });
    expect(mockSaveInviteWithSigning).toHaveBeenCalledTimes(1);
  });

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

    // The share payload (what SHARE / COPY send) must carry invitePrivate — the invitee's only path
    // to reconstruct the ephemeral key and accept (D-06) — but the screen must never show it (BIO-4).
    const block = tr.root.findAll((n) => n.props?.testIDPrefix === 'authority-invitation-share' && typeof n.props?.shareText === 'string')[0];
    expect(block.props.shareText).toContain('invitePrivate');
    expect(block.props.shareText).toContain('ephemeral-private-hex');
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('invitePrivate');
    expect(rendered).not.toContain('ephemeral-private-hex');
  });

  const sendAuthority = async (tr: renderer.ReactTestRenderer) => {
    await renderer.act(async () => {
      tr.root.findAll((n) => n.props?.title === 'name' && typeof n.props?.onChangeText === 'function')[0].props.onChangeText('New Authority');
    });
    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
      await Promise.resolve();
    });
  };

  describe('leave guard (unshared invite)', () => {
    let alertSpy: jest.SpyInstance;
    beforeEach(() => {
      alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
      mockCopyToClipboard.mockResolvedValue(true);
    });
    afterEach(() => {
      alertSpy.mockRestore();
    });
    const tap = async (tr: renderer.ReactTestRenderer, id: string) => {
      const b = tr.root.findAll((n) => n.props?.testID === id && typeof n.props?.onPress === 'function')[0];
      await renderer.act(async () => {
        await b.props.onPress();
      });
    };

    it('B1: before Send, Back pops with no Alert', async () => {
      await render();
      expect(lastPrevent()).toBe(false);
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('B2: after Send, Back raises the confirm Alert and the screen stays', async () => {
      const tr = await render();
      await sendAuthority(tr);
      expect(tr.root.findAll((n) => n.props?.testID === 'authority-invitation-share-ready').length).toBeGreaterThan(0);
      pressBack();
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toBe('inviteLeaveUnsharedTitle');
      expect(mockGoBack).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(tr.root.findAll((n) => n.props?.testID === 'authority-invitation-share-ready').length).toBeGreaterThan(0);
    });

    it('B3: the destructive button dispatches the blocked GO_BACK', async () => {
      const tr = await render();
      await sendAuthority(tr);
      pressBack();
      const leave = leaveButtons().find((b) => b.style === 'destructive')!;
      leave.onPress!();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    });

    it('B4: after a confirmed Copy, Back pops with no Alert', async () => {
      const tr = await render();
      await sendAuthority(tr);
      await tap(tr, 'authority-invitation-share-copy');
      expect(mockCopyToClipboard).toHaveBeenCalledTimes(1);
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('B5: after a Share that resolves sharedAction, Back pops with no Alert', async () => {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as never);
      const tr = await render();
      await sendAuthority(tr);
      await tap(tr, 'authority-invitation-share-share');
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });
});

describe('AuthorityInvitationScreen - accept mode resolves the slot from the paste', () => {
  const SLOT = 'slot-cid-1';
  let share!: { invitePrivate: string; text: string };
  beforeEach(() => {
    share = makeShare('au');
    mockRouteParams = { mode: 'accept', shareToken: stashInviteShare(share.text) };
    mockResolveInviteSlot.mockResolvedValue({ status: 'live', cid: SLOT });
    mockGetAuthorityInvite.mockResolvedValue({ invite: { name: 'Invitee' } });
  });

  it('resolves by (InviteKey, au), loads the invite from the resolved Cid, and accept signs with it', async () => {
    const tr = await render();
    expect(mockResolveInviteSlot).toHaveBeenCalledWith(expect.any(String), 'au');
    expect(mockGetAuthorityInvite).toHaveBeenCalledWith(SLOT);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith(SLOT, true, share.invitePrivate);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('decline signs with the resolved Cid and navigates back', async () => {
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'reject').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith(SLOT, false, share.invitePrivate);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('a respondToInvite failure maps to invitationAcceptFailed, shows no engine text, does not navigate', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: InviteSlot not found for Cid: x'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(rendered).toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('Cid');
  });

  it('the refusal copy renders inside the screen padding, not flush at x=0 (UAT gap 4 item 6)', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const wrapper = tr.root.findByProps({ testID: 'authority-invitation-error' });
    const style = StyleSheet.flatten(wrapper.props.style);
    expect(style.paddingHorizontal).toBe(globalStyles.container.padding);
    // the copy itself is a descendant of the padded wrapper
    const texts = wrapper.findAll((n) => n.props?.children === 'invitationAcceptFailed');
    expect(texts.length).toBeGreaterThan(0);
  });

  it('not-found renders invitationAcceptNotFound and never navigates', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'not-found' });
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptNotFound');
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a withdrawn or expired share renders invitationAcceptNoLongerValid, disables accept and reject, and never signs', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'no-longer-valid' });
    const tr = await render();
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptNoLongerValid');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('Cid');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'reject').props.disabled).toBe(true);
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('an engine-side refusal that races past the helper renders the generic failure copy, not the engine text', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: This invitation was withdrawn or has expired'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('withdrawn');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a share of another type renders invitationAcceptWrongType and never signs', async () => {
    mockRouteParams = { mode: 'accept', shareToken: stashInviteShare(makeShare('k').text) };
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptWrongType');
    expect(mockRespondToInvite).not.toHaveBeenCalled();
  });

  it('with no paste, accept and reject are disabled and the paste hint shows', async () => {
    mockRouteParams = { mode: 'accept' };
    const tr = await render();
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'reject').props.disabled).toBe(true);
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptPasteHint');
    expect(rendered).not.toContain('"loading"');
  });

  it('uses the shared paste placeholder, not hardcoded English', async () => {
    mockRouteParams = { mode: 'accept' };
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptPastePlaceholder');
  });

  it('labels the paste field once: no duplicate invitationKey heading above the input (UAT 62 K)', async () => {
    const tr = await render();
    const labels = tr.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'invitationKey');
    expect(labels).toHaveLength(1);
  });
});

describe('AuthorityInvitationScreen - expired share', () => {
  const withExp = (text: string, expiration: string) => JSON.stringify({ ...JSON.parse(text), expiration });

  it('shows the expired notice and disables Accept for a past, Z-less (UTC) expiration; no lookup, no signing', async () => {
    mockRouteParams = { mode: 'accept', shareToken: stashInviteShare(withExp(makeShare('au').text, '2020-01-01T00:00:00.000')) };
    const tr = await render();
    expect(tr.root.findAll((n) => n.props?.testID === 'invitation-expired-notice').length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptExpired');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockResolveInviteSlot).not.toHaveBeenCalled();
    expect(mockGetAuthorityInvite).not.toHaveBeenCalled();
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a future expiration (Z-less) still resolves and stays acceptable', async () => {
    mockRouteParams = { mode: 'accept', shareToken: stashInviteShare(withExp(makeShare('au').text, new Date(Date.now() + 3_600_000).toISOString().replace('Z', ''))) };
    mockGetAuthorityInvite.mockResolvedValue({ invite: { name: 'Invitee', title: 'Clerk', scopes: [] } });
    mockResolveInviteSlot.mockResolvedValue({ status: 'live', cid: 'slot-cid-1' });
    const tr = await render();
    expect(tr.root.findAll((n) => n.props?.testID === 'invitation-expired-notice')).toHaveLength(0);
    expect(mockResolveInviteSlot).toHaveBeenCalled();
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
  });
});

describe('AuthorityInvitationScreen - create mode error placement (UAT gap 4 item 6)', () => {
  it('the name-required error renders inside the screen padding', async () => {
    mockRouteParams = { mode: 'send' };
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
      await Promise.resolve();
    });
    const wrapper = tr.root.findByProps({ testID: 'authority-invitation-error' });
    expect(StyleSheet.flatten(wrapper.props.style).paddingHorizontal).toBe(globalStyles.container.padding);
    expect(JSON.stringify(tr.toJSON())).toContain('errAuthorityNameRequired');
  });
});

describe('AuthorityInvitationScreen - hardened accept (masked share, press-time resolve, latch, honest copy)', () => {
  const SLOT = 'slot-cid-1';
  const originalGetEngine = mockGetEngine.getMockImplementation() as any;
  let share!: { invitePrivate: string; text: string };
  const coded = (code: string) => Object.assign(new Error('engine text'), { code });
  const textInputs = (tr: renderer.ReactTestRenderer) => tr.root.findAll((n) => String(n.type) === 'TextInput');
  const byTestId = (tr: renderer.ReactTestRenderer, id: string) =>
    tr.root.findAll((n) => n.props?.testID === id && typeof n.props?.onPress === 'function')[0];
  const press = async (tr: renderer.ReactTestRenderer, title: string) => {
    await renderer.act(async () => {
      await buttonByTitle(tr, title).props.onPress();
      await Promise.resolve();
    });
  };
  beforeEach(() => {
    share = makeShare('au');
    mockRouteParams = { mode: 'accept', shareToken: stashInviteShare(share.text) };
    mockResolveInviteSlot.mockResolvedValue({ status: 'live', cid: SLOT });
    mockGetAuthorityInvite.mockResolvedValue({ invite: { name: 'Invitee', title: 'Clerk', scopes: [] } });
  });
  afterEach(() => {
    mockGetEngine.mockImplementation(originalGetEngine);
  });

  it('opened with a shareToken: loads the share, shows only the summary, no field or param holds the private key', async () => {
    const tr = await render();
    expect(mockResolveInviteSlot).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tr.toJSON())).toContain('invitationPastedSummary');
    expect(textInputs(tr).filter((n) => String(n.props.value ?? '').includes(share.invitePrivate))).toHaveLength(0);
    expect(JSON.stringify(tr.toJSON())).not.toContain(share.invitePrivate);
    expect(navigationLeaks(share.invitePrivate)).toEqual([]);
    expect(mockGetAuthorityInvite).toHaveBeenCalledTimes(1);
  });

  it('gap7/WR-01: accept re-resolves at press time so a resend made while open is answered on the new head', async () => {
    mockResolveInviteSlot.mockReset();
    mockResolveInviteSlot.mockResolvedValueOnce({ status: 'live', cid: 'head-A' }).mockResolvedValue({ status: 'live', cid: 'head-B' });
    const tr = await render();
    await press(tr, 'accept');
    expect(mockRespondToInvite).toHaveBeenCalledWith('head-B', true, share.invitePrivate);
  });

  it.each([
    ['invite-no-longer-valid', 'invitationAcceptNoLongerValid'],
    ['invite-superseded', 'invitationAcceptSuperseded'],
    ['invite-already-answered', 'invitationAcceptAlreadyAnswered'],
  ])('a respondToInvite refusal coded %s renders %s', async (code, key) => {
    mockRespondToInvite.mockRejectedValueOnce(coded(code));
    const tr = await render();
    await press(tr, 'accept');
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain(key);
    expect(rendered).not.toContain('engine text');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('gap6/IN-04: a double tap sends one respondToInvite and the footer is disabled while it is in flight', async () => {
    let release!: () => void;
    mockRespondToInvite.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const tr = await render();
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await renderer.act(async () => {
      first = buttonByTitle(tr, 'accept').props.onPress();
      second = buttonByTitle(tr, 'accept').props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    await renderer.act(async () => {
      release();
      await Promise.all([first, second]);
    });
    expect(mockRespondToInvite).toHaveBeenCalledTimes(1);
  });

  it('gap9/IN-08: a stale error is cleared when an expired share is pasted after Clear', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await press(tr, 'accept');
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptFailed');
    await renderer.act(async () => {
      byTestId(tr, 'authority-invitation-paste-clear').props.onPress();
    });
    expect(JSON.stringify(tr.toJSON())).not.toContain('invitationAcceptFailed');
    const expired = JSON.stringify({ ...JSON.parse(makeShare('au').text), expiration: '2020-01-01T00:00:00.000' });
    await renderer.act(async () => {
      tr.root.findAll((n) => n.props?.testID === 'authority-invitation-paste-input' && typeof n.props?.onChangeText === 'function')[0].props.onChangeText(expired);
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('invitationAcceptFailed');
    expect(rendered).toContain('invitationAcceptExpired');
  });

  // REVIEW WR-R5-07: the check above is satisfied by Clear alone. These put the stale error in place
  // AT the moment of the next paste (the field's value replaced while the error shows), so only the
  // paste effect itself can clear it.
  const pasteField = (tr: renderer.ReactTestRenderer) =>
    tr.root.findAll((n) => n.props?.testIDPrefix === 'authority-invitation-paste' && typeof n.props?.onChangeText === 'function')[0];

  it('gap9/IN-08: an expired share pasted while a stale error shows clears it and shows only the expired notice', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await press(tr, 'accept');
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptFailed');
    const expired = JSON.stringify({ ...JSON.parse(makeShare('au').text), expiration: '2020-01-01T00:00:00.000' });
    await renderer.act(async () => {
      pasteField(tr).props.onChangeText(expired);
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('invitationAcceptFailed');
    expect(rendered).toContain('invitationAcceptExpired');
  });

  it('gap9/IN-08: a parse-failing paste while a stale error shows clears it, and a following expired share keeps it clear', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await press(tr, 'accept');
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptFailed');
    await renderer.act(async () => {
      pasteField(tr).props.onChangeText('not a share');
    });
    let rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('invitationAcceptExpired');
    const expired = JSON.stringify({ ...JSON.parse(makeShare('au').text), expiration: '2020-01-01T00:00:00.000' });
    await renderer.act(async () => {
      pasteField(tr).props.onChangeText(expired);
    });
    rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('invitationAcceptFailed');
    expect(rendered).toContain('invitationAcceptExpired');
  });

  it('gap6/IN-03: a non-share load failure shows the load copy, not "could not respond"', async () => {
    mockResolveInviteSlot.mockRejectedValue(new Error('disk exploded'));
    const tr = await render();
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationLoadFailed');
    expect(rendered).not.toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('disk exploded');
  });

  it('gap6/IN-03: the no-network error shows invitationNeedsNetwork', async () => {
    mockGetEngine.mockImplementation(async (name: string) => {
      if (name === 'invitations') throw Object.assign(new Error('no network'), { noNetworkEstablished: true });
      return originalGetEngine(name);
    });
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationNeedsNetwork');
  });
});
