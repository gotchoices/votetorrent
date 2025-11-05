import { expect } from 'aegir/chai';
import { Logger, LogLevel, createLogger, type LogEntry } from '../src/common/logger.js';

describe('Logger', () => {
	let logger: Logger;
	let capturedLogs: LogEntry[];

	beforeEach(() => {
		logger = Logger.getInstance();
		logger.clearHandlers();
		logger.setLogLevel(LogLevel.DEBUG);

		capturedLogs = [];
		logger.addHandler((entry) => {
			capturedLogs.push(entry);
		});
	});

	describe('Basic logging', () => {
		it('should log debug messages', () => {
			logger.debug('Debug message', { foo: 'bar' });

			expect(capturedLogs.length).to.equal(1);
			expect(capturedLogs[0]!.level).to.equal('DEBUG');
			expect(capturedLogs[0]!.message).to.equal('Debug message');
			expect(capturedLogs[0]!.data).to.deep.equal({ foo: 'bar' });
		});

		it('should log info messages', () => {
			logger.info('Info message');

			expect(capturedLogs.length).to.equal(1);
			expect(capturedLogs[0]!.level).to.equal('INFO');
			expect(capturedLogs[0]!.message).to.equal('Info message');
		});

		it('should log warn messages', () => {
			logger.warn('Warning message');

			expect(capturedLogs.length).to.equal(1);
			expect(capturedLogs[0]!.level).to.equal('WARN');
			expect(capturedLogs[0]!.message).to.equal('Warning message');
		});

		it('should log error messages', () => {
			const error = new Error('Test error');
			logger.error('Error occurred', error);

			expect(capturedLogs.length).to.equal(1);
			expect(capturedLogs[0]!.level).to.equal('ERROR');
			expect(capturedLogs[0]!.message).to.equal('Error occurred');
			expect(capturedLogs[0]!.error?.message).to.equal('Test error');
		});

		it('should include timestamp', () => {
			logger.info('Test');

			expect(capturedLogs[0]!.timestamp).to.be.a('string');
			expect(new Date(capturedLogs[0]!.timestamp).getTime()).to.be.greaterThan(0);
		});
	});

	describe('Log levels', () => {
		it('should respect minimum log level', () => {
			logger.setLogLevel(LogLevel.WARN);

			logger.debug('Debug message');
			logger.info('Info message');
			logger.warn('Warning message');
			logger.error('Error message', new Error());

			expect(capturedLogs.length).to.equal(2);
			expect(capturedLogs[0]!.level).to.equal('WARN');
			expect(capturedLogs[1]!.level).to.equal('ERROR');
		});

		it('should not log when level is NONE', () => {
			logger.setLogLevel(LogLevel.NONE);

			logger.debug('Debug');
			logger.info('Info');
			logger.warn('Warn');
			logger.error('Error', new Error());

			expect(capturedLogs.length).to.equal(0);
		});
	});

	describe('Context', () => {
		it('should include context in log entries', () => {
			logger.info('Test message', undefined, {
				component: 'TestComponent',
				requestId: 'req-123',
			});

			expect(capturedLogs[0]!.context).to.deep.equal({
				component: 'TestComponent',
				requestId: 'req-123',
			});
		});

		it('should allow custom context fields', () => {
			logger.info('Test', undefined, {
				component: 'Test',
				customField: 'value',
				userId: 'user-123',
			});

			expect(capturedLogs[0]!.context).to.include({
				component: 'Test',
				customField: 'value',
			});
		});
	});

	describe('Sensitive data redaction', () => {
		it('should redact password fields', () => {
			logger.info('User data', {
				username: 'alice',
				password: 'secret123',
			});

			expect(capturedLogs[0]!.data).to.deep.equal({
				username: 'alice',
				password: '[REDACTED]',
			});
		});

		it('should redact private key fields', () => {
			logger.info('Key data', {
				publicKey: '0x123',
				privateKey: '0xsecret',
			});

			expect(capturedLogs[0]!.data).to.deep.equal({
				publicKey: '0x123',
				privateKey: '[REDACTED]',
			});
		});

		it('should redact nested sensitive fields', () => {
			logger.info('User object', {
				user: {
					name: 'Alice',
					credentials: {
						password: 'secret',
						apiKey: 'key123',
					},
				},
			});

			expect(capturedLogs[0]!.data).to.deep.equal({
				user: {
					name: 'Alice',
					credentials: {
						password: '[REDACTED]',
						apiKey: '[REDACTED]',
					},
				},
			});
		});

		it('should redact token fields', () => {
			logger.info('Auth data', {
				token: 'secret-token',
				authToken: 'auth-secret',
			});

			expect(capturedLogs[0]!.data?.token).to.equal('[REDACTED]');
			expect(capturedLogs[0]!.data?.authToken).to.equal('[REDACTED]');
		});

		it('should redact signature fields', () => {
			logger.info('Signature data', {
				message: 'hello',
				signature: 'sig-123',
			});

			expect(capturedLogs[0]!.data).to.deep.equal({
				message: 'hello',
				signature: '[REDACTED]',
			});
		});

		it('should redact invitation private keys', () => {
			logger.info('Invitation', {
				inviteKey: 'public-key',
				invitePrivate: 'private-key',
			});

			expect(capturedLogs[0]!.data).to.deep.equal({
				inviteKey: 'public-key',
				invitePrivate: '[REDACTED]',
			});
		});

		it('should handle arrays with sensitive data', () => {
			logger.info('Users', {
				users: [
					{ name: 'Alice', password: 'secret1' },
					{ name: 'Bob', password: 'secret2' },
				],
			});

			expect(capturedLogs[0]!.data?.users[0].password).to.equal('[REDACTED]');
			expect(capturedLogs[0]!.data?.users[1].password).to.equal('[REDACTED]');
		});
	});

	describe('Error handling', () => {
		it('should handle Error objects', () => {
			const error = new Error('Test error');
			error.stack = 'Stack trace here';

			logger.error('Failed operation', error);

			expect(capturedLogs[0]!.error?.message).to.equal('Test error');
			expect(capturedLogs[0]!.error?.stack).to.be.a('string');
		});

		it('should handle error-like objects', () => {
			const errorLike = {
				message: 'Custom error',
				code: 'ERR_CODE',
			};

			logger.error('Failed', errorLike);

			expect(capturedLogs[0]!.data).to.deep.equal(errorLike);
		});

		it('should handle null/undefined errors', () => {
			logger.error('Error without details');

			expect(capturedLogs[0]!.error).to.be.undefined;
			expect(capturedLogs[0]!.data).to.be.undefined;
		});
	});

	describe('Multiple handlers', () => {
		it('should call all registered handlers', () => {
			const handler1Logs: LogEntry[] = [];
			const handler2Logs: LogEntry[] = [];

			logger.addHandler((entry) => handler1Logs.push(entry));
			logger.addHandler((entry) => handler2Logs.push(entry));

			logger.info('Test message');

			expect(handler1Logs.length).to.equal(1);
			expect(handler2Logs.length).to.equal(1);
			expect(capturedLogs.length).to.equal(1);
		});

		it('should continue if a handler throws', () => {
			const workingHandlerLogs: LogEntry[] = [];

			logger.addHandler(() => {
				throw new Error('Handler error');
			});
			logger.addHandler((entry) => workingHandlerLogs.push(entry));

			logger.info('Test');

			expect(workingHandlerLogs.length).to.equal(1);
		});
	});

	describe('createLogger', () => {
		it('should create a logger with component context', () => {
			const componentLogger = createLogger('TestComponent');

			componentLogger.info('Test message');

			expect(capturedLogs[0]!.context?.component).to.equal('TestComponent');
		});

		it('should allow additional context', () => {
			const componentLogger = createLogger('TestComponent');

			componentLogger.info('Test', undefined, { requestId: 'req-123' });

			expect(capturedLogs[0]!.context).to.deep.equal({
				component: 'TestComponent',
				requestId: 'req-123',
			});
		});

		it('should support all log levels', () => {
			const componentLogger = createLogger('Test');

			componentLogger.debug('Debug');
			componentLogger.info('Info');
			componentLogger.warn('Warn');
			componentLogger.error('Error', new Error());

			expect(capturedLogs.length).to.equal(4);
			expect(capturedLogs[0]!.level).to.equal('DEBUG');
			expect(capturedLogs[1]!.level).to.equal('INFO');
			expect(capturedLogs[2]!.level).to.equal('WARN');
			expect(capturedLogs[3]!.level).to.equal('ERROR');
		});
	});

	describe('Singleton pattern', () => {
		it('should return the same instance', () => {
			const instance1 = Logger.getInstance();
			const instance2 = Logger.getInstance();

			expect(instance1).to.equal(instance2);
		});
	});
});
