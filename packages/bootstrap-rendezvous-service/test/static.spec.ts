import { expect } from 'chai'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep as pathSep } from 'node:path'
import {
	ENV_ALLOW_STALE_DIST,
	ServiceConfigError,
	loadServiceConfig,
	type ServiceConfig
} from '../src/config.js'
import type { LoggedOutcome, ServiceLogger } from '../src/logging.js'
import type { ServiceContext } from '../src/http.js'
import {
	DistProvenanceError,
	MIME_TYPES_BY_EXTENSION,
	assertDistProvenance,
	contentTypeForPath,
	handleStatic,
	inspectDistProvenance,
	resetDistProvenanceCache,
	resolveDistRequest,
	type DistRequestResolution
} from '../src/static.js'
import {
	FIXTURE_SCRIPT_HREF,
	FIXTURE_STYLESHEET_HREF,
	createFixtureDist,
	createFixtureSourceDir,
	touch
} from './helpers/fixture-dist.js'

/** A hand-built parsed configuration. `loadServiceConfig` is exercised on its
 * own below; everything that only needs a `distDir` uses this. */
function staticConfig (distDir: string, extra: Partial<ServiceConfig> = {}): ServiceConfig {
	return {
		bindHost: '127.0.0.1',
		port: 0,
		allowNonLoopbackBind: false,
		uploadToken: 'test-upload-token',
		maxUploadBytes: 8 * 1024 * 1024,
		graceWindowMinutes: 60,
		sweepIntervalSeconds: 60,
		dataDir: '/tmp/bootstrap-rendezvous-static-data',
		distDir,
		distSourceDir: undefined,
		allowStaleDist: false,
		logMode: 'production',
		...extra
	}
}

/**
 * static.spec.ts — the static tier's resolution arithmetic, its MIME table, its
 * dist provenance gate and the `handleStatic` route handler.
 *
 * **Positive control first, always.** Every rejection block below is preceded
 * by an assertion that the same code path *accepts* a legitimate input, because
 * a matcher that rejects everything would otherwise masquerade as a passing
 * traversal suite. This mirrors the discipline in
 * `apps/VoteTorrentDashboard/scripts/assert-no-test-harness-in-dist.mjs`, whose
 * header says in as many words that a check which cannot detect a planted token
 * proves nothing.
 *
 * **Every rejection pins its reason string**, not merely the fact of rejection.
 * A test that only asserts `kind === 'reject'` cannot tell a containment
 * backstop from a percent-escape parse failure, and the two have very different
 * security meanings.
 */

/** The dist root used by the pure-resolution tests. No file I/O happens in
 * `resolveDistRequest`, so this path never has to exist. */
const DIST_ROOT = '/tmp/bootstrap-rendezvous-dist-root'

function reasonOf (resolution: DistRequestResolution): string {
	expect(resolution.kind, `expected a reject, got ${resolution.kind}`).to.equal('reject')
	return resolution.kind === 'reject' ? resolution.reason : ''
}

describe('resolveDistRequest', () => {
	it('POSITIVE CONTROL: resolves a real asset path to a file strictly inside the dist root', () => {
		// Asserted FIRST, deliberately. Everything below this point is a
		// rejection matrix, and a resolver that rejected every input would pass
		// all of it while being completely broken.
		const resolution = resolveDistRequest(DIST_ROOT, '/assets/index-TESTHASH.js')
		expect(resolution.kind).to.equal('file')
		if (resolution.kind !== 'file') return
		expect(resolution.absolutePath).to.equal(`${DIST_ROOT}${pathSep}assets${pathSep}index-TESTHASH.js`)
		expect(resolution.absolutePath.startsWith(DIST_ROOT + pathSep)).to.equal(true)
	})

	it('resolves / to index.html inside the dist root', () => {
		const resolution = resolveDistRequest(DIST_ROOT, '/')
		expect(resolution.kind).to.equal('file')
		if (resolution.kind !== 'file') return
		expect(resolution.absolutePath).to.equal(`${DIST_ROOT}${pathSep}index.html`)
	})

	it('drops the query string and the fragment', () => {
		const plain = resolveDistRequest(DIST_ROOT, '/assets/index-TESTHASH.js')
		const decorated = resolveDistRequest(DIST_ROOT, '/assets/index-TESTHASH.js?v=1#frag')
		expect(decorated.kind).to.equal('file')
		if (plain.kind !== 'file' || decorated.kind !== 'file') return
		expect(decorated.absolutePath).to.equal(plain.absolutePath)
	})

	it('classifies the reserved API prefix as api, never as a file and never as the fallback', () => {
		const withPath = resolveDistRequest(DIST_ROOT, '/bootstrap/redemptions')
		expect(withPath.kind).to.equal('api')
	})

	it('classifies the bare /bootstrap path as api too', () => {
		const bare = resolveDistRequest(DIST_ROOT, '/bootstrap')
		expect(bare.kind).to.equal('api')
	})

	it('classifies an extensionless unknown path as the single-page-application fallback', () => {
		const resolution = resolveDistRequest(DIST_ROOT, '/some/deep/unknown/path')
		expect(resolution.kind).to.equal('fallback')
	})

	describe('traversal matrix', () => {
		it('refuses a leading .. segment and names it', () => {
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/../etc/passwd'))).to.equal('".." segment in request path')
		})

		it('refuses an interior .. segment and names it', () => {
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/assets/../../secret.txt'))).to.equal(
				'".." segment in request path'
			)
		})

		it('refuses percent-encoded .. — proving the decode happens BEFORE the segment check', () => {
			// If the segment check ran before decoding, `%2e%2e` would sail
			// straight through it. This case is the entire reason the order in
			// `resolveDistRequest` is load-bearing.
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/%2e%2e/%2e%2e/etc/passwd'))).to.equal(
				'".." segment in request path'
			)
		})

		it('refuses uppercase percent-encoded .. and encoded separators', () => {
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/%2E%2E%2Fetc%2Fpasswd'))).to.equal(
				'".." segment in request path'
			)
		})

		it('refuses a NUL byte in the request path', () => {
			// The escape, never a raw control byte in this source file.
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/index.html%00.png'))).to.equal('NUL byte in request path')
			expect(reasonOf(resolveDistRequest(DIST_ROOT, `/index.html\0.png`))).to.equal('NUL byte in request path')
		})

		it('refuses a malformed percent-escape', () => {
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/%zz'))).to.equal('malformed percent-escape in request path')
		})

		it('refuses a Windows-style backslash separator rather than normalising it', () => {
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/assets\\..\\..\\secret.txt'))).to.equal(
				'backslash segment in request path'
			)
			// And its percent-encoded spelling, which survives URL parsing.
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/assets%5C..%5Csecret.txt'))).to.equal(
				'backslash segment in request path'
			)
		})

		it('refuses a path that decodes cleanly but resolves outside the dist root (the containment backstop)', () => {
			// `%2F` decodes to a separator, producing an absolute target with no
			// `..` segment anywhere: it passes every check above and is caught
			// only by the containment test. This is the assertion that survives
			// if those checks are ever weakened.
			expect(reasonOf(resolveDistRequest(DIST_ROOT, '/%2Fetc/passwd'))).to.equal(
				'resolved path escapes the dist directory'
			)
		})
	})
})

describe('contentTypeForPath', () => {
	it('maps every extension the built dashboard can emit', () => {
		expect(contentTypeForPath('/index.html')).to.equal('text/html; charset=utf-8')
		expect(contentTypeForPath('/assets/index-TESTHASH.js')).to.equal('text/javascript; charset=utf-8')
		expect(contentTypeForPath('/assets/index-TESTHASH.mjs')).to.equal('text/javascript; charset=utf-8')
		expect(contentTypeForPath('/assets/index-TESTHASH.css')).to.equal('text/css; charset=utf-8')
		expect(contentTypeForPath('/assets/index-TESTHASH.js.map')).to.equal('application/json; charset=utf-8')
		expect(contentTypeForPath('/manifest.json')).to.equal('application/json; charset=utf-8')
		expect(contentTypeForPath('/logo.svg')).to.equal('image/svg+xml')
		expect(contentTypeForPath('/font.woff2')).to.equal('font/woff2')
		expect(contentTypeForPath('/module.wasm')).to.equal('application/wasm')
	})

	it('is case-insensitive about the extension', () => {
		expect(contentTypeForPath('/INDEX.HTML')).to.equal('text/html; charset=utf-8')
	})

	it('falls back to application/octet-stream for an unknown extension without throwing or guessing', () => {
		expect(contentTypeForPath('/x.unknownext')).to.equal('application/octet-stream')
		expect(contentTypeForPath('/LICENSE')).to.equal('application/octet-stream')
	})

	it('keys the table by lower-cased extension including the leading dot', () => {
		for (const key of Object.keys(MIME_TYPES_BY_EXTENSION)) {
			expect(key.startsWith('.'), `${key} must carry its leading dot`).to.equal(true)
			expect(key).to.equal(key.toLowerCase())
		}
	})
})

// ===========================================================================
// Dist provenance — the stale-dist detector
// ===========================================================================

describe('inspectDistProvenance', () => {
	const cleanups: Array<() => void> = []

	function track<T extends { cleanup: () => void }> (fixture: T): T {
		cleanups.push(fixture.cleanup)
		return fixture
	}

	beforeEach(() => {
		resetDistProvenanceCache()
	})

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.()
		}
	})

	it('POSITIVE CONTROL: reports a healthy dist as clean, with an entry script digest', () => {
		// Asserted FIRST. An inspector that reported every dist as broken would
		// pass every refusal test below while being useless.
		const fixture = track(createFixtureDist())
		const provenance = inspectDistProvenance(fixture.distDir, {})
		expect(provenance.missingReferencedAssets).to.deep.equal([])
		expect(provenance.unmappedExtensions).to.deep.equal([])
		expect(provenance.looksLikeSourceDir).to.equal(false)
		expect(provenance.staleAgainstSource).to.equal(null)
		expect(provenance.entryScriptHref).to.equal(FIXTURE_SCRIPT_HREF)
		expect(provenance.entryStylesheetHref).to.equal(FIXTURE_STYLESHEET_HREF)
		expect(provenance.entryScriptSha256Prefix).to.match(/^[0-9a-f]{16}$/)
		expect(provenance.assetCount).to.be.greaterThan(0)
		expect(provenance.newestAssetMtimeMs).to.be.a('number')
	})

	it('collects an index.html reference that is not on disk', () => {
		const fixture = track(createFixtureDist({ missingScriptHref: '/assets/index-GONE.js' }))
		const provenance = inspectDistProvenance(fixture.distDir, {})
		expect(provenance.missingReferencedAssets).to.include('/assets/index-GONE.js')
	})

	it('collects an extension the MIME table cannot type', () => {
		const fixture = track(createFixtureDist({ extraFiles: { 'assets/weird.xyz': 'x' } }))
		const provenance = inspectDistProvenance(fixture.distDir, {})
		expect(provenance.unmappedExtensions).to.deep.equal(['.xyz'])
	})

	it('ignores dotfiles and extensionless files in the extension scan', () => {
		const fixture = track(
			createFixtureDist({ extraFiles: { '.DS_Store': 'junk', LICENSE: 'text', 'assets/.keep': '' } })
		)
		const provenance = inspectDistProvenance(fixture.distDir, {})
		expect(provenance.unmappedExtensions).to.deep.equal([])
	})

	it('reports staleness when a source file is newer than the newest built asset', () => {
		const fixture = track(createFixtureDist())
		const source = track(createFixtureSourceDir({ newestFileMtimeMs: Date.now() + 600_000 }))
		const provenance = inspectDistProvenance(fixture.distDir, { sourceDir: source.sourceDir })
		expect(provenance.staleAgainstSource).to.not.equal(null)
		expect(provenance.staleAgainstSource?.newestSourcePath).to.equal(source.newestFilePath)
		expect(provenance.staleAgainstSource?.newestSourceMtimeMs).to.be.greaterThan(
			provenance.staleAgainstSource?.newestAssetMtimeMs ?? Number.POSITIVE_INFINITY
		)
	})

	it('NEGATIVE CONTROL: reports no staleness when every source file predates the assets', () => {
		const fixture = track(createFixtureDist())
		const source = track(createFixtureSourceDir({ newestFileMtimeMs: Date.now() - 600_000 }))
		const provenance = inspectDistProvenance(fixture.distDir, { sourceDir: source.sourceDir })
		expect(provenance.staleAgainstSource).to.equal(null)
	})

	it('skips node_modules and dotted directories in the source walk', () => {
		const fixture = track(createFixtureDist())
		const source = track(createFixtureSourceDir({ newestFileMtimeMs: Date.now() - 600_000 }))
		for (const relative of ['node_modules/pkg/index.js', 'dist/old.js', '.cache/blob.js']) {
			const full = join(source.sourceDir, relative)
			mkdirSync(join(full, '..'), { recursive: true })
			writeFileSync(full, 'planted\n', 'utf8')
			touch(full, Date.now() + 3_600_000)
		}
		const provenance = inspectDistProvenance(fixture.distDir, { sourceDir: source.sourceDir })
		expect(provenance.staleAgainstSource).to.equal(null)
	})
})

describe('assertDistProvenance', () => {
	const cleanups: Array<() => void> = []

	function track<T extends { cleanup: () => void }> (fixture: T): T {
		cleanups.push(fixture.cleanup)
		return fixture
	}

	function refusalFor (config: Parameters<typeof assertDistProvenance>[0]): DistProvenanceError {
		try {
			assertDistProvenance(config)
		} catch (err) {
			expect(err).to.be.instanceOf(DistProvenanceError)
			return err as DistProvenanceError
		}
		expect.fail('expected assertDistProvenance to refuse this dist')
		throw new Error('unreachable')
	}

	beforeEach(() => {
		resetDistProvenanceCache()
	})

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.()
		}
	})

	it('POSITIVE CONTROL: accepts a healthy dist and returns its provenance', () => {
		const fixture = track(createFixtureDist())
		const provenance = assertDistProvenance(staticConfig(fixture.distDir))
		expect(provenance.entryScriptHref).to.equal(FIXTURE_SCRIPT_HREF)
	})

	it('refuses a directory that is not there, naming the path and the build command', () => {
		const message = refusalFor(staticConfig('/tmp/bootstrap-rendezvous-definitely-absent-dist')).message
		expect(message).to.contain('/tmp/bootstrap-rendezvous-definitely-absent-dist')
		expect(message).to.contain('yarn workspace votetorrent-dashboard build')
	})

	it('refuses a directory with no index.html, naming it', () => {
		const empty = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-empty-dist-'))
		cleanups.push(() => rmSync(empty, { recursive: true, force: true }))
		const message = refusalFor(staticConfig(empty)).message
		expect(message).to.contain('index.html')
		expect(message).to.contain(empty)
	})

	it('refuses the dashboard SOURCE root by name rather than serving it', () => {
		const fixture = track(createFixtureDist({ sourceRootIndex: true }))
		const message = refusalFor(staticConfig(fixture.distDir)).message
		expect(message).to.contain('source directory')
		expect(message).to.contain('/src/main.tsx')
	})

	it('refuses a dist whose index.html references an asset that is not on disk', () => {
		const fixture = track(createFixtureDist({ missingScriptHref: '/assets/index-GONE.js' }))
		const message = refusalFor(staticConfig(fixture.distDir)).message
		expect(message).to.contain('/assets/index-GONE.js')
	})

	it('refuses a dist holding an extension the MIME table cannot type, naming the remedy', () => {
		const fixture = track(createFixtureDist({ extraFiles: { 'assets/weird.xyz': 'x' } }))
		const message = refusalFor(staticConfig(fixture.distDir)).message
		expect(message).to.contain('.xyz')
		expect(message).to.contain('MIME_TYPES_BY_EXTENSION')
	})

	it('refuses a stale dist, naming both mtimes, the newest source file and the opt-in variable', () => {
		const fixture = track(createFixtureDist())
		const source = track(createFixtureSourceDir({ newestFileMtimeMs: Date.now() + 600_000 }))
		const config = staticConfig(fixture.distDir, { distSourceDir: source.sourceDir })
		const provenance = inspectDistProvenance(fixture.distDir, { sourceDir: source.sourceDir })
		const message = refusalFor(config).message
		expect(message).to.contain(source.newestFilePath)
		expect(message).to.contain(String(Math.round(provenance.staleAgainstSource?.newestSourceMtimeMs ?? -1)))
		expect(message).to.contain(String(Math.round(provenance.staleAgainstSource?.newestAssetMtimeMs ?? -1)))
		expect(message).to.contain('BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST')
	})

	it('accepts the identical stale dist once the opt-in is set — the flag is real, not decorative', () => {
		const fixture = track(createFixtureDist())
		const source = track(createFixtureSourceDir({ newestFileMtimeMs: Date.now() + 600_000 }))
		const refused = staticConfig(fixture.distDir, { distSourceDir: source.sourceDir })
		refusalFor(refused)
		resetDistProvenanceCache()
		const permitted = staticConfig(fixture.distDir, { distSourceDir: source.sourceDir, allowStaleDist: true })
		const provenance = assertDistProvenance(permitted)
		expect(provenance.staleAgainstSource).to.not.equal(null)
	})

	it('memoises per configuration, and resetDistProvenanceCache clears it', () => {
		const fixture = createFixtureDist()
		const config = staticConfig(fixture.distDir)
		expect(assertDistProvenance(config).entryScriptHref).to.equal(FIXTURE_SCRIPT_HREF)

		// Delete the dist out from under it. A second call that still succeeds
		// can only have come from the memo, which is the property under test:
		// the filesystem walk happens once per process, not once per request.
		rmSync(fixture.distDir, { recursive: true, force: true })
		expect(assertDistProvenance(config).entryScriptHref).to.equal(FIXTURE_SCRIPT_HREF)

		resetDistProvenanceCache()
		expect(() => assertDistProvenance(config)).to.throw(DistProvenanceError)
	})
})

describe('loadServiceConfig — the D-22 static keys', () => {
	function baseEnv (): Record<string, string | undefined> {
		return {
			BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: 'test-upload-token',
			BOOTSTRAP_RENDEZVOUS_DATA_DIR: '/tmp/bootstrap-rendezvous-data',
			BOOTSTRAP_RENDEZVOUS_DIST_DIR: '/tmp/bootstrap-rendezvous-dist'
		}
	}

	it('defaults to no source directory and no staleness opt-in', () => {
		const config = loadServiceConfig(baseEnv())
		expect(config.distSourceDir).to.equal(undefined)
		expect(config.allowStaleDist).to.equal(false)
	})

	it('carries the source directory through verbatim', () => {
		const config = loadServiceConfig({
			...baseEnv(),
			BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR: '/repo/apps/VoteTorrentDashboard/src'
		})
		expect(config.distSourceDir).to.equal('/repo/apps/VoteTorrentDashboard/src')
	})

	it('POSITIVE CONTROLS: the staleness opt-in parses both recognised spellings', () => {
		expect(loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST: 'true' }).allowStaleDist).to.equal(true)
		expect(loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST: 'false' }).allowStaleDist).to.equal(false)
	})

	it('refuses an unrecognised staleness opt-in value, naming the key', () => {
		try {
			loadServiceConfig({ ...baseEnv(), BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST: 'maybe' })
			expect.fail('expected loadServiceConfig to throw for an unrecognised opt-in value')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal(ENV_ALLOW_STALE_DIST)
		}
	})
})

// ===========================================================================
// handleStatic, driven through a real node:http server
// ===========================================================================

interface StaticHarness {
	port: number
	outcomes: LoggedOutcome[]
	loggerCalls: string[]
	close: () => Promise<void>
}

async function startStaticHarness (config: ServiceConfig): Promise<StaticHarness> {
	const outcomes: LoggedOutcome[] = []
	const loggerCalls: string[] = []
	const logger: ServiceLogger = {
		fatal: (event) => loggerCalls.push(`fatal:${event}`),
		request: (route) => loggerCalls.push(`request:${route}`),
		sweep: () => loggerCalls.push('sweep')
	}
	// The static tier never touches the store; a placeholder proves it.
	const ctx: ServiceContext = { config, logger, store: {} as ServiceContext['store'] }

	const server = createServer((req, res) => {
		void handleStatic(req, res, ctx).then(
			(outcome) => {
				outcomes.push(outcome)
			},
			() => {
				outcomes.push('error')
			}
		)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	const address = server.address() as AddressInfo

	return {
		port: address.port,
		outcomes,
		loggerCalls,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err === undefined || err === null ? resolve() : reject(err)))
			})
		}
	}
}

interface RawResponse {
	status: number
	headers: IncomingHttpHeaders
	body: string
}

/**
 * A verbatim request. `fetch` normalises `..` away in the client before the
 * bytes ever leave the process, so a traversal case driven through `fetch`
 * would silently test nothing at all.
 */
async function rawRequest (port: number, method: string, rawPath: string): Promise<RawResponse> {
	return await new Promise<RawResponse>((resolve, reject) => {
		const req = httpRequest({ hostname: '127.0.0.1', port, path: rawPath, method }, (res) => {
			const chunks: Buffer[] = []
			res.on('data', (chunk: Buffer) => chunks.push(chunk))
			res.on('end', () => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks).toString('utf8')
				})
			})
		})
		req.on('error', reject)
		req.end()
	})
}

/** Lets the handler's own promise settle so its returned outcome is visible. */
async function settle (): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('handleStatic', () => {
	let fixture: ReturnType<typeof createFixtureDist>
	let harness: StaticHarness
	let outsideFile: string

	beforeEach(async () => {
		resetDistProvenanceCache()
		outsideFile = join(mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-outside-')), 'secret.js')
		writeFileSync(outsideFile, 'export const secret = "OUTSIDE-THE-DIST";\n', 'utf8')
		fixture = createFixtureDist({ symlinks: { 'assets/linked.js': outsideFile } })
		harness = await startStaticHarness(staticConfig(fixture.distDir))
	})

	afterEach(async () => {
		await harness.close()
		fixture.cleanup()
		rmSync(join(outsideFile, '..'), { recursive: true, force: true })
	})

	it('POSITIVE CONTROL: serves index.html at the root, no-cache, and reports ok', async () => {
		const response = await rawRequest(harness.port, 'GET', '/')
		await settle()
		expect(response.status).to.equal(200)
		expect(response.headers['content-type']).to.equal('text/html; charset=utf-8')
		expect(response.body).to.contain('<div id="root">')
		expect(response.headers['cache-control']).to.equal('no-cache')
		expect(harness.outcomes).to.deep.equal(['ok'])
	})

	it('serves a hashed JavaScript module with a JavaScript type and an immutable cache policy', async () => {
		const response = await rawRequest(harness.port, 'GET', FIXTURE_SCRIPT_HREF)
		await settle()
		expect(response.status).to.equal(200)
		expect(response.headers['content-type']).to.equal('text/javascript; charset=utf-8')
		expect(response.headers['cache-control']).to.equal('public, max-age=31536000, immutable')
		expect(harness.outcomes).to.deep.equal(['ok'])
	})

	it('serves the stylesheet as CSS', async () => {
		const response = await rawRequest(harness.port, 'GET', FIXTURE_STYLESHEET_HREF)
		expect(response.status).to.equal(200)
		expect(response.headers['content-type']).to.equal('text/css; charset=utf-8')
	})

	it('serves the source map as JSON', async () => {
		const response = await rawRequest(harness.port, 'GET', `${FIXTURE_SCRIPT_HREF}.map`)
		expect(response.status).to.equal(200)
		expect(response.headers['content-type']).to.equal('application/json; charset=utf-8')
	})

	it('falls back to index.html for an extensionless bookmark, no-cache', async () => {
		const response = await rawRequest(harness.port, 'GET', '/deep/unknown/route')
		await settle()
		expect(response.status).to.equal(200)
		expect(response.body).to.contain('<div id="root">')
		expect(response.headers['cache-control']).to.equal('no-cache')
		expect(harness.outcomes).to.deep.equal(['ok'])
	})

	it('answers 404 for a missing asset — never the index.html body', async () => {
		// The failure this whole design exists to avoid: an HTML document served
		// in place of a missing module, which the browser then tries to parse as
		// JavaScript.
		const response = await rawRequest(harness.port, 'GET', '/assets/index-MISSING.js')
		await settle()
		expect(response.status).to.equal(404)
		expect(response.headers['content-type']).to.equal('text/plain; charset=utf-8')
		expect(response.body).to.not.include('<div id="root">')
		expect(harness.outcomes).to.deep.equal(['not-found'])
	})

	it('refuses a symlink planted inside the dist root, and does not serve what it points at', async () => {
		const response = await rawRequest(harness.port, 'GET', '/assets/linked.js')
		await settle()
		expect(response.status).to.equal(404)
		expect(response.body).to.not.include('OUTSIDE-THE-DIST')
		expect(harness.outcomes).to.deep.equal(['not-found'])
	})

	it('refuses a traversal attempt with 400 JSON rather than absorbing it into the fallback', async () => {
		const response = await rawRequest(harness.port, 'GET', '/../etc/passwd')
		await settle()
		expect(response.status).to.equal(400)
		expect(String(response.headers['content-type'])).to.contain('application/json')
		expect(response.body).to.not.include('<div id="root">')
		// The reason is diagnostic, not client-facing: it names path shapes.
		expect(JSON.parse(response.body)).to.deep.equal({ error: 'bad request' })
		expect(harness.outcomes).to.deep.equal(['bad-request'])
	})

	it('answers HEAD with the headers and none of the body', async () => {
		const response = await rawRequest(harness.port, 'HEAD', '/')
		expect(response.status).to.equal(200)
		expect(response.headers['content-type']).to.equal('text/html; charset=utf-8')
		expect(Number(response.headers['content-length'])).to.equal(statSync(fixture.indexHtmlPath).size)
		expect(response.body).to.equal('')
	})

	it('answers 405 with an Allow header for any method other than GET or HEAD', async () => {
		const response = await rawRequest(harness.port, 'PUT', '/')
		await settle()
		expect(response.status).to.equal(405)
		expect(response.headers.allow).to.equal('GET, HEAD')
		expect(harness.outcomes).to.deep.equal(['method-not-allowed'])
	})

	it('DEFENCE IN DEPTH: answers a reserved API path with JSON 404, never the index.html body', async () => {
		// `server.ts` reserves the whole prefix and never routes it here. This
		// pins the behaviour anyway, so a future refactor of the dispatch table
		// cannot turn an API path into an HTML page the client parses as JSON.
		const response = await rawRequest(harness.port, 'GET', '/bootstrap/uploads')
		await settle()
		expect(response.status).to.equal(404)
		expect(String(response.headers['content-type'])).to.contain('application/json')
		expect(response.body).to.not.include('<div id="root">')
		expect(harness.outcomes).to.deep.equal(['not-found'])
	})

	it('makes no call into the service log for any of those outcomes', async () => {
		await rawRequest(harness.port, 'GET', '/')
		await rawRequest(harness.port, 'GET', '/assets/index-MISSING.js')
		await rawRequest(harness.port, 'GET', '/../etc/passwd')
		await settle()
		expect(harness.loggerCalls).to.deep.equal([])
	})
})

describe('handleStatic against a dist that went bad after startup', () => {
	let fixture: ReturnType<typeof createFixtureDist>
	let harness: StaticHarness

	beforeEach(async () => {
		resetDistProvenanceCache()
		fixture = createFixtureDist({ missingScriptHref: '/assets/index-GONE.js' })
		harness = await startStaticHarness(staticConfig(fixture.distDir))
	})

	afterEach(async () => {
		await harness.close()
		fixture.cleanup()
	})

	it('answers 500 JSON without echoing the provenance message, which names filesystem paths', async () => {
		const response = await rawRequest(harness.port, 'GET', '/')
		await settle()
		expect(response.status).to.equal(500)
		expect(String(response.headers['content-type'])).to.contain('application/json')
		expect(JSON.parse(response.body)).to.deep.equal({ error: 'internal error' })
		expect(response.body).to.not.include('<div id="root">')
		expect(response.body).to.not.include(fixture.distDir)
		expect(harness.outcomes).to.deep.equal(['error'])
	})
})
