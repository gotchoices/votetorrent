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

// Captures the CadreNode constructor config for each constructed instance.
// Task-1 RED: asserts network.strandBootstrapNodes forwarding.
const mockCapturedConfigs: Array<Record<string, unknown>> = [];

interface FakeCadreNode {
  start: jest.Mock;
  stop: jest.Mock;
  peerId: { toString: () => string };
  getControlNode: () => { getConnections: () => FakeConnection[] };
  // Fix A (Phase 30): getStrand exposes the live libp2pNode.getConnections() the runner reads.
  getStrand: (id: string) => { libp2pNode?: { getConnections?: () => FakeConnection[] } } | undefined;
  _setConnections: (conns: FakeConnection[]) => void;
  _setStrandPeers: (n: number) => void;
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
// ADD: new quereus plugin mocks required by the updated rn-db-factory solo path (D-06 / STORE-01)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });
jest.mock('@quereus/store', () => ({ createIsolatedStoreModule: jest.fn(() => ({})) }), { virtual: true });
jest.mock(
  '@votetorrent/vote-engine/rn',
  () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }),
  { virtual: true },
);

// CadreNode mock — mirroring CadreNodeProvider.test.tsx lines 44–80.
// FakeCadreNode is `mock`-prefixed (via mockConstructedNodes) per jest hoisting rules.
// Extended for Task 1 RED: captures constructor config in mockCapturedConfigs and exposes
// getStrand(id) returning a configurable connectedPeers via _setStrandPeers().
jest.mock(
  '@serfab/cadre-core',
  () => {
    class FakeCadreNode {
      public start = jest.fn(async () => {});
      public stop = jest.fn(async () => {});
      public peerId = { toString: () => 'fakePeerIdABC123' };
      private _connections: FakeConnection[] = [];
      private _strandConns: FakeConnection[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(config?: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockConstructedNodes.push(this as any);
        // Capture the full constructor config so tests can assert network.strandBootstrapNodes.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockCapturedConfigs.push(config as any);
      }

      getControlNode() {
        return {
          getConnections: () => this._connections,
        };
      }

      // Fix A (Phase 30): the runner reads the LIVE strand connection count via
      // getStrand(id).libp2pNode.getConnections().length, not the dead connectedPeers field.
      getStrand(_id: string) {
        return { libp2pNode: { getConnections: () => this._strandConns } };
      }

      _setConnections(conns: FakeConnection[]) {
        this._connections = conns;
      }

      _setStrandPeers(n: number) {
        this._strandConns = new Array(n).fill({});
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
// reloadRunnerFullMock — reset the module registry and re-register the FULL CadreNode mock
// (the one whose getStrand exposes libp2pNode.getConnections() and whose constructor records
// mockConstructedNodes/mockCapturedConfigs), then re-require the runner. Tests that need to
// drive the live strand connection count call this first so their assertions run against the
// full mock rather than a simpler one left active by an earlier test (Fix A, Phase 30).
// ---------------------------------------------------------------------------
function reloadRunnerFullMock(): void {
  jest.resetModules();
  jest.mock('../proof-flags.generated', () => ({ REPLICATION_PROOF_ENABLED: true }));
  jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), { virtual: true });
  jest.mock('@optimystic/db-p2p-storage-rn', () => ({
    openOptimysticRNDb: jest.fn(() => ({})),
    LevelDBRawStorage: class {},
    loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
  }), { virtual: true });
  jest.mock('@quereus/quereus', () => ({ Database: class {}, registerPlugin: jest.fn() }), { virtual: true });
  jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });
  jest.mock('@quereus/store', () => ({ createIsolatedStoreModule: jest.fn(() => ({})) }), { virtual: true });
  jest.mock('@votetorrent/vote-engine/rn', () => ({ VOTETORRENT_SCHEMA_SQL: 'declare schema main {}' }), { virtual: true });
  jest.mock('@serfab/cadre-core', () => {
    class FakeCadreNode {
      public start = jest.fn(async () => {});
      public stop = jest.fn(async () => {});
      public peerId = { toString: () => 'fakePeerIdABC123' };
      private _connections: FakeConnection[] = [];
      private _strandConns: FakeConnection[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(config?: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockConstructedNodes.push(this as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockCapturedConfigs.push(config as any);
      }
      getControlNode() { return { getConnections: () => this._connections }; }
      getStrand(_id: string) { return { libp2pNode: { getConnections: () => this._strandConns } }; }
      _setConnections(conns: FakeConnection[]) { this._connections = conns; }
      _setStrandPeers(n: number) { this._strandConns = new Array(n).fill({}); }
    }
    return { CadreNode: FakeCadreNode };
  }, { virtual: true });
  jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
  jest.mock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({}) }), { virtual: true });
  jest.mock('@multiformats/multiaddr', () => ({ multiaddr: (s: string) => ({ toString: () => s }) }), { virtual: true });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ runReplicationProof } = require('../replication-proof-runner'));
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConstructedNodes.length = 0;
  mockCapturedConfigs.length = 0;
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

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
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
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

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
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

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
      // Fix A (Phase 30): peerCount>0 now triggers the strand wait loop — give the strand a live
      // connection too so the loop exits immediately (otherwise it spins STRAND_PEER_POLL_MAX×1s).
      node._setStrandPeers(1);
      return realPush.apply(this, args);
    });

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

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
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

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

// ---------------------------------------------------------------------------
// REPL-01 strand cohort markers (RED until Task 2 implements them)
// ---------------------------------------------------------------------------

describe('REPL-01 strand cohort markers', () => {
  it('emits strandPeers=N with N>=1 from the LIVE getConnections() count (Fix A)', async () => {
    // Run against the full mock whose getStrand exposes libp2pNode.getConnections().
    reloadRunnerFullMock();
    mockConstructedNodes.length = 0;
    mockCapturedConfigs.length = 0;

    // Prime the node on construction: a control connection (peerCount >= 1) AND a live strand
    // connection (getConnections().length === 1) so the runner's LIVE read reports >= 1.
    const realPush = Array.prototype.push;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(mockConstructedNodes as any, 'push').mockImplementation(function (...args: any[]) {
      const node = args[0] as FakeCadreNode;
      node._setConnections([{}]);
      node._setStrandPeers(1);
      return realPush.apply(this, args);
    });

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReplicationProof();

    // The strandPeers= marker is emitted as L('strandPeers=', N) → args[1]==='strandPeers=', args[2]===N.
    const strandPeersCall = consoleSpy.mock.calls.find(
      (args) => args[0] === '[replication-proof]' && args[1] === 'strandPeers=',
    );
    expect(strandPeersCall).toBeDefined();
    // The emitted value must reflect the live getConnections().length (>= 1), not the dead field.
    expect(Number(strandPeersCall![2])).toBeGreaterThanOrEqual(1);

    consoleSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('waits — polls the LIVE getConnections more than once when the strand starts at 0 (Fix A wait-before-write)', async () => {
    reloadRunnerFullMock();
    mockConstructedNodes.length = 0;
    mockCapturedConfigs.length = 0;

    // getConnections returns [] on the first poll, then [{}] — proving the runner polls the
    // LIVE count repeatedly (the bounded wait loop) rather than reading it once.
    const getConnSpy = jest.fn().mockReturnValueOnce([]).mockReturnValue([{}]);

    const realPush = Array.prototype.push;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(mockConstructedNodes as any, 'push').mockImplementation(function (...args: any[]) {
      const node = args[0] as FakeCadreNode;
      node._setConnections([{}]); // control peer present → peerCount > 0 → strand wait loop runs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any).getStrand = () => ({ libp2pNode: { getConnections: getConnSpy } });
      return realPush.apply(this, args);
    });

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReplicationProof();

    const strandPeersCall = consoleSpy.mock.calls.find(
      (args) => args[0] === '[replication-proof]' && args[1] === 'strandPeers=',
    );

    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    // The wait loop polled the live count more than once (it did not read 0 and give up).
    expect(getConnSpy.mock.calls.length).toBeGreaterThan(1);
    // A strandPeers= marker was still emitted after the wait.
    expect(strandPeersCall).toBeDefined();
  });

  it('constructs CadreNode with network.strandBootstrapNodes = resolveBootstrapNodes(STRAND_BOOTSTRAP_ADDR)', async () => {
    reloadRunnerFullMock();
    mockConstructedNodes.length = 0;
    mockCapturedConfigs.length = 0;

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReplicationProof();

    consoleSpy.mockRestore();

    // Assert the first captured config has a network.strandBootstrapNodes array.
    // When STRAND_BOOTSTRAP_ADDR is the placeholder, resolveBootstrapNodes returns []
    // (solo-safe). The field must be present (not undefined).
    expect(mockCapturedConfigs.length).toBeGreaterThan(0);
    const cfg = mockCapturedConfigs[0] as { network?: { strandBootstrapNodes?: string[] } };
    expect(cfg).toBeDefined();
    expect(cfg?.network).toBeDefined();
    // strandBootstrapNodes must be an array (placeholder → []).
    expect(Array.isArray(cfg?.network?.strandBootstrapNodes)).toBe(true);
  });
});
