/**
 * RED test scaffold for createStrandKeyNetwork
 *
 * P2P-04: IKeyNetwork has a real implementation
 * P2P-05: Peer discovery works (findCoordinator / findCluster)
 *
 * These tests import from the not-yet-existing '../key-network-strand' module and
 * are intentionally RED until Plan 22-02 implements the production code.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandKeyNetwork } = require('../key-network-strand');

// ---------------------------------------------------------------------------
// Mock StrandInstance shape
// ---------------------------------------------------------------------------

/** Minimal stub for p2p-fret FretService accessed via services.fret */
function makeFretStub() {
  return {
    hashKey: jest.fn().mockResolvedValue(new Uint8Array(32)),
    getNeighbors: jest.fn().mockResolvedValue([]),
    assembleCohort: jest.fn().mockResolvedValue(new Map()),
  };
}

/** Minimal Libp2p stub that exposes a fret service (cadre-core wires this in) */
function makeLibp2pStub() {
  return {
    services: {
      fret: makeFretStub(),
    },
    getPeers: jest.fn().mockReturnValue([]),
    getConnections: jest.fn().mockReturnValue([]),
  };
}

/** Minimal StrandInstance stub with an active libp2pNode */
function makeActiveStrand() {
  return {
    libp2pNode: makeLibp2pStub(),
    database: {},
    connectedPeers: 0,
  };
}

/** Minimal StrandInstance stub with NO libp2pNode (falsy) */
function makeInactiveStrand() {
  return {
    libp2pNode: null,
    database: {},
    connectedPeers: 0,
  };
}

// ---------------------------------------------------------------------------
// P2P-04 / P2P-05: IKeyNetwork two-method surface
// ---------------------------------------------------------------------------

describe('createStrandKeyNetwork — P2P-04/P2P-05', () => {
  it('returns an object exposing findCoordinator', () => {
    const strand = makeActiveStrand();
    const kn = createStrandKeyNetwork(strand);
    expect(typeof kn.findCoordinator).toBe('function');
  });

  it('returns an object exposing findCluster', () => {
    const strand = makeActiveStrand();
    const kn = createStrandKeyNetwork(strand);
    expect(typeof kn.findCluster).toBe('function');
  });

  it('does NOT expose dialProtocol (not part of current IKeyNetwork)', () => {
    const strand = makeActiveStrand();
    const kn = createStrandKeyNetwork(strand);
    expect((kn as Record<string, unknown>).dialProtocol).toBeUndefined();
  });

  it('throws "Strand libp2p node not active" when libp2pNode is falsy', () => {
    const strand = makeInactiveStrand();
    expect(() => createStrandKeyNetwork(strand)).toThrow('Strand libp2p node not active');
  });

  it('findCoordinator delegates to the FRET ring (resolves a PeerId-shaped value)', async () => {
    const strand = makeActiveStrand();
    const kn = createStrandKeyNetwork(strand);
    const key = new Uint8Array(32);
    // Expect a promise — the exact resolved value is verified by integration tests (P2P-05 RED)
    await expect(kn.findCoordinator(key)).resolves.toBeDefined();
  });

  it('findCluster delegates to the FRET ring (resolves a ClusterPeers-shaped value)', async () => {
    const strand = makeActiveStrand();
    const kn = createStrandKeyNetwork(strand);
    const key = new Uint8Array(32);
    // Expect a promise — exact shape verified by integration tests
    await expect(kn.findCluster(key)).resolves.toBeDefined();
  });
});
