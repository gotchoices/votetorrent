import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import type { Database } from '@quereus/quereus';
import { registerPlugin, TEXT_TYPE, BOOLEAN_TYPE, createScalarFunction, FunctionFlags } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
// @ts-ignore TS2307 — exports subpath, see comment below
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { SignatureValid as jsSignatureValid } from '@optimystic/quereus-plugin-crypto';

let customFunctionsRegistered = false;

async function registerCustomFunctions(db: Database): Promise<void> {
	if (!customFunctionsRegistered) {
		customFunctionsRegistered = true;
		const quereusMain = fileURLToPath(import.meta.resolve('@quereus/quereus'));
		const quereusRoot = resolve(dirname(quereusMain), '../..');
		const windowModPath = resolve(quereusRoot, 'dist/src/schema/window-function.js');
		const { registerWindowFunction } = await import(windowModPath);
		registerWindowFunction({
			name: 'DigestAll',
			argCount: 1,
			returnType: {
				typeClass: 'scalar',
				logicalType: TEXT_TYPE,
				nullable: true,
				isReadOnly: true
			},
			requiresOrderBy: false,
			kind: 'aggregate',
			step: (state: unknown, value: unknown) => {
				if (value === null || value === undefined) return state;
				if (!state) return String(value);
				return (state as string) + String(value);
			},
			final: (state: unknown) => {
				if (!state) return null;
				return createHash('sha256').update(state as string).digest('base64url');
			}
		});
	}

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
	await registerCustomFunctions(db);
	await initDB(db);
}

export default initDB;
