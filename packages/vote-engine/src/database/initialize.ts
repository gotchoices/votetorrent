import { VOTETORRENT_SCHEMA_SQL } from './schema-sql.js';
import type { Database } from '@quereus/quereus';
import {
	registerPlugin,
	BOOLEAN_TYPE,
	createScalarFunction,
	FunctionFlags,
} from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
// @ts-ignore TS2307 — exports subpath, see comment below
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { verify as jsSignatureValid } from '@optimystic/quereus-plugin-crypto';
import { allocateTid, peekTid } from './tid-allocator.js';

/**
 * Verify a signature over a digest against a signer's public key.
 *
 * 999.1 D-11/D-12: extracted from the inline `SignatureValid` UDF closure
 * (Phase 29 WR-01) so BOTH the in-schema SQL UDF AND any TS call site
 * (engine-side carve-outs, e.g. plan 09's InviteSlot/InviteResult) share one
 * implementation. This is the exact body of the prior closure — no
 * behavioral change for the two existing live CHECKs (Registrant,
 * Association) that already call `SignatureValid`.
 *
 * Phase 29 WR-01 encoding convention (do NOT alter — 999.1 Pitfall 6, a
 * mismatch silently fails closed): `digest` is base64url (the `Digest()` SQL
 * output), `signature` and `signerKey` are hex-encoded.
 *
 * 49-02 (D-02/D-03): this is the secp256k1 half of a pair with
 * `verifySigP256` below. The pair exists because Android Keystore cannot
 * hold a secp256k1 key (D-01) — a hardware-backed Authority-app device key
 * is P-256, so a second, curve-pinned verifier was needed. The SQL-level
 * branch (two thin UDFs selected by a schema CHECK disjunction) was chosen
 * over widening this function to a 4th "curve" argument, because that would
 * change the arity of a function seven existing CHECKs already call —
 * registering a second function with an identical body is a strictly
 * smaller blast radius. `verifySig`'s own body is byte-unchanged by 49-02.
 */
export function verifySig(digest: SqlValue, signature: SqlValue, signerKey: SqlValue): boolean {
	if (!digest || !signature || !signerKey) return false;
	try {
		return jsSignatureValid(
			String(digest),
			String(signature),
			String(signerKey),
			'secp256k1',
			'base64url', // inputEncoding — digest is base64url (Digest() output)
			'hex', // sigEncoding — signatures are hex-encoded
			'hex', // keyEncoding — public keys are hex-encoded
		);
	} catch {
		return false;
	}
}

/**
 * P-256 (secp256r1) counterpart to `verifySig` above — same body, same
 * three encodings (base64url digest / hex signature / hex key), only the
 * curve argument differs. See `verifySig`'s doc comment for why this is a
 * separate function rather than a 4th argument on the existing one (49-02,
 * D-02/D-03).
 */
export function verifySigP256(digest: SqlValue, signature: SqlValue, signerKey: SqlValue): boolean {
	if (!digest || !signature || !signerKey) return false;
	try {
		return jsSignatureValid(
			String(digest),
			String(signature),
			String(signerKey),
			'p256',
			'base64url', // inputEncoding — digest is base64url (Digest() output)
			'hex', // sigEncoding — signatures are hex-encoded
			'hex', // keyEncoding — public keys are hex-encoded
		);
	} catch {
		return false;
	}
}

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
		(digest: SqlValue, signature: SqlValue, publicKey: SqlValue) => verifySig(digest, signature, publicKey),
	);
	db.registerFunction(signatureValidSchema);

	// 49-02 (D-02/D-03): the P-256 counterpart to SignatureValid above,
	// registered as its own scalar function (not a 4th arg on SignatureValid)
	// — see verifySig/verifySigP256's doc comments for the arity-blast-radius
	// reasoning. Consumed by the schema's curve-branched CHECKs on UserKey,
	// AdminSigning, and OfficerSignature.
	const signatureValidP256Schema = createScalarFunction(
		{
			name: 'SignatureValidP256',
			numArgs: 3,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: {
				typeClass: 'scalar',
				logicalType: BOOLEAN_TYPE,
				nullable: false,
				isReadOnly: true,
			},
		},
		(digest: SqlValue, signature: SqlValue, publicKey: SqlValue) => verifySigP256(digest, signature, publicKey),
	);
	db.registerFunction(signatureValidP256Schema);

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

}

/**
 * Always-run plugin registration: register the crypto plugin and custom SQL
 * functions on a freshly-created Database instance. This is per-Database-instance
 * state (not persisted), so it must run on EVERY database, fresh or re-attached.
 *
 * Phase 14 D-07: separated from DDL so that re-attach paths call this without
 * triggering schema creation.
 *
 * Phase 29 (SIGN-05): the local `Digest` UDF (|‐join sha256) has been removed.
 * The canonical injective `digest` from @optimystic/quereus-plugin-crypto@^0.14.0
 * is registered here with explicit { algorithm: 'sha256', encoding: 'base64url' }
 * config (D-02 single-source). ALL stored digest values from the old implementation
 * are incompatible with the new encoding — fresh DB reset + re-sign required.
 */
export async function registerDbPlugins(db: Database): Promise<void> {
	await registerPlugin(db, cryptoPlugin, { algorithm: 'sha256', encoding: 'base64url' });
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

	// Declare the SchemaInit table catalog (NO initialized row) as part of every
	// schema init. initDB only ever runs on a fresh/undeclared handle (create() and
	// open()'s re-attach guard both gate on this), so this consistently binds the
	// SchemaInit catalog on both the create path and the persistent re-attach path
	// — a fresh Quereus handle does not auto-restore the catalog from LevelDB. The
	// initialized ROW remains create()-only (markSchemaInitialized), so a genuinely
	// uninitialized store still has an EMPTY SchemaInit and open() throws (D-05).
	await ensureSchemaInitCatalog(db);
}

/**
 * Check whether the database has been initialized (i.e., SchemaInit table
 * exists and has a boolean-flag row with Initialized = 1). Returns false on
 * a fresh/empty store.
 *
 * Phase 14 D-08: used as a gate to decide whether to run DDL on re-attach.
 */
export async function isSchemaInitialized(db: Database): Promise<boolean> {
	try {
		// Point lookup on the primary key (Initialized=1), NOT a full table scan:
		// the Optimystic/LevelDB vtab's full-scan path aborts under "concurrent
		// mutations", whereas a PK equality routes to a safe point lookup.
		const row = await db.prepare('select Initialized from SchemaInit where Initialized = 1').get();
		return row !== undefined && row !== null;
	} catch {
		return false; // Table absent = fresh store
	}
}

/**
 * Re-declare the SchemaInit table catalog on a handle WITHOUT inserting the
 * boolean initialized flag row.
 *
 * Phase 14-04 follow-up (14-03 on-device gap): a fresh Quereus handle on an
 * existing LevelDB store does NOT auto-restore the table catalog (the documented
 * re-attach root cause). open()'s re-attach guard re-runs initDB (rebinds the
 * domain tables), but nothing re-declared SchemaInit — so isSchemaInitialized's
 * `select … from SchemaInit` hit an undeclared table → false → open() wrongly
 * threw "use create() first" even on a correctly-persisted store.
 * (999.1: this comment originally also credited "ensureTidSequence (rebinds
 * TidSequence)" — that trio is retired; the shared tid-allocator's TidHighWater
 * table is schema-declared and self-healing per handle, see readTidCounter
 * below.)
 *
 * Re-declaring with `create table if not exists` (NO insert) non-destructively
 * rebinds the persisted Initialized=1 row on the LevelDB backend, so an
 * initialized store passes the gate after restart. On a genuinely uninitialized
 * store the catalog binds to an EMPTY table, so isSchemaInitialized still
 * returns false and open() still throws — D-05 intent preserved.
 */
export async function ensureSchemaInitCatalog(db: Database): Promise<void> {
	await db.exec(
		'create table if not exists SchemaInit (Initialized integer primary key);',
	);
}

/**
 * Write the schema-init boolean flag after DDL is applied on a fresh store.
 * Creates the SchemaInit table (if absent) and inserts the initialized flag
 * using INSERT OR IGNORE — making this call idempotent (safe to call multiple
 * times on the same handle, e.g. on strand store re-create paths).
 *
 * Phase 14 D-08/D-10: placed in TS, NOT in votetorrent.qsql, so the schema
 * stays backend-agnostic. Versionless boolean semantics: a present row
 * Initialized = 1 means "schema initialized" — no version number.
 *
 * CR-01 fix: INSERT OR IGNORE means a second call (e.g. strand store re-create)
 * does not throw a PK-uniqueness violation.
 */
export async function markSchemaInitialized(db: Database): Promise<void> {
	await ensureSchemaInitCatalog(db);
	await db.exec('insert or ignore into SchemaInit (Initialized) values (1);');
}

/**
 * RETIRED (Phase 999.1 D-02/D-07/D-09/D-10): the fixed-`Id = 1` `TidSequence`
 * table + this trio (`ensureTidSequence`/`readTidCounter`/`incrementTidCounter`)
 * are superseded by the namespace-keyed shared allocator in `tid-allocator.ts`
 * (`TidHighWater { Namespace text primary key, HighWater integer not null }`,
 * declared in `votetorrent.qsql`). `NetworksEngine` now calls `allocateTid(ctx.db,
 * 'networks')` directly and no longer routes through this trio (see
 * `networks-engine.ts`).
 *
 * These three functions are kept ONLY as thin backward-compat shims — delegating
 * onto the allocator's `'networks'` namespace — because `networks.spec.ts` still
 * exercises `readTidCounter`/`prepareDb` directly by name (test-surface stability,
 * not a production call path). No `src/` caller besides this file may call them;
 * new production code MUST call `allocateTid`/`peekTid` directly.
 */

/**
 * Shim: no-op today (`TidHighWater` is schema-declared, and `tid-allocator.ts`
 * defensively creates it per-handle on first use). Kept for prepareDb's historical
 * call shape / any external caller still invoking it by name.
 */
export async function ensureTidSequence(db: Database): Promise<void> {
	await peekTid(db, 'networks'); // triggers the allocator's defensive create-if-not-exists guard
}

/**
 * Shim: returns the Tid the next `allocateTid(db, 'networks')` call would
 * return, WITHOUT consuming it — same "next value" semantics the retired
 * `TidSequence.NextTid` column had.
 */
export async function readTidCounter(db: Database): Promise<number> {
	return peekTid(db, 'networks');
}

/**
 * Shim: retired no-op. The allocator's `allocateTid()` persists its own
 * reservation atomically — there is no separate "increment after use" step to
 * perform anymore. Kept only so any lingering caller does not hard-crash;
 * `NetworksEngine` no longer calls this (see `networks-engine.ts`).
 */
export async function incrementTidCounter(_db: Database): Promise<void> {
	// Intentionally a no-op — allocateTid() already persisted the reservation.
}

/**
 * STRAND-VIEWS fix (strand-views-not-materialized): re-declare every schema VIEW
 * in the `main` schema so unqualified view references resolve on the strand path.
 *
 * Root cause: cadre-core's StrandDatabase.executeSchema() applies the schema under
 * `App` (`declare schema App { ... } apply schema App;`), so all views are created
 * in the `App` schema. Quereus's UNQUALIFIED relation resolution is ASYMMETRIC:
 * TABLE references walk the full schema path (`findTable(name, undefined, schemaPath)`
 * — schema-resolution.js), but VIEW references in the planner use ONLY the current
 * schema name (select.js: `getView(db.schemaManager.getCurrentSchemaName(), name)`).
 * On the strand the current schema is `main`, so `getView('main', 'CurrentAdmin')`
 * misses the App view and the query throws
 * `Table 'CurrentAdmin' not found in schema path: App, main`. Tables resolve
 * (path-searched) but every table-referencing view (CurrentAdmin, etc.) does not.
 *
 * Fix: after the strand's App schema is applied, also create each view in `main`
 * (`create view if not exists main.<Name> as <body>`). The view bodies reference
 * base tables by bare name; those resolve through the strand's schema path
 * (`['App','main']`) at the view's plan time, so a `main` view over `App` tables
 * works. Unqualified reads then find the view in the current (`main`) schema. This
 * is path-independent: on the in-memory / rnDbFactory path the views already live in
 * `main`, so `create view if not exists` is a harmless no-op there.
 *
 * View bodies are extracted from the bundled VOTETORRENT_SCHEMA_SQL (single source of
 * truth — no drift). Each view is a single top-level `view NAME as <SELECT...>;`
 * statement with no internal `;`, so a non-greedy match to the first `;` is safe.
 * Per-view creation is wrapped in try/catch so one malformed view body (e.g. the
 * pre-existing AcceptedInvite, which references an out-of-scope column and was already
 * non-functional) cannot abort declaration of the working views.
 */
export async function declareViewsInMain(db: Database): Promise<void> {
	const VIEW_RE = /\bview\s+(\w+)\s+as\b([\s\S]*?);/gi;
	let match: RegExpExecArray | null;
	while ((match = VIEW_RE.exec(VOTETORRENT_SCHEMA_SQL)) !== null) {
		const name = match[1];
		const body = match[2]?.trim();
		if (!name || !body) continue;
		try {
			await db.exec(`create view if not exists main.${name} as ${body};`);
		} catch (error) {
			// A malformed view body (pre-existing, query-time-only failure) must not
			// block the other views. The broken view was already unusable; swallow.
			console.warn(`declareViewsInMain: skipped view ${name}:`, error);
		}
	}
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
 * initDB + markSchemaInitialized. The in-memory path is always fresh, so these
 * always-run together. Existing callers need zero changes.
 *
 * 999.1: the `ensureTidSequence(db)` step this wrapper used to run is dropped —
 * `TidHighWater` is now schema-declared (applied by `initDB` above), and the
 * shared allocator (`tid-allocator.ts`) defensively creates it per-handle on
 * first use anyway, so there is nothing left for a separate ensure step to do.
 */
export async function prepareDb(db: Database): Promise<void> {
	await registerDbPlugins(db);
	await initDB(db);
	await markSchemaInitialized(db);
}

export default initDB;
