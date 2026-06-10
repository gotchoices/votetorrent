/**
 * digest-parity.spec.ts — DEBT-04: Digest cross-runtime parity gate (Node side)
 *
 * Asserts that the `Digest()` SQL scalar registered in `database/initialize.ts`
 * returns the exact precomputed base64url string for every vector in the D-05
 * type-sensitivity set.
 *
 * The companion device-side assertion (plan 04) replays the same vectors on
 * Hermes via `assertDigestParity()` in `persistence-proof.ts` to prove full
 * cross-runtime parity.
 *
 * See: DEBT-04 in STATE.md, DEBT-06 for device harness gate.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import { createHash } from 'crypto'
import { prepareDb } from '../src/database/initialize.js'
import { DIGEST_VECTORS } from './fixtures/digest-vectors.js'

describe('Digest cross-runtime parity (DEBT-04)', () => {
  let db: Database

  before(async () => {
    db = new Database()
    await prepareDb(db)
  })

  // Per-vector SQL assertions via live Quereus Digest() scalar.
  //
  // Binding convention: Quereus uses parameter names WITHOUT the colon prefix
  // in the binding object (key 'a0' for placeholder ':a0') — the "Quereus
  // colon-prefix quirk" documented in STATE.md Phase 3 Notes. Placeholders in
  // the SQL string use ':a0' syntax but binding keys use 'a0' (no colon).
  for (const vec of DIGEST_VECTORS) {
    it(`vector: ${vec.label}`, async () => {
      const placeholders = vec.args.map((_, i) => `:a${i}`).join(', ')
      // Binding keys without colon prefix (Quereus parameter resolution quirk)
      const bindings = Object.fromEntries(vec.args.map((v, i) => [`a${i}`, v]))
      const sql = vec.args.length === 0
        ? 'select Digest() as d'
        : `select Digest(${placeholders}) as d`
      const row = (await db.prepare(sql).get(bindings)) as { d: unknown } | undefined
      expect(row?.d, `vector: ${vec.label}`).to.equal(vec.expected)
    })
  }

  // Lock the no-arg .digest() → Uint8Array contract (multiformats / D-05).
  //
  // On Node this exercises the standard `crypto.createHash()` path; on Hermes
  // it exercises the polyfill in `node-crypto.js`. Both must return a Uint8Array
  // (not a string) for multiformats CID derivation to work correctly.
  it('no-arg .digest() returns Uint8Array (multiformats contract)', () => {
    const result = createHash('sha256').update('test').digest()
    expect(result, 'createHash().digest() without encoding is a Uint8Array').to.be.instanceOf(Uint8Array)
  })
})
