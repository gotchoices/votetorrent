/**
 * Repository Pattern for Data Access Layer
 *
 * This module provides a clean abstraction layer between business logic and
 * data storage, following the repository pattern. This approach:
 * - Decouples domain logic from data access implementation
 * - Enables easy switching between storage mechanisms (Quereus, in-memory, etc.)
 * - Improves testability through repository mocking
 * - Provides type-safe data access with Result types
 * - Supports CQRS patterns (command/query separation)
 *
 * Usage:
 * ```typescript
 * // Define entity
 * interface User {
 *   sid: string;
 *   name: string;
 * }
 *
 * // Define repository interface
 * interface IUserRepository extends IRepository<User, string> {
 *   findByName(name: string): AsyncResult<User | null>;
 * }
 *
 * // Implement repository
 * class UserRepository implements IUserRepository {
 *   async findById(id: string): AsyncResult<User | null> {
 *     return ResultUtils.tryCatchAsync(async () => {
 *       // Database access logic
 *     });
 *   }
 *   // ... other methods
 * }
 * ```
 */

import type { Result, AsyncResult, AppError } from './result.js';

/**
 * Query options for filtering and pagination
 */
export interface QueryOptions {
	/** Filter criteria */
	where?: Record<string, any>;
	/** Fields to include in results */
	select?: string[];
	/** Sort order */
	orderBy?: { field: string; direction: 'asc' | 'desc' }[];
	/** Skip first N results */
	skip?: number;
	/** Return at most N results */
	take?: number;
}

/**
 * Pagination metadata
 */
export interface PageInfo {
	/** Current page number (1-based) */
	page: number;
	/** Items per page */
	pageSize: number;
	/** Total number of items */
	totalCount: number;
	/** Total number of pages */
	totalPages: number;
	/** Has next page */
	hasNext: boolean;
	/** Has previous page */
	hasPrevious: boolean;
}

/**
 * Paginated result set
 */
export interface PagedResult<T> {
	/** Items in current page */
	items: T[];
	/** Pagination metadata */
	pageInfo: PageInfo;
}

/**
 * Transaction context for atomic operations
 */
export interface ITransaction {
	/** Commit the transaction */
	commit(): Promise<void>;
	/** Rollback the transaction */
	rollback(): Promise<void>;
	/** Check if transaction is active */
	isActive(): boolean;
}

/**
 * Base repository interface for CRUD operations
 * @template T Entity type
 * @template ID Entity identifier type
 */
export interface IRepository<T, ID = string> {
	/**
	 * Find entity by ID
	 * @returns Result with entity or null if not found
	 */
	findById(id: ID): AsyncResult<T | null, AppError>;

	/**
	 * Find all entities matching criteria
	 * @param options Query options for filtering and pagination
	 * @returns Result with array of entities
	 */
	findAll(options?: QueryOptions): AsyncResult<T[], AppError>;

	/**
	 * Find entities with pagination
	 * @param page Page number (1-based)
	 * @param pageSize Items per page
	 * @param options Additional query options
	 * @returns Result with paginated results
	 */
	findPaged(
		page: number,
		pageSize: number,
		options?: QueryOptions
	): AsyncResult<PagedResult<T>, AppError>;

	/**
	 * Count entities matching criteria
	 * @param options Query options for filtering
	 * @returns Result with count
	 */
	count(options?: QueryOptions): AsyncResult<number, AppError>;

	/**
	 * Create new entity
	 * @param entity Entity to create
	 * @returns Result with created entity
	 */
	create(entity: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): AsyncResult<T, AppError>;

	/**
	 * Update existing entity
	 * @param id Entity identifier
	 * @param updates Partial entity updates
	 * @returns Result with updated entity or null if not found
	 */
	update(id: ID, updates: Partial<T>): AsyncResult<T | null, AppError>;

	/**
	 * Delete entity by ID
	 * @param id Entity identifier
	 * @returns Result with true if deleted, false if not found
	 */
	delete(id: ID): AsyncResult<boolean, AppError>;

	/**
	 * Check if entity exists
	 * @param id Entity identifier
	 * @returns Result with true if exists
	 */
	exists(id: ID): AsyncResult<boolean, AppError>;

	/**
	 * Batch create multiple entities
	 * @param entities Entities to create
	 * @returns Result with created entities
	 */
	createMany(entities: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>): AsyncResult<T[], AppError>;

	/**
	 * Batch delete multiple entities
	 * @param ids Entity identifiers
	 * @returns Result with number of deleted entities
	 */
	deleteMany(ids: ID[]): AsyncResult<number, AppError>;
}

/**
 * Read-only repository interface (Query side of CQRS)
 * @template T Entity type
 * @template ID Entity identifier type
 */
export interface IReadRepository<T, ID = string> {
	findById(id: ID): AsyncResult<T | null, AppError>;
	findAll(options?: QueryOptions): AsyncResult<T[], AppError>;
	findPaged(
		page: number,
		pageSize: number,
		options?: QueryOptions
	): AsyncResult<PagedResult<T>, AppError>;
	count(options?: QueryOptions): AsyncResult<number, AppError>;
	exists(id: ID): AsyncResult<boolean, AppError>;
}

/**
 * Write-only repository interface (Command side of CQRS)
 * @template T Entity type
 * @template ID Entity identifier type
 */
export interface IWriteRepository<T, ID = string> {
	create(entity: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): AsyncResult<T, AppError>;
	update(id: ID, updates: Partial<T>): AsyncResult<T | null, AppError>;
	delete(id: ID): AsyncResult<boolean, AppError>;
	createMany(entities: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>): AsyncResult<T[], AppError>;
	deleteMany(ids: ID[]): AsyncResult<number, AppError>;
}

/**
 * Unit of Work pattern for managing transactions
 */
export interface IUnitOfWork {
	/**
	 * Begin a new transaction
	 */
	begin(): AsyncResult<ITransaction, AppError>;

	/**
	 * Execute operations within a transaction
	 * @param operation Function to execute within transaction
	 * @returns Result of the operation
	 */
	execute<T>(operation: (tx: ITransaction) => Promise<T>): AsyncResult<T, AppError>;
}

/**
 * Repository factory for creating repository instances
 */
export interface IRepositoryFactory {
	/**
	 * Create repository instance
	 * @param entityType Type of entity
	 * @returns Repository instance
	 */
	createRepository<T, ID = string>(entityType: string): IRepository<T, ID>;
}

/**
 * Specification pattern for complex queries
 */
export interface ISpecification<T> {
	/**
	 * Check if entity satisfies specification
	 */
	isSatisfiedBy(entity: T): boolean;

	/**
	 * Combine with another specification using AND
	 */
	and(other: ISpecification<T>): ISpecification<T>;

	/**
	 * Combine with another specification using OR
	 */
	or(other: ISpecification<T>): ISpecification<T>;

	/**
	 * Negate the specification
	 */
	not(): ISpecification<T>;

	/**
	 * Convert to query options (for database queries)
	 */
	toQuery(): QueryOptions;
}

/**
 * Abstract base class for specifications
 */
export abstract class Specification<T> implements ISpecification<T> {
	abstract isSatisfiedBy(entity: T): boolean;
	abstract toQuery(): QueryOptions;

	and(other: ISpecification<T>): ISpecification<T> {
		return new AndSpecification(this, other);
	}

	or(other: ISpecification<T>): ISpecification<T> {
		return new OrSpecification(this, other);
	}

	not(): ISpecification<T> {
		return new NotSpecification(this);
	}
}

/**
 * AND specification combinator
 */
class AndSpecification<T> extends Specification<T> {
	constructor(
		private left: ISpecification<T>,
		private right: ISpecification<T>
	) {
		super();
	}

	isSatisfiedBy(entity: T): boolean {
		return this.left.isSatisfiedBy(entity) && this.right.isSatisfiedBy(entity);
	}

	toQuery(): QueryOptions {
		const leftQuery = this.left.toQuery();
		const rightQuery = this.right.toQuery();

		return {
			where: {
				...leftQuery.where,
				...rightQuery.where,
			},
			select: leftQuery.select || rightQuery.select,
			orderBy: leftQuery.orderBy || rightQuery.orderBy,
		};
	}
}

/**
 * OR specification combinator
 */
class OrSpecification<T> extends Specification<T> {
	constructor(
		private left: ISpecification<T>,
		private right: ISpecification<T>
	) {
		super();
	}

	isSatisfiedBy(entity: T): boolean {
		return this.left.isSatisfiedBy(entity) || this.right.isSatisfiedBy(entity);
	}

	toQuery(): QueryOptions {
		// OR queries are more complex and may require database-specific handling
		// For now, we combine the where clauses
		const leftQuery = this.left.toQuery();
		const rightQuery = this.right.toQuery();

		return {
			where: {
				$or: [leftQuery.where, rightQuery.where],
			},
		};
	}
}

/**
 * NOT specification combinator
 */
class NotSpecification<T> extends Specification<T> {
	constructor(private spec: ISpecification<T>) {
		super();
	}

	isSatisfiedBy(entity: T): boolean {
		return !this.spec.isSatisfiedBy(entity);
	}

	toQuery(): QueryOptions {
		const query = this.spec.toQuery();
		return {
			where: {
				$not: query.where,
			},
		};
	}
}

/**
 * In-memory repository base class for testing
 */
export abstract class InMemoryRepository<T extends { id: ID }, ID = string>
	implements IRepository<T, ID>
{
	protected items = new Map<ID, T>();
	protected nextId = 1;

	abstract generateId(): ID;
	abstract extractId(entity: T): ID;

	async findById(id: ID): AsyncResult<T | null, AppError> {
		return Promise.resolve({
			success: true,
			value: this.items.get(id) || null,
		});
	}

	async findAll(options?: QueryOptions): AsyncResult<T[], AppError> {
		let results = Array.from(this.items.values());

		// Apply filtering
		if (options?.where) {
			results = results.filter((item) =>
				Object.entries(options.where!).every(
					([key, value]) => (item as any)[key] === value
				)
			);
		}

		// Apply sorting
		if (options?.orderBy) {
			for (const sort of options.orderBy) {
				results.sort((a, b) => {
					const aVal = (a as any)[sort.field];
					const bVal = (b as any)[sort.field];
					const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
					return sort.direction === 'desc' ? -comparison : comparison;
				});
			}
		}

		// Apply pagination
		if (options?.skip !== undefined) {
			results = results.slice(options.skip);
		}
		if (options?.take !== undefined) {
			results = results.slice(0, options.take);
		}

		return Promise.resolve({
			success: true,
			value: results,
		});
	}

	async findPaged(
		page: number,
		pageSize: number,
		options?: QueryOptions
	): AsyncResult<PagedResult<T>, AppError> {
		const skip = (page - 1) * pageSize;
		const itemsResult = await this.findAll({
			...options,
			skip,
			take: pageSize,
		});

		if (!itemsResult.success) {
			return itemsResult;
		}

		const totalResult = await this.count(options);
		if (!totalResult.success) {
			return totalResult;
		}

		const totalCount = totalResult.value;
		const totalPages = Math.ceil(totalCount / pageSize);

		return Promise.resolve({
			success: true,
			value: {
				items: itemsResult.value,
				pageInfo: {
					page,
					pageSize,
					totalCount,
					totalPages,
					hasNext: page < totalPages,
					hasPrevious: page > 1,
				},
			},
		});
	}

	async count(options?: QueryOptions): AsyncResult<number, AppError> {
		const result = await this.findAll(options);
		return {
			success: true,
			value: result.success ? result.value.length : 0,
		};
	}

	async create(entity: any): AsyncResult<T, AppError> {
		const id = this.generateId();
		const newEntity = {
			...entity,
			id,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} as T;

		this.items.set(id, newEntity);

		return Promise.resolve({
			success: true,
			value: newEntity,
		});
	}

	async update(id: ID, updates: Partial<T>): AsyncResult<T | null, AppError> {
		const existing = this.items.get(id);
		if (!existing) {
			return Promise.resolve({
				success: true,
				value: null,
			});
		}

		const updated = {
			...existing,
			...updates,
			id, // Ensure ID doesn't change
			updatedAt: Date.now(),
		} as T;

		this.items.set(id, updated);

		return Promise.resolve({
			success: true,
			value: updated,
		});
	}

	async delete(id: ID): AsyncResult<boolean, AppError> {
		const existed = this.items.has(id);
		this.items.delete(id);

		return Promise.resolve({
			success: true,
			value: existed,
		});
	}

	async exists(id: ID): AsyncResult<boolean, AppError> {
		return Promise.resolve({
			success: true,
			value: this.items.has(id),
		});
	}

	async createMany(entities: any[]): AsyncResult<T[], AppError> {
		const created: T[] = [];
		for (const entity of entities) {
			const result = await this.create(entity);
			if (!result.success) {
				return result;
			}
			created.push(result.value);
		}

		return Promise.resolve({
			success: true,
			value: created,
		});
	}

	async deleteMany(ids: ID[]): AsyncResult<number, AppError> {
		let count = 0;
		for (const id of ids) {
			const result = await this.delete(id);
			if (result.success && result.value) {
				count++;
			}
		}

		return Promise.resolve({
			success: true,
			value: count,
		});
	}

	/**
	 * Clear all items (for testing)
	 */
	clear(): void {
		this.items.clear();
		this.nextId = 1;
	}
}
