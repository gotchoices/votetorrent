import { expect } from 'chai'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServiceConfig } from '../src/config.js'
import { createServiceLogger } from '../src/logging.js'
import {
	RequestBodyInvalidError,
	RequestBodyTooLargeError,
	readJsonBody,
	sendJson,
	sendNotImplemented,
	type RouteHandler,
	type ServiceContext
} from '../src/http.js'
import { createRendezvousStores, type RendezvousStores } from '../src/store.js'
import { createFixtureDist } from './helpers/fixture-dist.js'
import type { SweeperOptions } from '../src/sweeper.js'
import { BOOTSTRAP_RENDEZVOUS_ROUTES, startService, type RouteTableEntry } from '../src/server.js'
import { handleUpload } from '../src/routes/upload.js'
import { handleRedeem } from '../src/routes/redeem.js'
import { runMain } from '../src/main.js'

/**
 * server-routes.spec.ts — the route table and the dispatcher.
 *
 * **Assertion discipline, read before adding an `expect`.** Four later plans
 * fill `static.ts`, `routes/upload.ts`, `routes/redeem.ts` and `sweeper.ts`,
 * and none of them may edit this file. **No assertion here may therefore depend
 * on any handler still being a stub** — not its status, not its body, not its
 * outcome. What is asserted instead is the *wiring*: which function each route
 * maps to, and how the dispatcher routes method and path. That stays true for
 * the life of the service. `sendNotImplemented` is covered directly, because
 * the helper is permanent even though all of its current callers are
 * temporary.
 */

function makeConfig (dataDir: string): ServiceConfig {
	return {
		bindHost: '127.0.0.1',
		port: 0,
		allowNonLoopbackBind: false,
		uploadToken: 'test-upload-token',
		maxUploadBytes: 8 * 1024 * 1024,
		graceWindowMinutes: 60,
		sweepIntervalSeconds: 60,
		dataDir,
		distDir: join(dataDir, 'dist'),
		distSourceDir: undefined,
		allowStaleDist: false,
		logMode: 'development'
	}
}

interface TestService {
	baseUrl: string
	config: ServiceConfig
	store: RendezvousStores
	lines: string[]
	uploadCalls: ServiceContext[]
	redeemCalls: ServiceContext[]
	staticCalls: ServiceContext[]
	sweeperOptions: SweeperOptions[]
	sweeperStops: () => number
	close: () => Promise<void>
}

/**
 * Starts a real service on an ephemeral loopback port with spy handlers
 * injected through the `routes` and `staticHandler` overrides, so nothing
 * asserted below depends on a real handler's behaviour.
 */
async function startTestService (): Promise<TestService> {
	const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-routes-'))
	const config = makeConfig(dataDir)
	const lines: string[] = []
	const logger = createServiceLogger({ mode: 'development', sink: (line) => lines.push(line) })
	const store = await createRendezvousStores(dataDir)

	const uploadCalls: ServiceContext[] = []
	const redeemCalls: ServiceContext[] = []
	const staticCalls: ServiceContext[] = []
	const sweeperOptions: SweeperOptions[] = []
	let sweeperStops = 0

	const routes: readonly RouteTableEntry[] = [
		{
			method: 'POST',
			path: '/bootstrap/uploads',
			route: 'upload',
			handler: async (_req, res, ctx) => {
				uploadCalls.push(ctx)
				sendJson(res, 200, { spy: 'upload' })
				return 'ok'
			}
		},
		{
			method: 'POST',
			path: '/bootstrap/redemptions',
			route: 'redeem',
			handler: async (_req, res, ctx) => {
				redeemCalls.push(ctx)
				sendJson(res, 200, { spy: 'redeem' })
				return 'ok'
			}
		}
	]

	const staticHandler: RouteHandler = async (_req, res, ctx) => {
		staticCalls.push(ctx)
		sendJson(res, 200, { spy: 'static' })
		return 'ok'
	}

	const service = await startService(config, {
		logger,
		store,
		staticHandler,
		routes,
		startSweeper: (options) => {
			sweeperOptions.push(options)
			return {
				stop: () => {
					sweeperStops += 1
				}
			}
		}
	})

	return {
		baseUrl: `http://127.0.0.1:${service.port}`,
		config,
		store,
		lines,
		uploadCalls,
		redeemCalls,
		staticCalls,
		sweeperOptions,
		sweeperStops: () => sweeperStops,
		close: async () => {
			await service.close()
		}
	}
}

/** Stands up a throwaway node:http server for the helpers that are tested
 * directly rather than through a route. */
async function startBareServer (
	listener: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ baseUrl: string, close: () => Promise<void> }> {
	const server: Server = createServer(listener)
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const address = server.address() as AddressInfo
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err === undefined || err === null ? resolve() : reject(err)))
			})
		}
	}
}

/** A chunked POST with no `Content-Length`, so only the streaming byte counter
 * can stop it. Resolves either way — the point of the assertion is what the
 * server observed, not whether the client managed to read a response from a
 * socket the server deliberately destroyed. */
async function postChunked (url: string, chunks: string[]): Promise<void> {
	await new Promise<void>((resolve) => {
		const parsed = new URL(url)
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: 'POST',
				headers: { 'content-type': 'application/json' }
			},
			(res) => {
				res.resume()
				res.on('end', () => resolve())
			}
		)
		req.on('error', () => resolve())
		for (const chunk of chunks) {
			req.write(chunk)
		}
		req.end()
	})
}

describe('BOOTSTRAP_RENDEZVOUS_ROUTES', () => {
	it('declares exactly the two POST endpoints the wire protocol needs', () => {
		expect(BOOTSTRAP_RENDEZVOUS_ROUTES).to.have.lengthOf(2)
		expect(BOOTSTRAP_RENDEZVOUS_ROUTES.map((entry) => entry.path)).to.deep.equal([
			'/bootstrap/uploads',
			'/bootstrap/redemptions'
		])
		for (const entry of BOOTSTRAP_RENDEZVOUS_ROUTES) {
			expect(entry.method).to.equal('POST')
		}
	})

	it('declares no pull-side endpoint', () => {
		const pullSide = BOOTSTRAP_RENDEZVOUS_ROUTES.filter((entry) => entry.path.includes('snapshot'))
		expect(pullSide).to.deep.equal([])
	})

	it('maps each path to the handler module the later plans fill', () => {
		// Reference equality, deliberately. This holds no matter what those two
		// functions do in any given wave, and it is what actually guarantees a
		// later plan reaches production by filling exactly one file.
		const upload = BOOTSTRAP_RENDEZVOUS_ROUTES.find((entry) => entry.path === '/bootstrap/uploads')
		const redeem = BOOTSTRAP_RENDEZVOUS_ROUTES.find((entry) => entry.path === '/bootstrap/redemptions')
		expect(upload).to.not.equal(undefined)
		expect(redeem).to.not.equal(undefined)
		expect(upload?.handler).to.equal(handleUpload)
		expect(upload?.route).to.equal('upload')
		expect(redeem?.handler).to.equal(handleRedeem)
		expect(redeem?.route).to.equal('redeem')
	})
})

describe('createRequestListener dispatch', () => {
	let service: TestService

	beforeEach(async () => {
		service = await startTestService()
	})

	afterEach(async () => {
		await service.close()
	})

	it('routes POST /bootstrap/uploads to the upload entry and nothing else', async () => {
		const response = await fetch(`${service.baseUrl}/bootstrap/uploads`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ hello: 'world' })
		})
		expect(response.status).to.equal(200)
		expect(service.uploadCalls).to.have.lengthOf(1)
		expect(service.redeemCalls).to.have.lengthOf(0)
		expect(service.staticCalls).to.have.lengthOf(0)
		expect(service.uploadCalls[0]?.config).to.equal(service.config)
		expect(service.uploadCalls[0]?.store).to.equal(service.store)
	})

	it('routes POST /bootstrap/redemptions to the redeem entry and nothing else', async () => {
		const response = await fetch(`${service.baseUrl}/bootstrap/redemptions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lookupId: 'irrelevant' })
		})
		expect(response.status).to.equal(200)
		expect(service.redeemCalls).to.have.lengthOf(1)
		expect(service.uploadCalls).to.have.lengthOf(0)
		expect(service.staticCalls).to.have.lengthOf(0)
		expect(service.redeemCalls[0]?.config).to.equal(service.config)
		expect(service.redeemCalls[0]?.store).to.equal(service.store)
	})

	it('ignores the query string when matching a route', async () => {
		const response = await fetch(`${service.baseUrl}/bootstrap/redemptions?trailing=junk`, {
			method: 'POST',
			body: '{}'
		})
		expect(response.status).to.equal(200)
		expect(service.redeemCalls).to.have.lengthOf(1)
	})

	it('answers 405 for a known path with the wrong method, invoking no handler', async () => {
		const response = await fetch(`${service.baseUrl}/bootstrap/redemptions`, { method: 'GET' })
		expect(response.status).to.equal(405)
		expect(await response.json()).to.deep.equal({ error: 'method not allowed' })
		expect(service.redeemCalls).to.have.lengthOf(0)
		expect(service.uploadCalls).to.have.lengthOf(0)
		expect(service.staticCalls).to.have.lengthOf(0)
	})

	it('answers 404 for an unknown path under the reserved API prefix', async () => {
		const response = await fetch(`${service.baseUrl}/bootstrap/nope`, { method: 'POST', body: '{}' })
		expect(response.status).to.equal(404)
		expect(await response.json()).to.deep.equal({ error: 'not found' })
		expect(service.uploadCalls).to.have.lengthOf(0)
		expect(service.redeemCalls).to.have.lengthOf(0)
		// The whole /bootstrap/ prefix belongs to the API: the static handler
		// must never see it, which is the precondition its SPA fallback relies
		// on.
		expect(service.staticCalls).to.have.lengthOf(0)
	})

	it('falls through to the static handler for every path outside the API prefix', async () => {
		const root = await fetch(`${service.baseUrl}/`)
		expect(root.status).to.equal(200)
		expect(service.staticCalls).to.have.lengthOf(1)

		const asset = await fetch(`${service.baseUrl}/assets/app.js`)
		expect(asset.status).to.equal(200)
		expect(service.staticCalls).to.have.lengthOf(2)

		expect(service.uploadCalls).to.have.lengthOf(0)
		expect(service.redeemCalls).to.have.lengthOf(0)
	})

	it('logs each request exactly once, forwarding the handler outcome verbatim', async () => {
		await fetch(`${service.baseUrl}/bootstrap/redemptions`, { method: 'POST', body: '{}' })
		expect(service.lines).to.have.lengthOf(1)
		expect(service.lines[0]).to.match(/^bootstrap-rendezvous request route=redeem outcome=ok latency_ms=\d+$/)
	})

	it('answers 500 without describing the error when a handler throws', async () => {
		// Uses its own service so the throwing handler cannot disturb the spies
		// above.
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-throw-'))
		const config = makeConfig(dataDir)
		const lines: string[] = []
		const logger = createServiceLogger({ mode: 'development', sink: (line) => lines.push(line) })
		const thrower = await startService(config, {
			logger,
			store: await createRendezvousStores(dataDir),
			startSweeper: () => ({ stop: () => undefined }),
			routes: [
				{
					method: 'POST',
					path: '/bootstrap/uploads',
					route: 'upload',
					handler: async () => {
						throw new Error('secret at /var/lib/rendezvous/abc')
					}
				}
			]
		})
		try {
			const response = await fetch(`http://127.0.0.1:${thrower.port}/bootstrap/uploads`, {
				method: 'POST',
				body: '{}'
			})
			expect(response.status).to.equal(500)
			const body = await response.text()
			expect(JSON.parse(body)).to.deep.equal({ error: 'internal error' })
			expect(body).to.not.contain('secret')
			expect(lines).to.have.lengthOf(1)
			expect(lines[0]).to.match(/^bootstrap-rendezvous request route=upload outcome=error latency_ms=\d+$/)
			expect(lines[0]).to.not.contain('secret')
		} finally {
			await thrower.close()
		}
	})
})

describe('startService lifecycle', () => {
	it('starts the sweeper with the configured window and interval and stops it on close', async () => {
		const service = await startTestService()
		expect(service.sweeperOptions).to.have.lengthOf(1)
		const options = service.sweeperOptions[0]
		expect(options?.graceWindowMinutes).to.equal(service.config.graceWindowMinutes)
		expect(options?.sweepIntervalSeconds).to.equal(service.config.sweepIntervalSeconds)
		expect(options?.store).to.equal(service.store)
		expect(service.sweeperStops()).to.equal(0)
		await service.close()
		expect(service.sweeperStops()).to.equal(1)
	})

	it('re-asserts the loopback refusal before it binds anything', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-bind-'))
		const config: ServiceConfig = { ...makeConfig(dataDir), bindHost: '0.0.0.0' }
		let thrown: unknown
		try {
			await startService(config, { startSweeper: () => ({ stop: () => undefined }) })
		} catch (err) {
			thrown = err
		}
		expect((thrown as Error | undefined)?.message ?? '').to.contain('refusing to bind non-loopback host')
	})

	it('positive control: an opted-in non-loopback config is permitted to bind', async () => {
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-optin-'))
		const config: ServiceConfig = {
			...makeConfig(dataDir),
			bindHost: '0.0.0.0',
			allowNonLoopbackBind: true
		}
		const service = await startService(config, { startSweeper: () => ({ stop: () => undefined }) })
		try {
			expect(service.port).to.be.greaterThan(0)
		} finally {
			await service.close()
		}
	})
})

describe('sendNotImplemented', () => {
	it('answers 501 with the documented body and reports its own outcome', async () => {
		let returned: unknown
		const bare = await startBareServer((_req, res) => {
			returned = sendNotImplemented(res)
		})
		try {
			const response = await fetch(bare.baseUrl)
			expect(response.status).to.equal(501)
			expect(await response.json()).to.deep.equal({ error: 'not implemented' })
			expect(returned).to.equal('not-implemented')
		} finally {
			await bare.close()
		}
	})
})

describe('readJsonBody', () => {
	let bare: { baseUrl: string, close: () => Promise<void> }
	let observed: unknown[]

	beforeEach(async () => {
		observed = []
		bare = await startBareServer((req, res) => {
			void readJsonBody(req, 32)
				.then((parsed) => {
					observed.push(parsed)
					sendJson(res, 200, { parsed })
				})
				.catch((err: unknown) => {
					observed.push(err)
					try {
						if (err instanceof RequestBodyTooLargeError) {
							sendJson(res, 413, { error: 'too large', limitBytes: err.limitBytes })
						} else if (err instanceof RequestBodyInvalidError) {
							sendJson(res, 400, { error: 'bad request' })
						} else {
							sendJson(res, 500, { error: 'internal error' })
						}
					} catch {
						// The socket may already have been destroyed by the byte
						// ceiling; there is nothing left to answer on.
					}
				})
		})
	})

	afterEach(async () => {
		await bare.close()
	})

	it('refuses an oversized body and names the limit', async () => {
		const response = await fetch(bare.baseUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ padding: 'x'.repeat(200) })
		})
		expect(response.status).to.equal(413)
		expect(await response.json()).to.deep.equal({ error: 'too large', limitBytes: 32 })
		expect(observed[0]).to.be.instanceOf(RequestBodyTooLargeError)
		expect((observed[0] as RequestBodyTooLargeError).limitBytes).to.equal(32)
	})

	it('refuses an oversized body that declares no Content-Length at all', async () => {
		// The streaming counter is the real ceiling; the header is only an early
		// exit and can be absent or a lie.
		await postChunked(bare.baseUrl, ['{"padding":"', 'x'.repeat(200), '"}'])
		await new Promise<void>((resolve) => setTimeout(resolve, 50))
		expect(observed[0]).to.be.instanceOf(RequestBodyTooLargeError)
		expect((observed[0] as RequestBodyTooLargeError).limitBytes).to.equal(32)
	})

	it('refuses a body that is not JSON, without quoting it back', async () => {
		const response = await fetch(bare.baseUrl, { method: 'POST', body: 'not json' })
		expect(response.status).to.equal(400)
		expect(observed[0]).to.be.instanceOf(RequestBodyInvalidError)
		expect((observed[0] as Error).message).to.not.contain('not json')
	})

	it('positive control: a small well-formed body parses', async () => {
		const response = await fetch(bare.baseUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}'
		})
		expect(response.status).to.equal(200)
		expect(await response.json()).to.deep.equal({ parsed: { a: 1 } })
		expect(observed[0]).to.deep.equal({ a: 1 })
	})

	it('resolves an empty body to undefined', async () => {
		const response = await fetch(bare.baseUrl, { method: 'POST' })
		expect(response.status).to.equal(200)
		expect(observed).to.have.lengthOf(1)
		expect(observed[0]).to.equal(undefined)
	})
})

describe('runMain', () => {
	function requiredEnv (): Record<string, string | undefined> {
		return {
			BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: 'test-upload-token',
			BOOTSTRAP_RENDEZVOUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-main-')),
			// 52-04's startup provenance gate refuses a directory with no index.html
			// BY DESIGN, so runMain must be handed a real built dashboard shape here.
			BOOTSTRAP_RENDEZVOUS_DIST_DIR: createFixtureDist().distDir
		}
	}

	it('surfaces the non-loopback refusal to an operator under the production-silent default', async () => {
		const lines: string[] = []
		const code = await runMain(
			{ ...requiredEnv(), BOOTSTRAP_RENDEZVOUS_BIND_HOST: '0.0.0.0' },
			(line) => lines.push(line)
		)
		expect(code).to.equal(1)
		expect(lines).to.have.lengthOf(1)
		expect(lines[0]).to.contain('event=config-invalid')
		expect(lines[0]).to.contain('refusing to bind non-loopback host')
	})

	it('positive control: a valid environment starts, stays silent, and registers a shutdown', async () => {
		const lines: string[] = []
		const signals = ['SIGINT', 'SIGTERM'] as const
		const before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]))

		const code = await runMain({ ...requiredEnv(), BOOTSTRAP_RENDEZVOUS_PORT: '0' }, (line) => lines.push(line))
		expect(code).to.equal(0)
		// Production is the default logging mode, so a healthy start says
		// nothing at all.
		expect(lines).to.have.lengthOf(0)

		// Shut the service down through the handler it registered, which both
		// proves the handler exists and keeps this suite from leaving a bound
		// socket behind.
		let shutdown: (() => void) | undefined
		for (const signal of signals) {
			const seen = before.get(signal) ?? new Set()
			for (const listener of process.listeners(signal)) {
				if (seen.has(listener)) continue
				process.removeListener(signal, listener)
				if (shutdown === undefined) {
					shutdown = listener as () => void
				}
			}
		}
		expect(shutdown, 'runMain must register a shutdown handler').to.be.a('function')
		shutdown?.()
		await new Promise<void>((resolve) => setTimeout(resolve, 100))
	})
})
