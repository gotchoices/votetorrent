/**
 * Behavioral tests for CadreNodeProvider — P2P-02 (GAP 1) + D-14 config-fault
 * wiring (56-10).
 *
 * Pins the documented boot invariants from 22-02-SUMMARY.md:
 *   - node.start() is NOT called synchronously during render (T-22-03 / D-06):
 *     CadreNode is constructed, but start() fires only after mount (in a useEffect).
 *   - NO setInterval / no polling anywhere (D-10 hard requirement).
 *   - syncState is event-driven: starts 'offline', listeners registered via on(),
 *     and a 'control:connected' / 'strand:started' event transitions to 'connected'.
 *   - useCadreNode() throws when called outside a CadreNodeProvider.
 *
 * D-14 adds: resolveBootstrapNodes keeps its exact one-string/string[]
 * signature and blank-safe contract; a bootstrap-config fault reaches the
 * context as `configFault` without blocking boot; the mocked CadreNode
 * constructor receives `controlNetwork.bootstrapNodes` derived from the
 * (mocked) config document, proving the wiring is load-bearing; and no
 * document content — including a recognisable probe value — ever reaches
 * the context value or a `console.error` call.
 *
 * CadreNode (@serfab/cadre-core) and openOptimysticRNDb / loadOrCreateRNPeerKey /
 * LevelDBRawStorage (@optimystic/db-p2p-storage-rn), plus rn-leveldb and the
 * libp2p transports, are ESM-only / native deps that cannot load under the
 * react-native jest preset — so they are virtual-mocked here. CadreNode is mocked
 * as a class whose start()/stop() are jest.fns and which records on()/off()
 * listener registrations so the test can drive events.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Capture each constructed fake CadreNode so the test can drive its events and
// assert on start()/on()/off() without reaching into module internals.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

// `mock`-prefixed so jest's hoisted module factory is allowed to reference it.
// Each constructed fake CadreNode pushes itself here for the test to drive.
const mockConstructedNodes: FakeCadreNode[] = [];

// Phase 64 plan 07 fixtures (all `mock`-prefixed for the jest-hoist rule). The fake cadre-core node
// reads them lazily, so a test sets them before the provider boots. Reset in the top-level beforeEach.
const mockCallOrder: string[] = [];
const mockControlOwners = new Set<string>();
const mockSavedAnchor = new Set<string>();
const mockMemoryAnchor = new Set<string>();
const mockStartErrors: Error[] = [];
let mockWireError: Error | null = null;
// Mirrors cadre-core 1.15 `driveControlRelayReservation`: with `network.relayAddrs` named and
// `network.requireRelay` not `false`, a FIRST reservation attempt that lands nothing inside its
// budget throws RelayReservationFailedError out of start(); with `requireRelay: false` the same
// drive only logs and start() carries on, the retry supervisor still running.
let mockRelayFirstAttemptMisses = false;
let mockOwnerKeysError: Error | null = null;
const mockHostPoolRendezvous = jest.fn(async (..._args: unknown[]) => {
  mockCallOrder.push('hostPoolRendezvous');
  return async () => undefined;
});

interface FakeCadreNode {
  start: jest.Mock;
  stop: jest.Mock;
  getStrand: jest.Mock;
  onCalls: Array<[string, Listener]>;
  offCalls: Array<[string, Listener]>;
  /** The options object the constructor was called with (D-14 wiring proof). */
  receivedOptions: unknown;
  trustOwnerKeys: jest.Mock;
  wireOwnKeyIfOwner: jest.Mock;
  emit(event: string, payload?: unknown): void;
  hasListener(event: string): boolean;
}

jest.mock(
  '@serfab/cadre-core',
  () => {
    class FakeCadreNode {
      public start = jest.fn(async () => {
        mockCallOrder.push('start');
        const queued = mockStartErrors.shift();
        if (queued) throw queued;
        const network = (this.receivedOptions as { network?: { relayAddrs?: string[]; requireRelay?: boolean } }).network;
        if (mockRelayFirstAttemptMisses && (network?.relayAddrs?.length ?? 0) > 0 && network?.requireRelay !== false) {
          const e = new Error('network.relayAddrs reservation failed (status: retrying): relay reservation request did not complete before the deadline');
          e.name = 'RelayReservationFailedError';
          throw e;
        }
      });
      public stop = jest.fn(async () => {});
      public trustOwnerKeys = jest.fn(async () => undefined);
      // cadre-core 1.18: wires the signer it is handed (the identity signer, from the provider's
      // identity-owner-key adapter) when that key's OwnerKey row is live.
      public wireOwnKeyIfOwner = jest.fn(async () => {
        mockCallOrder.push('wireOwnKeyIfOwner');
        if (mockWireError) throw mockWireError;
        if (mockControlOwners.has('self-pub')) {
          mockSavedAnchor.add('self-pub');
          return true;
        }
        return false;
      });
      public getTrustedOwnerStore() {
        const injected = (this.receivedOptions as { trustedOwners?: { store?: unknown } }).trustedOwners?.store;
        return injected ?? { all: () => new Set(mockMemoryAnchor) };
      }
      public getControlDatabase() {
        return {
          getOwnerKeys: async () => {
            mockCallOrder.push('getOwnerKeys');
            if (mockOwnerKeysError) throw mockOwnerKeysError;
            return new Set(mockControlOwners);
          },
        };
      }
      public getStrand = jest.fn(() => undefined);
      private listeners: Record<string, Listener[]> = {};
      public onCalls: Array<[string, Listener]> = [];
      public offCalls: Array<[string, Listener]> = [];
      public receivedOptions: unknown;

      constructor(opts: unknown) {
        this.receivedOptions = opts;
        mockConstructedNodes.push(this);
      }

      on(event: string, cb: Listener) {
        this.onCalls.push([event, cb]);
        (this.listeners[event] ??= []).push(cb);
      }

      off(event: string, cb: Listener) {
        this.offCalls.push([event, cb]);
        this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== cb);
      }

      // Optional payload forwarded to every listener (quick task 260928-kkf: the
      // first-sync gate's onStrandStarted reads `e?.strandId` off it). A call with
      // no payload (the ORIGINAL contract every pre-existing test in this file
      // relies on) still forwards `undefined`, exercising the same "no strandId"
      // branch as a real payload-less event.
      emit(event: string, payload?: unknown) {
        (this.listeners[event] ?? []).forEach((l) => l(payload));
      }

      hasListener(event: string) {
        return (this.listeners[event] ?? []).length > 0;
      }
    }
    // cadre-core 1.9.0: the provider opens a durable strand network state before constructing
    // the node. The fake records the slot it was opened over.
    const PersistentStrandNetworkStateStore = {
      open: jest.fn(async (slot: unknown, partyId: string) => ({
        partyId,
        slot,
        load: () => undefined,
        forget: async () => undefined,
      })),
    };
    // cadre-core 1.15: the saved trusted-owner anchor. open() reads the slot first, as the real class
    // does, so an AsyncStorage failure rejects it (the D-10 trigger).
    const PersistentTrustedOwnerStore = {
      open: jest.fn(async (slot: { load(): Promise<unknown> }, partyId: string) => {
        await slot.load();
        return {
          partyId,
          slot,
          all: () => new Set(mockSavedAnchor),
          has: (k: string) => mockSavedAnchor.has(k),
          sources: () => new Map(),
          trust: jest.fn(async () => undefined),
          remove: jest.fn(async () => undefined),
        };
      }),
    };
    const controlStorageScope = (partyId: string) => 'control-' + Buffer.from(partyId).toString('hex');
    // cadre-core 1.18: the identity owner key is derived app-side (engines/identity-owner-key.ts) through
    // these two helpers; the fake keeps the same 'self-pub' key the test owners name.
    const ed25519KeyPairFromLibp2p = () => ({ publicKeyB64: 'self-pub', privateKeyB64: 'self-priv' });
    const softwareOwnerSigner = (privateKeyB64: string) => ({ publicKey: privateKeyB64 === 'self-priv' ? 'self-pub' : 'other', approve: async () => () => '' });
    return { CadreNode: FakeCadreNode, PersistentStrandNetworkStateStore, PersistentTrustedOwnerStore, controlStorageScope, ed25519KeyPairFromLibp2p, softwareOwnerSigner };
  },
  { virtual: true },
);

jest.mock(
  'rn-leveldb',
  () => ({
    LevelDB: class {
      static destroyDB() {}
    },
    LevelDBWriteBatch: class {},
  }),
  { virtual: true },
);

jest.mock('../../engines/pool-rendezvous-host', () => ({
  hostPoolRendezvous: (...a: unknown[]) => mockHostPoolRendezvous(...a),
}));

// `mock`-prefixed so the hoisted jest.mock factory below is allowed to reference it
// (jest hoisting rule). Task 2's settlement-failure case makes this reject once.
const mockLoadOrCreateRNPeerKey = jest.fn(async () => ({ type: 'Ed25519' }));

jest.mock(
  '@optimystic/db-p2p-storage-rn',
  () => ({
    openOptimysticRNDb: jest.fn(() => ({})),
    LevelDBRawStorage: class {},
    loadOrCreateRNPeerKey: () => mockLoadOrCreateRNPeerKey(),
  }),
  { virtual: true },
);

jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
jest.mock(
  '@libp2p/circuit-relay-v2',
  () => ({ circuitRelayTransport: () => ({}) }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CadreNodeProvider, useCadreNode, resolveBootstrapNodes } = require('../CadreNodeProvider');
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders the provider with a probe child that captures the current context
 * value on every render, so the test can read syncState / node as they update.
 */
function renderProvider() {
  const captured: { value: ReturnType<typeof useCadreNode> | null } = { value: null };

  function Probe() {
    captured.value = useCadreNode();
    return null;
  }

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <CadreNodeProvider>
        <Probe />
      </CadreNodeProvider>,
    );
  });
  return { tr, captured };
}

beforeEach(() => {
  mockConstructedNodes.length = 0;
  mockCallOrder.length = 0;
  mockControlOwners.clear();
  mockSavedAnchor.clear();
  mockMemoryAnchor.clear();
  mockStartErrors.length = 0;
  mockWireError = null;
  mockOwnerKeysError = null;
  mockRelayFirstAttemptMisses = false;
  jest.clearAllMocks();
});

/** The boot now has more awaits (store open, re-anchor, classification), so flush more turns. */
const BOOT_FLUSH_TURNS = 50;

/** Flush the async microtasks queued by the provider's boot effect (construct + start). */
async function flushBoot() {
  await renderer.act(async () => {
    // Several turns: openOptimysticRNDb (sync) → await loadOrCreateRNPeerKey →
    // construct CadreNode → await start() → setNode → listener effect.
    for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}

describe('CadreNodeProvider — P2P-02 boot invariants', () => {
  it('does NOT call node.start() synchronously during render (T-22-03 / D-06)', () => {
    // Render synchronously (act flushes only the render + sync effect scheduling).
    // The boot effect's body is async: it awaits loadOrCreateRNPeerKey BEFORE the
    // CadreNode is even constructed, so start() cannot have run during render.
    const { captured } = renderProvider();

    // Initial synchronous render must expose a context value with node === null
    // (start() resolves and calls setNode only later, off the render path).
    expect(captured.value).not.toBeNull();
    expect(captured.value!.node).toBeNull();

    // And no node has been started in the synchronous render pass.
    const started = mockConstructedNodes.some((n) => n.start.mock.calls.length > 0);
    expect(started).toBe(false);
  });

  it('starts the node only after mount, via an effect (start() eventually called)', async () => {
    renderProvider();
    await flushBoot();

    expect(mockConstructedNodes.length).toBe(1);
    const node = mockConstructedNodes[0];
    expect(node.start).toHaveBeenCalledTimes(1);
  });

  it('configures network.controlCohort.strandAddrRefreshMs = 30000 and leaves other network fields', async () => {
    renderProvider();
    await flushBoot();
    const opts = mockConstructedNodes[0].receivedOptions as {
      network: Record<string, unknown>;
    };
    expect(opts.network.controlCohort).toEqual({ strandAddrRefreshMs: 30000 });
    expect(Array.isArray(opts.network.transports)).toBe(true);
  });

  it('does NOT call setInterval anywhere (no polling — D-10)', async () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    renderProvider();
    await flushBoot();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('defaults syncState to "offline" before any event fires', () => {
    const { captured } = renderProvider();
    expect(captured.value!.syncState).toBe('offline');
  });

  it('registers event listeners on the node and transitions to "connected" on control:connected (event-driven, D-10)', async () => {
    const { captured } = renderProvider();

    // Let the boot effect resolve so setNode runs and the listener effect fires.
    await flushBoot();
    const node = mockConstructedNodes[0];

    // Event-driven proof: a listener is registered for the connected event.
    expect(node.hasListener('control:connected')).toBe(true);
    expect(captured.value!.syncState).toBe('offline');

    // Drive the event → syncState transitions to 'connected'.
    renderer.act(() => {
      node.emit('control:connected');
    });
    expect(captured.value!.syncState).toBe('connected');
  });

  it('transitions to "connected" on strand:started as well', async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];

    expect(node.hasListener('strand:started')).toBe(true);
    renderer.act(() => {
      node.emit('strand:started');
    });
    expect(captured.value!.syncState).toBe('connected');
  });

  // todo 2026-09-11-optimystic-commit-success-hides-unresolvable-cohort: the provider's tracker (the REAL
  // vote-engine CommitDurabilityTracker) listens to the live node and feeds useUnsharedCommitCount.
  it('feeds the not-shared count from strand:commit-durability / strand:commit-held on the live node', async () => {
    const { useUnsharedCommitCount } = require('../../hooks/useCommitShare');
    const seen: { count: number } = { count: -1 };
    function CountProbe() {
      seen.count = useUnsharedCommitCount();
      return null;
    }
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(
        <CadreNodeProvider>
          <CountProbe />
        </CadreNodeProvider>,
      );
    });
    await flushBoot();
    const node = mockConstructedNodes[0];
    expect(node.hasListener('strand:commit-durability')).toBe(true);
    expect(node.hasListener('strand:commit-held')).toBe(true);
    expect(seen.count).toBe(0);

    renderer.act(() => {
      node.emit('strand:commit-durability', { strandId: 'net1', transactionId: 'tx1', heldElsewhere: false, followed: true });
    });
    expect(seen.count).toBe(1);
    renderer.act(() => {
      node.emit('strand:commit-held', { strandId: 'net1', transactionId: 'tx1' });
    });
    expect(seen.count).toBe(0);
    renderer.act(() => tr.unmount());
  });

  it('removes its event listeners on unmount (cleanup via off())', async () => {
    const { tr } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    expect(node.onCalls.length).toBeGreaterThan(0);

    renderer.act(() => {
      tr.unmount();
    });
    expect(node.offCalls.length).toBeGreaterThan(0);
  });

  it('useCadreNode() throws when used outside a CadreNodeProvider', () => {
    function Orphan() {
      useCadreNode();
      return null;
    }
    expect(() => {
      renderer.act(() => {
        renderer.create(<Orphan />);
      });
    }).toThrow('useCadreNode must be used within a CadreNodeProvider');
  });
});

// ---------------------------------------------------------------------------
// First-sync gate syncState mapping — quick task 260928-kkf.
//
// A gated joiner's `strand:started` event carries `{strandId}` but its
// `StrandInstance.database` is still unset — the OLD unconditional 'connected'
// mapping was wrong for exactly that case. `getStrand(strandId)` is now consulted:
// `database` unset -> 'syncing'; `database` present, or no strandId / no instance at
// all (the pre-existing payload-less-emit test above), -> 'connected' as before.
// `strand:writable` is the gate's own resolution signal, newly listened for.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — first-sync gate syncState mapping (quick task 260928-kkf)', () => {
  it("strand:started for a strandId whose getStrand() instance has no database maps to 'syncing'", async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    node.getStrand.mockReturnValue({ strandId: 'net1', database: undefined });

    renderer.act(() => {
      node.emit('strand:started', { strandId: 'net1' });
    });

    expect(captured.value!.syncState).toBe('syncing');
  });

  it("strand:writable transitions a gated 'syncing' strand to 'connected'", async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    node.getStrand.mockReturnValue({ strandId: 'net1', database: undefined });

    renderer.act(() => {
      node.emit('strand:started', { strandId: 'net1' });
    });
    expect(captured.value!.syncState).toBe('syncing');

    expect(node.hasListener('strand:writable')).toBe(true);
    renderer.act(() => {
      node.emit('strand:writable', { strandId: 'net1' });
    });
    expect(captured.value!.syncState).toBe('connected');
  });

  it("strand:started for a strandId whose getStrand() instance ALREADY has a database maps to 'connected' (founder / already-synced case, unchanged)", async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    node.getStrand.mockReturnValue({ strandId: 'net1', database: {} });

    renderer.act(() => {
      node.emit('strand:started', { strandId: 'net1' });
    });

    expect(captured.value!.syncState).toBe('connected');
  });

  it("strand:started with a strandId getStrand() cannot resolve (undefined instance) maps to 'connected', unchanged", async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    node.getStrand.mockReturnValue(undefined);

    renderer.act(() => {
      node.emit('strand:started', { strandId: 'unknown-strand' });
    });

    expect(captured.value!.syncState).toBe('connected');
  });

  it('removes the strand:writable listener on unmount (cleanup via off())', async () => {
    const { tr } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    expect(node.hasListener('strand:writable')).toBe(true);

    renderer.act(() => {
      tr.unmount();
    });

    const writableOffCalls = node.offCalls.filter(([event]) => event === 'strand:writable');
    expect(writableOffCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// nodeSettled — D-08/D-09 boot settlement contract (58-05).
//
// Run FIRST against the unmodified provider and recorded RED in the SUMMARY:
// before this plan's change, `nodeSettled` is `undefined` on the context
// value, so `await captured.value!.nodeSettled` resolves to `undefined` and
// `.status` reads as `undefined` — a TypeError-free but clearly-wrong shape,
// not the `{ status: 'ready' | 'failed', node }` this describe block asserts.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — nodeSettled boot settlement (D-08/D-09)', () => {
  it('guards the pinned Node version: Promise.withResolvers must be a function', () => {
    expect(typeof Promise.withResolvers).toBe(
      'function',
    );
  });

  it('resolves { status: "ready", node } after a successful boot, where node is the same instance the context exposes', async () => {
    const { captured } = renderProvider();
    await flushBoot();

    const settlement = await captured.value!.nodeSettled;
    expect(settlement.status).toBe('ready');
    expect(settlement.node).not.toBeNull();
    expect(settlement.node).toBe(captured.value!.node);
  });

  it('resolves { status: "failed", node: null } when the boot path throws before start() — the swallowed-error exit', async () => {
    // Drive the catch block: loadOrCreateRNPeerKey is awaited inside the same
    // try that constructs CadreNode, so making it reject once reaches the
    // catch without touching the FakeCadreNode class at all.
    mockLoadOrCreateRNPeerKey.mockRejectedValueOnce(new Error('boot key load failed'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const { captured } = renderProvider();
    await flushBoot();

    const settlement = await captured.value!.nodeSettled;
    expect(settlement.status).toBe('failed');
    expect(settlement.node).toBeNull();
    // The existing diagnostic is preserved, not replaced by the settlement.
    expect(errorSpy).toHaveBeenCalledWith(
      '[CadreNodeProvider] Boot error:',
      expect.stringContaining('boot key load failed'),
    );

    errorSpy.mockRestore();
  });

  it('is the same promise object on every render (referential stability)', async () => {
    const { tr, captured } = renderProvider();
    const first = captured.value!.nodeSettled;

    // Force a second render via a syncState-driving event after boot.
    await flushBoot();
    const node = mockConstructedNodes[0];
    renderer.act(() => {
      node.emit('control:connected');
    });
    const second = captured.value!.nodeSettled;

    expect(second).toBe(first);
    tr.unmount();
  });

  it('resolves at most once even though only one exit is reachable per boot (idempotency of the settle path)', async () => {
    const { captured } = renderProvider();
    await flushBoot();

    // Awaiting twice must yield the same settled value both times — proves
    // the promise settled exactly once rather than being re-created.
    const first = await captured.value!.nodeSettled;
    const second = await captured.value!.nodeSettled;
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// resolveBootstrapNodes — blank-safe single-address guard (D-14, 56-10).
//
// D-14 replaced the CONTROL_ADDR/BOOTSTRAP_PLACEHOLDER sentinel with a
// validated config document (bootstrap-config.ts). resolveBootstrapNodes
// itself keeps its EXACT signature and contract: one string in, string[]
// out, [] for empty/blank, never throw. Only the input SOURCE changed — it
// now receives one already-validated address at a time via
// `bootstrapConfig.addrs.flatMap(resolveBootstrapNodes)`, rather than one
// hard-coded constant.
// ---------------------------------------------------------------------------
describe('resolveBootstrapNodes — blank-safe single-address guard (D-14)', () => {
  it('returns [] for an empty string', () => {
    expect(resolveBootstrapNodes('')).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(resolveBootstrapNodes(undefined as unknown as string)).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(resolveBootstrapNodes('   ')).toEqual([]);
  });

  it('returns [addr] for a real address', () => {
    const real = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWReal';
    expect(resolveBootstrapNodes(real)).toEqual([real]);
  });

  it('signature lock: still takes exactly one parameter', () => {
    // A later refactor widening this to take a list would silently break the
    // D-14 contract — this pins the arity so that regression fails loudly.
    expect(resolveBootstrapNodes.length).toBe(1);
  });

  it('is still exported from the module', () => {
    expect(typeof resolveBootstrapNodes).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Config-fault wiring (D-14, 56-10). Each test loads a FRESH instance of the
// provider module with `bootstrap.config.json` mocked to a specific document,
// so the module-scope `readBootstrapConfig(bootstrapConfigDoc)` call re-runs
// against that document. jest.resetModules() clears the module registry
// (NOT the top-level virtual mocks registered above, which persist).
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — config-fault wiring (D-14)', () => {
  // `bootstrapConfig` is computed at MODULE SCOPE in CadreNodeProvider.tsx (by
  // design — see its D-14 header comment), so proving a fault reaches the
  // context for a GIVEN document requires re-requiring the whole module fresh
  // per document. jest.resetModules() clears the module registry — including
  // 'react' — which would otherwise hand the freshly-required provider a
  // SECOND react module instance with its own hook-dispatcher state, crashing
  // every hook call with "Cannot read properties of null (reading 'useState')"
  // (the exact multi-copy-React trap memory records for shared components).
  // Pinning 'react' to the single instance already loaded by this test file
  // (captured once, before any reset) keeps the dispatcher singular.
  const actualReact = jest.requireActual('react');

  afterEach(() => {
    jest.dontMock('../../../bootstrap.config.json');
    jest.dontMock('react');
  });

  function loadProviderModuleWithDoc(doc: unknown) {
    jest.resetModules();
    jest.doMock('react', () => actualReact);
    jest.doMock('../../../bootstrap.config.json', () => doc, { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../CadreNodeProvider');
  }

  it('a missing/empty document reaches the context as configFault, and node still becomes non-null', async () => {
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(captured.value!.configFault).toEqual({ kind: 'missing', reason: 'empty-address-list' });
    // Boot is not blocked by a fault — the node still constructs and starts.
    expect(captured.value!.node).not.toBeNull();
  });

  it('a valid document reports configFault: null, and the mocked CadreNode receives the derived bootstrapNodes', async () => {
    const validAddr = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample';
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [validAddr] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(captured.value!.configFault).toBeNull();
    // mockConstructedNodes is the shared, file-scoped capture array the
    // '@serfab/cadre-core' virtual mock pushes every constructed FakeCadreNode
    // into (module-level, survives jest.resetModules()). The most recently
    // constructed instance is this test's node; its receivedOptions is the
    // exact object the REAL provider passed to `new CadreNode(...)` — this is
    // the assertion that proves the wiring is load-bearing, not decorative.
    const lastNode = mockConstructedNodes[mockConstructedNodes.length - 1];
    const receivedOptions = lastNode.receivedOptions as { controlNetwork: { bootstrapNodes: string[] } };
    expect(receivedOptions.controlNetwork.bootstrapNodes).toEqual([validAddr]);
  });

  it('no document echo: a malformed document carrying a recognisable probe never reaches context or console.error', async () => {
    const LEAK_PROBE = 'LEAKPROBE0123';
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [`/ip4/${LEAK_PROBE}/tcp/443/wss`] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(JSON.stringify(captured.value!.configFault)).not.toContain(LEAK_PROBE);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(LEAK_PROBE);
      }
    }

    errorSpy.mockRestore();
  });
});

describe('CadreNodeProvider — native Noise crypto (spike 093)', () => {
  it('builds the node with network.noiseCrypto from the shared switch (symmetric by default)', async () => {
    renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    const network = (node.receivedOptions as { network?: { noiseCrypto?: unknown } }).network;
    // The jest mock of @serfab/cadre-rn/noise-crypto tags its result with the mode, so this
    // proves the provider forwards the switch rather than silently running stock pure-JS noise.
    expect(network?.noiseCrypto).toEqual({ __mockNoiseCrypto: 'symmetric' });
  });
});

describe('CadreNodeProvider — durable strand network state (cadre-core 1.9.0)', () => {
  it('builds the node with strandNetworkState.store: a persistent store for its own party and store scope', async () => {
    renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    const opts = node.receivedOptions as { strandNetworkState?: { store?: { partyId?: string; slot?: { key?: string } } } };
    expect(opts.strandNetworkState?.store?.partyId).toBe('votetorrent');
    // Namespaced by scope AND party, so the proof runner's node on the same device never shares it.
    expect(opts.strandNetworkState?.store?.slot?.key).toBe('@votetorrent/strandNetworkState/votetorrent-cadre-node/votetorrent');
  });
});

describe('CadreNodeProvider — yields the device to the replication proof (spike 093)', () => {
  it('constructs NO node and settles failed when REPLICATION_PROOF_ENABLED is on', async () => {
    // React, the renderer and the provider must all come from ONE isolated registry, or the
    // provider's hooks run against a different React than the renderer's dispatcher.
    let mod!: typeof import('../CadreNodeProvider');
    let R!: typeof import('react-test-renderer');
    let ReactIso!: typeof import('react');
    jest.isolateModules(() => {
      jest.doMock('../../engines/proof-flags.generated', () => ({
        ...jest.requireActual('../../engines/proof-flags.generated'),
        REPLICATION_PROOF_ENABLED: true,
      }));
      ReactIso = require('react');
      R = require('react-test-renderer');
      mod = require('../CadreNodeProvider');
    });
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };
    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }
    await R.act(async () => {
      R.create(ReactIso.createElement(mod.CadreNodeProvider, null, ReactIso.createElement(Probe)));
      for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });
    expect(mockConstructedNodes).toHaveLength(0);
    await expect(captured.value!.nodeSettled).resolves.toEqual({ status: 'failed', node: null });
    expect(infoSpy.mock.calls.some(c => String(c[0]).includes('replication proof owns'))).toBe(true);
    infoSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Phase 64 plan 07: the saved trusted-owner anchor (D-08), the three trust states (D-09, D-10, D-11),
// the founder re-anchor and refreshOwnerTrust.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — saved owner trust (D-08..D-11)', () => {
  const TRUST_PREFIX = '@votetorrent/trustedOwners/';
  const SETTING_KEY = '@votetorrent/settings/requireOwnerTrust';
  const OPEN_FAIL_TOKEN = '[CadreNodeProvider] trusted-owner store unavailable; using the in-memory anchor';
  const BLOCKED_TOKEN =
    '[CadreNodeProvider] trusted-owner store unavailable and saved owner trust is required; the node was not started';

  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  // The AsyncStorage jest mock's getItem is already a jest.fn, so spyOn hands back that SAME mock and
  // restoreAllMocks cannot undo a mockImplementation. Put the original implementation back by hand.
  const getItemMock = AsyncStorage.getItem as unknown as jest.Mock;
  let priorGetItem: ((...a: never[]) => unknown) | undefined;

  beforeEach(async () => {
    priorGetItem = getItemMock.getMockImplementation();
    await AsyncStorage.clear();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // P-14: nothing in the provider ever pins.
    for (const n of mockConstructedNodes) expect(n.trustOwnerKeys).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    getItemMock.mockImplementation(priorGetItem);
  });

  /** Make the saved store unreadable, and answer the require-trust setting as asked. */
  function failStore(setting: 'absent' | 'true' | 'reject') {
    return jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key: string) => {
      if (key.startsWith(TRUST_PREFIX)) throw new Error('planted-io-text');
      if (key === SETTING_KEY) {
        if (setting === 'reject') throw new Error('planted-io-text');
        return setting === 'true' ? 'true' : null;
      }
      return null;
    });
  }

  const loggedJson = () => JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]);
  const callsWith = (spy: jest.SpyInstance, token: string) => spy.mock.calls.filter((c) => c[0] === token);

  async function boot() {
    const r = renderProvider();
    await flushBoot();
    return r;
  }

  it('P-1 builds the node on a persistent store for its party and slot, and never reads the setting', async () => {
    const getItem = jest.spyOn(AsyncStorage, 'getItem');
    const { captured } = await boot();
    const opts = mockConstructedNodes[0].receivedOptions as {
      trustedOwners?: { store?: { partyId?: string; slot?: { key?: string } } };
    };
    expect(opts.trustedOwners?.store?.partyId).toBe('votetorrent');
    expect(opts.trustedOwners?.store?.slot?.key).toBe('@votetorrent/trustedOwners/votetorrent-cadre-node/votetorrent');
    expect(captured.value!.ownerTrust).toBe('ok');
    expect(getItem.mock.calls.some((c) => c[0] === SETTING_KEY)).toBe(false);
  });

  it('P-2 the recovery rebuild receives the SAME store and the re-anchor runs once, on the second node', async () => {
    mockStartErrors.push(new Error('CadreControl.Revocation could not be restored'));
    const { captured } = await boot();
    expect(mockConstructedNodes).toHaveLength(2);
    const [first, second] = mockConstructedNodes;
    const storeOf = (n: FakeCadreNode) => (n.receivedOptions as { trustedOwners: { store: unknown } }).trustedOwners.store;
    expect(storeOf(second)).toBe(storeOf(first));
    expect(first.wireOwnKeyIfOwner).not.toHaveBeenCalled();
    expect(second.wireOwnKeyIfOwner).toHaveBeenCalledTimes(1);
    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
  });

  it('P-3 boots in order: start, re-anchor, classification read, rendezvous; the re-anchor runs once', async () => {
    await boot();
    const order = mockCallOrder.filter((c) => ['start', 'wireOwnKeyIfOwner', 'getOwnerKeys', 'hostPoolRendezvous'].includes(c));
    expect(order).toEqual(['start', 'wireOwnKeyIfOwner', 'getOwnerKeys', 'hostPoolRendezvous']);
    expect(mockConstructedNodes[0].wireOwnKeyIfOwner).toHaveBeenCalledTimes(1);
  });

  it('P-4 a founder whose own key gets re-anchored reads ok', async () => {
    mockControlOwners.add('self-pub');
    const { captured } = await boot();
    expect(mockSavedAnchor.has('self-pub')).toBe(true);
    expect(captured.value!.ownerTrust).toBe('ok');
  });

  it('P-5 a re-anchor that rejects logs one closed token and the boot still completes ready', async () => {
    mockWireError = new Error('planted-io-text');
    const { captured } = await boot();
    expect(callsWith(warnSpy, '[owner-trust] reanchor: failed')).toHaveLength(1);
    expect(loggedJson()).not.toContain('planted-io-text');
    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
  });

  it('P-6 an empty saved anchor in a cadre this phone does not own reads needs-reinvite, with a live node', async () => {
    mockControlOwners.add('drone-owner');
    const { captured } = await boot();
    expect(captured.value!.ownerTrust).toBe('needs-reinvite');
    expect(captured.value!.node).not.toBeNull();
    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
  });

  it('P-7 refreshOwnerTrust clears needs-reinvite once the pins exist, and does not pin', async () => {
    mockControlOwners.add('drone-owner');
    const { captured } = await boot();
    expect(captured.value!.ownerTrust).toBe('needs-reinvite');
    mockSavedAnchor.add('drone-owner');
    await renderer.act(async () => {
      await captured.value!.refreshOwnerTrust();
    });
    expect(captured.value!.ownerTrust).toBe('ok');
  });

  it('P-8 refreshOwnerTrust rejects on an unreadable read and leaves the state alone', async () => {
    mockControlOwners.add('drone-owner');
    const { captured } = await boot();
    mockOwnerKeysError = new Error('planted-io-text');
    let thrown: unknown = null;
    await renderer.act(async () => {
      try {
        await captured.value!.refreshOwnerTrust();
      } catch (caught) {
        thrown = caught;
      }
    });
    expect((thrown as Error).name).toBe('OwnerTrustUnreadableError');
    expect(captured.value!.ownerTrust).toBe('needs-reinvite');
    expect(callsWith(warnSpy, '[owner-trust] classify: unreadable')).toHaveLength(1);
    expect(loggedJson()).not.toContain('planted-io-text');
  });

  it('P-9 an unreadable classification at boot reports ok, logs the closed token and still settles ready', async () => {
    mockOwnerKeysError = new Error('planted-io-text');
    const { captured } = await boot();
    expect(captured.value!.ownerTrust).toBe('ok');
    expect(callsWith(warnSpy, '[owner-trust] classify: unreadable')).toHaveLength(1);
    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
  });

  it('P-10 a store that will not open runs on the in-memory anchor and says so (memory-only)', async () => {
    failStore('absent');
    const { captured } = await boot();
    expect(mockConstructedNodes).toHaveLength(1);
    const opts = mockConstructedNodes[0].receivedOptions as Record<string, unknown>;
    expect('trustedOwners' in opts).toBe(false);
    expect(mockConstructedNodes[0].start).toHaveBeenCalledTimes(1);
    expect(captured.value!.ownerTrust).toBe('memory-only');
    expect(callsWith(warnSpy, OPEN_FAIL_TOKEN)).toHaveLength(1);
    expect(loggedJson()).not.toContain('planted-io-text');
    await renderer.act(async () => {
      await captured.value!.refreshOwnerTrust();
    });
    expect(captured.value!.ownerTrust).toBe('memory-only');
    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
  });

  it('P-11 with saved trust required, a store that will not open starts no node (blocked)', async () => {
    failStore('true');
    const { captured } = await boot();
    expect(mockConstructedNodes).toHaveLength(0);
    await expect(captured.value!.nodeSettled).resolves.toEqual({ status: 'failed', node: null });
    expect(captured.value!.ownerTrust).toBe('blocked');
    expect(callsWith(errorSpy, BLOCKED_TOKEN)).toHaveLength(1);
    expect(loggedJson()).not.toContain('planted-io-text');
  });

  it('P-12 an unreadable setting fails closed (blocked)', async () => {
    failStore('reject');
    const { captured } = await boot();
    expect(mockConstructedNodes).toHaveLength(0);
    expect(captured.value!.ownerTrust).toBe('blocked');
    await expect(captured.value!.nodeSettled).resolves.toEqual({ status: 'failed', node: null });
  });

  it('P-13 saved trust required with a healthy store starts the node and never reads the setting', async () => {
    await AsyncStorage.setItem(SETTING_KEY, 'true');
    const getItem = jest.spyOn(AsyncStorage, 'getItem');
    const { captured } = await boot();
    expect(mockConstructedNodes).toHaveLength(1);
    expect(captured.value!.ownerTrust).toBe('ok');
    expect(getItem.mock.calls.some((c) => c[0] === SETTING_KEY)).toBe(false);
  });

  it('P-15 offers no retry or restart on the context', async () => {
    const { captured } = await boot();
    expect(Object.keys(captured.value!).sort()).toEqual([
      'configFault',
      'connectedPeers',
      'node',
      'nodeSettled',
      'ownerTrust',
      'refreshOwnerTrust',
      'syncState',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Phase 64 plan 16 (D-26, research M4): a joined install's relay-circuit dial hints are merged into
// `controlNetwork.bootstrapNodes` at boot, config addresses first, and never become relay targets.
// ---------------------------------------------------------------------------
import { captureConsole, expectNoSecretInConsole } from '../../engines/__fixtures__/console-leak';

describe('CadreNodeProvider — join bootstrap merged at boot (D-26)', () => {
  const JB_KEY = '@votetorrent/authorityJoinBootstrap';
  const RELAY_ID = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR5STiGwxBhgFRcw3UERE';
  const C1 = `/ip4/192.168.1.7/tcp/4001/ws/p2p/${RELAY_ID}/p2p-circuit/p2p/12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo`;
  const C2 = `/ip4/192.168.1.8/tcp/4001/ws/p2p/${RELAY_ID}/p2p-circuit/p2p/12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzNAc5dVLAHZmwCe`;
  const DIRECT = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${RELAY_ID}`;
  const RELAY_CFG = `/ip4/203.0.113.9/tcp/443/wss/p2p/${RELAY_ID}`;
  const actualReact = jest.requireActual('react');
  const getItemMock = AsyncStorage.getItem as unknown as jest.Mock;
  let priorGetItem: ((...a: never[]) => unknown) | undefined;

  type Received = {
    controlNetwork: { bootstrapNodes: string[] };
    network: { relayAddrs: string[] };
  };
  const optionsOf = (n: FakeCadreNode) => n.receivedOptions as Received;

  beforeEach(async () => {
    priorGetItem = getItemMock.getMockImplementation();
    await AsyncStorage.clear();
  });

  afterEach(async () => {
    getItemMock.mockImplementation(priorGetItem);
    await AsyncStorage.clear();
    jest.dontMock('../../../bootstrap.config.json');
    jest.dontMock('@libp2p/circuit-relay-v2');
    jest.dontMock('react');
  });

  it('JBP-1 merges the stored circuit addresses (sanitized, deduplicated) and leaves relayAddrs empty', async () => {
    await AsyncStorage.setItem(JB_KEY, JSON.stringify([C1, ` ${C1} `, DIRECT, C2]));
    const c = captureConsole();
    try {
      const { captured } = renderProvider();
      await flushBoot();
      expect(mockConstructedNodes).toHaveLength(1);
      expect(optionsOf(mockConstructedNodes[0]).controlNetwork.bootstrapNodes).toEqual([C1, C2]);
      expect(optionsOf(mockConstructedNodes[0]).network.relayAddrs).toEqual([]);
      await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
      expectNoSecretInConsole(c, [C1, C2, 'planted-jb-text']);
    } finally {
      c.restore();
    }
  });

  it('JBP-2 puts config addresses first and never turns join hints into relay targets', async () => {
    jest.resetModules();
    // The replication-proof case above leaves its flag mock registered; this boot needs the real flags.
    jest.dontMock('../../engines/proof-flags.generated');
    jest.doMock('react', () => actualReact);
    jest.doMock('../../../bootstrap.config.json', () => ({ bootstrapNodes: [RELAY_CFG] }), { virtual: true });
    const transportOptions: Array<{ reservationConcurrency?: number }> = [];
    jest.doMock(
      '@libp2p/circuit-relay-v2',
      () => ({
        circuitRelayTransport: (o: { reservationConcurrency?: number }) => {
          transportOptions.push(o);
          return {};
        },
      }),
      { virtual: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../CadreNodeProvider');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshStorageModule = require('@react-native-async-storage/async-storage');
    const freshStorage = freshStorageModule.default ?? freshStorageModule;
    await freshStorage.setItem(JB_KEY, JSON.stringify([C1]));
    const c = captureConsole();
    try {
      await renderer.act(async () => {
        renderer.create(
          <mod.CadreNodeProvider>
            <></>
          </mod.CadreNodeProvider>,
        );
        for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
          // eslint-disable-next-line no-await-in-loop
          await Promise.resolve();
        }
      });
      const last = mockConstructedNodes[mockConstructedNodes.length - 1];
      expect(optionsOf(last).controlNetwork.bootstrapNodes).toEqual([RELAY_CFG, C1]);
      expect(optionsOf(last).network.relayAddrs).toEqual([RELAY_CFG]);
      expect(transportOptions.length).toBeGreaterThan(0);
      expect(transportOptions.every((o) => o.reservationConcurrency === 1)).toBe(true);
      expectNoSecretInConsole(c, [C1, RELAY_CFG]);
    } finally {
      c.restore();
    }
  });

  it('JBP-3 an unreadable join-bootstrap record boots on the config addresses alone', async () => {
    getItemMock.mockImplementation(async (key: string, ...rest: never[]) => {
      if (key === JB_KEY) throw new Error('planted-jb-text');
      return priorGetItem ? priorGetItem(key as never, ...rest) : null;
    });
    const c = captureConsole();
    try {
      const { captured } = renderProvider();
      await flushBoot();
      expect(mockConstructedNodes).toHaveLength(1);
      expect(mockConstructedNodes[0].start).toHaveBeenCalledTimes(1);
      expect(optionsOf(mockConstructedNodes[0]).controlNetwork.bootstrapNodes).toEqual([]);
      await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
      expectNoSecretInConsole(c, [C1, C2, 'planted-jb-text']);
    } finally {
      c.restore();
    }
  });

  it('JBP-4 the control-schema recovery rebuild dials the same merged list', async () => {
    await AsyncStorage.setItem(JB_KEY, JSON.stringify([C1]));
    mockStartErrors.push(new Error('CadreControl.Revocation could not be restored'));
    const c = captureConsole();
    try {
      const { captured } = renderProvider();
      await flushBoot();
      expect(mockConstructedNodes).toHaveLength(2);
      const [first, second] = mockConstructedNodes;
      expect(optionsOf(first).controlNetwork.bootstrapNodes).toEqual([C1]);
      expect(optionsOf(second).controlNetwork.bootstrapNodes).toEqual([C1]);
      await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
      expectNoSecretInConsole(c, [C1, C2, 'planted-jb-text']);
    } finally {
      c.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// A transient first relay-reservation miss (debug authority-reattach-after-settle-timeout).
//
// 64-53: a relaunched keyholder Authority on a loaded emulator logged
// `[CadreNodeProvider] Boot error: RelayReservationFailedError ... (status: retrying)` while the
// relay refused nothing and admitted a reservation within the same minute. The fail-fast posture
// stopped the node and settled `failed` for the whole process, so the strand network could never
// open again until the app was killed.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — a first relay reservation that misses its budget', () => {
  const actualReact = jest.requireActual('react');

  afterEach(() => {
    jest.dontMock('../../../bootstrap.config.json');
    jest.dontMock('@libp2p/circuit-relay-v2');
    jest.dontMock('react');
  });

  it('still boots ready with a live node, and builds it with network.requireRelay false', async () => {
    const relayAddr = '/ip4/203.0.113.9/tcp/4801/ws/p2p/12D3KooWExample';
    jest.resetModules();
    // Earlier describes leave the replication-proof flag mock registered and drop the virtual
    // circuit-relay mock in their afterEach; this boot needs the real flags and the transport stub.
    jest.dontMock('../../engines/proof-flags.generated');
    jest.doMock('react', () => actualReact);
    jest.doMock('../../../bootstrap.config.json', () => ({ bootstrapNodes: [relayAddr] }), { virtual: true });
    jest.doMock('@libp2p/circuit-relay-v2', () => ({ circuitRelayTransport: () => ({}) }), { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../CadreNodeProvider');
    mockRelayFirstAttemptMisses = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };
    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    await expect(captured.value!.nodeSettled).resolves.toMatchObject({ status: 'ready' });
    expect(captured.value!.node).not.toBeNull();
    expect(errorSpy.mock.calls.some((c) => c[0] === '[CadreNodeProvider] Boot error:')).toBe(false);
    const node = mockConstructedNodes[mockConstructedNodes.length - 1];
    const network = (node.receivedOptions as { network: { relayAddrs: string[]; requireRelay?: boolean } }).network;
    expect(network.relayAddrs).toEqual([relayAddr]);
    expect(network.requireRelay).toBe(false);
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Strand peers that declared themselves read-only edge readers (the officer's browser dashboard) are kept
// out of this phone's strand write cohorts and coordinator choice: the node config carries a sticky
// `strandCohortRefusal` hook from vote-engine's createEdgeReaderRefusal.
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — edge-reader cohort refusal', () => {
  type Hook = (strandId: string) => { refuses(peerId: string): boolean; attach?(node: unknown): void } | undefined;
  const hookOf = (n: FakeCadreNode) => (n.receivedOptions as { strandCohortRefusal?: unknown }).strandCohortRefusal;

  it('ER-A1 the node config carries strandCohortRefusal as a function that refuses nobody yet', async () => {
    renderProvider();
    await flushBoot();
    expect(mockConstructedNodes).toHaveLength(1);
    const hook = hookOf(mockConstructedNodes[0]);
    expect(typeof hook).toBe('function');
    const refusal = (hook as Hook)('s1');
    expect(refusal).toBeDefined();
    expect(refusal!.refuses('x')).toBe(false);
    expect((hook as Hook)('s1')).toBe(refusal);
  });

  it('ER-A2 the recovery rebuild passes the SAME hook', async () => {
    mockStartErrors.push(new Error('CadreControl.Revocation could not be restored'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderProvider();
    await flushBoot();
    expect(mockConstructedNodes).toHaveLength(2);
    const [first, second] = mockConstructedNodes;
    expect(typeof hookOf(first)).toBe('function');
    expect(hookOf(second)).toBe(hookOf(first));
    warnSpy.mockRestore();
  });
});
