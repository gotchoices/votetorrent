import type { Scope, Signature } from '@votetorrent/vote-core'
import type { SqlValue } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import { digestToBytes, nowCanonicalDatetime } from '../utils.js'
import { SigningEngine } from './signing-engine.js'

/**
 * Generic scope/digest/tid/sign-callback-parameterized AdminSigning ceremony
 * helper — generalizes `ElectionsEngine.seedElectionSigning`
 * (elections-engine.ts:489-601) so downstream registration/association/
 * authority-config engines (and their builders' `commit()`) reuse ONE
 * implementation instead of hand-copying the 7-step ceremony per table
 * (RESEARCH's "12x seedElectionSigning duplication").
 *
 * D-01 / D-19: the helper NEVER receives or constructs a private key — the
 * caller-supplied `sign` callback is the ONLY place a signature originates.
 *
 * Field-order fidelity (T-42-02-01): `digestExpr` is embedded VERBATIM in
 * both the SELECT (step 2) and the AdminSigning INSERT (step 5) so the
 * stored Digest is guaranteed byte-identical to what the SELECT computed —
 * the caller does not need to (and must not) re-type the field list twice.
 *
 * @param ctx - Shared engine context (db + user).
 * @param authorityId - Authority whose CurrentAdmin.EffectiveAt gates this signing session.
 * @param scope - The AdminSigning.Scope this mutation is authorized under (e.g. 'vrg' | 'mel' | 'cap').
 * @param tid - The Tid the caller's subsequent row-insert will use (PEEKED, not incremented, by the
 *   caller — mirrors `peekNextElectionTid()`). Passed through `digestParams` under whatever key the
 *   caller's `digestExpr` references (conventionally `:tid`); NOT a reserved bind name itself.
 * @param digestExpr - A `select <Digest(...)> as d` SQL expression matching the target table's own
 *   `InsertValid`/`MutationValid`/`DeleteValid` CHECK field order EXACTLY (Pitfall: field-order
 *   fidelity between TS and SQL is the domain-specific risk this helper's spec locks down).
 * @param digestParams - Bind params for `digestExpr`. MUST NOT use the reserved bind names this
 *   helper itself binds: `nonce`, `authorityId`, `adminEffectiveAt`, `scope`, `userId`, `signerKey`,
 *   `signature`, `now`. (`tid`/`authorityId` values referenced BY `digestExpr` are supplied through
 *   `digestParams`, not reused from this function's own `authorityId`/`tid` parameters, since a
 *   table's own row-specific `authorityId` column may differ in name/binding from the ceremony's
 *   `AuthorityId` FK — callers pass exactly what `digestExpr` needs.)
 * @param sign - App-layer signing callback: receives the canonical digest bytes (Uint8Array,
 *   computed via SQL `Digest()`/`digestExpr`) and returns a `Signature`. The private key stays
 *   app-side (D-01) — this helper never sees it.
 * @returns The signing nonce to pass to the caller's row-insert method
 *   (`with context SigningNonce = :nonce, Tid = ${tid}`).
 */
export async function seedSignedMutation (
  ctx: EngineContext,
  authorityId: string,
  scope: Scope,
  tid: number,
  digestExpr: string,
  digestParams: Record<string, unknown>,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  // 1. Resolve CurrentAdmin.EffectiveAt for the authority.
  const adminRow = await ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) {
    throw new Error(`seedSignedMutation: CurrentAdmin not found for authorityId=${authorityId}`)
  }
  const adminEffectiveAt = adminRow.EffectiveAt as string | number

  // 2. Compute the Digest via the caller-supplied expression — bytes IDENTICAL to what the
  //    target table's own InsertValid/MutationValid/DeleteValid CHECK will recompute.
  const digestRow = await ctx.db.prepare(digestExpr).get(digestParams as Record<string, SqlValue>)
  if (!digestRow || digestRow.d == null) {
    throw new Error('seedSignedMutation: Digest() returned null — crypto plugin not registered?')
  }

  // 3. Hand digest bytes to the app-layer sign callback (D-01/D-19 — engine never holds the key).
  const digestBytes: Uint8Array = digestToBytes(digestRow.d)
  const signature = await sign(digestBytes)

  // 4. Generate nonce + canonical now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonce: string = (globalThis as any).crypto.randomUUID()
  const now = nowCanonicalDatetime()

  // 5. Insert AdminSigning — embeds the SAME digestExpr so the stored Digest matches the SELECT.
  //    `scope` binds as a value (it is not part of the Digest, unlike `tid`, which stays inside
  //    digestExpr/digestParams as a bound integer per the caller's own field list).
  await ctx.db.exec(
    `insert into AdminSigning (
      Nonce,
      AuthorityId,
      AdminEffectiveAt,
      Scope,
      Digest,
      UserId,
      SignerKey,
      Signature
    )
    with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
    values (
      :nonce,
      :authorityId,
      :adminEffectiveAt,
      :scope,
      (${digestExpr}),
      :userId,
      :signerKey,
      :signature
    )`,
    {
      ...(digestParams as Record<string, SqlValue>),
      nonce,
      authorityId,
      adminEffectiveAt,
      scope,
      userId: signature.signerUserId,
      signerKey: signature.signerKey,
      signature: signature.signature,
      now,
    }
  )

  // 6. Drive OfficerSignature + AdminSignature via SigningEngine (threshold=1 -> AdminSignature auto-created).
  await new SigningEngine(ctx).sign(nonce, signature)

  // 7. Return the nonce for the caller to pass to the actual row-insert method.
  return nonce
}
