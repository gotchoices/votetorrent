/**
 * First-sync gate (StrandAwaitingFirstSyncError) tests for the Voter app's strand-backed
 * DbFactory — quick task 260928-kkf. Mirrors the Authority app's
 * `rn-db-factory.test.ts` "first-sync gate" describe block (same cases (a)/(a2)/(b)/
 * (b2)/(b3)/(c)/(c2)) — see that file for the fuller original commentary.
 *
 * The heavy native/runtime deps of `rn-db-factory.ts` are mocked at module load
 * (mirrors the Authority header) so importing the factory is safe under jest; the
 * strand behaviour is driven entirely by the fake node below. The fake gate error is a
 * plain `Error` with `name = 'StrandAwaitingFirstSyncError'`, `strandId`, `waitedMs`
 * set — exactly what the real class produces. `@serfab/cadre-core` is NOT mocked —
 * `rn-db-factory.ts` imports only TYPES from it (see strand-first-sync.ts's own header
 * for why a value/virtual mock would break the "any other error rejects unchanged"
 * contract).
 */

// --- mock the module-load-time native/runtime deps so importing the factory is safe ---
jest.mock('rn-leveldb', () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }), {
  virtual: true,
});

jest.mock('@quereus/quereus', () => {
  const DatabaseMock = jest.fn(function(this: Record<string, jest.Mock>) {
    this.registerModule = jest.fn();
    this.setDefaultVtabName = jest.fn();
    this.setSchemaPath = jest.fn();
    this.exec = jest.fn().mockResolvedValue(undefined);
    this.prepare = jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) });
  });
  return {
    Database: DatabaseMock,
    registerPlugin: jest.fn(),
  };
}, { virtual: true });

jest.mock('@quereus/plugin-react-native-leveldb', () => ({ ReactNativeLevelDBProvider: jest.fn() }), { virtual: true });

jest.mock('@quereus/store', () => ({
  createIsolatedStoreModule: jest.fn(() => ({ /* stub VirtualTableModule */ })),
}), { virtual: true });

jest.mock(
  '@votetorrent/vote-engine/rn',
  () => ({
    VOTETORRENT_SCHEMA_SQL: 'declare schema main {\n\ttable Network ( Id text );\n}\napply schema main;',
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrandDbFactory } = require('../rn-db-factory');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StrandWaitCancelledError, StrandLaunchFailedError, failOnStrandError } = require('../strand-first-sync');

// ---------------------------------------------------------------------------
// Fakes: a strand DB whose bare table names resolve, and a CadreNode seam.
// ---------------------------------------------------------------------------

/** Fake Quereus Database — setSchemaPath spy + a query path that accepts bare names. */
function makeFakeStrandDb() {
  return {
    setSchemaPath: jest.fn(),
    exec: jest.fn().mockResolvedValue(undefined),
    prepare: jest.fn().mockReturnValue({ all: jest.fn().mockResolvedValue([]) }),
  };
}

/**
 * Fake CadreNode seam. `connections` controls getControlNode().getConnections().length.
 * addStrand records that it resolved BEFORE getDatabase() is read (ordering guard).
 * `whenStrandWritable` is a jest.fn() the first-sync gate tests reconfigure per case;
 * it defaults to rejecting so a test that forgets to configure it fails loudly rather
 * than hanging.
 */
function makeFakeNode({ connections = 0, db = makeFakeStrandDb() } = {}) {
  let strandAdded = false;
  const strand = {
    strandId: 'fake',
    database: {
      getDatabase: jest.fn(() => {
        if (!strandAdded) throw new Error('getDatabase() called before addStrand resolved');
        return db;
      }),
    },
    connectedPeers: connections,
  };
  return {
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addStrand: jest.fn(async (_config: any) => {
      strandAdded = true;
      return strand;
    }),
    getControlNode: jest.fn(() => ({
      getConnections: () => new Array(connections).fill({}),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    whenStrandWritable: jest.fn(async (_strandId: string): Promise<any> => {
      throw new Error('whenStrandWritable not configured for this test');
    }),
    __markWritable(): void {
      strandAdded = true;
    },
  };
}

/** Builds a fake gate error exactly as the real StrandAwaitingFirstSyncError shapes it. */
function makeGateError(strandId: string, waitedMs = 300_000): Error {
  const err = new Error(`Strand ${strandId} is not yet reachable`);
  err.name = 'StrandAwaitingFirstSyncError';
  (err as unknown as { strandId: string; waitedMs: number }).strandId = strandId;
  (err as unknown as { strandId: string; waitedMs: number }).waitedMs = waitedMs;
  return err;
}

describe('createStrandDbFactory — first-sync gate (StrandAwaitingFirstSyncError) — Voter', () => {
  it('(a) waits via whenStrandWritable and resolves once writable, calling onAwaitingFirstSync once before resolution', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    const callOrder: string[] = [];
    node.whenStrandWritable.mockImplementationOnce(async (strandId: string) => {
      callOrder.push('whenStrandWritable');
      expect(strandId).toBe('networkhash123');
      node.__markWritable();
      return { strandId, database: { getDatabase: () => node.db } };
    });
    const onAwaitingFirstSync = jest.fn((strandId: string) => {
      callOrder.push('onAwaitingFirstSync:' + strandId);
    });

    const factory = createStrandDbFactory(node, { onAwaitingFirstSync });
    const db = await factory('networkhash123');

    expect(db).toBe(node.db);
    expect(node.db.setSchemaPath).toHaveBeenCalledTimes(1);
    expect(node.db.setSchemaPath).toHaveBeenCalledWith(['App', 'main']);
    expect(node.addStrand).toHaveBeenCalledTimes(1);
    expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);
    expect(onAwaitingFirstSync).toHaveBeenCalledTimes(1);
    expect(onAwaitingFirstSync).toHaveBeenCalledWith('networkhash123');
    expect(callOrder).toEqual(['onAwaitingFirstSync:networkhash123', 'whenStrandWritable']);
  });

  it('(a2) a gate rejection followed by a resolution does not hot-loop (floored at MIN_FIRST_SYNC_RETRY_INTERVAL_MS), addStrand called exactly once', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const node = makeFakeNode();
      const gateError = makeGateError('networkhash123');
      node.addStrand.mockRejectedValueOnce(gateError);

      let calls = 0;
      node.whenStrandWritable.mockImplementation(async (strandId: string) => {
        calls += 1;
        if (calls === 1) {
          throw makeGateError(strandId);
        }
        node.__markWritable();
        return { strandId, database: { getDatabase: () => node.db } };
      });

      const factory = createStrandDbFactory(node);
      const resultPromise = factory('networkhash123');

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5000);
      const db = await resultPromise;

      expect(db).toBe(node.db);
      expect(node.whenStrandWritable).toHaveBeenCalledTimes(2);
      expect(node.addStrand).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('(b) a generic addStrand rejection rejects the factory with the SAME error object; whenStrandWritable and onAwaitingFirstSync never called', async () => {
    const node = makeFakeNode();
    const boom = new Error('boom');
    node.addStrand.mockRejectedValueOnce(boom);
    const onAwaitingFirstSync = jest.fn();

    const factory = createStrandDbFactory(node, { onAwaitingFirstSync });

    await expect(factory('networkhash123')).rejects.toBe(boom);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
    expect(onAwaitingFirstSync).not.toHaveBeenCalled();
  });

  it('(b2) a gate-named error for a DIFFERENT strand rejects the factory unchanged (not waited on)', async () => {
    const node = makeFakeNode();
    const otherStrandError = makeGateError('some-other-strand');
    node.addStrand.mockRejectedValueOnce(otherStrandError);

    const factory = createStrandDbFactory(node);

    await expect(factory('networkhash123')).rejects.toBe(otherStrandError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });

  it('(b3) a non-gate whenStrandWritable rejection rejects the factory with it', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);
    const notRunning = new Error('strand not running on this node');
    node.whenStrandWritable.mockRejectedValueOnce(notRunning);

    const factory = createStrandDbFactory(node);

    await expect(factory('networkhash123')).rejects.toBe(notRunning);
  });

  it('(c) aborting the signal while whenStrandWritable is pending rejects with StrandWaitCancelledError, removes the abort listener, and never touches the orphaned resolution', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    let resolveOrphan!: (value: unknown) => void;
    node.whenStrandWritable.mockImplementationOnce(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Promise<any>((resolve) => {
          resolveOrphan = resolve;
        }),
    );

    const controller = new AbortController();
    const addSpy = jest.spyOn(controller.signal, 'addEventListener');
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');

    const factory = createStrandDbFactory(node, { signal: controller.signal });
    const resultPromise = factory('networkhash123');

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(node.whenStrandWritable).toHaveBeenCalledTimes(1);

    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(StrandWaitCancelledError);
    expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    resolveOrphan({ strandId: 'networkhash123', database: { getDatabase: () => node.db } });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.db.setSchemaPath).not.toHaveBeenCalled();
  });

  it('(c2) an already-aborted signal rejects with StrandWaitCancelledError without calling whenStrandWritable', async () => {
    const node = makeFakeNode();
    const gateError = makeGateError('networkhash123');
    node.addStrand.mockRejectedValueOnce(gateError);

    const controller = new AbortController();
    controller.abort();

    const factory = createStrandDbFactory(node, { signal: controller.signal });

    await expect(factory('networkhash123')).rejects.toBeInstanceOf(StrandWaitCancelledError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });
});

describe('createStrandDbFactory — a strand that fails to start is not waited on forever', () => {
  // 2026-10-31: a joiner whose deferred database build failed (`Missing block` from a slow seed)
  // was left `'error'` by cadre-core with its writable waiters never rejected; the join hung.
  function withStatus(node: ReturnType<typeof makeFakeNode>) {
    let status = 'starting';
    const stopStrand = jest.fn(async (_strandId: string) => undefined);
    const extended = Object.assign(node, {
      getStrand: jest.fn((_strandId: string) => ({ status })),
      stopStrand,
    });
    return { node: extended, fail: () => { status = 'error'; }, stopStrand };
  }

  it('(e1) a pending addStrand whose strand turns error rejects with StrandLaunchFailedError and stops the strand', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockImplementationOnce(() => new Promise(() => undefined));

    const opened = createStrandDbFactory(node)('networkhash123');
    fail();

    await expect(opened).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(stopStrand).toHaveBeenCalledWith('networkhash123');
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
  });

  it('(e2) a gate wait whose strand turns error rejects with StrandLaunchFailedError and stops the strand', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockRejectedValueOnce(makeGateError('networkhash123'));
    node.whenStrandWritable.mockImplementation(() => new Promise(() => undefined));

    const opened = createStrandDbFactory(node)('networkhash123');
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail();

    await expect(opened).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(stopStrand).toHaveBeenCalledTimes(1);
  });

  it('(e3) the wait loop does not start another attempt on a strand already in error', async () => {
    const { node, fail, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    node.addStrand.mockRejectedValueOnce(makeGateError('networkhash123'));
    fail();

    await expect(createStrandDbFactory(node)('networkhash123')).rejects.toBeInstanceOf(StrandLaunchFailedError);
    expect(node.whenStrandWritable).not.toHaveBeenCalled();
    expect(stopStrand).toHaveBeenCalledTimes(1);
  });

  it('(e4) a strand that stays healthy opens exactly as before, and a host without getStrand is passed through', async () => {
    const { node, stopStrand } = withStatus(makeFakeNode({ connections: 1 }));
    await expect(createStrandDbFactory(node)('networkhash123')).resolves.toBe(node.db);
    expect(stopStrand).not.toHaveBeenCalled();

    const pending = Promise.resolve('value');
    expect(failOnStrandError({}, 'networkhash123', pending)).toBe(pending);
  });
});

describe('createStrandDbFactory — a joined network is never opened as founder (spike 100)', () => {
  it('with no peer connected, a network this phone did NOT join opens as founder (the solo create path)', async () => {
    const node = makeFakeNode({ connections: 0 });
    await createStrandDbFactory(node, { isJoinedNetwork: () => false })('created-here');
    expect(node.addStrand.mock.calls[0][0].founder).toBe(true);
  });

  it('with no peer connected (a cold restart), a JOINED network still opens as a joiner, never as founder', async () => {
    const node = makeFakeNode({ connections: 0 });
    await createStrandDbFactory(node, { isJoinedNetwork: async (id: string) => id === 'joined-hash' })('joined-hash');
    expect(node.addStrand.mock.calls[0][0].founder).toBe(false);
  });

  it('an unreadable joined-network list refuses to open rather than risk founding', async () => {
    const node = makeFakeNode({ connections: 0 });
    await expect(createStrandDbFactory(node, { isJoinedNetwork: async () => { throw new Error('storage'); } })('h'))
      .rejects.toThrow('not opening the network as its founder');
    expect(node.addStrand).not.toHaveBeenCalled();
  });
});
