import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

/**
 * Initialize a fresh Quereus database by loading and executing the VoteTorrent SQL schema.
 *
 * NOTE: This function is intentionally schema-only (single-responsibility per
 * Phase 2 D-02). It does NOT register plugins. Callers that need the crypto
 * plugin's SQL functions (`Digest`, `DigestAll`, `SignatureValid`, ...) to
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

	// console.log(schemaSql);

	try {
		await db.exec(schemaSql);
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
}

/**
 * Prepare a fresh Quereus database for VoteTorrent use: register the crypto
 * plugin (so schema constraint references to `Digest`, `DigestAll`,
 * `SignatureValid`, etc. resolve), then load the schema via `initDB`.
 *
 * Per Phase 2 D-02 / D-02b option (b): production code (NetworksEngine.createContext)
 * and Phase 1's schema-load.spec.ts both route through this single helper so the
 * registration plumbing stays in one place.
 */
export async function prepareDb(db: Database): Promise<void> {
	await registerPlugin(db, cryptoPlugin);
	await initDB(db);
}

export default initDB;
