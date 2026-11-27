/**
 * src/bootstrap/index.ts — the `./bootstrap` subpath barrel (D-06, D-07).
 *
 * Re-exports the seam (`bootstrap-transport.ts`), the REST binding
 * (`rest-bootstrap-transport.ts`), and 50-02's envelope contract
 * (`snapshot-types.ts` / `snapshot-codec.ts` / `snapshot-manifest.ts`).
 *
 * **The filesystem binding is deliberately EXCLUDED from this barrel.**
 * `filesystem-bootstrap-transport.ts` imports `node:fs/promises` and is
 * therefore not bundleable by a browser or by React Native. It must not be
 * added here, must not get an index re-export, and must not become
 * reachable from the package root. In Phase 50 its only consumer is this
 * package's own conformance suite, which imports its deep source path
 * directly (`../src/bootstrap/filesystem-bootstrap-transport.js`). A future
 * edit that adds a filesystem-bootstrap-transport re-export to this barrel
 * would drag `node:fs` into the browser dashboard bundle and the React
 * Native app bundle at once — exactly the failure class this project has
 * hit before.
 */

export * from './bootstrap-transport.js'
export { RestBootstrapTransport } from './rest-bootstrap-transport.js'
export type { RestBootstrapTransportOptions } from './rest-bootstrap-transport.js'
export * from './snapshot-types.js'
export * from './snapshot-codec.js'
export * from './snapshot-manifest.js'

/**
 * Phase 52 (D-04/D-05) — the bootstrap key split and the sealed-payload
 * wrapper. A NAMED export list — deliberately not a wildcard re-export.
 *
 * The deterministic, nonce-injecting seal entry point is DELIBERATELY absent
 * from this list. Keeping it off the `@votetorrent/vote-engine/bootstrap`
 * subpath makes it unreachable from either app, so no production caller can
 * ever pin an AES-GCM nonce (a repeated nonce under one key forfeits both
 * confidentiality and authentication). Its absence is asserted by G-2 in
 * `test/sealed-payload.spec.ts`, which greps THIS FILE for that symbol name —
 * so do not name it here, not even in prose. Tests reach it, and only it, by
 * deep source path.
 */
export {
  BOOTSTRAP_CONTENT_LABEL,
  BOOTSTRAP_LOOKUP_LABEL,
  BOOTSTRAP_SECRET_MIN_BYTES,
  SEALED_PAYLOAD_FORMAT_VERSION,
  SEALED_PAYLOAD_KEY_BYTES,
  SEALED_PAYLOAD_NONCE_BYTES,
  deriveBootstrapKeys,
  sealPayload,
  unsealPayload
} from './sealed-payload.js'
export type {
  BootstrapKeySplit,
  SealedPayload,
  SealedUnsealFailureReason,
  SealedUnsealResult
} from './sealed-payload.js'
