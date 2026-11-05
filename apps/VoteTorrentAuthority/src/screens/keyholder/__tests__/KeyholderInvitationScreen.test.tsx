/**
 * KeyholderInvitationScreen.test.tsx — INV-04/05 screen-layer coverage, extended by Phase 62 Plan
 * 26 (D-21, D-26) for the accept path's keyholder-provisioning behavior (S1-S5).
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
 * success-gated-navigation contract (INV-04/05, accept + decline):
 * navigation.goBack() is called ONLY when the accept/decline resolves; on a
 * thrown/rejected respondToInvite, goBack is NOT called and errorMessage is
 * set (rendered by <InlineError>).
 *
 * 62-26: accept now provisions a fresh keyholder identity (D-21) through
 * `acceptKeyholderInvitation`/`resolveKeyholderKeyVault`, so this file sets a test vault override
 * via `setKeyholderKeyVaultForTests` in `beforeEach`/clears it in `afterEach`, and mocks
 * `../../../engines/device-signer` to prove the officer's device key is never touched by accept.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { Alert, Share } from 'react-native';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { setKeyholderKeyVaultForTests } from '../../../engines/keyholder-vault';
import { InviteShareError } from '../../invitations/invite-share';
import { stashInviteShare } from '../../invitations/invite-share-handoff';

jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: jest.fn(async () => true) }));

function makeShareText(type = 'k', name = 'Ada Keyholder') {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  return {
    invitePrivate,
    text: JSON.stringify({ invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), expiration: 'x', type, name }),
  };
}

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

const mockRouteParams: { mode: 'send' | 'accept'; shareToken?: string; electionEngine?: unknown; keyholder?: unknown } = {
  mode: 'accept',
};

const mockAcceptKeyholderInvitation = jest.fn(async (_deps: unknown, _text: string) => ({ userId: 'u', slotCid: 'cid-1' }));
jest.mock('../keyholder-accept', () => ({
  acceptKeyholderInvitation: (deps: unknown, text: string) => mockAcceptKeyholderInvitation(deps, text),
}));

const mockRespondToInvite = jest.fn(
  async (
    _slotCid: string,
    _accept: boolean,
    _invitePrivate?: string,
    _digest?: string,
    _invokedId?: string,
    _provisioning?: { signingKey: { key: string; type: string; expiration: number }; dkgPublicKey: string; sign: (digest: Uint8Array) => Promise<unknown> }
  ) => {}
);
const mockGetKeyholderInvite = jest.fn(async (_cid: string): Promise<any> => undefined);
const mockResolveInviteSlot = jest.fn(async (_key: string, _type: string): Promise<any> => ({ status: 'live', cid: 'cid-1' }));
const mockInvitationEngine = {
  resolveInviteSlot: mockResolveInviteSlot,
  respondToInvite: mockRespondToInvite,
  getKeyholderInvite: mockGetKeyholderInvite,
};

const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'invitations') return mockInvitationEngine;
  return undefined;
});

const mockCreateDeviceSigner = jest.fn(async (_displayName: string) => jest.fn());

jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: (displayName: string) => mockCreateDeviceSigner(displayName),
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 49-07: device-signer.ts now imports the app's `i18n` singleton (src/i18n/index.ts) at
  // module scope to resolve the native BiometricPrompt's prompt strings, and this screen
  // imports device-signer.ts directly (not mocked, unlike every other createDeviceSigner call
  // site's test — see this file's own header comment on why). `src/i18n/index.ts` calls
  // `i18n.use(initReactI18next).init(...)` at ITS OWN module scope, so this mock must supply a
  // real-shaped plugin object (i18next's actual duck-type contract: `{ type: '3rdParty', init }`
  // — see react-i18next's own initReactI18next.js) or `i18n.use(undefined)` throws before this
  // test file's real assertions ever run.
  initReactI18next: { type: '3rdParty', init: () => {} },
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
const KeyholderInvitationModule = require('../KeyholderInvitationScreen');
const KeyholderInvitationScreen =
  KeyholderInvitationModule.default ?? KeyholderInvitationModule.KeyholderInvitationScreen;

async function paste(tr: renderer.ReactTestRenderer, text: string) {
  const input = tr.root.findAll((n) => typeof n.props?.onChangeText === 'function')[0];
  await renderer.act(async () => {
    input.props.onChangeText(text);
  });
}

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

function makeFakeVault(overrides?: { putSecret?: jest.Mock }) {
  return {
    putSecret: overrides?.putSecret ?? jest.fn(async () => undefined),
    getSecret: jest.fn(async () => null),
    hasSecret: jest.fn(async () => false),
    deleteSecret: jest.fn(async () => true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRespondToInvite.mockResolvedValue(undefined);
  mockResolveInviteSlot.mockResolvedValue({ status: 'live', cid: 'cid-1' });
  // The slot's STORED name is what the screen shows (never the name inside the pasted JSON).
  mockGetKeyholderInvite.mockResolvedValue({ invite: { name: 'Ada Keyholder' }, result: undefined });
  mockAcceptKeyholderInvitation.mockResolvedValue({ userId: 'u', slotCid: 'cid-1' });
  setKeyholderKeyVaultForTests(makeFakeVault() as never);
});

afterEach(() => {
  setKeyholderKeyVaultForTests(undefined);
  mockRouteParams.mode = 'accept';
  delete mockRouteParams.shareToken;
  delete mockRouteParams.electionEngine;
  delete mockRouteParams.keyholder;
});

describe('KeyholderInvitationScreen - paste-first accept mode (no route id)', () => {
  it('labels the paste field once: no duplicate invitationKey heading above the input (UAT 62 K)', async () => {
    const tr = await render();
    const labels = tr.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'invitationKey');
    expect(labels).toHaveLength(1);
  });

  it('renders the paste hint and disabled Accept/Decline before any paste, never Loading', async () => {
    const tr = await render();
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('invitationAcceptPasteHint');
    expect(json).not.toContain('loading');
    expect(json).toContain('invitationAcceptPastePlaceholder');
    expect(json).not.toContain('Paste the invite text from the sender');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(true);
  });

  it('I1 accept mode explains re-accepting below the paste hint (keyholder-reaccept-accept-note)', async () => {
    const tr = await render();
    const note = tr.root.findAll((n) => n.props?.testID === 'keyholder-reaccept-accept-note');
    expect(note.length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderReacceptAcceptNote');
    const json = JSON.stringify(tr.toJSON());
    expect(json.indexOf('invitationAcceptPasteHint')).toBeLessThan(json.indexOf('keyholderReacceptAcceptNote'));
  });

  it('pasting a share shows the slot\'s stored name and enables Accept/Decline', async () => {
    const tr = await render();
    await paste(tr, makeShareText().text);
    const name = tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-name');
    expect(name.length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('Ada Keyholder');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(false);
  });

  it('Accept calls acceptKeyholderInvitation(deps, pastedText) with 2 args and navigates back', async () => {
    const tr = await render();
    const { text } = makeShareText();
    await paste(tr, text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(1);
    expect(mockAcceptKeyholderInvitation.mock.calls[0]).toHaveLength(2);
    expect(mockAcceptKeyholderInvitation.mock.calls[0][1]).toBe(text);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not-found', 'invitationAcceptNotFound'],
    ['wrong-type', 'invitationAcceptWrongType'],
    ['malformed', 'invitationAcceptMalformed'],
    ['no-longer-valid', 'invitationAcceptNoLongerValid'],
  ])('accept failure %s renders mapped copy', async (code, key) => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(new InviteShareError(code as never));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain(key);
  });

  it('auth-denied renders deviceSigningErrorGeneric and not the raw message', async () => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'auth-denied' }));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('deviceSigningErrorGeneric');
    expect(JSON.stringify(tr.toJSON())).not.toContain('nope');
  });

  it('an engine error renders invitationAcceptFailed with no engine text or Cid', async () => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: InviteSlot not found for Cid: abc123'));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('invitationAcceptFailed');
    expect(json).not.toContain('InvitationEngine');
    expect(json).not.toContain('Cid');
  });

  it('Decline resolves the slot then calls respondToInvite(slotCid, false, invitePrivate) with exactly 3 args', async () => {
    const tr = await render();
    const { text, invitePrivate } = makeShareText();
    await paste(tr, text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith('cid-1', false, invitePrivate);
    expect(mockRespondToInvite.mock.calls[0]).toHaveLength(3);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('Decline with an unresolvable share renders not-found copy and does not respond', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'not-found' });
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptNotFound');
  });

  it('Decline of a withdrawn or expired share renders invitationAcceptNoLongerValid with no prompt and no response', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'no-longer-valid' });
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptNoLongerValid');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('Cid');
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockAcceptKeyholderInvitation).not.toHaveBeenCalled();
    expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('Decline failure maps to invitationAcceptFailed', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: boom'));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptFailed');
    expect(JSON.stringify(tr.toJSON())).not.toContain('InvitationEngine');
  });

  it('S5: while an accept is in flight a second press does not start a second accept', async () => {
    let resolveAccept!: () => void;
    mockAcceptKeyholderInvitation.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAccept = () => resolve({ userId: 'u', slotCid: 'cid-1' }); })
    );
    const tr = await render();
    await paste(tr, makeShareText().text);

    let pressPromise!: Promise<void>;
    await renderer.act(async () => {
      pressPromise = buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      resolveAccept();
      await pressPromise;
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('seeds the share from the shareToken route param', async () => {
    mockRouteParams.shareToken = stashInviteShare(makeShareText('k', 'Seeded Name').text);
    mockGetKeyholderInvite.mockResolvedValue({ invite: { name: 'Seeded Name' }, result: undefined });
    try {
      const tr = await render();
      expect(JSON.stringify(tr.toJSON())).toContain('Seeded Name');
      expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
    } finally {
      delete mockRouteParams.shareToken;
    }
  });

  it('B6: accept mode never arms the leave guard', async () => {
    await render();
    expect(mockUsePreventRemove).toHaveBeenCalled();
    expect(mockUsePreventRemove.mock.calls.every((c) => c[0] === false)).toBe(true);
  });
});

describe('KeyholderInvitationScreen - expired share', () => {
  const withExp = (text: string, expiration: string) => JSON.stringify({ ...JSON.parse(text), expiration });

  it('shows the expired notice and disables Accept for a past, Z-less (UTC) expiration; pressing does nothing', async () => {
    const tr = await render();
    await paste(tr, withExp(makeShareText().text, '2020-01-01T00:00:00.000'));
    expect(tr.root.findAll((n) => n.props?.testID === 'invitation-expired-notice').length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptExpired');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockAcceptKeyholderInvitation).not.toHaveBeenCalled();
    expect(mockResolveInviteSlot).not.toHaveBeenCalled();
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
  });

  it('a Z-suffixed past expiration is expired too', async () => {
    const tr = await render();
    await paste(tr, withExp(makeShareText().text, '2020-01-01T00:00:00.000Z'));
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
  });

  it('a future expiration (Z-less) stays acceptable with no notice', async () => {
    const tr = await render();
    await paste(tr, withExp(makeShareText().text, new Date(Date.now() + 3_600_000).toISOString().replace('Z', '')));
    expect(tr.root.findAll((n) => n.props?.testID === 'invitation-expired-notice')).toHaveLength(0);
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
  });
});

describe('KeyholderInvitationScreen - send mode (UAT 62 L, validity presets, invitee binding)', () => {
  const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
  const mockInviteKeyholder = jest.fn(async (..._args: unknown[]) => undefined);
  const mockGetElectionDetails = jest.fn(async (): Promise<any> => ({ election: { id: 'election-1' }, current: { keyholders: [] } }));
  const electionEngine = {
    getElectionDetails: () => mockGetElectionDetails(),
    inviteKeyholder: (...args: unknown[]) => mockInviteKeyholder(...args),
  };
  const invitee = (name: string, accepted = false) => ({ invite: { name }, result: accepted ? { isAccepted: true } : undefined });

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockRouteParams.mode = 'send';
    mockRouteParams.electionEngine = electionEngine;
    mockGetElectionDetails.mockResolvedValue({ election: { id: 'election-1' }, current: { keyholders: [] } });
    mockGetEngine.mockImplementation(async (name: string): Promise<any> => {
      if (name === 'defaultUser') return { get: async () => ({ name: 'Officer' }) };
      if (name === 'invitations') return mockInvitationEngine;
      return undefined;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('I1 send mode does not render the accept note', async () => {
    const tr = await render();
    expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-reaccept-accept-note')).toHaveLength(0);
  });

  const radio = (tr: renderer.ReactTestRenderer, testID: string) =>
    tr.root.findAll((n) => n.props?.testID === testID && n.props?.accessibilityRole === 'radio')[0];
  const press = async (tr: renderer.ReactTestRenderer, testID: string) => {
    await renderer.act(async () => {
      radio(tr, testID).props.onPress();
    });
  };
  const send = async (tr: renderer.ReactTestRenderer) => {
    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
    });
  };
  const nameInputs = (tr: renderer.ReactTestRenderer) => tr.root.findAll((n) => (n.type as unknown) === 'TextInput');
  const sharedPayload = (tr: renderer.ReactTestRenderer) =>
    // The block no longer renders the invite text (BIO-4), so read the payload SHARE / COPY send.
    JSON.parse(tr.root.findAll((n) => n.props?.testIDPrefix === 'keyholder-invitation-share' && typeof n.props?.shareText === 'string')[0].props.shareText);

  it('shows the five validity presets as radios with 24 hours selected', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    const tr = await render();
    for (const h of [1, 12, 24, 72, 168]) expect(radio(tr, `keyholder-invite-expiry-${h}`)).toBeDefined();
    expect(radio(tr, 'keyholder-invite-expiry-24').props.accessibilityState.selected).toBe(true);
    expect(radio(tr, 'keyholder-invite-expiry-168').props.accessibilityState.selected).toBe(false);
  });

  it('default send carries now + 24 h in the call and the share; the free-text name field is gone', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    const tr = await render();
    expect(nameInputs(tr)).toHaveLength(0);
    expect(JSON.stringify(tr.toJSON())).toContain('Kay Holder');
    await send(tr);
    const expected = new Date(NOW + 24 * 3_600_000).toISOString();
    expect((mockInviteKeyholder.mock.calls[0]![0] as { expiration: string; name: string }).expiration).toBe(expected);
    expect((mockInviteKeyholder.mock.calls[0]![0] as { name: string }).name).toBe('Kay Holder');
    const payload = sharedPayload(tr);
    expect(payload.name).toBe('Kay Holder');
    expect(payload.expiration).toBe(expected);
    expect(payload.invitePrivate).toMatch(/^[0-9a-f]{64}$/);
    expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-share-share').length).toBeGreaterThan(0);
    expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-share-copy').length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderInviteExpiresAt');
  });

  it('WR-R3-08: a double tap on Send in one frame mints one invitation slot', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    const tr = await render();
    const onPress = buttonByTitle(tr, 'send').props.onPress;
    await renderer.act(async () => {
      await Promise.all([onPress(), onPress()]);
    });
    expect(mockInviteKeyholder).toHaveBeenCalledTimes(1);
    expect(sharedPayload(tr).name).toBe('Kay Holder');
  });

  it('WR-R3-08: the Send latch is released after a failed send, so Send works again', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    mockInviteKeyholder.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await send(tr);
    expect(mockInviteKeyholder).toHaveBeenCalledTimes(1);
    await send(tr);
    expect(mockInviteKeyholder).toHaveBeenCalledTimes(2);
    expect(sharedPayload(tr).name).toBe('Kay Holder');
  });

  it('choosing 7 days sends now + 168 h', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    const tr = await render();
    await press(tr, 'keyholder-invite-expiry-168');
    await send(tr);
    const expected = new Date(NOW + 168 * 3_600_000).toISOString();
    expect((mockInviteKeyholder.mock.calls[0]![0] as { expiration: string }).expiration).toBe(expected);
    expect(sharedPayload(tr).expiration).toBe(expected);
  });

  it('never calls resendInvite', async () => {
    // REVIEW WR-R5-08: resendInvite lives on the AUTHORITY engine (vote-core IAuthorityEngine), not on
    // the invitations engine, so a spy planted there could never fire. Instead every engine the
    // screen can reach (anything getEngine returns, under any name, and the route's electionEngine)
    // is wrapped so that reading any resend-like member is recorded, and the send must touch none.
    const touched: string[] = [];
    const RESEND = /resend/i;
    const watch = (label: string, target: object): object =>
      new Proxy(target, {
        get(t, prop, receiver) {
          if (typeof prop === 'string' && RESEND.test(prop)) {
            touched.push(`${label}.${prop}`);
            return jest.fn();
          }
          return Reflect.get(t, prop, receiver);
        },
      });
    const realGetEngine = mockGetEngine.getMockImplementation()!;
    mockGetEngine.mockImplementation(async (name: string): Promise<any> => {
      const engine = await realGetEngine(name);
      // An engine this harness does not provide is still a place a resend could be sought.
      return watch(name, (engine as object | undefined) ?? {});
    });
    mockRouteParams.electionEngine = watch('electionEngine', electionEngine);
    try {
      mockRouteParams.keyholder = invitee('Kay Holder');
      const tr = await render();
      await send(tr);
      expect(mockInviteKeyholder).toHaveBeenCalledTimes(1);
      expect(mockGetEngine).toHaveBeenCalled();
      expect(touched).toEqual([]);
    } finally {
      mockGetEngine.mockImplementation(realGetEngine);
      mockRouteParams.electionEngine = electionEngine;
    }
  });

  it('without a keyholder param lists only pending invitees; Send waits for a choice', async () => {
    mockGetElectionDetails.mockResolvedValue({
      election: { id: 'election-1' },
      current: { keyholders: [invitee('Alice', true), invitee('Bob'), invitee('Cara')] },
    });
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderInvitePickInvitee');
    expect(radio(tr, 'keyholder-invite-invitee-Alice')).toBeUndefined();
    expect(radio(tr, 'keyholder-invite-invitee-Bob')).toBeDefined();
    expect(buttonByTitle(tr, 'send').props.disabled).toBe(true);
    await press(tr, 'keyholder-invite-invitee-Cara');
    expect(buttonByTitle(tr, 'send').props.disabled).toBe(false);
    await send(tr);
    expect((mockInviteKeyholder.mock.calls[0]![0] as { name: string }).name).toBe('Cara');
  });

  it('with nobody pending shows the empty copy and no Send', async () => {
    mockGetElectionDetails.mockResolvedValue({ election: { id: 'election-1' }, current: { keyholders: [invitee('Alice', true)] } });
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholderInviteNoPendingInvitees');
    expect(buttonByTitle(tr, 'send')).toBeUndefined();
  });

  it('invite-expiration-out-of-range renders its copy and no engine text', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    mockInviteKeyholder.mockRejectedValueOnce(Object.assign(new Error('raw engine text'), { code: 'invite-expiration-out-of-range' }));
    const tr = await render();
    await send(tr);
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('keyholderInviteExpiryOutOfRange');
    expect(json).not.toContain('raw engine text');
  });

  it('any other send failure renders keyholderInviteSendFailed, never the raw message', async () => {
    mockRouteParams.keyholder = invitee('Kay Holder');
    mockInviteKeyholder.mockRejectedValueOnce(new Error('raw engine text'));
    const tr = await render();
    await send(tr);
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('keyholderInviteSendFailed');
    expect(json).not.toContain('raw engine text');
  });

  const sendKh = (tr: renderer.ReactTestRenderer) => send(tr);

  describe('leave guard (unshared invite)', () => {
    let alertSpy: jest.SpyInstance;
    beforeEach(() => {
      alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
      mockRouteParams.keyholder = invitee('Kay Holder');
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
      const tr = await render();
      expect(lastPrevent()).toBe(false);
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('B2: after Send, Back raises the confirm Alert and the screen stays', async () => {
      const tr = await render();
      await sendKh(tr);
      expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-share-ready').length).toBeGreaterThan(0);
      pressBack();
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toBe('inviteLeaveUnsharedTitle');
      expect(mockGoBack).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-share-ready').length).toBeGreaterThan(0);
    });

    it('B3: the destructive button dispatches the blocked GO_BACK', async () => {
      const tr = await render();
      await sendKh(tr);
      pressBack();
      const leave = leaveButtons().find((b) => b.style === 'destructive')!;
      leave.onPress!();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
    });

    it('B4: after a confirmed Copy, Back pops with no Alert', async () => {
      const tr = await render();
      await sendKh(tr);
      await tap(tr, 'keyholder-invitation-share-copy');
      expect(mockCopyToClipboard).toHaveBeenCalledTimes(1);
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('B5: after a Share that resolves sharedAction, Back pops with no Alert', async () => {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as never);
      const tr = await render();
      await sendKh(tr);
      await tap(tr, 'keyholder-invitation-share-share');
      pressBack();
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      expect(alertSpy).not.toHaveBeenCalled();
    });
  });
});

describe('KeyholderInvitationScreen - hardened accept (stored name, masked share, latch)', () => {
  const textInputs = (tr: renderer.ReactTestRenderer) => tr.root.findAll((n) => String(n.type) === 'TextInput');
  const coded = (code: string) => Object.assign(new Error('engine text'), { code });
  let share!: { invitePrivate: string; text: string };

  beforeEach(() => {
    share = makeShareText('k', 'Mallory');
    mockRouteParams.shareToken = stashInviteShare(share.text);
    mockGetKeyholderInvite.mockResolvedValue({ invite: { name: 'Kay Two' }, result: undefined });
  });

  it('gap6/WR-06: shows the name STORED on the slot, never the name in the pasted JSON', async () => {
    const tr = await render();
    const name = tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-name' && typeof n.props?.children === 'string');
    expect(name[0].props.children).toBe('Kay Two');
    expect(JSON.stringify(tr.toJSON())).not.toContain('Mallory');
    expect(mockGetKeyholderInvite).toHaveBeenCalledWith('cid-1');
  });

  it('gap6/WR-06: a raw-hex share keeps the paste hint and a disabled footer until the slot resolves', async () => {
    mockRouteParams.shareToken = stashInviteShare(share.invitePrivate);
    let release!: (v: unknown) => void;
    mockResolveInviteSlot.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptPasteHint');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(true);
    await renderer.act(async () => {
      release({ status: 'live', cid: 'cid-1' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(JSON.stringify(tr.toJSON())).toContain('Kay Two');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
  });

  it('gap6/WR-05: opened with a shareToken shows only the summary; no field or param holds the private key', async () => {
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationPastedSummary');
    expect(JSON.stringify(tr.toJSON())).not.toContain(share.invitePrivate);
    expect(textInputs(tr).filter((n) => String(n.props.value ?? '').includes(share.invitePrivate))).toHaveLength(0);
    expect(navigationLeaks(share.invitePrivate)).toEqual([]);
  });

  it('Decline: a double tap sends one respondToInvite', async () => {
    let release!: () => void;
    mockRespondToInvite.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const tr = await render();
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    await renderer.act(async () => {
      a = buttonByTitle(tr, 'decline').props.onPress();
      b = buttonByTitle(tr, 'decline').props.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(true);
    await renderer.act(async () => {
      release();
      await Promise.all([a, b]);
    });
    expect(mockRespondToInvite).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['self-invite', 'keyholderAcceptSelfInvite'],
    ['seat-already-held', 'keyholderAcceptSeatHeld'],
    ['invite-superseded', 'invitationAcceptSuperseded'],
  ])('Accept refusal coded %s renders %s', async (code, key) => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(coded(code));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain(key);
    expect(json).not.toContain('engine text');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('Decline refusal coded invite-superseded renders invitationAcceptSuperseded', async () => {
    mockRespondToInvite.mockRejectedValueOnce(coded('invite-superseded'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptSuperseded');
  });

  it('send mode renders the Send button for a fixed invitee', async () => {
    mockRouteParams.mode = 'send';
    mockRouteParams.keyholder = { invite: { name: 'Kay Holder' } };
    const tr = await render();
    expect(buttonByTitle(tr, 'send')).toBeDefined();
  });
});
