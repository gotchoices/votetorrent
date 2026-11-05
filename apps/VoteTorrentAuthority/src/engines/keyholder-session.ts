/**
 * keyholder-session.ts — the keyholder session seam (prompt batching), as a LEAF module.
 *
 * `withKeyholderSession` lives here, not in `keyholder-seat-vault.ts`, because accept
 * (`keyholder-identity.ts`), the DKG driver and the release ceremony all call it, and those modules are also
 * loaded under plain Node by the host lean driver (64-lean `lean-part2.ts`). The seat vault value-imports
 * `./key-vault` (-> `@votetorrent/attestation-native`, `react-native`), which Node cannot load. bcbf1902 put the
 * helper in the seat vault and broke that driver.
 *
 * Keep this file free of VALUE imports: `import type` only (erased at compile time). The
 * `keyholder-session-leaf.guard` test enforces it.
 */

import type { IKeyVault } from '@votetorrent/vote-engine/rn';

/** A vault that can batch one seat's secrets under one prompt (`keyholder-seat-vault.ts` implements it). */
export interface KeyholderSessionVault extends IKeyVault {
	withKeyholderSession<T>(userId: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` inside one keyholder session when `vault` supports sessions, else runs it as is (a plain
 * per-alias vault, or the in-memory vault a host driver injects).
 */
export function withKeyholderSession<T>(vault: IKeyVault, userId: string, fn: () => Promise<T>): Promise<T> {
	const v = vault as Partial<KeyholderSessionVault>;
	return typeof v.withKeyholderSession === 'function' ? v.withKeyholderSession(userId, fn) : fn();
}
