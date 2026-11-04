/**
 * strand-port-adapter.ts — Phase 62 Plan 21 (D-32).
 *
 * Wraps the established strand `Database` the engine context already holds into the narrow
 * `{query, mutate, close}` shape `P2pRegistrationTransport`/`P2pAssociationTransport` need
 * (`RegistrationStrandPort` / `AssociationStrandPort` from `@votetorrent/vote-engine/rn`).
 *
 * Four points, kept together because they are one decision:
 *  1. The strand Database is owned by CadreNode/NetworksEngine and is SHARED with every other
 *     engine in the app (`EngineContext.db`). Closing it here would kill the network for the
 *     whole app, not just this transport — so `close()` below is a deliberate no-op that never
 *     touches `db`. This mirrors 62-22's Voter `strand-port-adapter.ts` exactly: the transport's
 *     own `close()` clears its memoized port on top of calling this, so a "closed" port is never
 *     reused by its owning transport even though the underlying Database stays open.
 *  2. This file imports no P2P package (no cadre-core, no db-p2p, no libp2p) and never provisions a
 *     second strand of its own — it wraps a handle `rn-db-factory.ts` already constructed via
 *     `EngineFactory`'s existing strand-backed `DbFactory` path (62-23's screens are forbidden from
 *     provisioning a strand too). This file is engine-layer-only and never opens a strand itself.
 *  3. The transports' staging SQL needs no `with context` clause — the staging tables' own CHECKs
 *     (`SignatureValid`, `DeciderIsOfficerWithScope`, ...) verify every signature/digest at insert
 *     time (62-01), so this adapter is a pure pass-through with no authorization logic of its own.
 *  4. `createStrandPort` is called only from inside `EngineFactory.createPeerStagingTransports` —
 *     never from a screen or binding directly — so the raw strand Database handle never leaves the
 *     factory (the factory's no-raw-handle rule, stated on `EngineFactory.createPeerStagingTransports`).
 */

import type { RegistrationStrandPort, AssociationStrandPort } from '@votetorrent/vote-engine/rn';

/** The structural subset of the Quereus `Database` this adapter needs. */
export interface StrandSqlDatabase {
	eval(sql: string, params?: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
	exec(sql: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type StagingStrandPort = RegistrationStrandPort & AssociationStrandPort;

/**
 * `query` collects every row from `db.eval(...)` into an array (the same `for await` idiom
 * 62-14's `intakeQueryPortFromDb` uses). `mutate` awaits `db.exec(...)`. `close` is a deliberate
 * async no-op that never calls `db.close` (there is no such call here at all) — see point 1 above.
 */
export function createStrandPort(db: StrandSqlDatabase): StagingStrandPort {
	return {
		async query<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
			const rows: T[] = [];
			for await (const row of db.eval(sql, params)) {
				rows.push(row as T);
			}
			return rows;
		},
		async mutate(sql: string, params?: Record<string, unknown>): Promise<void> {
			await db.exec(sql, params);
		},
		async close(): Promise<void> {
			// Deliberate no-op — see point 1 above. Never touches `db`.
		},
	};
}
