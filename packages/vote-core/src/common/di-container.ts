/**
 * Dependency Injection Container for VoteTorrent
 *
 * This module provides a lightweight, type-safe dependency injection system
 * that improves testability and maintainability by:
 * - Decoupling components from their dependencies
 * - Enabling easy mocking in tests
 * - Managing object lifecycles (singleton, transient)
 * - Providing clear dependency graphs
 *
 * Usage:
 * ```typescript
 * // Register dependencies
 * container.registerSingleton('logger', () => new Logger());
 * container.registerTransient('userService', (c) => new UserService(c.resolve('logger')));
 *
 * // Resolve dependencies
 * const userService = container.resolve<UserService>('userService');
 * ```
 */

/**
 * Service lifecycle types
 */
export enum ServiceLifetime {
	/** Single instance shared across all resolutions */
	SINGLETON = 'singleton',
	/** New instance created for each resolution */
	TRANSIENT = 'transient',
	/** Single instance per scope (useful for request-scoped services) */
	SCOPED = 'scoped',
}

/**
 * Factory function type for creating service instances
 */
export type ServiceFactory<T> = (container: Container) => T;

/**
 * Service registration descriptor
 */
interface ServiceDescriptor<T = any> {
	lifetime: ServiceLifetime;
	factory: ServiceFactory<T>;
	instance?: T;
}

/**
 * Container scope for scoped services
 */
export class ContainerScope {
	private scopedInstances = new Map<string, any>();

	constructor(private parent: Container) {}

	/**
	 * Resolve a service within this scope
	 */
	resolve<T>(key: string): T {
		const descriptor = this.parent.getDescriptor(key);
		if (!descriptor) {
			throw new Error(`Service '${key}' not registered`);
		}

		// Return scoped instance if already created in this scope
		if (descriptor.lifetime === ServiceLifetime.SCOPED) {
			if (this.scopedInstances.has(key)) {
				return this.scopedInstances.get(key);
			}
			const instance = descriptor.factory(this.parent);
			this.scopedInstances.set(key, instance);
			return instance;
		}

		// Delegate to parent container for singleton/transient
		return this.parent.resolve<T>(key);
	}

	/**
	 * Dispose of scoped instances
	 */
	dispose(): void {
		// Call dispose on any disposable scoped instances
		for (const instance of this.scopedInstances.values()) {
			if (instance && typeof instance.dispose === 'function') {
				instance.dispose();
			}
		}
		this.scopedInstances.clear();
	}
}

/**
 * Dependency Injection Container
 *
 * Manages service registration and resolution with support for
 * different service lifetimes.
 */
export class Container {
	private services = new Map<string, ServiceDescriptor>();
	private resolving = new Set<string>(); // For circular dependency detection

	/**
	 * Register a singleton service
	 * @param key - Unique service identifier
	 * @param factory - Factory function to create the service
	 */
	registerSingleton<T>(key: string, factory: ServiceFactory<T>): this {
		this.services.set(key, {
			lifetime: ServiceLifetime.SINGLETON,
			factory,
		});
		return this;
	}

	/**
	 * Register a transient service
	 * @param key - Unique service identifier
	 * @param factory - Factory function to create the service
	 */
	registerTransient<T>(key: string, factory: ServiceFactory<T>): this {
		this.services.set(key, {
			lifetime: ServiceLifetime.TRANSIENT,
			factory,
		});
		return this;
	}

	/**
	 * Register a scoped service
	 * @param key - Unique service identifier
	 * @param factory - Factory function to create the service
	 */
	registerScoped<T>(key: string, factory: ServiceFactory<T>): this {
		this.services.set(key, {
			lifetime: ServiceLifetime.SCOPED,
			factory,
		});
		return this;
	}

	/**
	 * Register an existing instance as a singleton
	 * @param key - Unique service identifier
	 * @param instance - The service instance
	 */
	registerInstance<T>(key: string, instance: T): this {
		this.services.set(key, {
			lifetime: ServiceLifetime.SINGLETON,
			factory: () => instance,
			instance,
		});
		return this;
	}

	/**
	 * Resolve a service by key
	 * @param key - Service identifier
	 * @returns The resolved service instance
	 * @throws Error if service not registered or circular dependency detected
	 */
	resolve<T>(key: string): T {
		const descriptor = this.services.get(key);
		if (!descriptor) {
			throw new Error(`Service '${key}' not registered`);
		}

		// Check for circular dependencies
		if (this.resolving.has(key)) {
			throw new Error(`Circular dependency detected: ${key}`);
		}

		try {
			this.resolving.add(key);

			switch (descriptor.lifetime) {
				case ServiceLifetime.SINGLETON:
					if (!descriptor.instance) {
						descriptor.instance = descriptor.factory(this);
					}
					return descriptor.instance;

				case ServiceLifetime.TRANSIENT:
					return descriptor.factory(this);

				case ServiceLifetime.SCOPED:
					// Scoped services should be resolved through a scope
					throw new Error(
						`Scoped service '${key}' must be resolved within a scope. Use createScope()`
					);

				default:
					throw new Error(`Unknown service lifetime: ${descriptor.lifetime}`);
			}
		} finally {
			this.resolving.delete(key);
		}
	}

	/**
	 * Try to resolve a service, returning undefined if not found
	 * @param key - Service identifier
	 * @returns The resolved service instance or undefined
	 */
	tryResolve<T>(key: string): T | undefined {
		try {
			return this.resolve<T>(key);
		} catch {
			return undefined;
		}
	}

	/**
	 * Check if a service is registered
	 * @param key - Service identifier
	 */
	isRegistered(key: string): boolean {
		return this.services.has(key);
	}

	/**
	 * Create a new scope for scoped services
	 * @returns A new container scope
	 */
	createScope(): ContainerScope {
		return new ContainerScope(this);
	}

	/**
	 * Get service descriptor (internal use)
	 */
	getDescriptor(key: string): ServiceDescriptor | undefined {
		return this.services.get(key);
	}

	/**
	 * Clear all registered services
	 * Useful for testing
	 */
	clear(): void {
		// Dispose singletons that implement dispose
		for (const descriptor of this.services.values()) {
			if (
				descriptor.lifetime === ServiceLifetime.SINGLETON &&
				descriptor.instance &&
				typeof descriptor.instance.dispose === 'function'
			) {
				descriptor.instance.dispose();
			}
		}
		this.services.clear();
	}

	/**
	 * Get all registered service keys
	 */
	getRegisteredKeys(): string[] {
		return Array.from(this.services.keys());
	}

	/**
	 * Create a child container that inherits parent registrations
	 * @returns A new child container
	 */
	createChild(): Container {
		const child = new Container();
		// Copy parent registrations
		for (const [key, descriptor] of this.services.entries()) {
			child.services.set(key, { ...descriptor });
		}
		return child;
	}
}

/**
 * Default global container instance
 */
export const container = new Container();

/**
 * Service registration decorator (for future use with decorators)
 * @param key - Service identifier
 * @param lifetime - Service lifetime
 */
export function Injectable(
	key: string,
	lifetime: ServiceLifetime = ServiceLifetime.TRANSIENT
) {
	return function <T extends { new (...args: any[]): {} }>(constructor: T) {
		// This would be used with TypeScript decorators in the future
		return constructor;
	};
}
