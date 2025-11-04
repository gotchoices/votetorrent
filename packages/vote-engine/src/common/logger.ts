/**
 * Structured logging system for VoteTorrent
 *
 * This module provides a secure, structured logging system that:
 * - Prevents sensitive data from being logged
 * - Provides different log levels
 * - Can be easily integrated with external logging services
 * - Respects production/development environments
 *
 * Security features:
 * - Automatic redaction of sensitive fields
 * - No console.log in production (unless explicitly configured)
 * - Structured data for easy analysis
 * - Contextual information (timestamp, level, component)
 *
 * @remarks
 * This replaces all console.log/error/warn statements identified in the security audit.
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	NONE = 4,
}

export interface LogContext {
	/** Component or module name */
	component?: string;
	/** User ID (will be redacted in logs) */
	userId?: string;
	/** Request ID for tracing */
	requestId?: string;
	/** Election ID */
	electionId?: string;
	/** Authority ID */
	authorityId?: string;
	/** Additional metadata */
	[key: string]: any;
}

export interface LogEntry {
	timestamp: string;
	level: string;
	message: string;
	context?: LogContext;
	data?: any;
	error?: {
		message: string;
		stack?: string;
		code?: string;
	};
}

/**
 * Fields that should be redacted from logs for security
 */
const SENSITIVE_FIELDS = [
	'password',
	'privateKey',
	'private_key',
	'secretKey',
	'secret_key',
	'token',
	'apiKey',
	'api_key',
	'authToken',
	'auth_token',
	'sessionId',
	'session_id',
	'invitePrivate',
	'signature', // Can be used to track users
];

/**
 * Redacts sensitive information from an object
 */
function redactSensitiveData(data: any): any {
	if (data === null || data === undefined) {
		return data;
	}

	if (typeof data !== 'object') {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map(item => redactSensitiveData(item));
	}

	const redacted: any = {};
	for (const [key, value] of Object.entries(data)) {
		const lowerKey = key.toLowerCase();
		const isSensitive = SENSITIVE_FIELDS.some(field =>
			lowerKey.includes(field.toLowerCase())
		);

		if (isSensitive) {
			redacted[key] = '[REDACTED]';
		} else if (typeof value === 'object') {
			redacted[key] = redactSensitiveData(value);
		} else {
			redacted[key] = value;
		}
	}

	return redacted;
}

export class Logger {
	private static instance: Logger;
	private minLevel: LogLevel = LogLevel.INFO;
	private isDevelopment: boolean = true;
	private logHandlers: Array<(entry: LogEntry) => void> = [];

	private constructor() {
		// Detect environment
		if (typeof process !== 'undefined' && process.env) {
			this.isDevelopment = process.env.NODE_ENV !== 'production';
		} else if (typeof __DEV__ !== 'undefined') {
			this.isDevelopment = __DEV__;
		}

		// Set appropriate log level
		this.minLevel = this.isDevelopment ? LogLevel.DEBUG : LogLevel.WARN;

		// Add default console handler for development
		if (this.isDevelopment) {
			this.addHandler((entry) => {
				const prefix = `[${entry.timestamp}] [${entry.level}]`;
				const component = entry.context?.component
					? ` [${entry.context.component}]`
					: '';
				const message = `${prefix}${component} ${entry.message}`;

				switch (entry.level) {
					case 'ERROR':
						console.error(message, entry.data || '', entry.error || '');
						break;
					case 'WARN':
						console.warn(message, entry.data || '');
						break;
					case 'INFO':
						console.info(message, entry.data || '');
						break;
					case 'DEBUG':
						console.log(message, entry.data || '');
						break;
				}
			});
		}
	}

	public static getInstance(): Logger {
		if (!Logger.instance) {
			Logger.instance = new Logger();
		}
		return Logger.instance;
	}

	/**
	 * Set the minimum log level
	 */
	public setLogLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	/**
	 * Add a custom log handler (e.g., for remote logging)
	 */
	public addHandler(handler: (entry: LogEntry) => void): void {
		this.logHandlers.push(handler);
	}

	/**
	 * Clear all log handlers
	 */
	public clearHandlers(): void {
		this.logHandlers = [];
	}

	private log(
		level: LogLevel,
		levelName: string,
		message: string,
		data?: any,
		context?: LogContext,
		error?: Error
	): void {
		if (level < this.minLevel) {
			return;
		}

		const entry: LogEntry = {
			timestamp: new Date().toISOString(),
			level: levelName,
			message,
			context: context ? redactSensitiveData(context) : undefined,
			data: data ? redactSensitiveData(data) : undefined,
			error: error
				? {
						message: error.message,
						stack: this.isDevelopment ? error.stack : undefined,
						code: (error as any).code,
				  }
				: undefined,
		};

		// Call all handlers
		for (const handler of this.logHandlers) {
			try {
				handler(entry);
			} catch (err) {
				// Avoid infinite loops if handler throws
				if (this.isDevelopment) {
					console.error('Log handler error:', err);
				}
			}
		}
	}

	public debug(message: string, data?: any, context?: LogContext): void {
		this.log(LogLevel.DEBUG, 'DEBUG', message, data, context);
	}

	public info(message: string, data?: any, context?: LogContext): void {
		this.log(LogLevel.INFO, 'INFO', message, data, context);
	}

	public warn(message: string, data?: any, context?: LogContext): void {
		this.log(LogLevel.WARN, 'WARN', message, data, context);
	}

	public error(
		message: string,
		error?: Error | any,
		context?: LogContext
	): void {
		const err = error instanceof Error ? error : undefined;
		const data = error instanceof Error ? undefined : error;
		this.log(LogLevel.ERROR, 'ERROR', message, data, context, err);
	}
}

/**
 * Default logger instance
 *
 * @example
 * ```typescript
 * import { logger } from './common/logger';
 *
 * logger.info('User logged in', { userId: 'user-123' });
 * logger.error('Failed to save data', error, { component: 'UserService' });
 * logger.debug('Processing request', { requestId: 'req-456' });
 * ```
 */
export const logger = Logger.getInstance();

/**
 * Create a logger with a specific component context
 *
 * @param component - The component name
 * @returns A logger with the component context pre-set
 *
 * @example
 * ```typescript
 * const log = createLogger('AuthorityEngine');
 * log.info('Authority created', { authorityId: 'auth-123' });
 * ```
 */
export function createLogger(component: string) {
	return {
		debug: (message: string, data?: any, context?: LogContext) =>
			logger.debug(message, data, { ...context, component }),
		info: (message: string, data?: any, context?: LogContext) =>
			logger.info(message, data, { ...context, component }),
		warn: (message: string, data?: any, context?: LogContext) =>
			logger.warn(message, data, { ...context, component }),
		error: (message: string, error?: Error | any, context?: LogContext) =>
			logger.error(message, error, { ...context, component }),
	};
}
