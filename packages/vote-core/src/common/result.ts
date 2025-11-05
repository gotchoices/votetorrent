/**
 * Result Type for Type-Safe Error Handling
 *
 * This module provides a Result<T, E> type that represents either a success (Ok)
 * or a failure (Err), inspired by Rust's Result type. This pattern:
 * - Makes error handling explicit and type-safe
 * - Eliminates unchecked exceptions
 * - Forces developers to handle errors
 * - Improves code reliability and maintainability
 *
 * Usage:
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) {
 *     return Err('Division by zero');
 *   }
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.isOk()) {
 *   console.log(result.value); // 5
 * } else {
 *   console.error(result.error); // Won't happen in this case
 * }
 * ```
 */

/**
 * Represents a successful result
 */
export interface OkResult<T> {
	readonly success: true;
	readonly value: T;
}

/**
 * Represents a failed result
 */
export interface ErrResult<E> {
	readonly success: false;
	readonly error: E;
}

/**
 * Result type representing either success (Ok) or failure (Err)
 */
export type Result<T, E = Error> = OkResult<T> | ErrResult<E>;

/**
 * Create a successful result
 * @param value - The success value
 */
export function Ok<T>(value: T): OkResult<T> {
	return { success: true, value };
}

/**
 * Create a failed result
 * @param error - The error value
 */
export function Err<E>(error: E): ErrResult<E> {
	return { success: false, error };
}

/**
 * Type guard to check if result is Ok
 */
export function isOk<T, E>(result: Result<T, E>): result is OkResult<T> {
	return result.success === true;
}

/**
 * Type guard to check if result is Err
 */
export function isErr<T, E>(result: Result<T, E>): result is ErrResult<E> {
	return result.success === false;
}

/**
 * Result utility class with helper methods
 */
export class ResultUtils {
	/**
	 * Map a Result's value to a new type
	 * @param result - The result to map
	 * @param fn - Mapping function
	 */
	static map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
		if (isOk(result)) {
			return Ok(fn(result.value));
		}
		return result;
	}

	/**
	 * Map a Result's error to a new type
	 * @param result - The result to map
	 * @param fn - Mapping function
	 */
	static mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
		if (isErr(result)) {
			return Err(fn(result.error));
		}
		return result;
	}

	/**
	 * Chain multiple Result-returning operations
	 * @param result - The initial result
	 * @param fn - Function that returns a new Result
	 */
	static andThen<T, U, E>(
		result: Result<T, E>,
		fn: (value: T) => Result<U, E>
	): Result<U, E> {
		if (isOk(result)) {
			return fn(result.value);
		}
		return result;
	}

	/**
	 * Provide a default value if Result is Err
	 * @param result - The result
	 * @param defaultValue - Value to use if Err
	 */
	static unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
		if (isOk(result)) {
			return result.value;
		}
		return defaultValue;
	}

	/**
	 * Unwrap value or throw error
	 * @param result - The result
	 * @throws Error if result is Err
	 */
	static unwrap<T, E>(result: Result<T, E>): T {
		if (isOk(result)) {
			return result.value;
		}
		throw result.error;
	}

	/**
	 * Convert array of Results to Result of array
	 * Returns Err if any result is Err, otherwise Ok with all values
	 */
	static all<T, E>(results: Array<Result<T, E>>): Result<T[], E> {
		const values: T[] = [];
		for (const result of results) {
			if (isErr(result)) {
				return result;
			}
			values.push(result.value);
		}
		return Ok(values);
	}

	/**
	 * Return the first Ok result, or last Err if all fail
	 */
	static firstOk<T, E>(results: Array<Result<T, E>>): Result<T, E> {
		if (results.length === 0) {
			throw new Error('Cannot get first Ok from empty array');
		}

		for (const result of results) {
			if (isOk(result)) {
				return result;
			}
		}

		return results[results.length - 1]!;
	}

	/**
	 * Wrap a function that may throw in a Result
	 * @param fn - Function that may throw
	 */
	static tryCatch<T>(fn: () => T): Result<T, Error>;
	static tryCatch<T, E>(fn: () => T, mapError: (error: unknown) => E): Result<T, E>;
	static tryCatch<T, E = Error>(
		fn: () => T,
		mapError?: (error: unknown) => E
	): Result<T, E> {
		try {
			return Ok(fn());
		} catch (error) {
			if (mapError) {
				return Err(mapError(error));
			}
			return Err(error instanceof Error ? (error as any) : new Error(String(error)));
		}
	}

	/**
	 * Wrap an async function that may throw in a Result
	 * @param fn - Async function that may throw
	 */
	static async tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
	static async tryCatchAsync<T, E>(
		fn: () => Promise<T>,
		mapError: (error: unknown) => E
	): Promise<Result<T, E>>;
	static async tryCatchAsync<T, E = Error>(
		fn: () => Promise<T>,
		mapError?: (error: unknown) => E
	): Promise<Result<T, E>> {
		try {
			const value = await fn();
			return Ok(value);
		} catch (error) {
			if (mapError) {
				return Err(mapError(error));
			}
			return Err(error instanceof Error ? (error as any) : new Error(String(error)));
		}
	}

	/**
	 * Match on Result and execute appropriate handler
	 * @param result - The result to match
	 * @param handlers - Ok and Err handlers
	 */
	static match<T, E, R>(
		result: Result<T, E>,
		handlers: {
			ok: (value: T) => R;
			err: (error: E) => R;
		}
	): R {
		if (isOk(result)) {
			return handlers.ok(result.value);
		}
		return handlers.err(result.error);
	}

	/**
	 * Tap into a Result without changing it (useful for logging)
	 * @param result - The result
	 * @param fn - Function to execute if Ok
	 */
	static tap<T, E>(result: Result<T, E>, fn: (value: T) => void): Result<T, E> {
		if (isOk(result)) {
			fn(result.value);
		}
		return result;
	}

	/**
	 * Tap into an Err without changing it (useful for logging)
	 * @param result - The result
	 * @param fn - Function to execute if Err
	 */
	static tapErr<T, E>(result: Result<T, E>, fn: (error: E) => void): Result<T, E> {
		if (isErr(result)) {
			fn(result.error);
		}
		return result;
	}
}

/**
 * Common error types for VoteTorrent
 */
export enum ErrorType {
	VALIDATION = 'ValidationError',
	NOT_FOUND = 'NotFoundError',
	UNAUTHORIZED = 'UnauthorizedError',
	FORBIDDEN = 'ForbiddenError',
	CONFLICT = 'ConflictError',
	INTERNAL = 'InternalError',
	NETWORK = 'NetworkError',
	TIMEOUT = 'TimeoutError',
	INVALID_STATE = 'InvalidStateError',
}

/**
 * Structured error type for VoteTorrent
 */
export interface AppError {
	type: ErrorType;
	message: string;
	details?: Record<string, any>;
	cause?: Error;
}

/**
 * Create a structured error
 */
export function createError(
	type: ErrorType,
	message: string,
	details?: Record<string, any>,
	cause?: Error
): AppError {
	return { type, message, details, cause };
}

/**
 * Common error constructors
 */
export const Errors = {
	validation: (message: string, details?: Record<string, any>): AppError =>
		createError(ErrorType.VALIDATION, message, details),

	notFound: (resource: string, id?: string): AppError =>
		createError(ErrorType.NOT_FOUND, `${resource} not found`, id ? { id } : undefined),

	unauthorized: (message = 'Unauthorized'): AppError =>
		createError(ErrorType.UNAUTHORIZED, message),

	forbidden: (message = 'Forbidden'): AppError =>
		createError(ErrorType.FORBIDDEN, message),

	conflict: (message: string, details?: Record<string, any>): AppError =>
		createError(ErrorType.CONFLICT, message, details),

	internal: (message: string, cause?: Error): AppError =>
		createError(ErrorType.INTERNAL, message, undefined, cause),

	network: (message: string, cause?: Error): AppError =>
		createError(ErrorType.NETWORK, message, undefined, cause),

	timeout: (operation: string): AppError =>
		createError(ErrorType.TIMEOUT, `${operation} timed out`),

	invalidState: (message: string, details?: Record<string, any>): AppError =>
		createError(ErrorType.INVALID_STATE, message, details),
};

/**
 * Type alias for common Result patterns
 */
export type AsyncResult<T, E = AppError> = Promise<Result<T, E>>;
