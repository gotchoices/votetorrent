import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
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
 * Bundled-schema override. React-Native / Hermes has no Node `fs`, so the
 * on-device fresh-store DDL path cannot read `votetorrent.qsql` from disk.
 * The app injects the schema as a bundled string via `setSchemaSql()` before
 * the first `createContext()`. When unset (Node: tests, CLI), `initDB` falls
 * back to the original `readFileSync` path so the 581 in-memory tests are
 * byte-for-byte unchanged.
 */
let schemaSqlOverride: string | undefined;

/**
 * Inject the VoteTorrent schema SQL as a string (RN/Hermes — no Node fs).
 * Call once at app boot before any `createContext()`. Pass `undefined` to
 * clear the override and restore the Node `readFileSync` fallback.
 */
export function setSchemaSql(sql: string | undefined): void {
	schemaSqlOverride = sql;
}

/**
 * Initialize a fresh Quereus database by loading and executing the VoteTorrent SQL schema.
 *
 * NOTE: This function is intentionally schema-only (single-responsibility per
 * Phase 2 D-02). It does NOT register plugins. Callers that need the crypto
 * plugin's SQL functions (`Digest`, `SignatureValid`, ...) to
 * resolve in schema constraints must call `prepareDb(db)` instead, which
 * registers the plugin and then calls `initDB`.
 *
 * Schema source: the injected `setSchemaSql()` override when present (RN/Hermes),
 * otherwise the on-disk `votetorrent.qsql` via Node `fs` (tests / Node runtime).
 */
export async function initDB(db: Database): Promise<void> {
	let schemaSql: string;
	if (schemaSqlOverride !== undefined) {
		schemaSql = schemaSqlOverride;
	} else {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const schemaPath = resolve(
			__dirname,
			'../../../vote-core/schema/votetorrent.qsql',
		);
		schemaSql = readFileSync(schemaPath, 'utf8');
	}

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
		const row = await db.prepare('select Version from SchemaVersion limit 1').get();
		return row !== undefined && row !== null;
	} catch {
		return false; // Table absent = fresh store
	}
}

/**
 * Write the schema-version marker after DDL is applied on a fresh store.
 * Creates the SchemaVersion table (if absent) and inserts version 1.
 *
 * Phase 14 D-08/D-10: placed in TS, NOT in votetorrent.qsql, so the schema
 * stays backend-agnostic.
 */
export async function writeSchemaVersionMarker(db: Database): Promise<void> {
	await db.exec(
		`create table if not exists SchemaVersion (Version integer primary key);
		 insert into SchemaVersion (Version) values (1);`,
	);
}

/**
 * Ensure the TidSequence table exists and has its initial row.
 * Safe to run on a fresh store only (always-run on in-memory path since it
 * is always fresh; on the persistent path this is part of first-time DDL).
 *
 * Phase 14 D-12: monotonic per-context Tid counter seeded from persisted state.
 */
export async function ensureTidSequence(db: Database): Promise<void> {
	await db.exec(
		`create table if not exists TidSequence (NextTid integer not null);
		 insert or ignore into TidSequence (NextTid) values (1);`,
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
	const row = await db.prepare('select NextTid from TidSequence limit 1').get();
	return (row?.['NextTid'] as number | null) ?? 1;
}

/**
 * Advance the persisted TidSequence counter by 1 after consuming a Tid.
 *
 * Phase 14 D-12: ensures the on-disk counter is monotonic across restarts.
 */
export async function incrementTidCounter(db: Database): Promise<void> {
	await db.exec('update TidSequence set NextTid = NextTid + 1');
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
