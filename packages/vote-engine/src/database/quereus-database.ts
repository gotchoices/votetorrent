import { Database } from '@quereus/quereus';
import { CUSTOM_FUNCTIONS } from './custom-functions.js';

/**
 * Main database class that manages the quereus instance and provides
 * database operations for the VoteTorrent application.
 */
export class QuereusDatabase {
	private quereus: Database | null = null;
	private isInitialized = false;

	constructor() {}

	/**
	 * Initialize the database with the given configuration
	 */
	async initialize(config?: DatabaseConfig): Promise<void> {
		if (this.isInitialized) {
			throw new Error('Database is already initialized');
		}

		try {
			// Initialize quereus instance
			this.quereus = new Database();

			// Register custom cryptographic functions
			this.registerCustomFunctions();

			// TODO: Load and apply schema from vote-core
			// const schema = SchemaLoader.loadSchema('votetorrent');
			// await this.quereus.exec(schema);

			this.isInitialized = true;
		} catch (error) {
			throw new Error(`Failed to initialize database: ${error}`);
		}
	}

	/**
	 * Register custom SQL functions for cryptographic operations
	 */
	private registerCustomFunctions(): void {
		if (!this.quereus) {
			throw new Error('Cannot register functions before database initialization');
		}

		const mainSchema = this.quereus.schemaManager.getMainSchema();

		for (const funcDef of CUSTOM_FUNCTIONS) {
			try {
				mainSchema.addFunction(funcDef);
			} catch (error) {
				console.error(`Failed to register function ${funcDef.name}:`, error);
				throw error;
			}
		}

		console.log(`Registered ${CUSTOM_FUNCTIONS.length} custom database functions`);
	}

	/**
	 * Check if the database is initialized
	 */
	isReady(): boolean {
		return this.isInitialized && this.quereus !== null;
	}

	/**
	 * Get the underlying quereus instance
	 */
	getQuereus(): Database {
		if (!this.isReady()) {
			throw new Error('Database is not initialized');
		}
		return this.quereus!;
	}

	/**
	 * Execute a query with the given parameters
	 */
	async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
		if (!this.isReady()) {
			throw new Error('Database is not initialized');
		}

		try {
			// TODO: Implement query execution
			// return await this.quereus!.query(sql, params);
			throw new Error('Query execution not yet implemented');
		} catch (error) {
			throw new Error(`Query execution failed: ${error}`);
		}
	}

	/**
	 * Execute a single query that returns one result
	 */
	async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
		const results = await this.query<T>(sql, params);
		return results.length > 0 ? results[0] ?? null : null;
	}

	/**
	 * Execute a transaction with the given callback
	 */
	async transaction<T>(
		callback: (db: QuereusDatabase) => Promise<T>
	): Promise<T> {
		if (!this.isReady()) {
			throw new Error('Database is not initialized');
		}

		try {
			// TODO: Implement transaction support
			// return await this.quereus!.transaction(async () => {
			//     return await callback(this);
			// });
			throw new Error('Transaction support not yet implemented');
		} catch (error) {
			throw new Error(`Transaction failed: ${error}`);
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		if (this.quereus) {
			try {
				// TODO: Implement proper cleanup
				// await this.quereus.close();
				this.quereus = null;
				this.isInitialized = false;
			} catch (error) {
				throw new Error(`Failed to close database: ${error}`);
			}
		}
	}
}

/**
 * Configuration for the database
 */
export interface DatabaseConfig {
	/** Database file path or connection string */
	path?: string;
	/** Enable debug logging */
	debug?: boolean;
	/** Custom initialization options */
	options?: Record<string, any>;
}
