/**
 * Database module exports for VoteTorrent
 */

// Main database class
export { QuereusDatabase } from './quereus-database.js';
export type { DatabaseConfig } from './quereus-database.js';

// Schema loader
export { SchemaLoader } from './schema-loader.js';
export type {
	TableDefinition,
	ColumnDefinition,
	ValidationResult,
} from './schema-loader.js';
