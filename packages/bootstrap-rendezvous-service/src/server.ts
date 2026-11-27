import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertLoopbackOrOptedIn, type ServiceConfig } from './config.js'
import { createServiceLogger, type LoggedOutcome, type LoggedRoute, type ServiceLogger } from './logging.js'
import { sendJson, type RouteHandler, type ServiceContext } from './http.js'
import { createRendezvousStores, type RendezvousStores } from './store.js'
import { startSweeper } from './sweeper.js'
import { handleUpload } from './routes/upload.js'
import { handleRedeem } from './routes/redeem.js'
import { handleStatic } from './static.js'

/**
 * server.ts — the complete route table and the process lifecycle.
 *
 * **This file declares every route up front, on purpose.** Because the table,
 * the store and the retention sweeper are all wired here now, each later plan
 * fills exactly one handler module — `static.ts`, `routes/upload.ts`,
 * `routes/redeem.ts`, `sweeper.ts` — and none of them ever has to re-edit this
 * file. That is what keeps those four plans parallel instead of serial, and it
 * is why the stubs they replace are real typechecked modules rather than
 * placeholders.
 *
 * **The dispatcher never reads a request body.** Handlers receive the raw
 * `IncomingMessage`, because the upload endpoint owns its own streaming size
 * ceiling; draining here would move that ceiling into the wrong file.
 *
 * **One logging call, in one place.** Every request is logged exactly once,
 * from the `finally` block below and from nowhere else in the package. That
 * single call site is what makes the "no identifiers in the log stream"
 * property auditable by inspection rather than by trust: the logger's own
 * signatures accept only closed unions and a number, and there is one place
 * that could possibly call them.
 *
 * **Errors never describe themselves to the client.** An unexpected throw
 * becomes `500 {"error":"internal error"}` with no message, no path and no
 * stack, mirroring the status-and-path-only discipline of the REST bootstrap
 * transport.
 */

export interface RouteTableEntry {
	method: 'POST'
	path: string
	route: LoggedRoute
	handler: RouteHandler
}

/**
 * The whole `/bootstrap/` prefix is reserved for the API. Any path under it
 * that matches no entry is answered `404` here, which is precisely what makes
 * the static handler's single-page-application fallback safe: that handler can
 * never be reached for an API path and so can never mask one with an HTML page.
 */
export const BOOTSTRAP_API_PREFIX = '/bootstrap/'

/**
 * The complete route table. Two entries, both `POST`.
 *
 * There is deliberately **no third entry** for the pull-side (B-2) endpoint of
 * the wire protocol: the seam's pull method is removed in this phase, so the
 * real service never implements it. Adding it back here would resurrect an
 * interface that has no client.
 */
export const BOOTSTRAP_RENDEZVOUS_ROUTES: readonly RouteTableEntry[] = [
	{ method: 'POST', path: '/bootstrap/uploads', route: 'upload', handler: handleUpload },
	{ method: 'POST', path: '/bootstrap/redemptions', route: 'redeem', handler: handleRedeem }
]

export interface ServiceDependencies {
	context: ServiceContext
	staticHandler?: RouteHandler
	/**
	 * Overrides the route table. This exists so the dispatcher's
	 * method/path/405/404/static-fallback behaviour can be tested with spy
	 * handlers, permanently and independently of whatever the real handlers do
	 * in any given wave.
	 */
	routes?: readonly RouteTableEntry[]
}

export function createRequestListener (deps: ServiceDependencies): (req: IncomingMessage, res: ServerResponse) => void {
	const routes = deps.routes ?? BOOTSTRAP_RENDEZVOUS_ROUTES
	const staticHandler = deps.staticHandler ?? handleStatic
	const ctx = deps.context

	return (req: IncomingMessage, res: ServerResponse): void => {
		const startedAt = Date.now()
		let route: LoggedRoute = 'unrouted'
		let outcome: LoggedOutcome = 'error'

		// `createServer`'s listener is synchronous and handlers return promises,
		// so the work happens in an inner async function whose rejection can
		// never escape as an unhandled rejection.
		const dispatch = async (): Promise<void> => {
			try {
				// Normalises the path and discards the query string. Routes match
				// by exact string equality against a fixed table; nothing here
				// concatenates a path or touches the filesystem.
				const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
				const entry = routes.find((candidate) => candidate.path === pathname)

				if (entry !== undefined) {
					route = entry.route
					if (req.method === entry.method) {
						outcome = await entry.handler(req, res, ctx)
					} else {
						sendJson(res, 405, { error: 'method not allowed' })
						outcome = 'method-not-allowed'
					}
					return
				}

				if (pathname.startsWith(BOOTSTRAP_API_PREFIX)) {
					route = 'unrouted'
					sendJson(res, 404, { error: 'not found' })
					outcome = 'not-found'
					return
				}

				route = 'static'
				outcome = await staticHandler(req, res, ctx)
			} catch {
				// The caught error is deliberately not bound: neither its message
				// nor its stack may reach the client or the log stream.
				outcome = 'error'
				if (!res.headersSent) {
					sendJson(res, 500, { error: 'internal error' })
				}
			} finally {
				ctx.logger.request(route, outcome, Date.now() - startedAt)
			}
		}

		void dispatch().catch(() => {
			// `dispatch` already handled everything it can; swallowing here only
			// guarantees the listener itself cannot produce an unhandled
			// rejection.
		})
	}
}

export interface RunningService {
	port: number
	close(): Promise<void>
}

export interface StartServiceOverrides {
	store?: RendezvousStores
	logger?: ServiceLogger
	staticHandler?: RouteHandler
	routes?: readonly RouteTableEntry[]
	startSweeper?: typeof startSweeper
}

/**
 * Builds the service context, starts the retention sweeper, binds the socket
 * and returns a handle.
 *
 * The loopback guard is re-asserted here even though `loadServiceConfig`
 * already ran it, because this function also accepts a hand-built
 * `ServiceConfig` from tests and from the conformance harness. The check
 * therefore lives at the point that actually binds a port, not only at the
 * point that parses an environment.
 *
 * `config.port === 0` yields the real ephemeral port in the returned handle.
 */
export async function startService (config: ServiceConfig, overrides?: StartServiceOverrides): Promise<RunningService> {
	assertLoopbackOrOptedIn(config.bindHost, config.allowNonLoopbackBind)

	const logger = overrides?.logger ?? createServiceLogger({ mode: config.logMode })
	const store = overrides?.store ?? await createRendezvousStores(config.dataDir)
	const context: ServiceContext = { config, logger, store }

	const sweeper = (overrides?.startSweeper ?? startSweeper)({
		store,
		graceWindowMinutes: config.graceWindowMinutes,
		sweepIntervalSeconds: config.sweepIntervalSeconds,
		logger
	})

	const server = createServer(
		createRequestListener({
			context,
			staticHandler: overrides?.staticHandler,
			routes: overrides?.routes
		})
	)

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => {
			reject(err)
		}
		// A bind failure must surface as a rejected promise, never as an
		// unhandled 'error' event on the server.
		server.once('error', onError)
		server.listen(config.port, config.bindHost, () => {
			server.removeListener('error', onError)
			resolve()
		})
	})

	const address = server.address() as AddressInfo

	return {
		port: address.port,
		async close (): Promise<void> {
			sweeper.stop()
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err === undefined || err === null) {
						resolve()
					} else {
						reject(err)
					}
				})
			})
		}
	}
}
