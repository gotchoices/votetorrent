/**
 * control-schema-recovery.ts — spike 105, ported from the Voter.
 *
 * cadre-core refuses to migrate a control store written by a build with OLDER constraint text: its
 * declarative apply diffs to DDL the optimystic module refuses, Quereus takes the apply back, and
 * `CadreNode.start()` rejects on every launch ("policy: recreate", cadre-core's
 * `ControlDatabase.loadSchema`). Measured 1.13 -> 1.14: `DROP TABLE IF EXISTS
 * CadreControl.pendingjoin` is refused because `Revocation.RowIsGone` still references it. The
 * Authority hit it on an iPhone 13 on 2026-10-12, with the data the 2026-10-08 build (1.13) wrote.
 * Measured 1.14 -> 1.15: `ALTER TABLE CadreControl.CadrePeer ADD COLUMN Profile` is refused with
 * "Module for table 'CadrePeer' does not support ALTER TABLE ADD COLUMN". The module refuses every
 * ALTER TABLE form the same way ("does not support ALTER ..."), so the predicate matches the family.
 *
 * Unlike the Voter, the Authority founds strands, so its control store does hold party state. The
 * network survives a recreate anyway: every network's rows live in its own per-strand store, and
 * the strand factory (`rn-db-factory.ts`) hands `addStrand` a hand-built strand row with an
 * explicit `founder` flag on every attach, so it never reads a strand row back from the old
 * control store. What a recreate loses is control-only state (cadre invites, revocations, the peer
 * list). Those tables are optimystic-backed across the party, so a member with live peers reads
 * them back; a party of one loses them. Every launch fails otherwise, so the recovery is to
 * recreate ONLY the control scope (`controlStorageScope(partyId)`, which is
 * `control-<hex(partyId)>`, not `control`) and start once more.
 */

function errorChain(e: unknown): string {
	const parts: string[] = [];
	for (let x: unknown = e; x != null && parts.length < 6; x = (x as { cause?: unknown }).cause) {
		parts.push(x instanceof Error ? x.message : String(x));
	}
	return parts.join(' <- ');
}

/**
 * cadre-core 1.17+ checks a warm control store BEFORE applying anything and refuses one it cannot
 * migrate with a typed `ControlStoreIncompatibleError` (sereus#46). Its `reason` (1.18) says what to
 * do: `before-migrations` (written by 1.16 or earlier; measured: a 1.16 store reads version 0 against
 * this build's 3) and `not-migratable` are recreated; `newer-release` means a newer release already
 * migrated this store and its rows are intact, so the app must be updated and the store must NOT be
 * wiped. Matched by `name` and `reason` (set as string literals in cadre-core), so no import is needed.
 */
const RECREATE_REASONS: ReadonlySet<string> = new Set(['before-migrations', 'not-migratable']);

function typedStoreRefusal(e: unknown): string | null {
	for (let x: unknown = e, depth = 0; x != null && depth < 6; x = (x as { cause?: unknown }).cause, depth++) {
		const err = x as { name?: unknown; reason?: unknown };
		if (err.name === 'ControlStoreIncompatibleError') return typeof err.reason === 'string' ? err.reason : '';
	}
	return null;
}

/** True only for a CadreControl schema that can be neither migrated nor restored. */
export function isUnrestorableControlSchemaError(e: unknown): boolean {
	const refusal = typedStoreRefusal(e);
	if (refusal !== null) return RECREATE_REASONS.has(refusal);
	const text = errorChain(e);
	return /CadreControl\./i.test(text)
		&& /could not be restored|partially migrated|cannot drop table|drop constraint|does not support ALTER/i.test(text);
}
