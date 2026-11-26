/**
 * keyholder-session.ts: the keyholder session seam (prompt batching), as a LEAF module.
 *
 * Moved from `apps/VoteTorrentAuthority/src/engines/keyholder-session.ts` (phase 67 plan 05); the app path
 * is now a thin binding over this file.
 *
 * `withKeyholderSession` lives here, not in the app's seat vault, because accept (`keyholder-identity.ts`),
 * the DKG driver and the release ceremony all call it, and those modules are loaded under plain Node by the
 * `vt` CLI (`packages/vote-cli`). The seat vault stays in the app: it
 * value-imports the app key vault (the native secret-wrap module), which Node cannot load, so this shared
 * file must never value-import anything. bcbf1902 put the helper in the seat vault and broke that driver.
 *
 * Keep this file free of VALUE imports: `import type` only (erased at compile time). The app's
 * `keyholder-session-leaf.guard` test reads this file and enforces it, as does the package purity spec.
 */

import type { IKeyVault } from '@votetorrent/vote-engine/rn'

/** A vault that can batch one seat's secrets under one prompt (the app's seat vault implements it). */
export interface KeyholderSessionVault extends IKeyVault {
  withKeyholderSession<T>(userId: string, fn: () => Promise<T>): Promise<T>
}

/**
 * Runs `fn` inside one keyholder session when `vault` supports sessions, else runs it as is (a plain
 * per-alias vault, or the in-memory vault a host driver injects).
 */
export function withKeyholderSession<T>(vault: IKeyVault, userId: string, fn: () => Promise<T>): Promise<T> {
  const v = vault as Partial<KeyholderSessionVault>
  return typeof v.withKeyholderSession === 'function' ? v.withKeyholderSession(userId, fn) : fn()
}
