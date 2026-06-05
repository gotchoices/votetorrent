import { createHash } from 'crypto';
import { VOTETORRENT_SCHEMA_SQL } from './schema-sql.js';
import type { Database } from '@quereus/quereus';
import {
	registerPlugin,
	TEXT_TYPE,
	BOOLEAN_TYPE,
	createScalarFunction,
	FunctionFlags,
} from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
// @ts-ignore TS2307 — exports subpath, see comment below
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { SignatureValid as jsSignatureValid } from '@optimystic/quereus-plugin-crypto';

async function registerCustomFunctions(db: Database): Promise<void> {
	const signatureValidSchema = createScalarFunction(
		{
			name: 'SignatureValid',
			numArgs: 3,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: {
				typeClass: 'scalar',
				logicalType: BOOLEAN_TYPE,
				nullable: false,
				isReadOnly: true,
			},
		},
		(digest: SqlValue, signature: SqlValue, publicKey: SqlValue) => {
			if (!digest || !signature || !publicKey) return false;
			try {
				return jsSignatureValid(
					String(digest),
					String(signature),
					String(publicKey),
				);
			} catch {
				return false;
			}
		},
	);
	db.registerFunction(signatureValidSchema);

	const isoDatetimeSchema = createScalarFunction(
		{
			name: 'isISODatetime',
			numArgs: 1,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: {
				typeClass: 'scalar',
				logicalType: BOOLEAN_TYPE,
				nullable: false,
				isReadOnly: true,
			},
		},
		(value: SqlValue) => {
			if (typeof value !== 'string') return false;
			return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
		},
	);
	db.registerFunction(isoDatetimeSchema);

	const digestSchema = createScalarFunction(
		{
			name: 'Digest',
			numArgs: -1,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: {
				typeClass: 'scalar',
				logicalType: TEXT_TYPE,
				nullable: true,
				isReadOnly: true,
			},
		},
		(...args: SqlValue[]) => {
			const parts = args.map((a) =>
				a === null || a === undefined ? '' : String(a),
			);
			const concat = parts.join('|');
			return createHash('sha256').update(concat).digest('base64url');
		},
	);
	db.registerFunction(digestSchema);
}

/**
 * Always-run plugin registration: register the crypto plugin and custom SQL
 * functions on a freshly-created Database instance. This is per-Database-instance
 * state (not persisted), so it must run on EVERY database, fresh or re-attached.
 *
 * Phase 14 D-07: separated from DDL so that re-attach paths call this without
 * triggering schema creation.
 */
export async function registerDbPlugins(db: Database): Promise<void> {
	await registerPlugin(db, cryptoPlugin);
	await registerCustomFunctions(db);
}

/**
 * Optional schema-SQL override. The schema is bundled as a string
 * (`VOTETORRENT_SCHEMA_SQL`) so `initDB` works in every runtime — Node tests AND
 * React-Native/Hermes — without Node `fs` or `import.meta` (Hermes cannot parse
 * `import.meta`). `setSchemaSql()` lets a host inject an alternate schema string
 * if ever needed; when unset, the bundled default is used.
 */
let schemaSqlOverride: string | undefined;

/**
 * Override the schema SQL string used by `initDB`. Pass `undefined` to restore
 * the bundled default (`VOTETORRENT_SCHEMA_SQL`).
 */
export function setSchemaSql(sql: string | undefined): void {
	schemaSqlOverride = sql;
}

/**
 * Initialize a fresh Quereus database by executing the VoteTorrent SQL schema.
 *
 * NOTE: This function is intentionally schema-only (single-responsibility per
 * Phase 2 D-02). It does NOT register plugins. Callers that need the crypto
 * plugin's SQL functions (`Digest`, `SignatureValid`, ...) to
 * resolve in schema constraints must call `prepareDb(db)` instead, which
 * registers the plugin and then calls `initDB`.
 *
 * Schema source: the `setSchemaSql()` override when set, else the bundled
 * `VOTETORRENT_SCHEMA_SQL` string (generated from `vote-core/schema/votetorrent.qsql`).
 */
export async function initDB(db: Database): Promise<void> {
	const schemaSql = schemaSqlOverride ?? VOTETORRENT_SCHEMA_SQL;

	try {
		await db.exec(schemaSql);
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
}

/**
 * Check whether the database has been initialized (i.e., SchemaVersion table
 * exists and has at least one row). Returns false on a fresh/empty store.
 *
 * Phase 14 D-08: used as a gate to decide whether to run DDL on re-attach.
 */
export async function isSchemaInitialized(db: Database): Promise<boolean> {
	try {
		// Point lookup on the primary key (Version=1), NOT a full table scan:
		// the Optimystic/LevelDB vtab's full-scan path aborts under "concurrent
		// mutations", whereas a PK equality routes to a safe point lookup.
		const row = await db.prepare('select Version from SchemaVersion where Version = 1').get();
		return row !== undefined && row !== null;
	} catch {
		return false; // Table absent = fresh store
	}
}

/**
 * Re-declare the SchemaVersion table catalog on a handle WITHOUT inserting a
 * marker row.
 *
 * Phase 14-04 follow-up (14-03 on-device gap): a fresh Quereus handle on an
 * existing LevelDB store does NOT auto-restore the table catalog (the documented
 * re-attach root cause). open()'s re-attach guard re-runs initDB (rebinds the
 * domain tables) and ensureTidSequence (rebinds TidSequence), but nothing
 * re-declared SchemaVersion — so isSchemaInitialized's `select … from
 * SchemaVersion` hit an undeclared table → false → open() wrongly threw
 * "use create() first" even on a correctly-persisted store.
 *
 * Re-declaring with `create table if not exists` (NO insert) non-destructively
 * rebinds the persisted Version=1 row on the LevelDB backend, so an initialized
 * store passes the gate after restart. On a genuinely uninitialized store the
 * catalog binds to an EMPTY table, so isSchemaInitialized still returns false
 * and open() still throws — D-05 intent preserved.
 */
export async function ensureSchemaVersionCatalog(db: Database): Promise<void> {
	await db.exec(
		'create table if not exists SchemaVersion (Version integer primary key);',
	);
}

/**
 * Write the schema-version marker after DDL is applied on a fresh store.
 * Creates the SchemaVersion table (if absent) and inserts version 1.
 *
 * Phase 14 D-08/D-10: placed in TS, NOT in votetorrent.qsql, so the schema
 * stays backend-agnostic.
 */
export async function writeSchemaVersionMarker(db: Database): Promise<void> {
	await ensureSchemaVersionCatalog(db);
	await db.exec('insert into SchemaVersion (Version) values (1);');
}

/**
 * Ensure the TidSequence table exists and has its initial row.
 * Safe to run on a fresh store only (always-run on in-memory path since it
 * is always fresh; on the persistent path this is part of first-time DDL).
 *
 * Phase 14 D-12: monotonic per-context Tid counter seeded from persisted state.
 */
export async function ensureTidSequence(db: Database): Promise<void> {
	// Id primary key (fixed at 1) so reads/updates are PK point lookups, not full
	// table scans. The Optimystic/LevelDB vtab aborts full scans under "concurrent
	// mutations"; PK equality routes to the safe point-lookup path (D-12 on-device).
	await db.exec(
		`create table if not exists TidSequence (Id integer primary key, NextTid integer not null);
		 insert or ignore into TidSequence (Id, NextTid) values (1, 1);`,
	);
}

/**
 * Read the current NextTid value from the persisted TidSequence table.
 * Defaults to 1 if the table is empty or absent (should not happen after
 * ensureTidSequence, but safe fallback).
 *
 * Phase 14 D-12.
 */
export async function readTidCounter(db: Database): Promise<number> {
	// PK point lookup (Id=1), not a full scan — see ensureTidSequence.
	const row = await db.prepare('select NextTid from TidSequence where Id = 1').get();
	return (row?.['NextTid'] as number | null) ?? 1;
}

/**
 * Advance the persisted TidSequence counter by 1 after consuming a Tid.
 *
 * Phase 14 D-12: ensures the on-disk counter is monotonic across restarts.
 */
export async function incrementTidCounter(db: Database): Promise<void> {
	// PK-scoped update (Id=1), not a full scan — see ensureTidSequence.
	await db.exec('update TidSequence set NextTid = NextTid + 1 where Id = 1');
}

/**
 * Prepare a fresh Quereus database for VoteTorrent use: register the crypto
 * plugin (so schema constraint references to `Digest`, `SignatureValid`,
 * etc. resolve), then load the schema via `initDB`.
 *
 * Per Phase 2 D-02 / D-02b option (b): production code (NetworksEngine.createContext)
 * and Phase 1's schema-load.spec.ts both route through this single helper so the
 * registration plumbing stays in one place.
 *
 * Phase 14 backward-compat wrapper (D-07/SC4): composed from registerDbPlugins +
 * initDB + ensureTidSequence + writeSchemaVersionMarker. The in-memory path is
 * always fresh, so these always-run together. Existing callers need zero changes.
 */
export async function prepareDb(db: Database): Promise<void> {
	await registerDbPlugins(db);
	await initDB(db);
	await ensureTidSequence(db);
	await writeSchemaVersionMarker(db);
}

export default initDB;
