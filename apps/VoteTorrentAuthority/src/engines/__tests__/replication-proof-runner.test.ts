/**
 * RED → GREEN test for the replication-proof-runner (P2P-06 / P2P-04 / ENG-05).
 *
 * Wave 0 (Nyquist): all tests are RED until Plan 03 creates
 * `../replication-proof-runner` and implements `runReplicationProof()`.
 *
 * P2P-06: symmetric both-write / both-read replication proof (D-01).
 * P2P-04: stable peerId logged at boot via `[replication-proof] peerId=<id>` (D-05).
 * ENG-05: live connected-peer count via `[replication-proof] peers=N` (D-06).
 *
 * Virtual-mock preamble mirrors rn-db-factory.test.ts lines 20–36 exactly —
 * all `{ virtual: true }` mocks must be declared before any require() of the
 * module under test (ESM-only / native deps that cannot load under the
 * react-native jest preset).
 */

// ---------------------------------------------------------------------------
// Capture each constructed FakeCadreNode so tests can drive its methods.
// `mock`-prefixed to satisfy jest hoisting rules.
// ---------------------------------------------------------------------------

type FakeConnection = Record<string, unknown>;

// `mock`-prefixed so jest's hoisted module factory can reference it.
const mockConstructedNodes: FakeCadreNode[] = [];

interface FakeCadreNode {
  start: jest.Mock;
  stop: jest.Mock;
  peerId: { toString: () => string };
  getControlNode: () => { getConnections: () => FakeConnection[] };
  _setConnections: (conns: FakeConnection[]) => void;
}

// --- mock the module-load-time native/runtime deps so importing the runner is safe ---
// These packages publish ESM-only `exports` maps (no "require" condition), which
// jest's CommonJS resolver cannot resolve — so the mocks are registered `virtual`
// to intercept the source's imports without touching the filesystem.
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});
jest.mock(
  '@optimystic/db-p2p-storage-rn',
  () => ({
    openOptimysticRNDb: jest.fn(() => ({})),
    LevelDBRawStorage: class {},
    loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
  }),
  { virtual: true },
);
jest.mock('@quereus/quereus', () => ({ Database: class {}, registerPlugin: jest.fn() }), {
  virtual: true,
});
jest.mock('@optimystic/quereus-plugin-optimystic', () => ({ register: jest.fn() }), {
  virtual: true,
});
jest.mock(
  '@votetorrent/vote-engine/rn',
  () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }),
  { virtual: true },
);

// CadreNode mock — mirroring CadreNodeProvider.test.tsx lines 44–80.
// FakeCadreNode is `mock`-prefixed (via mockConstructedNodes) per jest hoisting rules.
jest.mock(
  '@serfab/cadre-core',
  () => {
    class FakeCadreNode {
      public start = jest.fn(async () => {});
      public stop = jest.fn(async () => {});
      public peerId = { toString: () => 'fakePeerIdABC123' };
      private _connections: FakeConnection[] = [];

      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockConstructedNodes.push(this as any);
      }

      getControlNode() {
        return {
          getConnections: () => this._connections,
        };
      }

      _setConnections(conns: FakeConnection[]) {
        this._connections = conns;
      }
    }
    return { CadreNode: FakeCadreNode };
  },
  { virtual: true },
);

jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
jest.mock(
  '@libp2p/circuit-relay-v2',
  () => ({ circuitRelayTransport: () => ({}) }),
  { virtual: true },
);
jest.mock(
  '@multiformats/multiaddr',
  () => ({ multiaddr: (s: string) => ({ toString: () => s }) }),
  { virtual: true },
);

// ---------------------------------------------------------------------------
// Module-level flag mock + lazy require AFTER all virtual mocks are registered.
// Each test that needs to flip REPLICATION_PROOF_ENABLED uses jest.resetModules()
// + re-mock + re-require so the flag re-evaluates at the require point.
// ---------------------------------------------------------------------------

jest.mock('../proof-flags.generated', () => ({ REPLICATION_PROOF_ENABLED: true }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
let { runReplicationProof } = require('../replication-proof-runner');

// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConstructedNodes.length = 0;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Gate behavior
// ---------------------------------------------------------------------------

describe('runReplicationProof — gate behavior', () => {
  it('is a no-op when REPLICATION_PROOF_ENABLED=false', async () => {
    // Flip the flag, re-require the module with a fresh module registry.
    jest.resetModules();
    jest.mock('../proof-flags.generated', () => ({ REPLICATION_PROOF_ENABLED: false }));

    // Re-register all virtual mocks after resetModules clears the registry.
    jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
      virtual: true,
    });
    jest.mock(
      '@optimystic/db-p2p-storage-rn',
      () => ({
        openOptimysticRNDb: jest.fn(() => ({})),
        LevelDBRawStorage: class {},
        loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
      }),
      { virtual: true },
    );
    jest.mock('@quereus/quereus', () => ({ Database: class {}, registerPlugin: jest.fn() }), {
      virtual: true,
    });
    jest.mock('@optimystic/quereus-plugin-optimystic', () => ({ register: jest.fn() }), {
      virtual: true,
    });
    jest.mock(
      '@votetorrent/vote-engine/rn',
      () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }),
      { virtual: true },
    );
    jest.mock(
      '@serfab/cadre-core',
      () => {
        class FakeCadreNode {
          start = jest.fn(async () => {});
          stop = jest.fn(async () => {});
          peerId = { toString: () => 'fakePeerIdABC123' };
          getControlNode() { return { getConnections: () => [] }; }
        }
        return { CadreNode: FakeCadreNode };
      },
      { virtual: true },
    );
    jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
    jest.mock(
      '@libp2p/circuit-relay-v2',
      () => ({ circuitRelayTransport: () => ({}) }),
      { virtual: true },
    );
    jest.mock(
      '@multiformats/multiaddr',
      () => ({ multiaddr: (s: string) => ({ toString: () => s }) }),
      { virtual: true },
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runReplicationProof: runDisabled } = require('../replication-proof-runner');

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await runDisabled();

    // No [replication-proof]-tagged console.log call should have occurred.
    const taggedCalls = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[replication-proof]'),
    );
    expect(taggedCalls).toHaveLength(0);

    // No FakeCadreNode should have been constructed.
    expect(mockConstructedNodes).toHaveLength(0);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Marker emissions (all RED until ../replication-proof-runner exists)
// ---------------------------------------------------------------------------

describe('runReplicationProof — marker emissions', () => {
  it('emits [replication-proof] starting when enabled', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runReplicationProof();

    // Multi-arg console.log: args[0] === '[replication-proof]', args[1..] contain 'starting'.
    const startingCall = consoleSpy.mock.calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.slice(1).some((a) => typeof a === 'string' && a.toLowerCase().includes('starting')),
    );
    expect(startingCall).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('emits peerId= marker with the fake peer id (D-05 / P2P-04)', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runReplicationProof();

    // Expect a call whose joined args contain 'peerId=' and the stub peerId value.
    const peerIdCall = consoleSpy.mock.calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('peerId=') &&
        args.join(' ').includes('fakePeerIdABC123'),
    );
    expect(peerIdCall).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('emits peers= marker with N>=1 when connections are present (D-06 / ENG-05)', async () => {
    // Arrange: prime the constructed fake node to report ≥1 connection.
    // Because FakeCadreNode is constructed inside runReplicationProof(), we
    // intercept mockConstructedNodes after construction via a micro-hook.
    // Reset the mockConstructedNodes capture so we can intercept the one
    // built by this invocation.
    mockConstructedNodes.length = 0;

    // Spy to capture the node construction moment: once a node appears in
    // mockConstructedNodes, set its connections to 1.
    const realPush = Array.prototype.push;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(mockConstructedNodes as any, 'push').mockImplementation(function (...args: any[]) {
      const node = args[0] as FakeCadreNode;
      // Give the fake node 1 connection so the peers= poll finds N>=1 immediately.
      node._setConnections([{}]);
      return realPush.apply(this, args);
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runReplicationProof();

    const peersCall = consoleSpy.mock.calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('peers='),
    );
    expect(peersCall).toBeDefined();

    consoleSpy.mockRestore();
    // Restore the spy on push
    jest.restoreAllMocks();

    // Re-acquire runReplicationProof for subsequent tests.
    // The gate test (test 1) used jest.resetModules() + overrode the flag mock with `false`.
    // That override persists in jest's mock registry and the stale `false` module is cached.
    // Re-register the `true` flag mock + clear the module cache so the next require loads a
    // fresh module with the correct enabled=true flag for the verdict test (test 5).
    jest.resetModules();
    jest.mock('../proof-flags.generated', () => ({ REPLICATION_PROOF_ENABLED: true }));
    jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
    jest.mock(
      '@optimystic/db-p2p-storage-rn',
      () => ({
        openOptimysticRNDb: jest.fn(() => ({})),
        LevelDBRawStorage: class {},
        loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
      }),
      { virtual: true },
    );
    jest.mock('@quereus/quereus', () => ({ Database: class {}, registerPlugin: jest.fn() }), { virtual: true });
    jest.mock('@optimystic/quereus-plugin-optimystic', () => ({ register: jest.fn() }), { virtual: true });
    jest.mock(
      '@votetorrent/vote-engine/rn',
      () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }),
      { virtual: true },
    );
    jest.mock(
      '@serfab/cadre-core',
      () => {
        class FakeCadreNode {
          start = jest.fn(async () => {});
          stop = jest.fn(async () => {});
          peerId = { toString: () => 'fakePeerIdABC123' };
          getControlNode() { return { getConnections: () => [] }; }
        }
        return { CadreNode: FakeCadreNode };
      },
      { virtual: true },
    );
    jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
    jest.mock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({}) }), { virtual: true });
    jest.mock('@multiformats/multiaddr', () => ({ multiaddr: (s: string) => ({ toString: () => s }) }), { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ runReplicationProof } = require('../replication-proof-runner'));
  });

  it('emits a REPLICATION VERDICT line', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runReplicationProof();

    const verdictCall = consoleSpy.mock.calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();

    consoleSpy.mockRestore();
  });
});
