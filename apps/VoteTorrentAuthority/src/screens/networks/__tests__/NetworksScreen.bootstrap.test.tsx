/**
 * Behavioral tests for NetworksScreen bootstrap-paste Connect — NETOP-03 (GAP 2), rewritten for
 * D-39 (62-23): the pasted-bootstrap path now DIALS the parsed peer on the CadreNode control
 * node — it never opens a strand. Every strand is opened solely by the networks engine's
 * DbFactory, keyed on `networkHash` (`rn-db-factory.ts`'s `createStrandDbFactory`).
 *
 * Pins:
 *   - B-1: a malformed bootstrap address → multiaddr() throws → CAUGHT, the inline
 *     `invalidBootstrapAddress` error shows, no dial, no addStrand, no throw escapes.
 *   - B-2: a valid multiaddr with a /p2p component calls `getControlNode().dial` exactly once
 *     with the parsed multiaddr; `addStrand` is NEVER called.
 *   - B-3: a valid multiaddr WITHOUT a /p2p component shows `invalidBootstrapAddress`, no dial.
 *   - B-4: a dial rejection shows `joinFailed`.
 *   - B-5: a null node, or a node whose `getControlNode()` returns null, shows
 *     `invalidBootstrapAddress` with no throw.
 *
 * The screen is rendered for real (no production behavior is altered). Its heavy environmental
 * deps are mocked following the SyncChip pattern: useApp, useCadreNode, @react-navigation/native,
 * react-i18next, vector-icons, safe-area-context.
 *
 * @multiformats/multiaddr is ESM-only (no "require"/"main" export condition) and cannot be
 * resolved by the react-native jest CommonJS resolver — so it is mocked with a FAITHFUL fake
 * that reproduces the security-relevant behavior verified against the real v13 parser:
 *   - multiaddr('<garbage>') throws (InvalidMultiaddrError analog)
 *   - multiaddr('/ip4/.../p2p/<id>').getComponents() yields a { name:'p2p', value:<id> }
 *   - a valid multiaddr without a /p2p component yields no p2p component (value undefined)
 * The parser's own correctness is covered by multiaddr's test suite; this test pins the GUARD
 * behavior around it.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Faithful multiaddr mock (ESM-only real package is unresolvable under the
// react-native jest preset). Reproduces the throw-on-garbage / parse-/p2p-value
// behavior verified against @multiformats/multiaddr@13.
// ---------------------------------------------------------------------------
jest.mock(
  '@multiformats/multiaddr',
  () => ({
    multiaddr: (input: string) => {
      // Real parser requires a leading '/' and a known protocol; anything else throws.
      if (typeof input !== 'string' || !input.startsWith('/') || input.trim() === '/') {
        throw new Error('InvalidMultiaddrError: invalid multiaddr');
      }
      // Decode "/p2p/<value>" segment(s) into components, mirroring getComponents().
      const segments = input.split('/').filter(Boolean);
      const components: Array<{ name: string; value?: string }> = [];
      for (let i = 0; i < segments.length; i++) {
        // crude protocol/value pairing; sufficient for the /p2p decode under test
        if (segments[i] === 'p2p') {
          const value = segments[i + 1];
          if (!value) throw new Error('InvalidMultiaddrError: missing p2p value');
          components.push({ name: 'p2p', value });
          i++;
        } else {
          components.push({ name: segments[i], value: segments[i + 1] });
        }
      }
      return { getComponents: () => components, __tag: 'mock-multiaddr', __raw: input };
    },
  }),
  { virtual: true },
);

// vote-core type-only import — provide an empty module so resolution succeeds.
jest.mock('@votetorrent/vote-core', () => ({}), { virtual: true });

// react-native-vector-icons not available in jest env. Also needed transitively by
// FoundingBundleExportCard's LifecycleConfirmCard (CustomTextInput -> ChipButton).
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// i18n: echo the key (label copy is incidental; the error KEY is what we assert).
// `initReactI18next` must also be exported: NetworksScreen.tsx now transitively imports
// FoundingBundleExportCard.tsx -> engines/device-signer.ts -> the REAL src/i18n/index.ts, whose
// module-scope `i18n.use(initReactI18next).init(...)` call would otherwise throw "undefined
// module" against this mock (62-12 note: a react-i18next mock must export initReactI18next too).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: jest.fn() },
}));

// Navigation theme + hooks.
jest.mock('@react-navigation/native', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ReactForMock = require('react');
  return {
    useTheme: () => ({
      colors: {
        primary: '#007AFF',
        error: '#FF3B30',
        important: '#FF9500',
        text: '#000000',
        textSecondary: '#888888',
        accent: '#d9d9d9',
      },
    }),
    useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
    // NetworksScreen re-loads recent networks on focus. A real navigation focus fires exactly
    // once on initial mount (no navigation container in this test harness ever blurs/refocuses) —
    // mirror that via a plain mount-only effect, rather than invoking the callback directly
    // during render (which would violate the rules of hooks / setState-during-render and can loop).
    useFocusEffect: (cb: () => void | (() => void)) => {
      ReactForMock.useEffect(() => cb(), []);
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// SettingsProvider uses AsyncStorage (null native module under jest); CustomTextInput
// consumes useSettings(). Mock it to avoid the native dependency.
jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// App provider — networksEngine drives a loadNetworks() effect keyed on the engine
// identity, so the returned object MUST be stable across renders (a fresh object each
// render would retrigger the effect → setState → infinite re-render).
const mockGetRecentNetworks = jest.fn(async () => []);
const mockNetworksEngine = { getRecentNetworks: mockGetRecentNetworks };
const mockSelectNetwork = jest.fn(async () => undefined);
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: mockSelectNetwork }),
}));

// CadreNode provider — supply a node whose control-node dial we can observe. D-39: the screen
// no longer calls node.addStrand directly; it dials via node.getControlNode().dial(...).
const mockAddStrand = jest.fn(async () => ({}));
const mockDial = jest.fn(async (_target: unknown) => ({}));
const mockGetConnections = jest.fn(() => []);
let mockControl: { dial: jest.Mock; getConnections: jest.Mock } | null = {
  dial: mockDial,
  getConnections: mockGetConnections,
};
const mockReconcile = jest.fn(async () => ({}));
const mockGetStrands = jest.fn(() => new Map());
let mockNode: {
  addStrand: jest.Mock;
  getControlNode: () => typeof mockControl;
  reconcileControlCohort: jest.Mock;
  getStrands: jest.Mock;
} | null = {
  addStrand: mockAddStrand,
  getControlNode: () => mockControl,
  reconcileControlCohort: mockReconcile,
  getStrands: mockGetStrands,
};
jest.mock('../../../providers/CadreNodeProvider', () => ({
  useCadreNode: () => ({ node: mockNode, syncState: 'offline', connectedPeers: jest.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NetworksScreenModule = require('../NetworksScreen');
const NetworksScreen = NetworksScreenModule.default ?? NetworksScreenModule.NetworksScreen;

// ---------------------------------------------------------------------------
// Helpers: render the real screen and drive the bootstrap input + Connect button.
// ---------------------------------------------------------------------------

async function renderScreen() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<NetworksScreen />);
  });
  // flush the loadNetworks() effect
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return tr;
}

/** Walk the rendered tree for a node whose props match a predicate. */
function findByProps(
  tr: renderer.ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  return tr.root.findAll((n) => {
    try {
      return predicate(n.props as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

/** The bootstrap CustomTextInput is the one with autoCapitalize="none". */
function getBootstrapInput(tr: renderer.ReactTestRenderer) {
  const matches = findByProps(tr, (p) => p.autoCapitalize === 'none' && typeof p.onChangeText === 'function');
  return matches[0];
}

/** The Connect button: CustomButton with title 't("connect")' → echoed key 'connect'. */
function getConnectButton(tr: renderer.ReactTestRenderer) {
  const matches = findByProps(tr, (p) => p.title === 'connect' && typeof p.onPress === 'function');
  return matches[0];
}

/** True if the inline join-error ThemedText (key 'invalidBootstrapAddress'/'joinFailed') is shown. */
function hasErrorText(tr: renderer.ReactTestRenderer, key: string) {
  return JSON.stringify(tr.toJSON()).includes(key);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockControl = { dial: mockDial, getConnections: mockGetConnections };
  mockNode = {
    addStrand: mockAddStrand,
    getControlNode: () => mockControl,
    reconcileControlCohort: mockReconcile,
    getStrands: mockGetStrands,
  };
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('NetworksScreen bootstrap Connect — D-39: dial only, never addStrand', () => {
  it('B-1: a malformed bootstrap address shows inline error, calls neither dial nor addStrand, and never throws', async () => {
    const tr = await renderScreen();

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('this-is-not-a-multiaddr');
    });

    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).not.toHaveBeenCalled();
    expect(mockAddStrand).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'invalidBootstrapAddress')).toBe(true);
  });

  it('B-2: a valid multiaddr with a /p2p component calls getControlNode().dial exactly once with the parsed multiaddr, and addStrand is never called', async () => {
    const tr = await renderScreen();
    const PEER = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER}`;

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText(addr);
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).toHaveBeenCalledTimes(1);
    expect(mockDial.mock.calls[0][0]).toEqual(expect.objectContaining({ __tag: 'mock-multiaddr', __raw: addr }));
    expect(mockAddStrand).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'invalidBootstrapAddress')).toBe(false);
    expect(hasErrorText(tr, 'joinFailed')).toBe(false);
  });

  it('B-3: a valid multiaddr WITHOUT a /p2p component is rejected (no strandId/peerId) without calling dial', async () => {
    const tr = await renderScreen();

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('/ip4/127.0.0.1/tcp/4001/ws');
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).not.toHaveBeenCalled();
    expect(mockAddStrand).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'invalidBootstrapAddress')).toBe(true);
  });

  it('B-4: a dial rejection shows joinFailed', async () => {
    mockDial.mockRejectedValueOnce(new Error('connection refused'));
    const tr = await renderScreen();
    const PEER = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER}`;

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText(addr);
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).toHaveBeenCalledTimes(1);
    expect(hasErrorText(tr, 'joinFailed')).toBe(true);
  });

  it('B-5a: a null node shows invalidBootstrapAddress with no throw', async () => {
    mockNode = null;
    const tr = await renderScreen();
    const PEER = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER}`;

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText(addr);
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'invalidBootstrapAddress')).toBe(true);
  });

  it('B-5b: a node whose getControlNode() returns null shows invalidBootstrapAddress with no throw', async () => {
    mockControl = null;
    const tr = await renderScreen();
    const PEER = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER}`;

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText(addr);
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockDial).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'invalidBootstrapAddress')).toBe(true);
  });

  it('A: a successful dial triggers exactly one control-cohort re-probe', async () => {
    const tr = await renderScreen();
    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X');
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(hasErrorText(tr, 'joinFailed')).toBe(false);
  });

  it('B: an invalid address or a rejected dial never triggers the re-probe', async () => {
    const tr = await renderScreen();
    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('garbage');
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });
    expect(mockReconcile).not.toHaveBeenCalled();

    mockDial.mockRejectedValueOnce(new Error('refused'));
    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X');
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(hasErrorText(tr, 'joinFailed')).toBe(true);
  });
});
