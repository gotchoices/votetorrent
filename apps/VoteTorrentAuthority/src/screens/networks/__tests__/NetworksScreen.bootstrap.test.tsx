/**
 * Behavioral tests for NetworksScreen bootstrap-paste join — NETOP-03 (GAP 2).
 *
 * Pins the T-22-09 / Security-V5 DoS-mitigation guard in handleBootstrapConnect:
 *   - A malformed bootstrap address → multiaddr() throws → the throw is CAUGHT,
 *     the inline `invalidBootstrapAddress` error is shown, node.addStrand is NOT
 *     called, and NO exception escapes (the node never crashes).
 *   - A valid multiaddr → strandId decoded from the /p2p component → node.addStrand
 *     is called exactly once with mode 'networked' and the official strand row
 *     (Type 'o', MemberPrivateKey null, Id = decoded peer id).
 *
 * The screen is rendered for real (no production behavior is altered). Its heavy
 * environmental deps are mocked following the SyncChip pattern: useApp, useCadreNode,
 * @react-navigation/native, react-i18next, vector-icons, safe-area-context, and the
 * vote-engine schema re-export.
 *
 * @multiformats/multiaddr is ESM-only (no "require"/"main" export condition) and
 * cannot be resolved by the react-native jest CommonJS resolver — so it is mocked
 * with a FAITHFUL fake that reproduces the security-relevant behavior verified
 * against the real v13 parser:
 *   - multiaddr('<garbage>') throws (InvalidMultiaddrError analog)
 *   - multiaddr('/ip4/.../p2p/<id>').getComponents() yields a { name:'p2p', value:<id> }
 *   - a valid multiaddr without a /p2p component yields no p2p component (value undefined)
 * The parser's own correctness is covered by multiaddr's test suite; this test pins
 * the GUARD behavior around it.
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
      return { getComponents: () => components };
    },
  }),
  { virtual: true },
);

// Schema re-export from the vote-engine RN entry (ESM workspace pkg) — mocked.
jest.mock(
  '@votetorrent/vote-engine/rn',
  () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }),
  { virtual: true },
);

// vote-core type-only import — provide an empty module so resolution succeeds.
jest.mock('@votetorrent/vote-core', () => ({}), { virtual: true });

// react-native-vector-icons not available in jest env.
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// i18n: echo the key (label copy is incidental; the error KEY is what we assert).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
      },
    }),
    useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
    // NetworksScreen re-loads recent networks on focus. A real navigation focus
    // fires exactly once on initial mount (no navigation container in this test
    // harness ever blurs/refocuses) — mirror that via a plain mount-only effect,
    // rather than invoking the callback directly during render (which would
    // violate the rules of hooks / setState-during-render and can loop).
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
jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ networksEngine: mockNetworksEngine }),
}));

// CadreNode provider — supply a node whose addStrand we can observe.
const mockAddStrand = jest.fn(async () => ({}));
const mockNode = { addStrand: mockAddStrand };
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

/** True if the inline join-error ThemedText (key 'invalidBootstrapAddress') is shown. */
function hasInvalidAddrError(tr: renderer.ReactTestRenderer) {
  return JSON.stringify(tr.toJSON()).includes('invalidBootstrapAddress');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NetworksScreen bootstrap join — NETOP-03 / T-22-09 guard', () => {
  it('malformed bootstrap address shows inline error, does NOT call addStrand, and never throws', async () => {
    const tr = await renderScreen();

    // Type a malformed address.
    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('this-is-not-a-multiaddr');
    });

    // Press Connect — must not throw (the node must never crash on a bad paste).
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockAddStrand).not.toHaveBeenCalled();
    expect(hasInvalidAddrError(tr)).toBe(true);
  });

  it('valid multiaddr decodes the /p2p strandId and calls addStrand once with mode "networked" and an official strand row', async () => {
    const tr = await renderScreen();
    const PEER = '12D3KooWPjceQrSwdWXPyLLeABRXmuqt69Rg3sBYbU1Nft9HyQ6X';
    const addr = `/ip4/127.0.0.1/tcp/4001/ws/p2p/${PEER}`;

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText(addr);
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockAddStrand).toHaveBeenCalledTimes(1);
    const config = mockAddStrand.mock.calls[0][0] as {
      strandRow: { Id: string; MemberPrivateKey: null; Type: string };
      mode: string;
      sAppConfig: { schema: string };
    };
    expect(config.strandRow).toEqual({ Id: PEER, MemberPrivateKey: null, Type: 'o' });
    expect(config.mode).toBe('networked');
    expect(config.sAppConfig.schema).toBe('declare schema main {}');

    // No inline error on the success path.
    expect(hasInvalidAddrError(tr)).toBe(false);
  });

  it('a valid multiaddr WITHOUT a /p2p component is rejected (no strandId) without calling addStrand', async () => {
    const tr = await renderScreen();

    await renderer.act(async () => {
      getBootstrapInput(tr).props.onChangeText('/ip4/127.0.0.1/tcp/4001/ws');
    });
    await renderer.act(async () => {
      await getConnectButton(tr).props.onPress();
    });

    expect(mockAddStrand).not.toHaveBeenCalled();
    expect(hasInvalidAddrError(tr)).toBe(true);
  });
});
