/**
 * RED → GREEN test for isSelfVouched (QUICK-260928-jwi).
 *
 * This mirrors cadre-core 1.18.0's (unchanged in substance since 1.14.0) private CadreNode#hasAnchoredProof(row, chain) — checks 2-4
 * of the authorized-membership predicate, by either proof a row can carry (an owner voucher, or
 * the invitation admission a member seats on redemption) — applied to THIS peer's own CadrePeer
 * row. It exists because
 * listAuthorizedMembers()/isAuthorizedMember() unconditionally exclude self (check 1,
 * cadre-node.js:6058 `row.peerId !== selfPeerId`), and isMember(self) skips the voucher
 * check entirely (true before any owner ever vouches).
 *
 * @serfab/cadre-core is ESM-only, so it is registered `{ virtual: true }` here exactly like
 * replication-proof-runner.test.ts.
 */

// `mock`-prefixed so jest's hoisted module factory can reference it.
const mockVerify = jest.fn();
const mockVerifyAdmission = jest.fn();

jest.mock(
  '@serfab/cadre-core',
  () => ({
    verifyCadrePeerVoucher: (...a: unknown[]) => mockVerify(...a),
    verifyInvitationAdmission: (...a: unknown[]) => mockVerifyAdmission(...a),
  }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { isSelfVouched, type SelfVoucherNode } from '../self-voucher';

const PARTY_ID = 'votetorrent';
const SELF_PEER_ID = 'selfPeer';
const OWNER_KEY = 'ownerKeyB64';
const OTHER_OWNER_KEY = 'someOtherOwnerKeyB64';
const STAMP_ID = 'stamp-1';
const SIG = 'sigB64';

type Row = {
  peerId: string;
  multiaddr: string | null;
  stampId: string | null;
  vouchOwner: string | null;
  vouchSig: string | null;
  vouchUsage: string | null;
};

const USAGE_STAMP = 'usage-1';
const INVITE_KEY = 'inviteKeyB64';
const usageRow = { usageStampId: USAGE_STAMP, inviteKey: INVITE_KEY, peerId: SELF_PEER_ID, peerStampId: STAMP_ID };
const inviteRow = { key: INVITE_KEY, issuerKey: OWNER_KEY };

const selfRowVouched: Row = {
  peerId: SELF_PEER_ID,
  multiaddr: null,
  stampId: STAMP_ID,
  vouchOwner: OWNER_KEY,
  vouchSig: SIG,
  vouchUsage: null,
};

/** The row a member seats when this peer redeems a cadre invitation (cadre-core 1.14+). */
const selfRowAdmitted: Row = {
  peerId: SELF_PEER_ID,
  multiaddr: null,
  stampId: STAMP_ID,
  vouchOwner: OWNER_KEY,
  vouchSig: null,
  vouchUsage: USAGE_STAMP,
};

function makeNode(opts: {
  rows?: Row[] | (() => Promise<Row[]>);
  ownerSet?: Set<string>;
  noDb?: boolean;
  noStore?: boolean;
  usages?: unknown[];
  invites?: unknown[];
}): SelfVoucherNode & { queryCadreInviteUsages: jest.Mock; queryCadreInvites: jest.Mock } {
  const queryCadrePeers = jest.fn(async () => {
    if (typeof opts.rows === 'function') {
      return opts.rows();
    }
    return opts.rows ?? [];
  });
  const queryCadreInviteUsages = jest.fn(async () => opts.usages ?? [usageRow]);
  const queryCadreInvites = jest.fn(async () => opts.invites ?? [inviteRow]);
  return {
    partyId: PARTY_ID,
    getControlDatabase: () =>
      opts.noDb ? null : { queryCadrePeers, queryCadreInviteUsages, queryCadreInvites },
    getTrustedOwnerStore: () =>
      opts.noStore ? null : { has: (k: string) => (opts.ownerSet ?? new Set([OWNER_KEY])).has(k) },
    queryCadreInviteUsages,
    queryCadreInvites,
  } as unknown as SelfVoucherNode & { queryCadreInviteUsages: jest.Mock; queryCadreInvites: jest.Mock };
}

beforeEach(() => {
  mockVerify.mockReset();
  mockVerify.mockReturnValue(true);
  mockVerifyAdmission.mockReset();
  mockVerifyAdmission.mockReturnValue(true);
});

describe('isSelfVouched', () => {
  it('resolves true when the self row is fully vouched by an anchored owner and verify succeeds', async () => {
    const node = makeNode({ rows: [selfRowVouched] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(true);

    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith(PARTY_ID, SELF_PEER_ID, STAMP_ID, OWNER_KEY, SIG);
  });

  it('judges a vouched row as a voucher and never reads the invitation tables', async () => {
    const node = makeNode({ rows: [selfRowVouched] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(true);
    expect(node.queryCadreInviteUsages).not.toHaveBeenCalled();
    expect(node.queryCadreInvites).not.toHaveBeenCalled();
    expect(mockVerifyAdmission).not.toHaveBeenCalled();
  });

  it('resolves false when queryCadrePeers returns only OTHER peers fully vouched rows', async () => {
    const node = makeNode({
      rows: [
        {
          peerId: 'someOtherPeer',
          multiaddr: null,
          stampId: STAMP_ID,
          vouchOwner: OWNER_KEY,
          vouchSig: SIG,
          vouchUsage: null,
        },
      ],
    });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when stampId is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, stampId: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when vouchOwner is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, vouchOwner: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when vouchSig is null', async () => {
    const node = makeNode({ rows: [{ ...selfRowVouched, vouchSig: null }] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false and does not call verify when the self row is complete but its owner is not anchored', async () => {
    const node = makeNode({ rows: [selfRowVouched], ownerSet: new Set([OTHER_OWNER_KEY]) });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('resolves false when the self row is complete, owner is anchored, but verify returns false', async () => {
    mockVerify.mockReturnValue(false);
    const node = makeNode({ rows: [selfRowVouched] });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('resolves false without throwing when getControlDatabase() returns null', async () => {
    const node = makeNode({ noDb: true });

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
  });

  it('resolves false without throwing and never calls queryCadrePeers when getTrustedOwnerStore() returns null', async () => {
    const queryCadrePeers = jest.fn(async () => [selfRowVouched]);
    const node = {
      partyId: PARTY_ID,
      getControlDatabase: () => ({ queryCadrePeers }),
      getTrustedOwnerStore: () => null,
    } as unknown as SelfVoucherNode;

    await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    expect(queryCadrePeers).not.toHaveBeenCalled();
  });

  describe('invitation-admitted self row (redeemed cadre invitation)', () => {
    it('resolves true when the usage and invitation it names verify against the anchor', async () => {
      const node = makeNode({ rows: [selfRowAdmitted] });

      await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(true);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockVerifyAdmission).toHaveBeenCalledTimes(1);
      const [partyId, row, usage, invite, isAnchored] = mockVerifyAdmission.mock.calls[0];
      expect([partyId, row, usage, invite]).toEqual([PARTY_ID, selfRowAdmitted, usageRow, inviteRow]);
      expect(isAnchored(OWNER_KEY)).toBe(true);
      expect(isAnchored(OTHER_OWNER_KEY)).toBe(false);
    });

    it('resolves false when verifyInvitationAdmission rejects the chain', async () => {
      mockVerifyAdmission.mockReturnValue(false);
      const node = makeNode({ rows: [selfRowAdmitted] });

      await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
    });

    it('resolves false without verifying when the usage row has not replicated', async () => {
      const node = makeNode({ rows: [selfRowAdmitted], usages: [] });

      await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
      expect(mockVerifyAdmission).not.toHaveBeenCalled();
    });

    it('resolves false without verifying when the invitation row has not replicated', async () => {
      const node = makeNode({ rows: [selfRowAdmitted], invites: [] });

      await expect(isSelfVouched(node, SELF_PEER_ID)).resolves.toBe(false);
      expect(mockVerifyAdmission).not.toHaveBeenCalled();
    });
  });

  it('rejects (does not swallow) when queryCadrePeers rejects', async () => {
    const err = new Error('control DB not readable yet');
    const node = makeNode({
      rows: () => Promise.reject(err),
    });

    await expect(isSelfVouched(node, SELF_PEER_ID)).rejects.toBe(err);
  });
});
