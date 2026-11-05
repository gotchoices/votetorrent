/**
 * self-voucher.ts — isSelfVouched (QUICK-260928-jwi).
 *
 * Mirrors @serfab/cadre-core 1.18.0's (unchanged in substance since 1.14.0) PRIVATE `CadreNode#hasAnchoredProof(row, chain)` —
 * checks 2-4 of the authorized-membership predicate — applied to THIS peer's own `CadrePeer`
 * row. A row carries one of two proofs, and the voucher wins when both are present:
 *  - an owner VOUCHER (`hasAnchoredVoucher`): complete voucher, `VouchOwner` anchored in the
 *    node-local trust store, signature valid over the row's (partyId, PeerId, StampId) digest;
 *  - an INVITATION ADMISSION (`vouchSig` null, `vouchUsage` set): the row a member seats when
 *    this peer redeems a cadre invitation, judged by the exported `verifyInvitationAdmission`
 *    over the `CadreInviteUsage` row it names and the `CadreInvite` row that usage names.
 * Check 5 (revocation) is already applied upstream by `ControlDatabase.queryCadrePeers`.
 *
 * It exists because `listAuthorizedMembers()` / `isAuthorizedMember()` unconditionally
 * exclude self (check 1: `row.peerId !== selfPeerId`), so neither can ever answer true for
 * our own row, and `isMember(self)` is the addressable surface — it reads true before any
 * owner has vouched at all. Only public `CadreNode` API is read here (`partyId`,
 * `getControlDatabase()`, `getTrustedOwnerStore()`, the exported `verifyCadrePeerVoucher` and
 * `verifyInvitationAdmission`) — no private cadre-core field.
 *
 * Re-diffed on every cadre-core bump: `hasAnchoredVoucher` was byte-identical from 1.6.0
 * through 1.13.0. 1.14.0 changed it twice — the voucher digest gained `partyId`, and the
 * invitation branch was added (redemption is now the only joiner route the API offers). On the
 * 1.15.0 bump `hasAnchoredProof`, `hasAnchoredVoucher` and `isInvitationAdmitted` re-diffed
 * byte-identical and `peer-authorization.js` was unchanged. 1.16.0's whole `dist/` is
 * byte-identical to 1.15.0's (only dependency ranges moved). 1.18.0 (2026-10-26): `hasAnchoredVoucher`
 * is byte-identical; `isInvitationAdmitted` was renamed `isConsentSeated` (same predicate, `vouchSig`
 * null and `vouchUsage` set, now also covering owner-grant `OwnerKey` rows); `hasAnchoredProof` only
 * gained a NOTE; `verifyInvitationAdmission` inlined its shared chain with the same eight links
 * (anchored issuer, issuer = `vouchOwner`, usage/peer stamps, targeted peer, peer key, and the add,
 * redeem and consent signatures). A future bump should re-diff the same three in `cadre-node.js`
 * before trusting this unchanged.
 */
import { verifyCadrePeerVoucher, verifyInvitationAdmission } from '@serfab/cadre-core';
import type { CadreInviteRow, CadreInviteUsageRow, CadrePeerRow } from '@serfab/cadre-core';

type VoucherRow = Pick<CadrePeerRow, 'peerId' | 'stampId' | 'vouchOwner' | 'vouchSig' | 'vouchUsage'>;

/**
 * Structural subset of `CadreNode` this predicate needs — the real `CadreNode` satisfies
 * it with no cast (see replication-proof-runner.ts's `authNode` usage).
 */
export interface SelfVoucherNode {
  readonly partyId: string;
  getControlDatabase(): {
    queryCadrePeers(retry?: boolean): Promise<ReadonlyArray<VoucherRow>>;
    queryCadreInvites(retry?: boolean): Promise<ReadonlyArray<CadreInviteRow>>;
    queryCadreInviteUsages(retry?: boolean): Promise<ReadonlyArray<CadreInviteUsageRow>>;
  } | null;
  getTrustedOwnerStore(): { has(ownerKey: string): boolean } | null;
}

/** cadre-core's `isInvitationAdmitted`: no owner signature, a usage stamp instead. */
function isInvitationAdmitted(row: VoucherRow): boolean {
  return row.vouchSig === null && row.vouchUsage != null;
}

/**
 * True when THIS peer's own replicated `CadrePeer` row carries a proof — an owner voucher or
 * an invitation admission — that chains to an owner anchored in the node-local trust store.
 * Cheap synchronous surfaces (the store, the DB) are checked before the async row read, and
 * the invitation tables are read only when the row needs them.
 */
export async function isSelfVouched(node: SelfVoucherNode, peerId: string): Promise<boolean> {
  const store = node.getTrustedOwnerStore();
  if (!store) {
    return false;
  }
  const db = node.getControlDatabase();
  if (!db) {
    return false;
  }
  const rows = await db.queryCadrePeers();
  const self = rows.find((r) => r.peerId === peerId);
  if (!self) {
    return false;
  }
  if (isInvitationAdmitted(self)) {
    const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()]);
    const usage = usages.find((u) => u.usageStampId === self.vouchUsage);
    const invite = usage === undefined ? undefined : invites.find((i) => i.key === usage.inviteKey);
    if (usage === undefined || invite === undefined) {
      return false;
    }
    return verifyInvitationAdmission(node.partyId, self, usage, invite, (key) => store.has(key));
  }
  if (self.stampId === null || self.vouchOwner === null || self.vouchSig === null) {
    return false;
  }
  if (!store.has(self.vouchOwner)) {
    return false;
  }
  return verifyCadrePeerVoucher(node.partyId, self.peerId, self.stampId, self.vouchOwner, self.vouchSig);
}
