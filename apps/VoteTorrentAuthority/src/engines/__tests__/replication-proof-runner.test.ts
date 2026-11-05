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
// Spike 094: the runner opens a durable strand peer book (AsyncStorage-backed) before building its
// node. Mocked at the seam, once, so every per-case @serfab/cadre-core fake below stays unchanged.
// The fake book is empty, which is also what a fresh install reads.
jest.mock('../rn-durable-slot', () => ({
  openStrandNetworkState: async (partyId: string) => ({ partyId, load: () => undefined, forget: async () => undefined }),
}));

const mockConstructedNodes: FakeCadreNode[] = [];

// Captures the CadreNode constructor config for each constructed instance.
// Task-1 RED: asserts network.strandBootstrapNodes forwarding.
const mockCapturedConfigs: Array<Record<string, unknown>> = [];

// QUICK-260928-jwi: mock verifyCadrePeerVoucher, module-scope so both FakeCadreNode module
// factories can reference it (jest hoisting requires the `mock` prefix).
const mockVerifyCadrePeerVoucher = jest.fn((..._a: unknown[]) => true);

// ---------------------------------------------------------------------------
// Write-phase choreography mocks (checkpoint 3, 2026-09-28, debug session
// p2p11-multi-peer-replication) — `@votetorrent/vote-engine/rn`'s NetworkEngine and
// AuthorityEngine, replacing the earlier bare `VOTETORRENT_SCHEMA_SQL`-only virtual mock.
//
// These fakes deliberately do NOT touch `ctx.db` the way the real engine classes do (that
// would require emulating Quereus's `.prepare().get()` SQL surface, which the task brief
// explicitly scopes OUT — "test the CHOREOGRAPHY, not an end-to-end schema execution"). Instead
// they record constructor/method arguments for assertions and are individually configurable to
// succeed or fail, so tests can drive and observe: founder success, founder-fails-falls-to-join,
// and the joiner's own respondToInvite/createAuthority call shapes — without a real DB.
//
// `mock`-prefixed (module scope) per jest hoisting rules — referenced from `jest.mock(...)`
// factories below.
// ---------------------------------------------------------------------------

const mockAuthorityEngineConstructions: Array<{ authority: unknown; ctx: { user?: { id: string } } }> = [];
const mockCreateAuthorityInviteCalls: string[] = [];
const mockSaveInviteWithSigningCalls: Array<{ invite: unknown; scope: unknown }> = [];
let mockSaveInviteWithSigningShouldFail = false;
let mockSaveInviteWithSigningFailureMessage = 'CHECK constraint failed: InsertValid';

const mockNetworkEngineConstructions: Array<{ init: unknown; ctx: { user?: { id: string } } }> = [];
const mockRespondToInviteCalls: unknown[] = [];
let mockRespondToInviteShouldFail = false;
let mockRespondToInviteFailureMessage = 'respondToInvite failed';
let mockRespondToInviteReturnId = 'mock-joined-authority-id';
const mockCreateAuthorityCalls: Array<{ authorityInit: unknown; adminInit: unknown; options: unknown }> = [];
let mockCreateAuthorityShouldFail = false;
let mockCreateAuthorityFailureMessage = 'createAuthority failed';

class MockAuthorityEngineForRn {
  constructor(
    public authority: unknown,
    public ctx: { user?: { id: string } },
  ) {
    mockAuthorityEngineConstructions.push({ authority, ctx });
  }

  createAuthorityInvite(name: string) {
    mockCreateAuthorityInviteCalls.push(name);
    return {
      name,
      type: 'au' as const,
      expiration: '2099-01-01T00:00:00',
      inviteKey: 'fakeInviteKeyHex',
      invitePrivate: 'fakeInvitePrivateHex',
      inviteSignature: 'fakeInviteSignatureHex',
    };
  }

  async saveInviteWithSigning(invite: unknown, scope: unknown, cb: unknown) {
    mockSaveInviteWithSigningCalls.push({ invite, scope });
    if (mockSaveInviteWithSigningShouldFail) {
      throw new Error(mockSaveInviteWithSigningFailureMessage);
    }
    // Realism: the real engine invokes the caller's signCallback with computed digest bytes —
    // invoke it here too so a signCallback-shape bug in the runner would surface as a thrown
    // error from this call, not silently pass.
    if (typeof cb === 'function') {
      await (cb as (d: Uint8Array) => Promise<unknown>)(new Uint8Array([1, 2, 3, 4]));
    }
  }
}

class MockNetworkEngineForRn {
  constructor(
    public init: unknown,
    public localStorage: unknown,
    public ctx: { user?: { id: string } },
    public getPeerCount?: unknown,
  ) {
    mockNetworkEngineConstructions.push({ init, ctx });
  }

  async respondToInvite(action: unknown): Promise<string> {
    mockRespondToInviteCalls.push(action);
    if (mockRespondToInviteShouldFail) {
      throw new Error(mockRespondToInviteFailureMessage);
    }
    return mockRespondToInviteReturnId;
  }

  async createAuthority(authorityInit: unknown, adminInit: unknown, options?: unknown): Promise<void> {
    mockCreateAuthorityCalls.push({ authorityInit, adminInit, options });
    if (mockCreateAuthorityShouldFail) {
      throw new Error(mockCreateAuthorityFailureMessage);
    }
  }
}

// Ordered log of strand-handle events ('register' from registerDbPlugins, 'exec' from a write)
// so a test can assert UDF registration happens before the first write on the handle.
const mockDbEvents: string[] = [];

function mockVoteEngineRnModule() {
  return {
    VOTETORRENT_SCHEMA_SQL: 'declare schema main {}',
    registerDbPlugins: async (_db: unknown) => {
      mockDbEvents.push('register');
    },
    NetworkEngine: MockNetworkEngineForRn,
    AuthorityEngine: MockAuthorityEngineForRn,
  };
}

// Reset every choreography-mock recording array/flag to its default (founder-succeeds) state.
// Call from beforeEach / at the start of any test that overrides them.
function mockResetChoreographyMocks(): void {
  mockAuthorityEngineConstructions.length = 0;
  mockCreateAuthorityInviteCalls.length = 0;
  mockSaveInviteWithSigningCalls.length = 0;
  mockSaveInviteWithSigningShouldFail = false;
  mockSaveInviteWithSigningFailureMessage = 'CHECK constraint failed: InsertValid';
  mockNetworkEngineConstructions.length = 0;
  mockRespondToInviteCalls.length = 0;
  mockRespondToInviteShouldFail = false;
  mockRespondToInviteFailureMessage = 'respondToInvite failed';
  mockRespondToInviteReturnId = 'mock-joined-authority-id';
  mockCreateAuthorityCalls.length = 0;
  mockCreateAuthorityShouldFail = false;
  mockCreateAuthorityFailureMessage = 'createAuthority failed';
}

type VoucherRow = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
};

interface FakeCadreNode {
  start: jest.Mock;
  stop: jest.Mock;
  peerId: { toString: () => string };
  getControlNode: () => { getConnections: () => FakeConnection[] };
  // Fix A (Phase 30): getStrand exposes the live libp2pNode.getConnections() the runner reads.
  getStrand: (id: string) => { libp2pNode?: { getConnections?: () => FakeConnection[] } } | undefined;
  _setConnections: (conns: FakeConnection[]) => void;
  _setStrandPeers: (n: number) => void;
  // The real library excludes self unconditionally (check 1) — this is exactly what hid the
  // section-4b defect, so the mock must too. Never returns the self peerId.
  listAuthorizedMembers: jest.Mock;
  // Section 4b write gate: isSelfVouched() reads THIS peer's own CadrePeer row via
  // getControlDatabase().queryCadrePeers(). queryCadrePeers is driven by _selfAuthorized:
  // vouched (complete voucher) when true, unvouched (self-published, no voucher yet) when false.
  queryCadrePeers: jest.Mock;
  getControlDatabase: () => { queryCadrePeers: jest.Mock };
  getTrustedOwnerStore: () => { has: (k: string) => boolean };
  _setSelfAuthorized: (authorized: boolean) => void;
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
  () => mockVoteEngineRnModule(),
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

      // The runner polls getMultiaddrs() for a '/p2p-circuit' entry to emit the D-09
      // relayReservation= marker. The mock lacked it entirely, so the call threw and the
      // runner's catch-all swallowed the rest of the proof — which is why every assertion
      // AFTER that point (peers=, strandPeers=, the constructor config) failed while the
      // markers before it passed. Return a reserved address by default; _setRelayReserved(false)
      // exercises the unreserved path.
      private _circuitAddrs: Array<{ toString(): string }> = [
        { toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' },
      ];

      getMultiaddrs() {
        return this._circuitAddrs;
      }

      _setRelayReserved(reserved: boolean) {
        this._circuitAddrs = reserved
          ? [{ toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' }]
          : [];
      }

      // Cadre membership ceremony (P2P-11). The runner redeems an injected cadre invitation after
      // the relay reservation and before the strand work; with the committed placeholder it takes
      // the skip branch, so this exists to be ASSERTED ON — chiefly that it is NOT called when no
      // invite is injected.
      public partyId = 'votetorrent';
      public redeemCadreInvitation = jest.fn(async () => ({ peerId: null, redeemedAt: '' }));

      // Section 4b write gate (run 18): the runner will not write until this peer's own
      // CadrePeer row carries a voucher from an owner anchored in the local trust store — the
      // same predicate cadre-core's authorizeInboundControlStream consults. Vouched by DEFAULT,
      // or every test asserting on a post-write marker would sit through the gate's full 90 s
      // budget in real time.
      //
      // listAuthorizedMembers ALWAYS excludes self (check 1 — real cadre-core does this
      // unconditionally, `row.peerId !== selfPeerId`), which is exactly what hid the
      // QUICK-260928-jwi defect: the old gate looked up self in a list that can never contain it.
      public listAuthorizedMembers = jest.fn(async () => []);

      private _selfAuthorized = true;
      public queryCadrePeers = jest.fn(async (): Promise<VoucherRow[]> => [
        this._selfAuthorized
          ? {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: 'stamp-1',
              vouchOwner: 'ownerKeyB64',
              vouchSig: 'sigB64',
            }
          : {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: null,
              vouchOwner: null,
              vouchSig: null,
            },
      ]);

      getControlDatabase() {
        return { queryCadrePeers: this.queryCadrePeers };
      }

      getTrustedOwnerStore() {
        return { has: (k: string) => k === 'ownerKeyB64' };
      }

      _setSelfAuthorized(authorized: boolean) {
        this._selfAuthorized = authorized;
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
    return {
      CadreNode: FakeCadreNode,
      verifyCadrePeerVoucher: (...a: unknown[]) => mockVerifyCadrePeerVoucher(...a),
      verifyInvitationAdmission: () => false,
      decodeCadreInvitation: (s: string) => ({ v: 1, partyId: 'votetorrent', ownerKeys: [], members: [], encoded: s }),
    };
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
  mockVerifyCadrePeerVoucher.mockReset();
  mockVerifyCadrePeerVoucher.mockImplementation((..._a: unknown[]) => true);
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
  jest.mock('@votetorrent/vote-engine/rn', () => mockVoteEngineRnModule(), { virtual: true });
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
      // Must mirror the module-level FakeCadreNode above — see the note there on why a
      // missing getMultiaddrs() silently truncated the whole proof. The two mocks are
      // near-duplicates; a method added to one belongs in both.
      private _circuitAddrs: Array<{ toString(): string }> = [
        { toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' },
      ];
      getMultiaddrs() { return this._circuitAddrs; }
      _setRelayReserved(reserved: boolean) {
        this._circuitAddrs = reserved
          ? [{ toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' }]
          : [];
      }
      public partyId = 'votetorrent';
      public redeemCadreInvitation = jest.fn(async () => ({ peerId: null, redeemedAt: '' }));
      // Section 4b write gate — mirrors the module-level mock; vouched by default.
      // listAuthorizedMembers ALWAYS excludes self (check 1) — exactly what hid the defect.
      public listAuthorizedMembers = jest.fn(async () => []);
      private _selfAuthorized = true;
      public queryCadrePeers = jest.fn(async (): Promise<VoucherRow[]> => [
        this._selfAuthorized
          ? {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: 'stamp-1',
              vouchOwner: 'ownerKeyB64',
              vouchSig: 'sigB64',
            }
          : {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: null,
              vouchOwner: null,
              vouchSig: null,
            },
      ]);
      getControlDatabase() { return { queryCadrePeers: this.queryCadrePeers }; }
      getTrustedOwnerStore() { return { has: (k: string) => k === 'ownerKeyB64' }; }
      _setSelfAuthorized(authorized: boolean) { this._selfAuthorized = authorized; }
      getControlNode() { return { getConnections: () => this._connections }; }
      getStrand(_id: string) { return { libp2pNode: { getConnections: () => this._strandConns } }; }
      _setConnections(conns: FakeConnection[]) { this._connections = conns; }
      _setStrandPeers(n: number) { this._strandConns = new Array(n).fill({}); }
    }
    return {
      CadreNode: FakeCadreNode,
      verifyCadrePeerVoucher: (...a: unknown[]) => mockVerifyCadrePeerVoucher(...a),
      verifyInvitationAdmission: () => false,
      decodeCadreInvitation: (s: string) => ({ v: 1, partyId: 'votetorrent', ownerKeys: [], members: [], encoded: s }),
    };
  }, { virtual: true });
  jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
  jest.mock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({}) }), { virtual: true });
  jest.mock('@multiformats/multiaddr', () => ({ multiaddr: (s: string) => ({ toString: () => s }) }), { virtual: true });
  // Fix A (Phase 30): the strandPeers wait loop now runs AFTER the strand is created in the write
  // phase (createStrandDbFactory → addStrand). Mock rn-db-factory so the write phase succeeds (the
  // real factory calls node.addStrand, which the FakeCadreNode mock does not implement) and the
  // runner reaches the wait loop + strandPeers= emit. eval yields one row so the read poll exits fast.
  jest.mock('../rn-db-factory', () => ({
    createStrandDbFactory: () => async () => ({
      exec: async () => undefined,
      // Manual async-iterable (NOT an async generator — jest.mock factories forbid the
      // _wrapAsyncGenerator babel helper). Yields exactly one foreign row so the read poll
      // sets verdict=true and exits on the first tick.
      eval: () => {
        let sent = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () =>
                sent
                  ? { done: true, value: undefined }
                  : ((sent = true), { done: false, value: { Id: 'repl-auth-otherpeer' } }),
            };
          },
        };
      },
    }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ runReplicationProof } = require('../replication-proof-runner'));
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConstructedNodes.length = 0;
  mockCapturedConfigs.length = 0;
  mockResetChoreographyMocks();
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
      () => mockVoteEngineRnModule(),
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
      () => mockVoteEngineRnModule(),
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

  it('does NOT pass the retired strandBootstrapNodes / strandNetwork keys (dead config since cadre-core 0.10.0)', async () => {
    reloadRunnerFullMock();
    mockConstructedNodes.length = 0;
    mockCapturedConfigs.length = 0;

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    await runReplicationProof();

    consoleSpy.mockRestore();

    // This asserted `Array.isArray(network.strandBootstrapNodes)` until 2026-09-03, which is
    // backwards: cadre-core 0.10.0 REPLACED that key with `resolveCohortSeed` (strand peers
    // are derived from the CONTROL cohort via the `/sereus/strand-addr/1.0.0` RPC, not from an
    // app-supplied strand multiaddr), and the runner's own comment records both it and
    // `strandNetwork` as dead config with zero occurrences in the published types. The old
    // assertion would have forced retired keys back into the config. Lock their ABSENCE.
    expect(mockCapturedConfigs.length).toBeGreaterThan(0);
    const cfg = mockCapturedConfigs[0] as {
      network?: Record<string, unknown>;
      strandNetwork?: unknown;
    };
    expect(cfg).toBeDefined();
    expect(cfg?.network).toBeDefined();
    expect(cfg?.network?.strandBootstrapNodes).toBeUndefined();
    expect(cfg?.strandNetwork).toBeUndefined();
  });

  // ── cadre membership (P2P-11) ────────────────────────────────────────────────────────
  // The runner redeems an injected invite so the drone will admit it as a member; without
  // membership its strand-addr request is refused and the cohort never forms. The committed
  // source carries the placeholder (the harness injects the real invite per-run), so what is
  // assertable here is the placeholder branch — and that it is loud rather than silent.
  describe('cadre enrolment markers', () => {
    it('emits enrolInvite=skipped and does NOT dial when no invite is injected', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      await runReplicationProof();
      const calls = consoleSpy.mock.calls;
      consoleSpy.mockRestore();

      // Unconditional marker: an unenrolled run must be legible AS unenrolled, not merely
      // fail later as an unexplained empty strand cohort — the exact misdiagnosis that cost
      // every device run through 41-09.
      const enrolCall = calls.find(
        (args) => args[0] === '[replication-proof]' && String(args[1]).startsWith('enrolInvite='),
      );
      expect(enrolCall).toBeDefined();
      expect(String(enrolCall![1])).toContain('skipped');

      // The placeholder must not be dialed as if it were an invite.
      const node = mockConstructedNodes[0] as unknown as { redeemCadreInvitation: jest.Mock };
      expect(node.redeemCadreInvitation).not.toHaveBeenCalled();
    });

    it('emits the enrolment marker AFTER relayReservation= and BEFORE strandPeers=', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      await runReplicationProof();
      const markers = consoleSpy.mock.calls
        .filter((args) => args[0] === '[replication-proof]')
        .map((args) => String(args[1]));
      consoleSpy.mockRestore();

      const idx = (prefix: string) => markers.findIndex((m) => m.startsWith(prefix));
      const relay = idx('relayReservation=');
      const enrol = idx('enrolInvite=');
      const strand = idx('strandPeers=');

      expect(relay).toBeGreaterThanOrEqual(0);
      expect(enrol).toBeGreaterThanOrEqual(0);
      expect(strand).toBeGreaterThanOrEqual(0);
      // Ordering is load-bearing, not cosmetic. Before the reservation, a relay-only peer can
      // still be without a circuit address on cadre-core 0.12.0 and the ceremony reads control
      // state nobody can serve yet (`peers-unreachable`) — a timing artifact that reads as a
      // membership verdict. After the strand work, the strand-addr request has already been
      // refused for non-membership and the cohort has already failed to form.
      expect(enrol).toBeGreaterThan(relay);
      expect(enrol).toBeLessThan(strand);
    });
  });

  // ── section 4b write gate (run 18) ───────────────────────────────────────────────────
  // `enrolInvite=ok` means only that THIS peer dialed the invite. The owner-side acceptPhone
  // is the half that confers membership, and on the n=4 device run it landed 90 s (Peer A) and
  // 134 s (Peer B) LATER. Both peers wrote inside that gap, every cohort stream the write needed
  // was refused for non-membership, and the commit reported success anyway (Optimystic#19), so
  // the run failed with each peer holding only its own row. The gate waits for the owner's
  // decision to be visible HERE before writing.
  describe('write gate — owner authorization', () => {
    it('emits cadreAuthorized= AFTER peers= and BEFORE strandPeers=', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      await runReplicationProof();
      const markers = consoleSpy.mock.calls
        .filter((args) => args[0] === '[replication-proof]')
        .map((args) => String(args[1]));
      consoleSpy.mockRestore();

      const idx = (prefix: string) => markers.findIndex((m) => m.startsWith(prefix));
      const peers = idx('peers=');
      const auth = idx('cadreAuthorized=');
      const strand = idx('strandPeers=');

      expect(auth).toBeGreaterThanOrEqual(0);
      // After peers=: the harness has that marker in hand before this blocks, so the wait is
      // absorbed by its 300 s REPL-01 window rather than a shorter marker timeout.
      expect(auth).toBeGreaterThan(peers);
      // Before strandPeers=: strandPeers is emitted after the write, which is what this gates.
      expect(auth).toBeLessThan(strand);
    });

    // QUICK-260928-jwi REGRESSION: the mock now behaves like the REAL library —
    // listAuthorizedMembers ALWAYS excludes self (check 1) — while this peer's own CadrePeer row
    // is vouched by an owner anchored in the local trust store and verify succeeds. Against the
    // OLD `members.some(m => m.peerId === peerId)` gate this can never pass: `members` is always
    // `[]`, so `cadreAuthorized=` resolves `false` after burning the full AUTH_GATE_BUDGET_MS.
    // Against the NEW isSelfVouched() gate it must resolve `true` promptly.
    it('reports cadreAuthorized= true from the self-voucher, even though listAuthorizedMembers excludes self (regression)', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const realPush = Array.prototype.push;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      jest.spyOn(mockConstructedNodes as any, 'push').mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        function (this: unknown[], ...args: any[]) {
          const node = args[0] as FakeCadreNode;
          node._setConnections([{}]);
          node._setStrandPeers(1);
          return realPush.apply(this, args);
        },
      );

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      await runReplicationProof();
      const calls = consoleSpy.mock.calls;
      consoleSpy.mockRestore();
      jest.restoreAllMocks();

      const authCall = calls.find(
        (args) => args[0] === '[replication-proof]' && args[1] === 'cadreAuthorized=',
      );
      expect(authCall).toBeDefined();
      // L('cadreAuthorized=', selfAuthorized, 'after', <n>, 's') — args[2] is the boolean.
      expect(authCall![2]).toBe(true);
      expect(mockVerifyCadrePeerVoucher).toHaveBeenCalledWith(
        'votetorrent', 'fakePeerIdABC123', 'stamp-1', 'ownerKeyB64', 'sigB64',
      );
    }, 120000);

    it('BLOCKS until this peer\'s own row carries an anchored voucher', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const proof = runReplicationProof();

      // Deny the first poll, admit the second — the real shape, where the owner's acceptPhone
      // lands while this peer is already polling. Driven off the CALL COUNT rather than a wall
      // clock: the gate runs several seconds after construction, so a timed flip would race it.
      // The node is constructed inside runReplicationProof(), so wait for it to exist first.
      for (let i = 0; i < 500 && mockConstructedNodes.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 10));
      }
      const node = mockConstructedNodes[0] as unknown as {
        queryCadrePeers: jest.Mock;
        _setConnections: (c: FakeConnection[]) => void;
      };
      // The gate only runs when this peer has a cohort to be authorized BY — peers=0 skips it.
      node._setConnections([{} as FakeConnection]);
      let polls = 0;
      node.queryCadrePeers.mockImplementation(async () => {
        polls += 1;
        return polls >= 2
          ? [{ peerId: 'fakePeerIdABC123', multiaddr: null, stampId: 'stamp-1', vouchOwner: 'ownerKeyB64', vouchSig: 'sigB64' }]
          : [{ peerId: 'fakePeerIdABC123', multiaddr: null, stampId: null, vouchOwner: null, vouchSig: null }];
      });

      await proof;
      const markers = consoleSpy.mock.calls
        .filter((args) => args[0] === '[replication-proof]')
        .map((args) => String(args[1]));
      consoleSpy.mockRestore();

      // It polled more than once — i.e. it actually waited rather than reading the row once and
      // proceeding regardless, which is precisely what `enrolInvite=ok` did.
      expect(node.queryCadrePeers.mock.calls.length).toBeGreaterThan(1);
      expect(markers.some((m) => m.startsWith('cadreAuthorized='))).toBe(true);
    }, 60000);

    // Run 19 died exactly here. While this peer is a non-member its control-DB reads are the thing
    // being denied, and a self-voucher read does not always throw that denial — it can simply
    // never settle. An un-raced await blocked the proof for 8+ minutes: no write, no strand, no
    // verdict, and the harness timed out at REPL-01 while the drones logged 178
    // NoValidAddressesError against a strand node that could never exist.
    it('treats a call that never settles as "not yet" instead of hanging forever', async () => {
      reloadRunnerFullMock();
      mockConstructedNodes.length = 0;

      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const proof = runReplicationProof();

      for (let i = 0; i < 500 && mockConstructedNodes.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 10));
      }
      const node = mockConstructedNodes[0] as unknown as {
        queryCadrePeers: jest.Mock;
        _setConnections: (c: FakeConnection[]) => void;
      };
      node._setConnections([{} as FakeConnection]);
      let polls = 0;
      node.queryCadrePeers.mockImplementation(() => {
        polls += 1;
        // First poll never settles; the second answers vouched.
        return polls === 1
          ? new Promise(() => {})
          : Promise.resolve([{ peerId: 'fakePeerIdABC123', multiaddr: null, stampId: 'stamp-1', vouchOwner: 'ownerKeyB64', vouchSig: 'sigB64' }]);
      });

      await proof;
      const markers = consoleSpy.mock.calls
        .filter((args) => args[0] === '[replication-proof]')
        .map((args) => String(args[1]));
      consoleSpy.mockRestore();

      // It got past the stalled call and reached a verdict rather than blocking on it.
      expect(polls).toBeGreaterThan(1);
      expect(markers.some((m) => m.startsWith('cadreAuthorized='))).toBe(true);
      expect(markers.some((m) => m.startsWith('strandPeers='))).toBe(true);
    }, 60000);
  });
});

// ---------------------------------------------------------------------------
// Harness false-PASS fix (2026-09-28, debug session p2p11-multi-peer-replication).
//
// CORRECTION 3 / Eliminated ("Peer B's VERDICT: PASS ... represents a genuine passing
// replication result"): a live device run had this peer's OWN Authority insert fail with
// `CHECK constraint failed: InsertValid`, yet the runner still reported PASS because it merely
// saw the OTHER peer's row in its read set. The verdict must require BOTH this peer's own write
// having landed AND having read another peer's row — not either alone.
//
// `reloadRunnerWithControlledDb` mirrors `reloadRunnerFullMock` (same FakeCadreNode) but replaces
// the `../rn-db-factory` mock with one that distinguishes the write-phase choreography's own
// query shapes (checkpoint 3, 2026-09-28 — see replication-proof-runner.ts's write-phase doc
// comment): the idempotency presence check (`FROM Officer WHERE UserId`), the founder's own
// `insert into Authority` (can be told to fail — the "lost the race" case — via the `mock`-
// prefixed module-scope flags below, per jest hoisting rules), the joiner's InviteSlot poll
// (`FROM InviteSlot WHERE Type`), and the read-phase census query (`SELECT Id FROM Authority`,
// no WHERE) — each independently controllable so a test can drive founder success, founder-
// fails-falls-to-join, or a genuinely empty read set without conflating them.
// ---------------------------------------------------------------------------

let mockAuthorityInsertShouldFail = false;
let mockAuthorityInsertFailureMessage = 'CHECK constraint failed: InsertValid';
let mockInviteSlotAvailable = true;
let mockForeignRowOnRead = true;
// Leg-6b false-PASS regression (2026-09-28T20:03): when set, overrides `mockForeignRowOnRead`
// entirely and returns EXACTLY these ids from the read-phase `SELECT Id FROM Authority` census —
// lets a test assert the read set is composed of specific ids (e.g. this peer's own orphan PLUS
// its own joined authority, no genuinely foreign row) rather than only "some fixed foreign id or
// nothing".
let mockReadRowIds: string[] | null = null;

function reloadRunnerWithControlledDb(): void {
  mockVerifyCadrePeerVoucher.mockReset();
  mockVerifyCadrePeerVoucher.mockImplementation((..._a: unknown[]) => true);
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
  jest.mock('@votetorrent/vote-engine/rn', () => mockVoteEngineRnModule(), { virtual: true });
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
      private _circuitAddrs: Array<{ toString(): string }> = [
        { toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' },
      ];
      getMultiaddrs() { return this._circuitAddrs; }
      _setRelayReserved(reserved: boolean) {
        this._circuitAddrs = reserved
          ? [{ toString: () => '/ip4/10.0.2.2/tcp/1/ws/p2p/fakeRelay/p2p-circuit' }]
          : [];
      }
      public partyId = 'votetorrent';
      public redeemCadreInvitation = jest.fn(async () => ({ peerId: null, redeemedAt: '' }));
      public listAuthorizedMembers = jest.fn(async () => []);
      private _selfAuthorized = true;
      public queryCadrePeers = jest.fn(async (): Promise<VoucherRow[]> => [
        this._selfAuthorized
          ? {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: 'stamp-1',
              vouchOwner: 'ownerKeyB64',
              vouchSig: 'sigB64',
            }
          : {
              peerId: 'fakePeerIdABC123',
              multiaddr: null,
              stampId: null,
              vouchOwner: null,
              vouchSig: null,
            },
      ]);
      getControlDatabase() { return { queryCadrePeers: this.queryCadrePeers }; }
      getTrustedOwnerStore() { return { has: (k: string) => k === 'ownerKeyB64' }; }
      _setSelfAuthorized(authorized: boolean) { this._selfAuthorized = authorized; }
      getControlNode() { return { getConnections: () => this._connections }; }
      getStrand(_id: string) { return { libp2pNode: { getConnections: () => this._strandConns } }; }
      _setConnections(conns: FakeConnection[]) { this._connections = conns; }
      _setStrandPeers(n: number) { this._strandConns = new Array(n).fill({}); }
    }
    return {
      CadreNode: FakeCadreNode,
      verifyCadrePeerVoucher: (...a: unknown[]) => mockVerifyCadrePeerVoucher(...a),
      verifyInvitationAdmission: () => false,
      decodeCadreInvitation: (s: string) => ({ v: 1, partyId: 'votetorrent', ownerKeys: [], members: [], encoded: s }),
    };
  }, { virtual: true });
  jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
  jest.mock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({}) }), { virtual: true });
  jest.mock('@multiformats/multiaddr', () => ({ multiaddr: (s: string) => ({ toString: () => s }) }), { virtual: true });
  // Query-shape-aware exec/eval so the write-phase choreography's distinct steps (idempotency
  // check, founder genesis inserts, joiner InviteSlot poll, read-phase census) can each be
  // driven independently — see the `mock`-prefixed flags declared above this function.
  jest.mock('../rn-db-factory', () => ({
    createStrandDbFactory: () => async () => ({
      exec: async (sql: string) => {
        mockDbEvents.push('exec');
        if (mockAuthorityInsertShouldFail && /insert into Authority/.test(sql)) {
          throw new Error(mockAuthorityInsertFailureMessage);
        }
      },
      eval: (sql: string) => {
        let rows: Array<Record<string, unknown>> = [];
        if (/FROM Officer WHERE UserId/.test(sql)) {
          rows = []; // never idempotent-skip in these tests — the genesis/join attempt must run
        } else if (/FROM InviteSlot WHERE Type/.test(sql)) {
          rows = mockInviteSlotAvailable
            ? [{ Cid: 'mock-slot-cid', InviteKey: 'mock-invite-key', InviteSignature: 'mock-invite-sig' }]
            : [];
        } else if (/SELECT Id FROM Authority/.test(sql)) {
          rows = mockReadRowIds
            ? mockReadRowIds.map((id) => ({ Id: id }))
            : mockForeignRowOnRead
              ? [{ Id: 'repl-auth-otherpeer' }]
              : [];
        }
        let i = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () =>
                i < rows.length
                  ? { done: false, value: rows[i++] }
                  : { done: true, value: undefined },
            };
          },
        };
      },
    }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ runReplicationProof } = require('../replication-proof-runner'));
}

function primeConnectedNode(): void {
  const realPush = Array.prototype.push;
  jest.spyOn(mockConstructedNodes as any, 'push').mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function (this: unknown[], ...args: any[]) {
      const node = args[0] as FakeCadreNode;
      node._setConnections([{}]);
      node._setStrandPeers(1);
      return realPush.apply(this, args);
    },
  );
}

describe('runReplicationProof — verdict composition (harness false-PASS fix)', () => {
  beforeEach(() => {
    mockAuthorityInsertShouldFail = false;
    mockAuthorityInsertFailureMessage = 'CHECK constraint failed: InsertValid';
    mockInviteSlotAvailable = true;
    mockForeignRowOnRead = true;
    mockReadRowIds = null;
    mockDbEvents.length = 0;
  });

  // Checkpoint 4, item 2: the leg-6b founder failed `Function not found: SignatureValidP256/3`
  // because the proof took its strand handle straight from the DbFactory and never ran
  // registerDbPlugins (NetworksEngine always does). Lock that the handle is registered before
  // anything is written to it.
  it('registers vote-engine UDFs on the strand handle before the first write', async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    expect(mockDbEvents).toContain('register');
    expect(mockDbEvents).toContain('exec');
    expect(mockDbEvents.indexOf('register')).toBeLessThan(mockDbEvents.indexOf('exec'));
  }, 20000);

  // Both the founder attempt AND the join-via-invite fallback fail — a genuine total write-phase
  // failure, not the old single-insert-failure shape. Driven fast (no 60s InviteSlot-poll wait):
  // the founder's own Authority insert fails immediately (mockAuthorityInsertShouldFail), and the
  // fallback join attempt finds an InviteSlot but its NetworkEngine.respondToInvite call itself
  // fails (mockRespondToInviteShouldFail) — exercising the outer write-phase catch either way.
  it("FAILs when this peer's own write fails, even though it reads another peer's row", async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    mockAuthorityInsertShouldFail = true;
    mockRespondToInviteShouldFail = true;
    mockRespondToInviteFailureMessage = 'respondToInvite failed (fixture)';
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    // The founder attempt really did fail and fell back to the joiner (sanity check on the
    // fixture, not just the verdict).
    const fallbackCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('falling back to join-via-invite'),
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall!.join(' ')).toContain('InsertValid');

    // ...and the join attempt itself also failed for real (via respondToInvite).
    const writeErrCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('write phase error'),
    );
    expect(writeErrCall).toBeDefined();
    expect(writeErrCall!.join(' ')).toContain('respondToInvite failed (fixture)');

    // It DID see the other peer's row (the old buggy predicate would have PASSed on this alone —
    // the write-phase choreography's founder never resolved an authority id of its own here, so
    // the read-phase predicate falls back to the 'repl-auth-' prefix heuristic; see the runner's
    // isForeignAuthorityRow doc comment).
    const readTickCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('authorityRows= 1'),
    );
    expect(readTickCall).toBeDefined();

    const verdictCall = calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.join(' ')).toContain('FAIL');
    expect(verdictCall!.join(' ')).not.toContain('PASS');
  }, 20000);

  it("PASSes when this peer's own write succeeds (founder path) AND it reads another peer's row", async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    mockAuthorityInsertShouldFail = false;
    mockForeignRowOnRead = true;
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    const founderCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('founder published authority + invite'),
    );
    expect(founderCall).toBeDefined();

    // The real AuthorityEngine invite-issuance ceremony was actually exercised: a real invite
    // was created and saveInviteWithSigning was called with the 'iad' scope.
    expect(mockCreateAuthorityInviteCalls.length).toBe(1);
    expect(mockSaveInviteWithSigningCalls.length).toBe(1);
    expect(mockSaveInviteWithSigningCalls[0]!.scope).toBe('iad');
    // The joiner path was NOT exercised — the founder attempt succeeded outright.
    expect(mockNetworkEngineConstructions.length).toBe(0);

    const verdictCall = calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.join(' ')).toContain('PASS');
  }, 20000);

  // No foreign row ever appears, so the read poll must exhaust the FULL REPL_POLL_MAX
  // (120 ticks x POLL_INTERVAL_MS) before giving up — a genuinely ~120s wait, unlike the other
  // two tests above which exit on the first tick. Timeout sized accordingly (same pattern as
  // the write-gate describe block's 60000/120000ms tests elsewhere in this file).
  it('FAILs when this peer sees no other row, even though its own write succeeded', async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    mockAuthorityInsertShouldFail = false;
    mockForeignRowOnRead = false;
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    const verdictCall = calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.join(' ')).toContain('FAIL');
  }, 150000);

  // Checkpoint 3 (2026-09-28): the join-via-invite fallback itself, driven to a SUCCESSFUL
  // completion — the founder attempt loses the Authority race (mockAuthorityInsertShouldFail),
  // this peer finds the (mocked) founder's InviteSlot, accepts it via the real
  // NetworkEngine.respondToInvite() authority-accept branch, and creates its own authority via
  // the real invite-bound NetworkEngine.createAuthority(..., { inviteSlotCid, inviteSignature }).
  // This is the choreography's "issue -> accept -> invite-bound insert" call sequence the task
  // brief asked to be tested — verified here as call shapes/argument plumbing, not a real schema
  // execution (no real Optimystic/cadre-core runtime in jest — see the file header).
  it('falls back to join-via-invite when the founder loses the Authority race, and completes via the real invite flow', async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    mockAuthorityInsertShouldFail = true;
    mockInviteSlotAvailable = true;
    mockRespondToInviteReturnId = 'mock-joined-authority-id';
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    // The founder attempt was tried and lost the race — it never reached AuthorityEngine
    // construction (the Authority insert throws before that point).
    expect(mockAuthorityEngineConstructions.length).toBe(0);

    // The joiner path ran for real: NetworkEngine was constructed, respondToInvite was called
    // with the InviteSlot's own inviteKey (public — read directly from the shared strand DB,
    // exactly as a real out-of-band-delivered invite share would carry it), and createAuthority
    // was called with the invite-bound options carrying that same slot's Cid.
    expect(mockNetworkEngineConstructions.length).toBe(1);
    expect(mockRespondToInviteCalls.length).toBe(1);
    expect((mockRespondToInviteCalls[0] as { invite: { inviteKey: string } }).invite.inviteKey).toBe(
      'mock-invite-key',
    );
    expect(mockCreateAuthorityCalls.length).toBe(1);
    expect(
      (mockCreateAuthorityCalls[0] as { options: { inviteSlotCid: string; inviteSignature: string } }).options,
    ).toMatchObject({ inviteSlotCid: 'mock-slot-cid' });

    const joinedCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('joined authority via real invite flow'),
    );
    expect(joinedCall).toBeDefined();
    expect(joinedCall!.join(' ')).toContain('mock-joined-authority-id');

    const verdictCall = calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();
    // No foreign row configured this test (mockForeignRowOnRead defaults true from beforeEach,
    // but this peer's OWN resolved authority id is the joiner's mock-returned id, which differs
    // from the default foreign fixture row 'repl-auth-otherpeer' — so sawOtherPeerRow is true and
    // ownWriteOk is true: PASS).
    expect(verdictCall!.join(' ')).toContain('PASS');
  }, 20000);

  // Leg-6b false-PASS regression (2026-09-28T20:03, ORCHESTRATOR CORRECTION / checkpoint-4
  // item 1): reproduces the EXACT on-device shape — this peer's founder attempt commits its
  // `repl-auth-<tail>` Authority row, then fails LATER in the SAME genesis ceremony (on-device:
  // `saveInviteWithSigning` threw `QuereusError: Function not found: SignatureValidP256/3`),
  // falls back to attemptJoinViaInvite, and that succeeds under a DIFFERENT (invite-bound) id.
  // The read-phase census then sees BOTH of this peer's own rows (the orphan + the joined
  // authority) and NO row that was genuinely written by the other peer (Peer A never wrote at
  // all in leg 6b). Before the fix, the single-id `id !== myAuthorityId` predicate counted the
  // orphan as "the other peer's row" and the verdict falsely PASSed. After the fix, both ids are
  // recognized as this peer's own (via ownAuthorityIds) and the verdict correctly FAILs.
  it('leg-6b shape, corrected by spike 095: a founder whose row committed NEVER redeems an invite, and its own row is not foreign', async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    // Founder's own Authority insert SUCCEEDS (commits the 'repl-auth-<tail>' orphan row) ...
    mockAuthorityInsertShouldFail = false;
    // ... but the ceremony fails LATER, in the real threshold-signing invite-issuance call —
    // exactly where leg 6b's device run failed, on a missing SQL function.
    mockSaveInviteWithSigningShouldFail = true;
    mockSaveInviteWithSigningFailureMessage =
      "Unknown error: QuereusError: Function not found: SignatureValidP256/3";
    // An InviteSlot IS visible (on-device it was this founder's OWN, committed before the
    // signing step threw). The joiner path would redeem it; spike 095 leg 3 caught exactly that.
    mockInviteSlotAvailable = true;
    mockRespondToInviteShouldFail = false;
    mockCreateAuthorityShouldFail = false;
    mockRespondToInviteReturnId = '242d5575-8170-4f17-930c-cd219bc06408';
    // The read-phase census sees ONLY this peer's own founder row — no genuinely foreign row.
    mockReadRowIds = ['repl-auth-IdABC123'];
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    // Sanity check on the fixture: the founder attempt really did reach the real invite-issuance
    // ceremony (AuthorityEngine was constructed, saveInviteWithSigning was called) and really did
    // fail there, not at the Authority insert itself.
    expect(mockAuthorityEngineConstructions.length).toBe(1);
    expect(mockSaveInviteWithSigningCalls.length).toBe(1);
    const fallbackCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('falling back to join-via-invite'),
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall!.join(' ')).toContain('SignatureValidP256/3');

    // SPIKE 095: the founder does NOT redeem the invite. It keeps its role and leaves the open
    // slot for the sibling. Before the fix it joined through its own slot, spending it.
    expect(mockRespondToInviteCalls.length).toBe(0);
    expect(calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('joined authority via real invite flow'),
    )).toBeUndefined();
    const founderHeldCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('founder row committed and invite open for the sibling'),
    );
    expect(founderHeldCall).toBeDefined();
    expect(founderHeldCall!.join(' ')).toContain('repl-auth-IdABC123');

    // The read phase saw exactly the one row configured — this peer's own.
    const readTickCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('authorityRows= 1'),
    );
    expect(readTickCall).toBeDefined();
    expect(readTickCall!.join(' ')).toContain('repl-auth-IdABC123');

    // ownWriteOk=true (the founder row is this peer's own committed write) but
    // sawOtherPeerRow=false (its own row is never foreign).
    const verdictInputsCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args[1] === 'verdict inputs: ownWriteOk=',
    );
    expect(verdictInputsCall).toBeDefined();
    expect(verdictInputsCall![2]).toBe(true); // ownWriteOk
    expect(verdictInputsCall![4]).toBe(false); // sawOtherPeerRow — the leg-6b false-PASS lock

    const verdictCall = calls.find(
      (args) =>
        args[0] === '[replication-proof]' &&
        args.join(' ').includes('========== REPLICATION VERDICT'),
    );
    expect(verdictCall).toBeDefined();
    expect(verdictCall!.join(' ')).toContain('FAIL');
    expect(verdictCall!.join(' ')).not.toContain('PASS');
  }, 150000); // no foreign row ever appears, so the read phase polls its full window (~120s)

  it('spike 095: a founder whose row committed but who cannot open an invite FAILs its write rather than joining', async () => {
    reloadRunnerWithControlledDb();
    mockConstructedNodes.length = 0;
    mockAuthorityInsertShouldFail = false;
    mockSaveInviteWithSigningShouldFail = true; // the first ceremony AND every retry fail
    mockSaveInviteWithSigningFailureMessage = 'the repo could not determine whether it exists';
    mockInviteSlotAvailable = false; // nothing was published
    mockRespondToInviteShouldFail = false;
    mockReadRowIds = ['repl-auth-IdABC123'];
    primeConnectedNode();

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await runReplicationProof();
    const calls = consoleSpy.mock.calls;
    consoleSpy.mockRestore();
    jest.restoreAllMocks();

    expect(mockSaveInviteWithSigningCalls.length).toBe(1 + 3); // the ceremony + FOUNDER_INVITE_RETRIES
    expect(mockRespondToInviteCalls.length).toBe(0);
    const writeErr = calls.find(
      (args) => args[0] === '[replication-proof]' && args.join(' ').includes('no invite could be opened for the sibling'),
    );
    expect(writeErr).toBeDefined();
    const verdictInputsCall = calls.find(
      (args) => args[0] === '[replication-proof]' && args[1] === 'verdict inputs: ownWriteOk=',
    );
    expect(verdictInputsCall![2]).toBe(false);
  }, 150000);
});

// ---------------------------------------------------------------------------
// Harness early-quit / mislabelled-timeout fix (2026-09-28, same debug session).
//
// The FIX itself lives in scripts/run-replication-proof.sh (a bash harness, not this TS
// runner) — jest cannot drive an adb-backed bash script directly, so this is a lightweight
// text-level regression guard: it locks (a) the verdict-wait error message reporting the
// variable that was ACTUALLY used to bound the wait rather than a stale one, and (b) that
// budget being sized for the runner's own REPL_POLL_MAX-tick read phase, not the old
// undersized value that cut Peer A off at read tick 105/120 (see the debug session file).
// ---------------------------------------------------------------------------
describe('run-replication-proof.sh — verdict-wait timeout message (harness early-quit fix)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const scriptPath = path.resolve(__dirname, '../../../../../scripts/run-replication-proof.sh');
  const script: string = fs.readFileSync(scriptPath, 'utf8');

  it('defines VERDICT_TIMEOUT and never lets the "no verdict" error message reference the stale LOGCAT_TIMEOUT', () => {
    expect(script).toMatch(/VERDICT_TIMEOUT=\d+/);
    const noVerdictLine = script
      .split('\n')
      .find((line: string) => line.includes('did not emit a verdict within'));
    expect(noVerdictLine).toBeDefined();
    expect(noVerdictLine).toContain('${VERDICT_TIMEOUT}');
    expect(noVerdictLine).not.toContain('${LOGCAT_TIMEOUT}');
  });

  it('budgets VERDICT_TIMEOUT for the real on-device read-phase duration (>= 480s, not the old 420s)', () => {
    const match = script.match(/VERDICT_TIMEOUT=(\d+)/);
    expect(match).not.toBeNull();
    const verdictTimeout = Number(match![1]);
    // 120 ticks measured at ~4s/tick on device (Peer A reached only tick 105 after the OLD 420s
    // budget elapsed) needs ~480s; this locks the budget above that measured floor.
    expect(verdictTimeout).toBeGreaterThanOrEqual(480);
  });
});

// ---------------------------------------------------------------------------
// Strand-store wipe moved from the app to the harness (checkpoint 4, item 3).
//
// The in-app wipe ran on EVERY boot, including Peer A's D-05 relaunch, after Peer A had already
// joined networked and become one of the two holders of blocks it wrote — leaving the drones
// pointing at blocks nobody served (`Missing block`, Peer-A role only). Text-level guard, like the
// verdict-timeout block above: the runner no longer destroys a store, the script's store name
// matches the runner's, and only the Step-4 relaunch (never D-05) wipes.
// ---------------------------------------------------------------------------
describe('run-replication-proof.sh — strand-store wipe is harness-owned and skips D-05', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const script: string = fs.readFileSync(
    path.resolve(__dirname, '../../../../../scripts/run-replication-proof.sh'),
    'utf8',
  );
  const runner: string = fs.readFileSync(path.resolve(__dirname, '../replication-proof-runner.ts'), 'utf8');

  it('the runner never calls LevelDB.destroyDB', () => {
    expect(runner).not.toMatch(/LevelDB\.destroyDB\(/);
  });

  it("the script's PROOF_STRAND_STORE is the runner's scoped store name", () => {
    const prefix = runner.match(/const PROOF_STORE_PREFIX = '([^']+)'/)![1];
    const scope = runner.match(/const PROOF_NETWORK_STORE = '([^']+)'/)![1];
    expect(script).toContain(`PROOF_STRAND_STORE="${prefix}-${scope}"`);
  });

  it('wipes before the Step-4 relaunch but NOT before the D-05 relaunch', () => {
    const step4 = script.match(/^MARKER_LINE=\$\(relaunch_and_wait .*\)$/m)![0];
    const d05 = script.match(/^D05_MARKER_LINE=\$\(relaunch_and_wait .*\)$/m)![0];
    expect(step4).toMatch(/ 1\)$/);
    expect(d05).not.toMatch(/ 1\)$/);
  });
});

// ---------------------------------------------------------------------------
// Late-enrolled self-record publish (device leg 7 trace). A phone enrolled after boot never
// publishes its signed CadrePeer address until cadre-core's 7.5-min heartbeat, so no drone can
// dial it back and it joins the strand with 0 peers. The runner must start the publish after a
// successful enrol and await it BEFORE the strand acquire. PROOF_INVITE is substituted by the
// harness at run time (a placeholder under jest), so this ordering is guarded at text level.
// ---------------------------------------------------------------------------
describe('replication-proof-runner — self-record publish after enrol', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const runner: string = fs.readFileSync(path.resolve(__dirname, '../replication-proof-runner.ts'), 'utf8');

  it('starts the publish only after a successful enrol', () => {
    const enrolOk = runner.indexOf("L('enrolInvite=ok'");
    const start = runner.indexOf('selfRecordPublish = publishSelfRecordAfterEnrol(node);');
    expect(enrolOk).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(enrolOk);
    expect(start).toBeLessThan(runner.indexOf("L('enrolInvite=failed'"));
  });

  it('awaits the publish before the strand acquire starts', () => {
    const awaitAt = runner.indexOf('const pub = await selfRecordPublish;');
    const acquireAt = runner.indexOf('const acquireStart = Date.now();');
    expect(awaitAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeGreaterThan(awaitAt);
  });
});
