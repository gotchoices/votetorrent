import {
  OWNER_REANCHOR_TIMEOUT_MS,
  OWNER_TRUST_CLASSIFY_TIMEOUT_MS,
  OwnerTrustUnreadableError,
  classifyOwnerTrust,
  readOwnerTrustClassification,
  reanchorOwnKey,
  type OwnerTrustNode,
} from '../owner-trust';

const PLANTED = 'planted-secret-text';

describe('classifyOwnerTrust', () => {
  const rows: Array<[string, 'persistent' | 'memory', number, string[], string | null, 'ok' | 'needs-reinvite']> = [
    ['brand-new phone, no rows', 'persistent', 0, [], 'self', 'ok'],
    ['founder before the re-anchor', 'persistent', 0, ['self'], 'self', 'ok'],
    ['founder after the re-anchor', 'persistent', 1, ['self'], 'self', 'ok'],
    ['joined, pins lost', 'persistent', 0, ['drone'], 'self', 'needs-reinvite'],
    ['joined, pins saved', 'persistent', 1, ['drone'], 'self', 'ok'],
    ['memory-only is the provider state', 'memory', 0, ['drone'], 'self', 'ok'],
    ['ephemeral identity', 'persistent', 0, ['drone'], null, 'needs-reinvite'],
    ['this phone is one of several owners', 'persistent', 0, ['drone', 'self'], 'self', 'ok'],
  ];
  it.each(rows)('%s', (_name, storeKind, anchorSize, ownerKeys, selfKey, expected) => {
    expect(classifyOwnerTrust({ storeKind, anchorSize, ownerKeys, selfKey })).toBe(expected);
  });
});

interface FakeOpts {
  anchor?: string[];
  owners?: string[];
  ownersError?: boolean;
  ownersHang?: boolean;
  noStore?: boolean;
  noDb?: boolean;
  noIdentity?: boolean;
  wire?: () => Promise<boolean>;
}

function fakeNode(o: FakeOpts = {}) {
  const trust = jest.fn(async () => undefined);
  const trustOwnerKeys = jest.fn(async () => undefined);
  const getOwnerKeys = jest.fn(async () => {
    if (o.ownersHang) return new Promise<ReadonlySet<string>>(() => undefined);
    if (o.ownersError) throw new Error(PLANTED);
    return new Set(o.owners ?? []);
  });
  const node = {
    getTrustedOwnerStore: () => (o.noStore ? null : { all: () => new Set(o.anchor ?? []), trust }),
    getControlDatabase: () => (o.noDb ? null : { getOwnerKeys }),
    getIdentityOwnerKey: () => {
      if (o.noIdentity) throw new Error(PLANTED);
      return { publicKeyB64: 'self' };
    },
    wireOwnKeyIfOwner: jest.fn(o.wire ?? (async () => true)),
    trustOwnerKeys,
  };
  return { node: node as unknown as OwnerTrustNode, trust, trustOwnerKeys, getOwnerKeys, wire: node.wireOwnKeyIfOwner };
}

function loggedText(spy: jest.SpyInstance): string {
  return JSON.stringify(spy.mock.calls);
}

describe('owner-trust constants and error', () => {
  it('fixes the bounds and names the error', () => {
    expect(OWNER_REANCHOR_TIMEOUT_MS).toBe(5000);
    expect(OWNER_TRUST_CLASSIFY_TIMEOUT_MS).toBe(5000);
    const e = new OwnerTrustUnreadableError();
    expect(e.name).toBe('OwnerTrustUnreadableError');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('reanchorOwnKey', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('maps true to wired and false to not-owner', async () => {
    expect(await reanchorOwnKey(fakeNode({ wire: async () => true }).node)).toBe('wired');
    expect(await reanchorOwnKey(fakeNode({ wire: async () => false }).node)).toBe('not-owner');
    expect(warn).not.toHaveBeenCalled();
  });

  it('hands wireOwnKeyIfOwner the identity owner signer when the node has one (cadre-core 1.18)', async () => {
    const signer = { publicKey: 'self-pub' };
    const wire = jest.fn(async () => true);
    const node = { wireOwnKeyIfOwner: wire, getIdentityOwnerSigner: () => signer };
    expect(await reanchorOwnKey(node)).toBe('wired');
    expect(wire).toHaveBeenCalledWith(signer);
  });

  it('maps a throwing identity signer to failed, without calling wireOwnKeyIfOwner', async () => {
    const wire = jest.fn(async () => true);
    const node = { wireOwnKeyIfOwner: wire, getIdentityOwnerSigner: () => { throw new Error(PLANTED); } };
    expect(await reanchorOwnKey(node)).toBe('failed');
    expect(wire).not.toHaveBeenCalled();
    expect(loggedText(warn)).not.toContain(PLANTED);
  });

  it('maps a rejection to failed with one closed token and no rejection text', async () => {
    const f = fakeNode({
      wire: async () => {
        throw new Error(PLANTED);
      },
    });
    expect(await reanchorOwnKey(f.node)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[owner-trust] reanchor: failed');
    expect(loggedText(warn)).not.toContain(PLANTED);
    expect(f.trust).not.toHaveBeenCalled();
    expect(f.trustOwnerKeys).not.toHaveBeenCalled();
  });

  it('times out exactly at the bound and logs one closed token', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const f = fakeNode({ wire: () => new Promise<boolean>(() => undefined) });
    let outcome: string | undefined;
    const p = reanchorOwnKey(f.node).then((r) => {
      outcome = r;
    });
    await jest.advanceTimersByTimeAsync(4999);
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(outcome).toBe('timed-out');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[owner-trust] reanchor: timed-out');
  });

  it('clears its timer after a prompt resolve', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    await reanchorOwnKey(fakeNode().node);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('readOwnerTrustClassification', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
  });

  it('returns the classification table results through a fake node and never pins', async () => {
    const cases: Array<[FakeOpts, 'ok' | 'needs-reinvite']> = [
      [{ anchor: [], owners: [] }, 'ok'],
      [{ anchor: [], owners: ['self'] }, 'ok'],
      [{ anchor: ['self'], owners: ['self'] }, 'ok'],
      [{ anchor: [], owners: ['drone'] }, 'needs-reinvite'],
      [{ anchor: ['drone'], owners: ['drone'] }, 'ok'],
      [{ anchor: [], owners: ['drone', 'self'] }, 'ok'],
      [{ anchor: [], owners: ['drone'], noIdentity: true }, 'needs-reinvite'],
    ];
    for (const [opts, expected] of cases) {
      const f = fakeNode(opts);
      expect(await readOwnerTrustClassification(f.node, 'persistent')).toBe(expected);
      expect(f.trust).not.toHaveBeenCalled();
      expect(f.trustOwnerKeys).not.toHaveBeenCalled();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns ok for a memory store without reading the control database', async () => {
    const f = fakeNode({ owners: ['drone'] });
    expect(await readOwnerTrustClassification(f.node, 'memory')).toBe('ok');
    expect(f.getOwnerKeys).not.toHaveBeenCalled();
  });

  it.each<[string, FakeOpts]>([
    ['owner keys reject', { ownersError: true }],
    ['no control database', { noDb: true }],
    ['no trusted-owner store', { noStore: true }],
  ])('is unreadable when %s, with one closed token and no raw text', async (_n, opts) => {
    const f = fakeNode(opts);
    expect(await readOwnerTrustClassification(f.node, 'persistent')).toBe('unreadable');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[owner-trust] classify: unreadable');
    expect(loggedText(warn)).not.toContain(PLANTED);
    expect(f.trust).not.toHaveBeenCalled();
    expect(f.trustOwnerKeys).not.toHaveBeenCalled();
  });

  it('is unreadable when the owner read never settles, at the classify bound', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    const f = fakeNode({ ownersHang: true });
    let outcome: string | undefined;
    const p = readOwnerTrustClassification(f.node, 'persistent').then((r) => {
      outcome = r;
    });
    await jest.advanceTimersByTimeAsync(OWNER_TRUST_CLASSIFY_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(outcome).toBe('unreadable');
    expect(warn).toHaveBeenCalledWith('[owner-trust] classify: unreadable');
    expect(jest.getTimerCount()).toBe(0);
  });
});
