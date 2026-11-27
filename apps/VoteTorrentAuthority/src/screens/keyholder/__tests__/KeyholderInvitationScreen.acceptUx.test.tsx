/**
 * KeyholderInvitationScreen accept UX (iPhone 13 and Redmi 8, 24 Nov 2026): Accept gave no feedback
 * for tens of seconds; Accept and Decline stayed grey with no explanation while the invitation was
 * looked up (sender's phone offline, and again after a failed accept until an app restart); and a
 * failure showed only the generic copy with an `Error` class in the log.
 *
 * Covers: the busy footer and the success confirmation, the lookup spinner and its timeout notice,
 * Try Again re-running the lookup, each failure class's copy, the scrubbed log line, and recovery
 * after a failed accept with a hung first lookup. Fake timers throughout.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { setKeyholderKeyVaultForTests } from '../../../engines/keyholder-vault';
import { INVITE_LOOKUP_TIMEOUT_MS, InviteShareError } from '../../invitations/invite-share';
import { INVITE_RESPONSE_SLOW_MS } from '../../invitations/useInviteLookup';

jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: jest.fn(async () => true) }));

function makeShare() {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  const text = JSON.stringify({ invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), expiration: 'x', type: 'k', name: 'Ada' });
  return { invitePrivate, text };
}

const mockGoBack = jest.fn();
const mockShowToast = jest.fn();
jest.mock('../../../components/Toast', () => ({ useToast: () => mockShowToast }));

const mockRouteParams: { mode: 'accept' } = { mode: 'accept' };

const mockAcceptKeyholderInvitation = jest.fn(async (_deps: unknown, _text: string): Promise<unknown> => ({ userId: 'u', slotCid: 'cid-1' }));
jest.mock('../keyholder-accept', () => ({
  acceptKeyholderInvitation: (deps: unknown, text: string) => mockAcceptKeyholderInvitation(deps, text),
}));

const mockRespondToInvite = jest.fn(async (..._args: unknown[]): Promise<void> => undefined);
const mockGetKeyholderInvite = jest.fn(async (_cid: string): Promise<any> => ({ invite: { name: 'Kay Holder' }, result: undefined }));
const mockResolveInviteSlot = jest.fn(async (_key: string, _type: string): Promise<any> => ({ status: 'live', cid: 'cid-1' }));
const mockGetEngine = jest.fn(async (name: string) =>
  name === 'invitations'
    ? { resolveInviteSlot: mockResolveInviteSlot, respondToInvite: mockRespondToInvite, getKeyholderInvite: mockGetKeyholderInvite }
    : undefined
);

jest.mock('../../../engines/device-signer', () => ({ createDeviceSigner: jest.fn() }));
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock('../../../providers/AppProvider', () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: { primary: '#P', background: '#B', card: '#C', text: '#T', border: '#BO', error: '#E', textSecondary: '#S', success: '#SU', warning: '#W' },
  }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').useEffect(cb, [cb]);
  },
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: jest.fn(), setParams: jest.fn(), dispatch: jest.fn() }),
  usePreventRemove: () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mod = require('../KeyholderInvitationScreen');
const KeyholderInvitationScreen = Mod.default ?? Mod.KeyholderInvitationScreen;

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const hang = () => new Promise<never>(() => undefined);

async function flush() {
  await renderer.act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function advance(ms: number) {
  await renderer.act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

async function mount() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<KeyholderInvitationScreen />);
  });
  await flush();
  return tr;
}
async function paste(tr: renderer.ReactTestRenderer, text: string) {
  const input = tr.root.findAll((n) => typeof n.props?.onChangeText === 'function')[0];
  await renderer.act(async () => {
    input.props.onChangeText(text);
  });
  await flush();
}

const json = (tr: renderer.ReactTestRenderer) => JSON.stringify(tr.toJSON());
const has = (tr: renderer.ReactTestRenderer, testID: string) => tr.root.findAll((n) => n.props?.testID === testID).length > 0;
function footer(tr: renderer.ReactTestRenderer, which: 'accept' | 'reject') {
  return tr.root.findAll(
    (n) => n.props?.testID === `signature-task-footer-${which}` && typeof n.props?.title === 'string' && typeof n.props?.onPress === 'function'
  )[0];
}
/** Press a footer button; `done` settles when its handler does (boxed, so awaiting press never waits on it). */
async function press(tr: renderer.ReactTestRenderer, which: 'accept' | 'reject'): Promise<{ done: Promise<void> }> {
  let p!: Promise<void>;
  await renderer.act(async () => {
    p = footer(tr, which).props.onPress();
  });
  await flush();
  return { done: p };
}
async function pressRetry(tr: renderer.ReactTestRenderer) {
  const b = tr.root.findAll((n) => n.props?.testID === 'invite-lookup-retry' && typeof n.props?.onPress === 'function')[0];
  await renderer.act(async () => {
    b.props.onPress();
  });
  await flush();
}

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockResolveInviteSlot.mockImplementation(async () => ({ status: 'live', cid: 'cid-1' }));
  mockGetKeyholderInvite.mockImplementation(async () => ({ invite: { name: 'Kay Holder' }, result: undefined }));
  mockAcceptKeyholderInvitation.mockImplementation(async () => ({ userId: 'u', slotCid: 'cid-1' }));
  mockRespondToInvite.mockImplementation(async () => undefined);
  setKeyholderKeyVaultForTests({ putSecret: jest.fn(), getSecret: jest.fn(), hasSecret: jest.fn(), deleteSecret: jest.fn() } as never);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setKeyholderKeyVaultForTests(undefined);
  warn.mockRestore();
  jest.useRealTimers();
});

describe('busy state and confirmation', () => {
  it('Accept shows Accepting with a spinner, keeps both buttons off, says it is still working, then confirms', async () => {
    const accept = deferred<unknown>();
    mockAcceptKeyholderInvitation.mockImplementationOnce(() => accept.promise);
    const tr = await mount();
    await paste(tr, makeShare().text);
    expect(footer(tr, 'accept').props.disabled).toBe(false);

    const pressed = await press(tr, 'accept');
    expect(footer(tr, 'accept').props.title).toBe('acceptingBusy');
    expect(has(tr, 'signature-task-footer-accept-busy')).toBe(true);
    expect(footer(tr, 'accept').props.disabled).toBe(true);
    expect(footer(tr, 'reject').props.disabled).toBe(true);
    // a second tap does not start a second accept
    await press(tr, 'accept');
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(1);

    expect(has(tr, 'keyholder-invitation-answer-slow')).toBe(false);
    await advance(INVITE_RESPONSE_SLOW_MS);
    expect(has(tr, 'keyholder-invitation-answer-slow')).toBe(true);
    // the write is never abandoned: still busy long after the lookup timeout
    await advance(INVITE_LOOKUP_TIMEOUT_MS * 4);
    expect(footer(tr, 'accept').props.title).toBe('acceptingBusy');
    expect(mockGoBack).not.toHaveBeenCalled();

    await renderer.act(async () => {
      accept.resolve({ userId: 'u', slotCid: 'cid-1' });
      await pressed.done;
    });
    expect(mockShowToast).toHaveBeenCalledWith('keyholderAcceptSuccess', { testID: 'keyholder-accept-success' });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('Decline shows Declining with a spinner, then confirms', async () => {
    const respond = deferred<void>();
    mockRespondToInvite.mockImplementationOnce(() => respond.promise);
    const tr = await mount();
    await paste(tr, makeShare().text);
    const pressed = await press(tr, 'reject');
    expect(footer(tr, 'reject').props.title).toBe('decliningBusy');
    expect(has(tr, 'signature-task-footer-reject-busy')).toBe(true);
    expect(footer(tr, 'accept').props.disabled).toBe(true);
    await renderer.act(async () => {
      respond.resolve();
      await pressed.done;
    });
    expect(mockShowToast).toHaveBeenCalledWith('invitationDeclinedToast', { testID: 'keyholder-decline-success' });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('a failed accept shows no confirmation', async () => {
    mockAcceptKeyholderInvitation.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const tr = await mount();
    await paste(tr, makeShare().text);
    await press(tr, 'accept');
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(footer(tr, 'accept').props.title).toBe('accept');
  });
});

describe('lookup state', () => {
  it('shows a spinner while looking up, then the explanation and Try Again after the timeout', async () => {
    mockResolveInviteSlot.mockImplementation(hang);
    const tr = await mount();
    await paste(tr, makeShare().text);
    expect(has(tr, 'invite-lookup-looking')).toBe(true);
    expect(has(tr, 'invite-lookup-spinner')).toBe(true);
    expect(json(tr)).toContain('invitationLookingUp');
    expect(footer(tr, 'accept').props.disabled).toBe(true);
    expect(footer(tr, 'reject').props.disabled).toBe(true);

    await advance(INVITE_LOOKUP_TIMEOUT_MS - 1);
    expect(has(tr, 'invite-lookup-looking')).toBe(true);
    expect(has(tr, 'invite-lookup-timed-out')).toBe(false);

    await advance(1);
    expect(has(tr, 'invite-lookup-looking')).toBe(false);
    expect(has(tr, 'invite-lookup-timed-out')).toBe(true);
    expect(json(tr)).toContain('invitationLookupSlowTitle');
    expect(json(tr)).toContain('invitationLookupSlowBody');
    expect(has(tr, 'invite-lookup-retry')).toBe(true);
    expect(footer(tr, 'accept').props.disabled).toBe(true);
  });

  it('an answer that arrives after the timeout still enables the buttons', async () => {
    const slow = deferred<unknown>();
    mockResolveInviteSlot.mockImplementationOnce(() => slow.promise);
    const tr = await mount();
    await paste(tr, makeShare().text);
    await advance(INVITE_LOOKUP_TIMEOUT_MS);
    expect(has(tr, 'invite-lookup-timed-out')).toBe(true);
    await renderer.act(async () => {
      slow.resolve({ status: 'live', cid: 'cid-1' });
    });
    await flush();
    expect(json(tr)).toContain('Kay Holder');
    expect(footer(tr, 'accept').props.disabled).toBe(false);
  });

  it('Try Again runs a fresh lookup without re-pasting, and a late answer of the hung one is ignored', async () => {
    const first = deferred<unknown>();
    mockResolveInviteSlot.mockImplementationOnce(() => first.promise);
    const tr = await mount();
    await paste(tr, makeShare().text);
    await advance(INVITE_LOOKUP_TIMEOUT_MS);
    expect(mockResolveInviteSlot).toHaveBeenCalledTimes(1);

    await pressRetry(tr);
    expect(mockResolveInviteSlot).toHaveBeenCalledTimes(2);
    expect(json(tr)).toContain('Kay Holder');
    expect(footer(tr, 'accept').props.disabled).toBe(false);

    // the first, hung lookup settles late with a refusal: it must not take the screen back
    await renderer.act(async () => {
      first.resolve({ status: 'answered' });
    });
    await flush();
    expect(json(tr)).toContain('Kay Holder');
    expect(json(tr)).not.toContain('invitationAcceptAlreadyAnswered');
    expect(footer(tr, 'accept').props.disabled).toBe(false);
  });

  it('re-entering the screen starts a fresh lookup instead of waiting on the hung one', async () => {
    mockResolveInviteSlot.mockImplementationOnce(hang);
    const share = makeShare();
    const first = await mount();
    await paste(first, share.text);
    await advance(INVITE_LOOKUP_TIMEOUT_MS);
    expect(has(first, 'invite-lookup-timed-out')).toBe(true);
    await renderer.act(async () => {
      first.unmount();
    });

    const second = await mount();
    await paste(second, share.text);
    expect(mockResolveInviteSlot).toHaveBeenCalledTimes(2);
    expect(json(second)).toContain('Kay Holder');
    expect(footer(second, 'accept').props.disabled).toBe(false);
  });

  it.each([
    ['the network did not answer', Object.assign(new Error('InvitationEngine.resolveInviteSlot: dial timeout'), { code: 'DIAL_TIMEOUT' }), 'invitationNetworkNoAnswer', true],
    ['a slot not on this phone yet', null, 'invitationAcceptNotFound', true],
    ['already answered', 'answered', 'invitationAcceptAlreadyAnswered', false],
    ['withdrawn or expired', 'no-longer-valid', 'invitationAcceptNoLongerValid', false],
    ['an unknown failure', new Error('InvitationEngine.resolveInviteSlot: weird'), 'invitationLoadFailed', true],
  ])('a lookup failure (%s) shows its copy, with Try Again only where it can help', async (_label, outcome, key, retry) => {
    if (outcome instanceof Error) {
      mockResolveInviteSlot.mockImplementation(async () => {
        throw outcome;
      });
    } else {
      mockResolveInviteSlot.mockImplementation(async () => ({ status: outcome ?? 'not-found' }));
    }
    const tr = await mount();
    await paste(tr, makeShare().text);
    expect(has(tr, 'invite-lookup-failed')).toBe(true);
    expect(json(tr)).toContain(key);
    expect(json(tr)).not.toContain('InvitationEngine');
    expect(has(tr, 'invite-lookup-retry')).toBe(retry);
    expect(footer(tr, 'accept').props.disabled).toBe(true);
  });
});

describe('accept failure classes', () => {
  const coded = (code: string, message = 'engine text') => Object.assign(new Error(message), { code });
  it.each([
    ['network or members did not answer', coded('RESPONSE_TIMEOUT', 'response timeout: peer=x'), 'invitationNetworkNoAnswer'],
    ['a cohort-unreachable write', new Error('InvitationEngine.respondToInvite: Block abc is unavailable (cohort-unreachable)'), 'invitationNetworkNoAnswer'],
    ['the pre-write lookup timed out', coded('invite-lookup-timeout'), 'invitationNetworkNoAnswer'],
    ['already answered (share check)', new InviteShareError('already-answered'), 'invitationAcceptAlreadyAnswered'],
    ['already answered (engine)', coded('invite-already-answered'), 'invitationAcceptAlreadyAnswered'],
    ['expired or withdrawn', coded('invite-no-longer-valid'), 'invitationAcceptNoLongerValid'],
    ['biometric cancelled', Object.assign(new Error('key-vault: native wrap denied'), { name: 'KeyVaultError', code: 'auth-denied', nativeCode: 'CANCELED' }), 'invitationAcceptBiometricCancelled'],
    ['a biometric lockout', Object.assign(new Error('denied'), { code: 'auth-denied', nativeCode: 'LOCKOUT' }), 'deviceSigningErrorGeneric'],
    ['unknown', new Error('InvitationEngine.respondToInvite: something else'), 'invitationAcceptFailed'],
  ])('%s', async (_label, error, key) => {
    mockAcceptKeyholderInvitation.mockImplementationOnce(async () => {
      throw error;
    });
    const tr = await mount();
    await paste(tr, makeShare().text);
    await press(tr, 'accept');
    expect(json(tr)).toContain(key);
    expect(json(tr)).not.toContain('engine text');
    expect(json(tr)).not.toContain('InvitationEngine');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('the log line names class, code and a scrubbed reason, never the invitation', async () => {
    const share = makeShare();
    mockAcceptKeyholderInvitation.mockImplementationOnce(async () => {
      throw coded('DIAL_TIMEOUT', `dial timeout for ${share.text} key ${share.invitePrivate} cid bafyreigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`);
    });
    const tr = await mount();
    await paste(tr, share.text);
    await press(tr, 'accept');
    const lines = warn.mock.calls.filter((c) => c[0] === 'Error responding to invite:');
    expect(lines).toHaveLength(1);
    const logged = String(lines[0][1]);
    expect(logged.startsWith('class=Error code=DIAL_TIMEOUT msg=dial timeout')).toBe(true);
    const all = JSON.stringify(warn.mock.calls);
    expect(all.includes(share.invitePrivate)).toBe(false);
    expect(all.includes('bafyrei')).toBe(false);
    expect(all.includes('"Ada"')).toBe(false);
    for (const call of warn.mock.calls) for (const a of call) expect(typeof a).toBe('string');
  });
});

describe('recovery after a failed accept', () => {
  it('hung first lookup, Try Again, failed accept: the lookup re-runs, the buttons come back and a second accept succeeds', async () => {
    mockResolveInviteSlot.mockImplementationOnce(hang);
    const tr = await mount();
    await paste(tr, makeShare().text);
    await advance(INVITE_LOOKUP_TIMEOUT_MS);
    expect(has(tr, 'invite-lookup-timed-out')).toBe(true);
    expect(footer(tr, 'accept').props.disabled).toBe(true);

    await pressRetry(tr);
    expect(footer(tr, 'accept').props.disabled).toBe(false);

    // The accept fails; the re-run lookup is slow, so the screen shows it is looking again.
    const relookup = deferred<unknown>();
    mockResolveInviteSlot.mockImplementationOnce(() => relookup.promise);
    mockAcceptKeyholderInvitation.mockImplementationOnce(async () => {
      throw coded('RESPONSE_TIMEOUT');
    });
    const callsBefore = mockResolveInviteSlot.mock.calls.length;
    await press(tr, 'accept');
    expect(json(tr)).toContain('invitationNetworkNoAnswer');
    expect(mockResolveInviteSlot.mock.calls.length).toBe(callsBefore + 1);
    expect(has(tr, 'invite-lookup-looking')).toBe(true);
    expect(footer(tr, 'accept').props.title).toBe('accept');
    expect(footer(tr, 'accept').props.disabled).toBe(true);

    await renderer.act(async () => {
      relookup.resolve({ status: 'live', cid: 'cid-1' });
    });
    await flush();
    expect(footer(tr, 'accept').props.disabled).toBe(false);
    expect(footer(tr, 'reject').props.disabled).toBe(false);
    // the accept error stays up until the next answer
    expect(json(tr)).toContain('invitationNetworkNoAnswer');

    const pressed = await press(tr, 'accept');
    await renderer.act(async () => {
      await pressed.done;
    });
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenCalledWith('keyholderAcceptSuccess', { testID: 'keyholder-accept-success' });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(json(tr)).not.toContain('invitationNetworkNoAnswer');
  });

  it('a failed accept whose re-run lookup also hangs times out again and offers Try Again', async () => {
    const tr = await mount();
    await paste(tr, makeShare().text);
    mockResolveInviteSlot.mockImplementationOnce(hang);
    mockAcceptKeyholderInvitation.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await press(tr, 'accept');
    expect(has(tr, 'invite-lookup-looking')).toBe(true);
    await advance(INVITE_LOOKUP_TIMEOUT_MS);
    expect(has(tr, 'invite-lookup-timed-out')).toBe(true);
    await pressRetry(tr);
    expect(footer(tr, 'accept').props.disabled).toBe(false);
  });

  it('accept passes the bounded read timeout to the accept orchestration', async () => {
    const tr = await mount();
    await paste(tr, makeShare().text);
    const pressed = await press(tr, 'accept');
    await renderer.act(async () => {
      await pressed.done;
    });
    expect((mockAcceptKeyholderInvitation.mock.calls[0][0] as { readTimeoutMs?: number }).readTimeoutMs).toBe(INVITE_LOOKUP_TIMEOUT_MS);
  });
});

function coded(code: string, message = 'engine text') {
  return Object.assign(new Error(message), { code });
}
