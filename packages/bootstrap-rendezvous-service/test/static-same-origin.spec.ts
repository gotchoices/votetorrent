import { expect } from 'chai'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServiceConfig } from '../src/config.js'
import { createServiceLogger } from '../src/logging.js'
import { createRendezvousStores } from '../src/store.js'
import { startService, type RunningService } from '../src/server.js'
import { inspectDistProvenance, resetDistProvenanceCache } from '../src/static.js'
import { runMain } from '../src/main.js'
import { createFixtureDist, createFixtureSourceDir, FIXTURE_SCRIPT_HREF } from './helpers/fixture-dist.js'

/**
 * static-same-origin.spec.ts — one process, one port, both halves.
 *
 * **The property under test:** the dashboard sets its API base URL to
 * `window.location.origin` (`apps/VoteTorrentDashboard/src/screens/Bootstrap.tsx:55`),
 * so the shipped client can only ever reach an API that answers on the very
 * origin that served the page. A test that exercised the two halves on two
 * ports would prove nothing about the client that actually ships; every request
 * below is therefore issued against a single derived `origin` constant, and
 * that single constant is the assertion mechanism rather than a convenience.
 *
 * The second half of the file proves the startup gate by **occupancy**: an exit
 * code alone would not show that the port stayed closed.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REAL_DASHBOARD_DIST = resolve(HERE, '../../../apps/VoteTorrentDashboard/dist')
const DASHBOARD_BUILD_COMMAND = 'yarn workspace votetorrent-dashboard build'

function makeConfig (distDir: string, dataDir: string): ServiceConfig {
	return {
		bindHost: '127.0.0.1',
		port: 0,
		allowNonLoopbackBind: false,
		uploadToken: 'test-upload-token',
		maxUploadBytes: 8 * 1024 * 1024,
		graceWindowMinutes: 60,
		sweepIntervalSeconds: 60,
		dataDir,
		distDir,
		distSourceDir: undefined,
		allowStaleDist: false,
		logMode: 'development'
	}
}

interface Harness {
	origin: string
	lines: string[]
	service: RunningService
}

/** Starts the REAL service — the real dispatcher, the real route table, the
 * real static handler — on an ephemeral loopback port. */
async function startRealService (distDir: string, cleanups: Array<() => void>): Promise<Harness> {
	const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-same-origin-'))
	cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
	const lines: string[] = []
	const service = await startService(makeConfig(distDir, dataDir), {
		logger: createServiceLogger({ mode: 'development', sink: (line) => lines.push(line) }),
		store: await createRendezvousStores(dataDir),
		startSweeper: () => ({ stop: () => undefined })
	})
	return { origin: `http://127.0.0.1:${service.port}`, lines, service }
}

async function listenOn (server: Server, port: number): Promise<void> {
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (err: Error): void => rejectListen(err)
		server.once('error', onError)
		server.listen(port, '127.0.0.1', () => {
			server.removeListener('error', onError)
			resolveListen()
		})
	})
}

async function closeServer (server: Server): Promise<void> {
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((err) => (err === undefined || err === null ? resolveClose() : rejectClose(err)))
	})
}

/** Binds an ephemeral port and immediately releases it, yielding a port number
 * that is known to have been free a moment ago. */
async function borrowFreePort (): Promise<number> {
	const server = createServer()
	await listenOn(server, 0)
	const port = (server.address() as AddressInfo).port
	await closeServer(server)
	return port
}

/** True when nothing holds the port — the occupancy probe. Its own positive
 * control is the healthy-start case below, which requires this to be false. */
async function portIsFree (port: number): Promise<boolean> {
	const probe = createServer()
	try {
		await listenOn(probe, port)
	} catch (err) {
		expect((err as NodeJS.ErrnoException).code).to.equal('EADDRINUSE')
		return false
	}
	await closeServer(probe)
	return true
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const

function snapshotSignalListeners (): Map<string, Set<unknown>> {
	return new Map(SIGNALS.map((signal) => [signal as string, new Set(process.listeners(signal))]))
}

/** Removes and returns the shutdown handler `runMain` registered, so a passing
 * test never leaves a bound socket or a live signal listener behind. */
function harvestShutdown (before: Map<string, Set<unknown>>): (() => void) | undefined {
	let shutdown: (() => void) | undefined
	for (const signal of SIGNALS) {
		const seen = before.get(signal) ?? new Set<unknown>()
		for (const listener of process.listeners(signal)) {
			if (seen.has(listener)) continue
			process.removeListener(signal, listener)
			if (shutdown === undefined) shutdown = listener as () => void
		}
	}
	return shutdown
}

async function settleShutdown (): Promise<void> {
	await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100))
}

describe('one port answers both the dashboard and the API (same origin)', () => {
	const cleanups: Array<() => void> = []
	let harness: Harness

	beforeEach(async () => {
		resetDistProvenanceCache()
		const fixture = createFixtureDist()
		cleanups.push(fixture.cleanup)
		harness = await startRealService(fixture.distDir, cleanups)
	})

	afterEach(async () => {
		await harness.service.close()
		while (cleanups.length > 0) {
			cleanups.pop()?.()
		}
	})

	it('serves the dashboard entry document at the root of that origin', async () => {
		const response = await fetch(`${harness.origin}/`)
		expect(response.status).to.equal(200)
		expect(response.headers.get('content-type')).to.equal('text/html; charset=utf-8')
		expect(await response.text()).to.contain('<div id="root">')
	})

	it('serves the hashed JavaScript module from the same origin with a JavaScript type', async () => {
		const response = await fetch(`${harness.origin}${FIXTURE_SCRIPT_HREF}`)
		expect(response.status).to.equal(200)
		expect(response.headers.get('content-type')).to.equal('text/javascript; charset=utf-8')
	})

	it('answers the redemption endpoint with JSON on that same origin, never with index.html', async () => {
		// **Assert the content-type and JSON-parseability only.** The redemption
		// route is still a stub at this wave and a later plan replaces what it
		// answers. The property this file owns is that the API answers on the
		// same port as the dashboard's build output, not what it answers — so do
		// not "fix" this test by pinning a status code.
		const response = await fetch(`${harness.origin}/bootstrap/redemptions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: 'irrelevant' })
		})
		expect(String(response.headers.get('content-type'))).to.satisfy((value: string) =>
			value.startsWith('application/json')
		)
		const body = await response.text()
		expect(() => JSON.parse(body)).to.not.throw()
		expect(body).to.not.contain('<div id="root">')
	})

	it('answers an unmatched API path with a JSON 404 and provably not with the dashboard HTML', async () => {
		// The worst-case symptom the `/bootstrap/`-before-fallback ordering
		// exists to prevent: a client parsing an HTML page as JSON. This one IS
		// safe to pin — it is the dispatcher's own reserved-prefix 404.
		const response = await fetch(`${harness.origin}/bootstrap/definitely-not-a-route`)
		expect(response.status).to.equal(404)
		expect(String(response.headers.get('content-type'))).to.contain('application/json')
		const body = await response.text()
		expect(JSON.parse(body)).to.deep.equal({ error: 'not found' })
		expect(body).to.not.contain('<div id="root">')
	})

	it('falls back to the dashboard entry document for a bookmarked path, through the real dispatcher', async () => {
		const response = await fetch(`${harness.origin}/some/bookmarked/path`)
		expect(response.status).to.equal(200)
		expect(await response.text()).to.contain('<div id="root">')
	})
})

describe('the startup gate keeps the port closed', () => {
	const cleanups: Array<() => void> = []

	function requiredEnv (): Record<string, string | undefined> {
		const dataDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-gate-data-'))
		cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
		return {
			BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: 'test-upload-token',
			BOOTSTRAP_RENDEZVOUS_DATA_DIR: dataDir
		}
	}

	beforeEach(() => {
		resetDistProvenanceCache()
	})

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.()
		}
	})

	it('refuses a dist whose index.html references a missing asset, and never binds the port', async () => {
		const port = await borrowFreePort()
		const broken = createFixtureDist({ missingScriptHref: '/assets/index-GONE.js' })
		cleanups.push(broken.cleanup)

		const lines: string[] = []
		const before = snapshotSignalListeners()
		const code = await runMain(
			{
				...requiredEnv(),
				BOOTSTRAP_RENDEZVOUS_PORT: String(port),
				BOOTSTRAP_RENDEZVOUS_DIST_DIR: broken.distDir
			},
			(line) => lines.push(line)
		)
		harvestShutdown(before)

		expect(code).to.equal(1)
		expect(lines).to.have.lengthOf(1)
		expect(lines[0]).to.contain('event=config-invalid')
		expect(lines[0]).to.contain('/assets/index-GONE.js')
		// The assertion that actually proves it: the port is still bindable, so
		// nothing ever listened on it.
		expect(await portIsFree(port)).to.equal(true)
	})

	it('POSITIVE CONTROL: a healthy dist binds the same port, proving the occupancy probe is live', async () => {
		// Without this, the case above would pass just as happily against a
		// probe that could never detect a bound port.
		const port = await borrowFreePort()
		const healthy = createFixtureDist()
		cleanups.push(healthy.cleanup)

		const lines: string[] = []
		const before = snapshotSignalListeners()
		const code = await runMain(
			{
				...requiredEnv(),
				BOOTSTRAP_RENDEZVOUS_PORT: String(port),
				BOOTSTRAP_RENDEZVOUS_DIST_DIR: healthy.distDir
			},
			(line) => lines.push(line)
		)
		const shutdown = harvestShutdown(before)

		expect(code).to.equal(0)
		// Production is the default logging mode: a healthy start says nothing.
		expect(lines).to.have.lengthOf(0)
		expect(await portIsFree(port)).to.equal(false)

		expect(shutdown, 'runMain must register a shutdown handler').to.be.a('function')
		shutdown?.()
		await settleShutdown()
	})

	it('refuses a stale dist, naming the opt-in, and accepts it once the opt-in is set', async () => {
		const port = await borrowFreePort()
		const fixture = createFixtureDist()
		cleanups.push(fixture.cleanup)
		const source = createFixtureSourceDir({ newestFileMtimeMs: Date.now() + 600_000 })
		cleanups.push(source.cleanup)

		const staleEnv = {
			...requiredEnv(),
			BOOTSTRAP_RENDEZVOUS_PORT: String(port),
			BOOTSTRAP_RENDEZVOUS_DIST_DIR: fixture.distDir,
			BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR: source.sourceDir
		}

		const refusedLines: string[] = []
		const beforeRefusal = snapshotSignalListeners()
		const refused = await runMain(staleEnv, (line) => refusedLines.push(line))
		harvestShutdown(beforeRefusal)
		expect(refused).to.equal(1)
		expect(refusedLines).to.have.lengthOf(1)
		expect(refusedLines[0]).to.contain('event=config-invalid')
		expect(refusedLines[0]).to.contain('BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST')
		expect(refusedLines[0]).to.contain(source.newestFilePath)
		expect(await portIsFree(port)).to.equal(true)

		// The opt-in, proven end to end through the real entrypoint rather than
		// only through the exported function.
		const permittedLines: string[] = []
		const beforePermitted = snapshotSignalListeners()
		const permitted = await runMain(
			{ ...staleEnv, BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST: 'true' },
			(line) => permittedLines.push(line)
		)
		const shutdown = harvestShutdown(beforePermitted)
		expect(permitted).to.equal(0)
		expect(permittedLines).to.have.lengthOf(0)
		shutdown?.()
		await settleShutdown()
	})
})

describe('the real dashboard build, served from the same origin', () => {
	const cleanups: Array<() => void> = []
	let harness: Harness | undefined

	beforeEach(async function () {
		resetDistProvenanceCache()
		if (!existsSync(join(REAL_DASHBOARD_DIST, 'index.html'))) {
			// A silent skip rots into a permanently inert test. Print the exact
			// command that turns this leg back on.
			console.log(
				`      skipped: ${REAL_DASHBOARD_DIST} has no index.html. Enable this leg with: ${DASHBOARD_BUILD_COMMAND}`
			)
			this.skip()
			return
		}
		harness = await startRealService(REAL_DASHBOARD_DIST, cleanups)
	})

	afterEach(async () => {
		await harness?.service.close()
		harness = undefined
		while (cleanups.length > 0) {
			cleanups.pop()?.()
		}
	})

	it('serves the real index.html and the real entry module it references', async () => {
		const origin = harness?.origin ?? ''
		const index = await fetch(`${origin}/`)
		expect(index.status).to.equal(200)
		expect(index.headers.get('content-type')).to.equal('text/html; charset=utf-8')

		const html = readFileSync(join(REAL_DASHBOARD_DIST, 'index.html'), 'utf8')
		const entry = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/i.exec(html)?.[1]
		expect(entry, 'the real index.html must reference an entry module').to.be.a('string')

		const script = await fetch(`${origin}${entry ?? ''}`)
		expect(script.status).to.equal(200)
		expect(script.headers.get('content-type')).to.equal('text/javascript; charset=utf-8')
	})

	it('keeps the MIME table honest against what the build actually emits', async () => {
		// The assertion that stops `MIME_TYPES_BY_EXTENSION` from being a record
		// of what this plan ASSUMED Vite emits.
		const provenance = inspectDistProvenance(REAL_DASHBOARD_DIST, {})
		expect(provenance.missingReferencedAssets).to.deep.equal([])
		expect(provenance.unmappedExtensions).to.deep.equal([])
		expect(provenance.entryScriptSha256Prefix).to.match(/^[0-9a-f]{16}$/)
		console.log(
			`      real dist entry script: ${String(provenance.entryScriptHref)} sha256:${String(provenance.entryScriptSha256Prefix)} assets=${provenance.assetCount}`
		)
	})
})
