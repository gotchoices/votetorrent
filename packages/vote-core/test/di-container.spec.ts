import { expect } from 'aegir/chai';
import { Container, ServiceLifetime, ContainerScope } from '../src/common/di-container.js';

// Test service classes
class Logger {
	constructor(public name: string = 'default') {}
	log(message: string): void {
		// no-op for testing
	}
}

class Database {
	constructor(public connectionString: string) {}
	query(sql: string): any[] {
		return [];
	}
}

class UserService {
	constructor(
		public logger: Logger,
		public db: Database
	) {}
}

class DisposableService {
	public disposed = false;
	dispose(): void {
		this.disposed = true;
	}
}

describe('DI Container', () => {
	let container: Container;

	beforeEach(() => {
		container = new Container();
	});

	describe('Singleton Registration', () => {
		it('should register and resolve singleton service', () => {
			container.registerSingleton('logger', () => new Logger('test'));

			const logger = container.resolve<Logger>('logger');
			expect(logger).to.be.instanceOf(Logger);
			expect(logger.name).to.equal('test');
		});

		it('should return same instance for singleton', () => {
			container.registerSingleton('logger', () => new Logger('test'));

			const logger1 = container.resolve<Logger>('logger');
			const logger2 = container.resolve<Logger>('logger');

			expect(logger1).to.equal(logger2);
		});

		it('should support method chaining', () => {
			const result = container
				.registerSingleton('logger', () => new Logger())
				.registerSingleton('db', () => new Database('test'));

			expect(result).to.equal(container);
		});
	});

	describe('Transient Registration', () => {
		it('should register and resolve transient service', () => {
			container.registerTransient('logger', () => new Logger('test'));

			const logger = container.resolve<Logger>('logger');
			expect(logger).to.be.instanceOf(Logger);
			expect(logger.name).to.equal('test');
		});

		it('should return different instance for transient', () => {
			container.registerTransient('logger', () => new Logger('test'));

			const logger1 = container.resolve<Logger>('logger');
			const logger2 = container.resolve<Logger>('logger');

			expect(logger1).to.not.equal(logger2);
			expect(logger1).to.be.instanceOf(Logger);
			expect(logger2).to.be.instanceOf(Logger);
		});
	});

	describe('Instance Registration', () => {
		it('should register existing instance', () => {
			const logger = new Logger('existing');
			container.registerInstance('logger', logger);

			const resolved = container.resolve<Logger>('logger');
			expect(resolved).to.equal(logger);
		});

		it('should return same instance when registered as instance', () => {
			const logger = new Logger('existing');
			container.registerInstance('logger', logger);

			const resolved1 = container.resolve<Logger>('logger');
			const resolved2 = container.resolve<Logger>('logger');

			expect(resolved1).to.equal(logger);
			expect(resolved2).to.equal(logger);
		});
	});

	describe('Dependency Injection', () => {
		it('should inject dependencies', () => {
			container.registerSingleton('logger', () => new Logger('app'));
			container.registerSingleton('db', () => new Database('connection'));
			container.registerSingleton(
				'userService',
				(c) =>
					new UserService(c.resolve<Logger>('logger'), c.resolve<Database>('db'))
			);

			const userService = container.resolve<UserService>('userService');
			expect(userService).to.be.instanceOf(UserService);
			expect(userService.logger).to.be.instanceOf(Logger);
			expect(userService.logger.name).to.equal('app');
			expect(userService.db).to.be.instanceOf(Database);
			expect(userService.db.connectionString).to.equal('connection');
		});

		it('should share singleton dependencies', () => {
			container.registerSingleton('logger', () => new Logger('shared'));
			container.registerTransient(
				'service1',
				(c) => ({ logger: c.resolve<Logger>('logger') })
			);
			container.registerTransient(
				'service2',
				(c) => ({ logger: c.resolve<Logger>('logger') })
			);

			const service1 = container.resolve<any>('service1');
			const service2 = container.resolve<any>('service2');

			expect(service1.logger).to.equal(service2.logger);
		});
	});

	describe('Error Handling', () => {
		it('should throw error for unregistered service', () => {
			expect(() => container.resolve('nonexistent')).to.throw(
				"Service 'nonexistent' not registered"
			);
		});

		it('should detect circular dependencies', () => {
			container.registerSingleton('a', (c) => ({ b: c.resolve('b') }));
			container.registerSingleton('b', (c) => ({ a: c.resolve('a') }));

			expect(() => container.resolve('a')).to.throw('Circular dependency detected');
		});

		it('should throw error when resolving scoped service without scope', () => {
			container.registerScoped('scoped', () => new Logger());

			expect(() => container.resolve('scoped')).to.throw(
				"Scoped service 'scoped' must be resolved within a scope"
			);
		});
	});

	describe('Service Queries', () => {
		it('should check if service is registered', () => {
			container.registerSingleton('logger', () => new Logger());

			expect(container.isRegistered('logger')).to.be.true;
			expect(container.isRegistered('nonexistent')).to.be.false;
		});

		it('should tryResolve return undefined for missing service', () => {
			const result = container.tryResolve('nonexistent');
			expect(result).to.be.undefined;
		});

		it('should tryResolve return service if registered', () => {
			container.registerSingleton('logger', () => new Logger('test'));

			const logger = container.tryResolve<Logger>('logger');
			expect(logger).to.be.instanceOf(Logger);
			expect(logger!.name).to.equal('test');
		});

		it('should get all registered keys', () => {
			container.registerSingleton('logger', () => new Logger());
			container.registerTransient('db', () => new Database('test'));

			const keys = container.getRegisteredKeys();
			expect(keys).to.have.length(2);
			expect(keys).to.include('logger');
			expect(keys).to.include('db');
		});
	});

	describe('Scoped Services', () => {
		it('should create scope', () => {
			const scope = container.createScope();
			expect(scope).to.be.instanceOf(ContainerScope);
		});

		it('should resolve scoped service within scope', () => {
			container.registerScoped('scoped', () => new Logger('scoped'));

			const scope = container.createScope();
			const logger = scope.resolve<Logger>('scoped');

			expect(logger).to.be.instanceOf(Logger);
			expect(logger.name).to.equal('scoped');
		});

		it('should return same instance within scope', () => {
			container.registerScoped('scoped', () => new Logger('scoped'));

			const scope = container.createScope();
			const logger1 = scope.resolve<Logger>('scoped');
			const logger2 = scope.resolve<Logger>('scoped');

			expect(logger1).to.equal(logger2);
		});

		it('should return different instance in different scopes', () => {
			container.registerScoped('scoped', () => new Logger('scoped'));

			const scope1 = container.createScope();
			const scope2 = container.createScope();

			const logger1 = scope1.resolve<Logger>('scoped');
			const logger2 = scope2.resolve<Logger>('scoped');

			expect(logger1).to.not.equal(logger2);
		});

		it('should resolve singleton from scope', () => {
			container.registerSingleton('singleton', () => new Logger('singleton'));

			const scope1 = container.createScope();
			const scope2 = container.createScope();

			const logger1 = scope1.resolve<Logger>('singleton');
			const logger2 = scope2.resolve<Logger>('singleton');

			expect(logger1).to.equal(logger2);
		});

		it('should dispose scoped instances', () => {
			const disposable = new DisposableService();
			container.registerScoped('disposable', () => disposable);

			const scope = container.createScope();
			scope.resolve('disposable');
			scope.dispose();

			expect(disposable.disposed).to.be.true;
		});
	});

	describe('Container Management', () => {
		it('should clear all services', () => {
			container.registerSingleton('logger', () => new Logger());
			container.registerTransient('db', () => new Database('test'));

			container.clear();

			expect(container.isRegistered('logger')).to.be.false;
			expect(container.isRegistered('db')).to.be.false;
		});

		it('should dispose singletons on clear', () => {
			const disposable = new DisposableService();
			container.registerInstance('disposable', disposable);

			container.clear();

			expect(disposable.disposed).to.be.true;
		});

		it('should create child container', () => {
			container.registerSingleton('logger', () => new Logger('parent'));

			const child = container.createChild();
			const logger = child.resolve<Logger>('logger');

			expect(logger).to.be.instanceOf(Logger);
			expect(logger.name).to.equal('parent');
		});

		it('should allow child to override parent registration', () => {
			container.registerSingleton('logger', () => new Logger('parent'));

			const child = container.createChild();
			child.registerSingleton('logger', () => new Logger('child'));

			const parentLogger = container.resolve<Logger>('logger');
			const childLogger = child.resolve<Logger>('logger');

			expect(parentLogger.name).to.equal('parent');
			expect(childLogger.name).to.equal('child');
		});
	});

	describe('Real-world Usage Patterns', () => {
		it('should support factory pattern', () => {
			container.registerSingleton('logger', () => new Logger('app'));
			container.registerTransient('userServiceFactory', (c) => {
				return (userId: string) => {
					const logger = c.resolve<Logger>('logger');
					return { userId, logger };
				};
			});

			const factory = container.resolve<(id: string) => any>('userServiceFactory');
			const service1 = factory('user1');
			const service2 = factory('user2');

			expect(service1.userId).to.equal('user1');
			expect(service2.userId).to.equal('user2');
			expect(service1.logger).to.equal(service2.logger); // Shared singleton
		});

		it('should support configuration objects', () => {
			const config = {
				database: { host: 'localhost', port: 5432 },
				logging: { level: 'debug' },
			};

			container.registerInstance('config', config);
			container.registerSingleton(
				'db',
				(c) => new Database(c.resolve<any>('config').database.host)
			);

			const db = container.resolve<Database>('db');
			expect(db.connectionString).to.equal('localhost');
		});

		it('should support conditional registration', () => {
			const isDevelopment = true;

			if (isDevelopment) {
				container.registerSingleton('logger', () => new Logger('dev'));
			} else {
				container.registerSingleton('logger', () => new Logger('prod'));
			}

			const logger = container.resolve<Logger>('logger');
			expect(logger.name).to.equal('dev');
		});
	});

	describe('Type Safety', () => {
		it('should maintain type information', () => {
			container.registerSingleton('logger', () => new Logger('typed'));

			const logger = container.resolve<Logger>('logger');

			// TypeScript should infer these types correctly
			logger.log('test message');
			expect(logger.name).to.equal('typed');
		});

		it('should work with complex types', () => {
			interface IEmailService {
				sendEmail(to: string, subject: string): void;
			}

			class EmailService implements IEmailService {
				sendEmail(to: string, subject: string): void {
					// no-op
				}
			}

			container.registerSingleton<IEmailService>('emailService', () => new EmailService());

			const emailService = container.resolve<IEmailService>('emailService');
			emailService.sendEmail('test@example.com', 'Hello');
		});
	});
});
