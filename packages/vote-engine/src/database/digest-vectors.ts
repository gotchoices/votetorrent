// Digest golden-vector constants for the DEBT-04 cross-runtime parity gate.
//
// WR-15 (17-REVIEW): this file is the SINGLE SOURCE OF TRUTH for the golden
// vectors. It lives in src/ (not test/) so both consumers import the same
// module and can never drift:
//   - packages/vote-engine/test/fixtures/digest-vectors.ts re-exports it for
//     the Node-side digest-parity spec.
//   - apps/VoteTorrentAuthority/src/engines/persistence-proof.ts imports it
//     via `@votetorrent/vote-engine/rn` for the device-side parity gate
//     (assertDigestParity).
// Do NOT inline copies of these vectors anywhere else.
//
// Each vector describes a set of args, the expected base64url SHA-256 output
// from the `Digest()` SQL scalar registered in `database/initialize.ts`, and
// a human-readable label.
//
// Semantics follow the live SQL implementation exactly:
//   - args are joined with '|' as a separator
//   - null/undefined values are coerced to '' (empty string) before joining
//   - number args are coerced via String() — String(1) === '1', so integer
//     args and equivalent string args produce the same digest (see note below)
//
// The expected values were computed via:
//   node -e "const {createHash}=require('crypto');
//            const d=(...a)=>createHash('sha256')
//              .update(a.map(x=>x===null||x===undefined?'':String(x)).join('|'))
//              .digest('base64url');
//            ..."
// and cross-verified against the live Quereus Digest() SQL function via
// prepareDb + db.prepare().get() — confirming the Node implementation and the
// registered SQL scalar produce byte-identical base64url outputs for every vector.
//
// NOTE on int-arg vs string-int vectors (D-05 type-sensitivity):
//   The current Digest() implementation uses String() coercion, which converts
//   the integer 1 to the string '1'. Therefore Digest(1, 'a') and Digest('1', 'a')
//   produce the same hash. Both vectors are retained for documentation and
//   cross-runtime parity purposes — confirming that Node and Hermes agree on
//   the coercion semantics for bound parameters. The D-05 "type-sensitivity lock"
//   in this context means: the same coercion rule (String()) is applied consistently
//   across both runtimes, not that integers and strings produce different outputs.

export interface DigestVector {
  label: string
  args: Array<string | number | null>
  /** Precomputed base64url SHA-256 of args joined with '|' (null/undefined → ''). */
  expected: string
}

export const DIGEST_VECTORS: DigestVector[] = [
  // No args → SHA-256 of '' (empty string join of zero parts)
  {
    label: 'empty-no-args',
    args: [],
    expected: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
  },
  // Single string arg
  {
    label: 'single-string',
    args: ['hello'],
    expected: 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
  },
  // Multiple string args joined with '|'
  {
    label: 'multi-arg',
    args: ['foo', 'bar', 'baz'],
    expected: 'BPsVKJWumgh66hp69KLMN9SEKnAJJeVGYGMkuhxHlB0',
  },
  // Null in the middle → empty string slot ('a||b')
  {
    label: 'null-arg',
    args: ['a', null, 'b'],
    expected: 'IzYJlP2qYI7pHIjikBwug9UyLcFF-v6-BuTZA21dHig',
  },
  // Unicode multi-byte characters
  {
    label: 'unicode',
    args: ['votetorrent', 'ÿ'],
    expected: '63aFKQBNgu0DxgNRwMGiuF8dlrpBsgO1FsMo5apvXEI',
  },
  // Integer 1 coerced to '1' via String() — same result as string-int (see NOTE above)
  {
    label: 'int-arg',
    args: [1, 'a'],
    expected: '1V4EJDRagX43V607tD5sfYiLXIqn31Wp0BIkVmMFJpg',
  },
  // String '1' — same expected as int-arg because String(1) === '1'
  {
    label: 'string-int',
    args: ['1', 'a'],
    expected: '1V4EJDRagX43V607tD5sfYiLXIqn31Wp0BIkVmMFJpg',
  },
]
