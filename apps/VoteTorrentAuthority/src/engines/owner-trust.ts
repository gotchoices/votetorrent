/**
 * Owner trust: what the Authority knows about its saved trusted-owner anchor (D-08..D-11).
 *
 * The anchor is the set of owner keys this phone has been told, out of band, to trust (cadre-core's
 * TrustedOwnerStore). `isAuthorizedMember` checks pool admissions against it. The replicated
 * `OwnerKey` table is NOT a source of trust: any cadre member can write rows there, so this module
 * reads it only to CLASSIFY and never pins anything from it (D-09). Pins come from an invitation
 * or from the operator.
 *
 * The four states, in priority order blocked > memory-only > needs-reinvite > ok:
 *  - 'blocked'      (D-11) the saved store would not open and the officer requires saved trust; no node
 *                   was started. Decided by CadreNodeProvider from the store-open outcome.
 *  - 'memory-only'  (D-10) the saved store would not open and saved trust is not required; the node
 *                   runs on cadre-core's in-memory anchor, which a restart loses. Decided by the provider.
 *  - 'needs-reinvite' (D-09) the saved store opened, its anchor is empty after the re-anchor, and the
 *                   control DB shows owners that exclude this phone: the pins were lost and only a
 *                   fresh invitation can restore them. Decided here, by classifyOwnerTrust.
 *  - 'ok'           anything else, including a brand-new phone with no rows.
 *
 * A corrupt, foreign-party or unknown-version saved record loads EMPTY and does not reject (cadre-core's
 * NodeLocalSnapshot), so it does not trigger D-10. This classification plus the founder re-anchor
 * cover it: an owner phone re-pins its own key at boot, a joined phone reads needs-reinvite.
 *
 * Structural types only, and no imports: the real CadreNode satisfies OwnerTrustNode without a cast,
 * and the RN jest project loads this file with no mock.
 */

export type OwnerTrustState = 'ok' | 'needs-reinvite' | 'memory-only' | 'blocked';

export type OwnerStoreKind = 'persistent' | 'memory';

/** Bound on the boot re-anchor. A slow or hung wire must not stop the node from booting. */
export const OWNER_REANCHOR_TIMEOUT_MS = 5_000;

/** Bound on one classification read of the control database. */
export const OWNER_TRUST_CLASSIFY_TIMEOUT_MS = 5_000;

export interface OwnerTrustNode {
  getTrustedOwnerStore(): { all(): ReadonlySet<string> } | null;
  getControlDatabase(): { getOwnerKeys(): Promise<ReadonlySet<string>> } | null;
  getIdentityOwnerKey(): { publicKeyB64: string };
  /** cadre-core 1.18 takes the candidate owner signer explicitly (see identity-owner-key.ts). */
  wireOwnKeyIfOwner(signer?: unknown): Promise<boolean>;
  /** The identity owner signer, when the node carries one (identity-owner-key.ts). */
  getIdentityOwnerSigner?(): unknown;
}

export type ReanchorOutcome = 'wired' | 'not-owner' | 'failed' | 'timed-out';

/** Thrown by a refresh when the classification could not be read; the state is left unchanged. */
export class OwnerTrustUnreadableError extends Error {
  constructor() {
    super('owner trust could not be classified');
    this.name = 'OwnerTrustUnreadableError';
  }
}

/**
 * needs-reinvite iff the store is the persistent one, its anchor is empty, the control DB has owner
 * keys, and none of them is this phone's own identity key (null for an ephemeral identity).
 */
export function classifyOwnerTrust(i: {
  storeKind: OwnerStoreKind;
  anchorSize: number;
  ownerKeys: readonly string[];
  selfKey: string | null;
}): 'ok' | 'needs-reinvite' {
  const foreignCadre =
    i.ownerKeys.length > 0 && (i.selfKey === null || !i.ownerKeys.includes(i.selfKey));
  return i.storeKind === 'persistent' && i.anchorSize === 0 && foreignCadre ? 'needs-reinvite' : 'ok';
}

const TIMED_OUT = Symbol('owner-trust-timed-out');

/** Races `work` against a timer. The timer is cleared on every outcome. */
async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Founder re-anchor at boot. cadre-core's wireOwnKeyIfOwner(signer) wires the signer's key only when
 * its live OwnerKey row exists; it never pins a foreign key. Since cadre-core 1.18 it no longer tries
 * the node's identity key by itself, so the identity owner signer is handed in explicitly
 * (identity-owner-key.ts); a node without one gets cadre-core's own default. Bounded, never rejects,
 * and logs only closed tokens.
 */
export async function reanchorOwnKey(
  node: Pick<OwnerTrustNode, 'wireOwnKeyIfOwner' | 'getIdentityOwnerSigner'>,
  timeoutMs: number = OWNER_REANCHOR_TIMEOUT_MS,
): Promise<ReanchorOutcome> {
  try {
    const signer = node.getIdentityOwnerSigner?.();
    const outcome = await bounded(node.wireOwnKeyIfOwner(signer), timeoutMs);
    if (outcome === TIMED_OUT) {
      console.warn('[owner-trust] reanchor: timed-out');
      return 'timed-out';
    }
    return outcome ? 'wired' : 'not-owner';
  } catch {
    console.warn('[owner-trust] reanchor: failed');
    return 'failed';
  }
}

/**
 * Reads the anchor and the control DB's owner keys and classifies. Read-only: it never calls trust or
 * trustOwnerKeys. A memory store is always 'ok' here (memory-only is the provider's state). Any throw,
 * missing piece or timeout is 'unreadable'.
 */
export async function readOwnerTrustClassification(
  node: OwnerTrustNode,
  storeKind: OwnerStoreKind,
  timeoutMs: number = OWNER_TRUST_CLASSIFY_TIMEOUT_MS,
): Promise<'ok' | 'needs-reinvite' | 'unreadable'> {
  if (storeKind === 'memory') return 'ok';
  try {
    const store = node.getTrustedOwnerStore();
    const db = node.getControlDatabase();
    if (!store || !db) throw new OwnerTrustUnreadableError();
    const keys = await bounded(db.getOwnerKeys(), timeoutMs);
    if (keys === TIMED_OUT) throw new OwnerTrustUnreadableError();
    let selfKey: string | null = null;
    try {
      selfKey = node.getIdentityOwnerKey().publicKeyB64;
    } catch {
      selfKey = null;
    }
    return classifyOwnerTrust({
      storeKind,
      anchorSize: store.all().size,
      ownerKeys: [...keys],
      selfKey,
    });
  } catch {
    console.warn('[owner-trust] classify: unreadable');
    return 'unreadable';
  }
}
