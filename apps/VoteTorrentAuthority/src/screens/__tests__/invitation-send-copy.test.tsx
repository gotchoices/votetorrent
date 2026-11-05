/**
 * The three invitation screens' SEND modes show catalog copy for every failure and log only
 * fixed tags and class names. Engines are jest.fn() stubs: this proves the screens' copy and
 * logging contract, not the engines.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import renderer from 'react-test-renderer';
import { consoleTags, leakingCalls, nonLiteralConsoleFirstArgs, untaggedCalls } from '../__fixtures__/log-content-scan';

const LEAK = 'Engine X requestId=abc cid=bafyLEAK';

let mockRouteParams: any = {};
let mockNetworksEngine: any;
const mockSaveInviteWithSigning = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const mockInviteKeyholder = jest.fn(async (..._args: any[]): Promise<any> => undefined);
const mockAuthorityEngine = {
  createOfficerInvite: jest.fn(() => ({
    invitePrivate: 'p', inviteKey: 'k', inviteSignature: 's', expiration: 'x', type: 'o', name: 'N', title: 'T',
  })),
  createAuthorityInvite: jest.fn(() => ({
    invitePrivate: 'p', inviteKey: 'k', inviteSignature: 's', expiration: 'x', type: 'a', name: 'N',
  })),
  saveInviteWithSigning: mockSaveInviteWithSigning,
};
let mockNetworkDetails: any;
const mockNetworkEngine = {
  getDetails: jest.fn(async () => mockNetworkDetails),
  openAuthority: jest.fn(async () => mockAuthorityEngine),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === 'network') return mockNetworkEngine;
  if (name === 'authority') return mockAuthorityEngine;
  if (name === 'defaultUser') return { get: async () => ({ name: 'Officer' }) };
  return undefined;
});

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: jest.fn(async () => true) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock('../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine, networksEngine: mockNetworksEngine }),
}));
jest.mock('../../engines/device-signer', () => ({
  createDeviceSigner: jest.fn(async () => async () => ({ signature: 's', signerKey: 'k', signerUserId: 'u' })),
}));
jest.mock('../../engines/device-user', () => ({
  getOrCreateDeviceUser: jest.fn(async () => ({ id: 'user-1', name: 'Device User' })),
}));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000' }) }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('react').useEffect(cb, [cb]);
  },
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn(), setOptions: jest.fn() }),

  usePreventRemove: () => undefined,
}));

type Screen = { name: string; file: string; load: () => any };
const SCREENS: Screen[] = [
  { name: 'Administrator', file: 'admin/AdministratorInvitationScreen.tsx', load: () => require('../admin/AdministratorInvitationScreen') },
  { name: 'Authority', file: 'authorities/AuthorityInvitationScreen.tsx', load: () => require('../authorities/AuthorityInvitationScreen') },
  { name: 'Keyholder', file: 'keyholder/KeyholderInvitationScreen.tsx', load: () => require('../keyholder/KeyholderInvitationScreen') },
];

function screenSource(file: string): string {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

async function render(screen: Screen) {
  const mod = screen.load();
  const C = mod.default ?? Object.values(mod)[0];
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<C />);
  });
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return tr;
}
async function pressSend(tr: renderer.ReactTestRenderer) {
  const b = tr.root.findAll((n) => n.props?.title === 'send' && typeof n.props?.onPress === 'function')[0];
  await renderer.act(async () => {
    await b.props.onPress();
    await Promise.resolve();
  });
}
function fillName(tr: renderer.ReactTestRenderer) {
  return renderer.act(async () => {
    for (const n of tr.root.findAll((x) => typeof x.props?.onChangeText === 'function' && (x.props.title === 'name' || x.props.accessibilityLabel === 'name'))) {
      n.props.onChangeText('Some Name');
    }
  });
}
const text = (tr: renderer.ReactTestRenderer) => JSON.stringify(tr.toJSON());

function expectNoLeak(tr: renderer.ReactTestRenderer) {
  const t = text(tr);
  expect(t).not.toContain('Engine X');
  expect(t).not.toContain('requestId');
  expect(t).not.toContain('bafy');
}

let warn: jest.SpyInstance;
let err: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockNetworkDetails = { network: { name: 'Net', primaryAuthorityId: 'authority-1' } };
  mockNetworksEngine = {
    getRecentNetworks: jest.fn(async () => [{ id: 'network-1' }]),
    open: jest.fn(async () => mockNetworkEngine),
  };
  mockSaveInviteWithSigning.mockResolvedValue(undefined);
});
afterEach(() => {
  warn.mockRestore();
  err.mockRestore();
});

/** Per screen: route params for a runnable send, and the engine call that is made to fail. */
function arrange(name: string, failWith: unknown) {
  if (name === 'Administrator') {
    mockRouteParams = { mode: 'send', authority: { id: 'authority-1' }, officerInit: { name: 'Bea', title: 'Clerk' } };
    mockSaveInviteWithSigning.mockRejectedValue(failWith);
  } else if (name === 'Authority') {
    mockRouteParams = { mode: 'send' };
    mockSaveInviteWithSigning.mockRejectedValue(failWith);
  } else {
    mockRouteParams = {
      mode: 'send',
      keyholder: { invite: { name: 'Kay' } },
      electionEngine: {
        getElectionDetails: async () => ({ election: { id: 'e1' } }),
        inviteKeyholder: mockInviteKeyholder.mockImplementation(async () => {
          throw failWith;
        }),
      },
    };
  }
}

describe.each(SCREENS)('$name invitation send mode', (screen) => {
  it('I-1 a non-signing failure shows the catalog copy and no engine text, id or Cid', async () => {
    arrange(screen.name, new Error(LEAK));
    const tr = await render(screen);
    await fillName(tr);
    await pressSend(tr);
    // REVIEW WR-R5-04: the rejecting engine call ran, so the copy is that rejection's, not a harness TypeError's.
    expect(screen.name === 'Keyholder' ? mockInviteKeyholder : mockSaveInviteWithSigning).toHaveBeenCalled();
    expect(text(tr)).toContain(screen.name === 'Keyholder' ? 'keyholderInviteSendFailed' : 'invitationSendFailed');
    expectNoLeak(tr);
  });

  it('I-3 the screen logs only fixed tags and class names', async () => {
    arrange(screen.name, new Error(LEAK));
    const src = screenSource(screen.file);
    const tags = consoleTags(src);
    expect(tags.size).toBeGreaterThan(0);
    // A log whose first argument is built at runtime (template literal, concatenation) fails here.
    expect(nonLiteralConsoleFirstArgs(src)).toEqual([]);
    const tr = await render(screen);
    await fillName(tr);
    await pressSend(tr);
    // EVERY spied call, not only the tagged ones (REVIEW WR-R5-01).
    const calls = [...warn.mock.calls, ...err.mock.calls];
    expect(calls.some((c) => typeof c[0] === 'string' && tags.has(c[0]))).toBe(true);
    expect(untaggedCalls(calls, tags)).toEqual([]);
    expect(leakingCalls(calls, ['Engine X', 'requestId=abc', 'bafyLEAK'])).toEqual([]);
    for (const call of calls) for (const a of call) expect(typeof a).toBe('string');
  });
});

describe('I-2 precondition failures use catalog copy', () => {
  it('Administrator with no authority', async () => {
    mockRouteParams = { mode: 'send', officerInit: { name: 'Bea', title: 'Clerk' } };
    const s = SCREENS[0];
    const tr = await render(s);
    await pressSend(tr);
    expect(text(tr)).toContain('invitationNeedsAuthority');
    expect(text(tr)).not.toContain('navigate from');
  });

  it('Keyholder with no election engine', async () => {
    mockRouteParams = { mode: 'send', keyholder: { invite: { name: 'Kay' } } };
    const tr = await render(SCREENS[2]);
    await pressSend(tr);
    expect(text(tr)).toContain('invitationNeedsElection');
    expect(text(tr)).not.toContain('navigate from');
  });

  it('Authority with no networks engine, no network, unresolved authority', async () => {
    mockRouteParams = { mode: 'send' };
    mockNetworksEngine = undefined;
    let tr = await render(SCREENS[1]);
    await fillName(tr);
    await pressSend(tr);
    expect(text(tr)).toContain('invitationNetworkStarting');
    expect(text(tr)).not.toContain('not yet initialized');

    mockNetworksEngine = { getRecentNetworks: jest.fn(async () => []), open: jest.fn() };
    tr = await render(SCREENS[1]);
    await fillName(tr);
    await pressSend(tr);
    expect(text(tr)).toContain('invitationNoNetwork');
    expect(text(tr)).not.toContain('create a network first');

    mockNetworksEngine = { getRecentNetworks: jest.fn(async () => [{ id: 'n' }]), open: jest.fn(async () => mockNetworkEngine) };
    mockNetworkDetails = { network: { name: 'Net' } };
    tr = await render(SCREENS[1]);
    await fillName(tr);
    await pressSend(tr);
    expect(text(tr)).toContain('invitationAuthorityUnresolved');
    expect(text(tr)).not.toContain('invite not created');
  });
});

describe('I-4 regressions', () => {
  it('a peer write failure still shows the hook copy, not the generic send copy', async () => {
    arrange('Administrator', new Error('Block abc is unavailable (cohort-unreachable)'));
    const tr = await render(SCREENS[0]);
    await fillName(tr);
    await pressSend(tr);
    const t = text(tr);
    expect(t).toContain('peerWriteUnavailable');
    expect(t).not.toContain('invitationSendFailed');
  });
});

describe('log-content-scan self-test (the shared checks can fail)', () => {
  it('harvests both quote styles and flags runtime-built first arguments', () => {
    const src = [
      'console.warn("double tag:", e.name);',
      "console.error('single tag', e.name);",
      'console.warn(`plain backtick`);',
      'console.warn(`built ${e.message}`);',
      'console.error("x: " + e.message);',
      'console.warn(tagVar, e.name);',
    ].join('\n');
    expect([...consoleTags(src)].sort()).toEqual(['double tag:', 'plain backtick', 'single tag']);
    expect(nonLiteralConsoleFirstArgs(src)).toHaveLength(3);
  });

  it('finds a secret in any argument, including inside an Error object, and reports unknown first arguments', () => {
    const calls: unknown[][] = [['tag', 'TypeError'], ['tag', new Error('has SECRET')], ['other first arg']];
    expect(leakingCalls(calls, ['SECRET'])).toHaveLength(1);
    expect(untaggedCalls(calls, new Set(['tag']))).toEqual(['other first arg']);
  });
});
