import { pathToFileURL } from 'node:url'
import { ServiceConfigError, loadServiceConfig } from './config.js'
import { createServiceLogger, errorClass } from './logging.js'
import { startService } from './server.js'
import { DistProvenanceError, assertDistProvenance } from './static.js'

/**
 * main.ts — the deployable entrypoint behind the package's `start` script.
 *
 * The logger is created **first**, in production mode, before anything can
 * fail. That ordering is the whole point: production logging is otherwise
 * silent, so a fatal startup error is the only thing an operator will ever see,
 * and it has to be emitted even when the configuration that would have chosen a
 * logging mode is the very thing that failed to parse.
 *
 * A `ServiceConfigError`'s message is service-authored — written in this
 * repository, naming an environment variable and what to do about it — so it is
 * both safe and actionable to print verbatim. Anything else is reduced to its
 * class name by `errorClass`, because a foreign error's message can carry a
 * filesystem path, a request body, or the operator bearer token.
 */
export async function runMain (
	env: Record<string, string | undefined>,
	sink?: (line: string) => void
): Promise<number> {
	const logger = createServiceLogger({ mode: 'production', sink })

	try {
		const config = loadServiceConfig(env)
		// The dist gate runs here, between parsing the environment and binding
		// the socket. A broken, stale or source-root-pointed build directory
		// therefore refuses to listen at all, rather than coming up healthy and
		// serving old JavaScript against a new API.
		assertDistProvenance(config)
		const service = await startService(config)

		const shutdown = (): void => {
			void service.close().catch(() => {
				// Nothing useful can be said about a failed close, and saying it
				// would risk describing paths. Exit quietly.
			})
		}
		process.once('SIGINT', shutdown)
		process.once('SIGTERM', shutdown)

		return 0
	} catch (err) {
		// A `DistProvenanceError` message is service-authored in exactly the
		// same sense as a `ServiceConfigError` one — it names operator-supplied
		// paths and the remedy, never a foreign error's text — and a
		// misconfigured or stale build directory *is* an invalid configuration,
		// so it maps onto the existing fatal event rather than a new one.
		const serviceAuthored = err instanceof ServiceConfigError || err instanceof DistProvenanceError
		logger.fatal(
			serviceAuthored ? 'config-invalid' : 'startup-failed',
			serviceAuthored ? (err as Error).message : errorClass(err)
		)
		return 1
	}
}

// Self-start only when this module is the process entrypoint, so importing it
// from a test never launches a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = await runMain(process.env)
}
