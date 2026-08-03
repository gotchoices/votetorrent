import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'

/**
 * digest-binding.ts — the D-06 anti-relay Digest binding (Phase 43's D-06:
 * `requestDetails.nonce` / the KeyDescription `attestationChallenge`
 * extension must equal `Digest(challenge.nonce, challenge.deviceKey)`,
 * welding an attestation token to the exact voting key it was issued for).
 * Disambiguation: this is UNRELATED to Phase 42's `association-engine.ts`
 * D-06 comment, which covers device-uniqueness — same decision-ID label,
 * different phase, different concern (Common Pitfall 4).
 *
 * This is the FIRST pure-JS (non-SQL) `digestFields` call site in the repo.
 * It deliberately mirrors the registered config in
 * `database/initialize.ts:99` (`registerPlugin(db, cryptoPlugin, {
 * algorithm: 'sha256', encoding: 'base64url' })`) so this function's output
 * is byte-identical to what the SQL `Digest()` UDF produces at runtime for
 * the same inputs — per SIGN-05 / `digest-vectors.ts`'s "no independent
 * reimplementation" rule. Do NOT hand-roll `sha256(nonce + deviceKey)`
 * string concatenation here.
 *
 * Deliberately does NOT thread `ctx.db` / any Database handle — this is a
 * plain, synchronous, pure function usable outside any SQL execution
 * context (verifiers run offline against attacker-controlled token bytes,
 * not inside a schema CHECK).
 */

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/**
 * Recompute the canonical injective digest binding a challenge nonce to a
 * device's voting public key: `Digest(nonce, deviceKey)`, sha256/base64url.
 * Deterministic and field-injective (NOT naive concatenation — `('n1','k1')`
 * and `('n','1k1')` never collide).
 */
export function recomputeChallengeDigest (nonce: string, deviceKey: string): string {
  return digestFields([nonce, deviceKey], hasher, encode) as string
}
