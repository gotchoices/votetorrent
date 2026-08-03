import type { Database } from '@quereus/quereus';

/**
 * Shared durable, peer-safe Tid allocator (Phase 999.1 D-02/D-05/D-07/D-09/D-10).
 *
 * Generalizes the proven `NetworksEngine`/`TidSequence` reserve-before-use mechanism
 * (the retired `ensureTidSequence`/`readTidCounter`/`incrementTidCounter` trio in
 * `initialize.ts`, keyed by a fixed `Id = 1` PK) into a namespace-keyed high-water
 * table — `TidHighWater { Namespace text primary key, HighWater integer not null }`
 * (declared in `votetorrent.qsql`, Phase 999.1 plan 01) — with:
 *
 *  - D-07 hybrid seed: `max(persisted HighWater, Date.now())`. The persisted table
 *    wins over a rolled-back wall clock; `Date.now()` is only the backstop used the
 *    very first time a namespace allocates (no row yet).
 *  - D-09 reserve-before-use: the `TidHighWater` upsert is persisted BEFORE this
 *    module returns the allocated Tid to the caller — this upsert IS the
 *    reservation. A crash between the persist and the caller's own consuming
 *    `db.exec(insert ...)` burns a Tid; this is an accepted, harmless residual
 *    (Tid is never a PK/unique/index — see the phase's threat register T-999.1-05).
 *  - D-10 per-namespace serialization: a module-level promise-chain mutex keyed by
 *    namespace. Two overlapping `allocateTid()` calls for the SAME namespace are
 *    chained (never interleaved); different namespaces proceed independently.
 *  - Block reservation (`count > 1`): `allocateTid(db, ns, 2)` reserves `[T, T+1]`
 *    atomically under ONE mutex hold, guaranteeing adjacency for callers such as the
 *    elections engine's `Election`/`ElectionRevision` T/T+1 pair (D-03 dependency).
 *
 * PK-point-lookup discipline (LevelDB vtab safety — load-bearing, mirrors the
 * legacy `TidSequence` comments verbatim): every `TidHighWater` access is scoped
 * `where Namespace = :ns` (read) or a single-row upsert keyed on the `Namespace`
 * PK (write). NEVER scan the table — the Optimystic/LevelDB vtab aborts full table
 * scans under concurrent mutation.
 *
 * Note on restart-safety: unlike the retired `tidCounters` Map the old
 * `NetworksEngine` kept (which needed an explicit reseed-from-DB step on
 * re-attach), this allocator holds NO cross-call Tid state in the TS layer at all
 * — every `allocateTid`/`peekTid` call reads the current `HighWater` fresh from the
 * `Database` handle it is given. A "restart" (fresh module state, same persisted DB
 * handle) is therefore automatically safe: there is no stale in-memory cache to
 * invalidate or reseed.
 */

// D-10: one promise-chain mutex per namespace, shared across every `Database`
// handle in this process. Independent namespaces never wait on each other.
const namespaceLocks = new Map<string, Promise<unknown>>();

// Per-`Database`-instance guard so the defensive `create table if not exists` DDL
// runs at most once per handle (not module-wide — tests construct many separate
// `Database()` instances and each needs its own guard).
const ensuredDbs = new WeakSet<Database>();

/**
 * Defensive idempotent DDL guard (mirrors the legacy `ensureTidSequence` pattern).
 * `TidHighWater` is declared in `votetorrent.qsql` (Phase 999.1 plan 01), so this is
 * a no-op on any handle with the schema already applied — it exists only so a bare
 * `new Database()` handle without the schema applied (some unit tests construct
 * `TidHighWater` reads/writes directly against a minimal handle) stays safe.
 */
async function ensureTidHighWaterTable(db: Database): Promise<void> {
	if (ensuredDbs.has(db)) return;
	await db.exec(
		'create table if not exists TidHighWater (Namespace text primary key, HighWater integer not null);',
	);
	ensuredDbs.add(db);
}

/** PK point lookup (`where Namespace = :ns`) — never a full scan. */
async function readHighWater(db: Database, namespace: string): Promise<number | undefined> {
	const row = await db
		.prepare('select HighWater from TidHighWater where Namespace = :ns')
		.get({ ns: namespace });
	return (row?.['HighWater'] as number | null | undefined) ?? undefined;
}

/**
 * Allocate `count` durable, peer-safe Tids for `namespace`, returning the block's
 * start value. A caller consuming a block of `count > 1` uses
 * `start, start + 1, ..., start + count - 1` (e.g. the elections engine's
 * `Election`/`ElectionRevision` T/T+1 pair uses `count = 2`).
 *
 * D-09: reserve-before-use — the `TidHighWater` upsert is persisted before this
 * promise resolves, so the returned Tid(s) are durably reserved even if the
 * process crashes immediately after this call returns (before the caller's own
 * consuming `db.exec(insert ...)`).
 *
 * D-10: calls for the same `namespace` are serialized via a per-namespace
 * promise-chain mutex — concurrent callers never observe/persist the same value.
 */
export async function allocateTid(db: Database, namespace: string, count = 1): Promise<number> {
	// D-10: chain onto any allocation already in flight for this namespace.
	const prior = namespaceLocks.get(namespace) ?? Promise.resolve();
	const next = prior.then(async () => {
		await ensureTidHighWaterTable(db);
		const persisted = await readHighWater(db, namespace);
		// D-07 hybrid seed: the persisted high-water wins over a rolled-back wall
		// clock; Date.now() is only the backstop for a namespace's first-ever
		// allocation (no persisted row yet).
		const seed = Math.max(persisted ?? 0, Date.now());
		const start = seed + 1;
		const newHighWater = start + count - 1;
		// D-09: PERSIST before returning — this upsert IS the reservation. Runs
		// BEFORE any caller-side db.exec(insert ...) that actually consumes the
		// Tid (reserve-before-use ordering, non-negotiable — see networks-engine.ts
		// for the proven production precedent this generalizes).
		await db.exec(
			'insert into TidHighWater (Namespace, HighWater) values (:ns, :hw) ' +
				'on conflict (Namespace) do update set HighWater = :hw;',
			{ ns: namespace, hw: newHighWater },
		);
		return start;
	});
	// Swallow rejections in the chain so a failed allocation cannot wedge the
	// namespace's mutex for subsequent callers (D-10).
	namespaceLocks.set(namespace, next.catch(() => {}));
	return next;
}

/**
 * Peek the Tid the next `allocateTid(db, namespace)` call would return, WITHOUT
 * consuming it (no persist). Mirrors the existing `peekNextElectionTid()` test
 * hook (`elections-engine.ts`).
 *
 * Not mutex-serialized against concurrent `allocateTid` calls — a peeked value can
 * be stale by the time a caller acts on it. Intended for test/introspection use,
 * not as a substitute for `allocateTid`'s reservation guarantee.
 */
export async function peekTid(db: Database, namespace: string): Promise<number> {
	await ensureTidHighWaterTable(db);
	const persisted = await readHighWater(db, namespace);
	return Math.max(persisted ?? 0, Date.now()) + 1;
}
