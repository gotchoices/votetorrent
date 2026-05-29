import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
<<<<<<< HEAD
import { createHash } from 'crypto';
import type { Database } from '@quereus/quereus';
import { registerPlugin, TEXT_TYPE, BOOLEAN_TYPE, createScalarFunction, FunctionFlags } from '@quereus/quereus';
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
			returnType: { typeClass: 'scalar', logicalType: BOOLEAN_TYPE, nullable: false, isReadOnly: true }
		},
		(digest: SqlValue, signature: SqlValue, publicKey: SqlValue) => {
			if (!digest || !signature || !publicKey) return false;
			try {
				return jsSignatureValid(
					String(digest),
					String(signature),
					String(publicKey)
				);
			} catch {
				return false;
			}
		}
	);
	db.registerFunction(signatureValidSchema);

	const isoDatetimeSchema = createScalarFunction(
		{
			name: 'isISODatetime',
			numArgs: 1,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: { typeClass: 'scalar', logicalType: BOOLEAN_TYPE, nullable: false, isReadOnly: true }
		},
		(value: SqlValue) => {
			if (typeof value !== 'string') return false;
			return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
		}
	);
	db.registerFunction(isoDatetimeSchema);

	const digestSchema = createScalarFunction(
		{
			name: 'Digest',
			numArgs: -1,
			flags: FunctionFlags.DETERMINISTIC,
			returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }
		},
		(...args: SqlValue[]) => {
			const parts = args.map(a => a === null || a === undefined ? '' : String(a));
			const concat = parts.join('|');
			return createHash('sha256').update(concat).digest('base64url');
		}
	);
	db.registerFunction(digestSchema);
}
=======
import type { Database } from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
// Crypto plugin entry point: per @optimystic/quereus-plugin-crypto@0.13.0
// package.json `exports`, the registration function is the default export of
// the `./plugin` subpath. The package's top-level entry (`./`) exports the
// JS-level helpers (`Digest`, `Sign`, `SignatureValid`, etc.) used elsewhere
// in the engine; the SQL function registrations live behind `./plugin`.
//
// `@ts-ignore` is necessary because tsconfig.test.json uses
// `moduleResolution: "node"` (classic), which does not honor the package's
// `exports` map subpaths. The production build (`tsconfig.build.json`) uses
// `moduleResolution: "Bundler"` and resolves this correctly without the
// directive. The runtime ESM loader (Node 24) resolves the subpath in both
// modes. Normalizing the test tsconfig is out of Phase 2 scope (D-03).
// @ts-ignore TS2307 — exports subpath, see comment above
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
>>>>>>> origin/authority-app

/**
 * Initialize a fresh Quereus database by loading and executing the VoteTorrent SQL schema.
 *
 * NOTE: This function is intentionally schema-only (single-responsibility per
 * Phase 2 D-02). It does NOT register plugins. Callers that need the crypto
<<<<<<< HEAD
 * plugin's SQL functions (`Digest`, `SignatureValid`, ...) to
=======
 * plugin's SQL functions (`Digest`, `DigestAll`, `SignatureValid`, ...) to
>>>>>>> origin/authority-app
 * resolve in schema constraints must call `prepareDb(db)` instead, which
 * registers the plugin and then calls `initDB`.
 */
export async function initDB(db: Database): Promise<void> {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const schemaPath = resolve(
		__dirname,
		'../../../vote-core/schema/votetorrent.qsql',
	);

	const schemaSql = readFileSync(schemaPath, 'utf8');

<<<<<<< HEAD
=======
	// console.log(schemaSql);

>>>>>>> origin/authority-app
	try {
		await db.exec(schemaSql);
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
}

/**
 * Prepare a fresh Quereus database for VoteTorrent use: register the crypto
<<<<<<< HEAD
 * plugin (so schema constraint references to `Digest`, `SignatureValid`,
 * etc. resolve), then load the schema via `initDB`.
=======
 * plugin (so schema constraint references to `Digest`, `DigestAll`,
 * `SignatureValid`, etc. resolve), then load the schema via `initDB`.
>>>>>>> origin/authority-app
 *
 * Per Phase 2 D-02 / D-02b option (b): production code (NetworksEngine.createContext)
 * and Phase 1's schema-load.spec.ts both route through this single helper so the
 * registration plumbing stays in one place.
 */
export async function prepareDb(db: Database): Promise<void> {
	await registerPlugin(db, cryptoPlugin);
<<<<<<< HEAD
	await registerCustomFunctions(db);
=======
>>>>>>> origin/authority-app
	await initDB(db);
}

export default initDB;
