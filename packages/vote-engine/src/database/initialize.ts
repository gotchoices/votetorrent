import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Database } from '@quereus/quereus';

/**
 * Initialize a fresh Quereus database by loading and executing the VoteTorrent SQL schema.
 */
export async function initDB(db: Database): Promise<void> {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const schemaPath = resolve(
		__dirname,
		'../../../vote-core/schema/votetorrent.qsql'
	);

	const schemaSql = readFileSync(schemaPath, 'utf8');

	//console.log(schemaSql);

	try {
		await db.exec(schemaSql);
	} catch (error) {
		console.error('Error initializing database:', error);
		throw error;
	}
}

export default initDB;
