import type { SealedPayload } from './sealed-payload.js'

/**
 * bootstrap-transport.ts — the D-06 bootstrap-transport seam.
 *
 * **1. Two real bindings from day one.** D-06 follows Phase 48's D-01
 * precedent verbatim, and D-01 explicitly rejects "prove one, add more
 * later" for a transport seam. `IBootstrapTransport` requires two real
 * bindings — a filesystem binding (`filesystem-bootstrap-transport.ts`) and
 * a pull-based REST binding (`rest-bootstrap-transport.ts`), both P2P-free,
 * both exercised by one shared conformance suite whose assertion body is
 * written exactly once and run once per binding. One binding would prove
 * only that the interface compiles.
 *
 * **2. No third slot.** Unlike the D-01 registration seam this file does
 * NOT reserve a peer-cluster entry. D-06 excludes a peer-cluster binding
 * outright, and the standalone receiver service such a binding would need
 * is explicitly not built in this phase ("That service is NOT built in
 * Phase 50"). A later reader must not "restore" a third slot here — none
 * ever existed for this seam.
 *
 * **3. Security property.** The browser holds no key and can never sign
 * (D-04). This transport carries a bearer redemption code, a snapshot
 * envelope, and that envelope's manifest + content digest — NEVER key
 * material. A binding that crosses a filesystem or a network therefore has
 * no key to leak.
 *
 * **4. The trust anchor.** An `https://` origin, a configured bearer
 * header, and a filesystem permission bit authorize NOTHING. What a
 * delivered payload has to survive happens entirely on the CONSUMER side of
 * this seam, in this order: the consumer UNSEALS the wrapper with the
 * `contentKey` derived from its own copy of the code, then parses, then runs
 * 50-02's manifest row-count + content digest + schema-hash verification
 * (`verifySnapshot`) against the `expectedDigest` it read out of band.
 * Unsealing proves only that the payload was sealed by someone holding the
 * secret; it does NOT prove the payload is the snapshot the officer's screen
 * described. Only `expectedDigest` does that, and it remains the trust
 * anchor. A binding that trusted its endpoint instead of that content check
 * would be trusting the network.
 *
 * **5. Couriers do not reject.** Neither binding inspects, repairs,
 * re-serializes, or re-digests a delivered payload. Tampering must remain
 * detectable at the same point, with the same evidence, through either
 * binding; a binding that re-computed the digest over mutated bytes would
 * launder a tampered payload into a verifiable one. A binding MAY
 * deserialize its own transport encoding — turning the JSON text it read off
 * a socket or a disk into a JS object is how it got a value at all — but it
 * may not validate, repair or interpret that wrapper's fields. Structural
 * judgement about a wrapper belongs to `unsealPayload`, above this seam,
 * which owns `malformed-wrapper`; a courier that pre-screened wrapper
 * members would be deciding, on the consumer's behalf, which refusals the
 * consumer is allowed to see.
 *
 * **6. No ceremony, no scope claim.** No sentence in this file claims that
 * any scope is enforced here.
 */

/**
 * D-06: the closed redemption-status vocabulary, declared ONCE here — the
 * same discipline `registration-request-transport.ts` records after two of
 * its three bindings coerced an untrusted status instead of checking it.
 *
 * `'schema-mismatch'` is deliberately ABSENT from this union: a schema-hash
 * divergence is detected by 50-02's `verifySnapshot` on the consumer side,
 * not by a courier. Adding a verification-flavoured status here would put
 * verification in the transport and break rule 5 above — couriers do not
 * reject, they only report what the source told them (ok / expired / used /
 * unknown).
 */
export type BootstrapRedemptionStatus = 'ok' | 'expired' | 'used' | 'unknown'

/** The closed set backing `assertKnownBootstrapRedemptionStatus`. Exactly
 * four members; see the type doc comment above for why `'schema-mismatch'`
 * is not a fifth. */
export const KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES: ReadonlySet<string> = new Set([
  'ok',
  'expired',
  'used',
  'unknown'
])

/**
 * The single narrowing helper every binding routes an untrusted `status`
 * value through. `where` is a caller-supplied prefix (e.g.
 * `'RestBootstrapTransport.redeem'`) so the thrown error still names the
 * binding that produced it. The message carries the offending status value
 * and NOTHING else — no snapshot body, no filename, no redemption code.
 *
 * This THROWS rather than coercing or skipping: a status outside this set
 * means the producer and this seam disagree about the vocabulary, which
 * will mis-decide every subsequent redemption from the same source, not
 * just the one that surfaced it.
 */
export function assertKnownBootstrapRedemptionStatus (status: unknown, where: string): BootstrapRedemptionStatus {
  if (typeof status !== 'string' || !KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES.has(status)) {
    throw new Error(`${where}: redemption result carries a status outside the known vocabulary: ${JSON.stringify(status)}`)
  }
  return status as BootstrapRedemptionStatus
}

/**
 * The 19-character canonical-datetime pattern used throughout this
 * project: `YYYY-MM-DDTHH:MM:SS` with NO trailing `Z`. A `Z` suffix makes
 * every `Digest` mismatch and surfaces as a bare `InsertValid` failure,
 * indistinguishable from a real authorization failure — so this guard
 * rejects it rather than stripping it.
 */
const CANONICAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * Declared locally rather than importing `toCanonicalDatetime` from
 * `../utils.js`: `utils.ts` imports `./database/initialize.js`, which would
 * drag the Quereus database layer into a barrel this plan must keep
 * bundleable by a browser (this seam is part of the `./bootstrap` barrel).
 *
 * All freshness comparisons in this seam and its bindings are RAW STRING
 * comparisons against values validated by this guard — canonical form sorts
 * lexicographically — and must never route through `new Date()` or
 * `Date.parse`, which would treat two textually different but
 * instant-equal strings as identical.
 */
export function assertCanonicalBootstrapDatetime (value: unknown, where: string): string {
  if (typeof value !== 'string' || !CANONICAL_DATETIME_PATTERN.test(value)) {
    throw new Error(`${where}: expected a 19-character canonical datetime with no Z suffix, got: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The result of a redemption attempt. `sealed` is present IF AND ONLY IF
 * `status === 'ok'` — every binding must omit it on a refusal so a caller
 * cannot accidentally consume a partial artifact.
 *
 * **`sealed` is an OUTER wrapper around the 50-02 envelope, never a modified
 * envelope.** `snapshot-types.ts` is frozen: sealing wraps a serialized
 * `BootstrapSnapshot` whole and returns it whole, adding confidentiality
 * against the courier and changing nothing about integrity. No envelope
 * field name, and nothing about the digest's scope, moves because of it.
 *
 * **The courier does not open it (D-06).** A binding returns these bytes
 * unread. The sequence that turns them back into a `BootstrapSnapshot` —
 * `unsealPayload` with the `contentKey`, then `parseSnapshot`, then
 * `verifySnapshot({ expectedDigest })` — lives entirely ABOVE this seam, in
 * the consumer. A binding that unsealed here would hold the plaintext voter
 * roll inside the courier, which is precisely what D-06 forbids: the whole
 * point of sealing is that the party carrying the payload cannot read it.
 */
export interface BootstrapRedemptionResult {
  status: BootstrapRedemptionStatus
  sealed?: SealedPayload
}

/**
 * D-06: the bootstrap-transport seam. **ONE method.** A binding redeems a
 * bearer code and couriers back a sealed wrapper; there is nothing else it
 * is asked to do.
 *
 * **Why the removed pull-style method costs nothing and reserves nothing
 * (D-07).** A second, cursor-shaped pull-style method once sat here. It never
 * had a live caller — the only implementations outside the two bindings were
 * doubles that threw by name. Restoring it would be wrong on three separate
 * counts, so a later reader must not treat its absence as an oversight:
 *
 *   - A pull-style refresh arrives with NO out-of-band digest to check it
 *     against. `expectedDigest` reaches the browser on the officer's phone
 *     screen, attached to one minted code; a later unattended pull has no
 *     such anchor, so verification would collapse from "this is the snapshot
 *     the officer described" to mere self-consistency — the envelope's own
 *     `digest` field checking the envelope's own bytes, which whoever
 *     controls the payload also controls.
 *   - Under sealing it is additionally incoherent. A payload is sealed under
 *     the `contentKey` derived from ONE code's secret, so a shared
 *     "current" document has no single key that opens it. There is no
 *     coherent thing for a keyless pull to return.
 *   - The two-bindings rule (48 D-01, restated by 50 D-06) is a rule about
 *     BINDINGS, not about method count: one method with two real bindings,
 *     exercised by one shared conformance body, satisfies it exactly as two
 *     methods did.
 *
 * A future refreshable session credential — a deferred decision that belongs
 * with the relay service — needs a credential argument and a different
 * signature anyway. Nothing here is a placeholder held open for it.
 *
 * **Pull-by-design.** Neither the browser dashboard nor the React Native
 * authority app can listen; nothing here binds a port or hosts a webhook
 * receiver. A binding only ever calls OUT.
 */
export interface IBootstrapTransport {
  /**
   * Redeem a bearer bootstrap code for one call, returning the resolved
   * artifact.
   *
   * The code is a bearer secret, short-expiry, and SINGLE-USE (D-05): a
   * binding must treat a second redemption of the same code as `'used'`,
   * and the single-use marker must be created ATOMICALLY so two concurrent
   * redemptions can never both observe it absent.
   */
  redeem(code: string): Promise<BootstrapRedemptionResult>
}
