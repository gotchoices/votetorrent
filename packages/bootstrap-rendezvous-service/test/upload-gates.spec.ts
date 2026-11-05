import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceConfigError, loadServiceConfig, type ServiceConfig } from '../src/config.js'
import { createServiceLogger } from '../src/logging.js'
import { startService } from '../src/server.js'
import { UPLOAD_INVALID_REASONS, isAuthorizedUpload, parseUploadRequest } from '../src/routes/upload.js'
import { createFixtureDist } from './helpers/fixture-dist.js'

/**
 * upload-gates.spec.ts — the D-17 proof for `POST /bootstrap/uploads`.
 *
 * **Every assertion here goes over real HTTP through `startService`.** Calling
 * `handleUpload` directly would prove the function correct while leaving it
 * unreachable, which is the exact failure class this project has already paid
 * for twice — a correct iOS verifier no code path reached, and a composed
 * dashboard shell no test ever mounted. Direct calls to `isAuthorizedUpload`
 * and `parseUploadRequest` appear below **in addition** to the wire tests, for
 * edge cases that are awkward to drive over a socket, never instead of them.
 *
 * The harness builds its configuration through the real `loadServiceConfig`
 * rather than a hand-written literal, so this file cannot rot when a later plan
 * adds a configuration field. It deliberately passes **no store override**: the
 * point is to exercise the one storage instance `startService` builds.
 *
 * Datetime fixtures live here, in `test/`, and never under `src/`.
 */

/** Distinctive on purpose: every response body in this file is scanned for it. */
export const UPLOAD_TOKEN = 'test-upload-token-9c3f'

/** The ceiling every size assertion in this file is written against. */
export const MAX_UPLOAD_BYTES = 512

export function authHeader (token: string = UPLOAD_TOKEN): Record<string, string> {
	return { authorization: `Bearer ${token}` }
}

export function baseUploadEnv (dataDir: string, distDir: string): Record<string, string | undefined> {
	return {
		BOOTSTRAP_RENDEZVOUS_PORT: '0',
		BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: UPLOAD_TOKEN,
		BOOTSTRAP_RENDEZVOUS_DATA_DIR: dataDir,
		BOOTSTRAP_RENDEZVOUS_DIST_DIR: distDir,
		BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES),
		BOOTSTRAP_RENDEZVOUS_DEV_LOGGING: 'true'
	}
}

export interface UploadHarness {
	origin: string
	dataDir: string
	claimsDir: string
	lines: string[]
	close: () => Promise<void>
}

export interface UploadHarnessOverrides {
	/** Applied to the configuration the real loader produced. The only way to
	 * reach an empty operator token, since the loader itself refuses it. */
	mutateConfig?: (config: ServiceConfig) => ServiceConfig
}

/** Every log line every harness in this file emitted, in order. Case 20 scans
 * it as a whole rather than trusting any single line's format. */
const ALL_LINES: string[] = []
/** Every identifier and every sealed value this file put on the wire. */
const ALL_SECRETS: string[] = []

export async function startUploadService (overrides: UploadHarnessOverrides = {}): Promise<UploadHarness> {
	const dataDir = await mkdtemp(join(tmpdir(), 'brs-upload-'))
	const fixture = createFixtureDist()
	const loaded = loadServiceConfig(baseUploadEnv(dataDir, fixture.distDir))
	const config = overrides.mutateConfig === undefined ? loaded : overrides.mutateConfig(loaded)

	const lines: string[] = []
	const service = await startService(config, {
		logger: createServiceLogger({
			mode: 'development',
			sink: (line) => {
				lines.push(line)
				ALL_LINES.push(line)
			}
		}),
		// The sweeper is stubbed so no background timer runs during the file; the
		// storage instance is deliberately NOT overridden.
		startSweeper: () => ({ stop: () => undefined })
	})

	return {
		origin: `http://127.0.0.1:${service.port}`,
		dataDir,
		claimsDir: join(dataDir, 'claims'),
		lines,
		close: async () => {
			await service.close()
			fixture.cleanup()
			await rm(dataDir, { recursive: true, force: true })
		}
	}
}

export interface UploadResponse {
	status: number
	text: string
	json: unknown
	wwwAuthenticate: string | null
}

export async function postUpload (
	origin: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<UploadResponse> {
	const response = await fetch(`${origin}/bootstrap/uploads`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	})
	const text = await response.text()
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		json = undefined
	}
	return { status: response.status, text, json, wwwAuthenticate: response.headers.get('www-authenticate') }
}

/**
 * A chunked POST with no `content-length`, so ONLY the streaming byte counter
 * can stop it. Resolves either way: the reader destroys the request stream when
 * the counter trips, so whether a response is readable at all is best-effort —
 * what is not best-effort is that nothing was stored.
 */
export async function postChunkedUpload (
	origin: string,
	chunks: string[],
	headers: Record<string, string> = {}
): Promise<{ status?: number }> {
	return await new Promise<{ status?: number }>((resolve) => {
		const parsed = new URL(`${origin}/bootstrap/uploads`)
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers }
			},
			(res) => {
				res.resume()
				res.on('end', () => resolve({ status: res.statusCode }))
			}
		)
		req.on('error', () => resolve({}))
		for (const chunk of chunks) {
			req.write(chunk)
		}
		req.end()
	})
}

export interface SealedWireFixture {
	v: number
	nonce: string
	ciphertext: string
}

export interface UploadBodyFixture {
	lookupId: string
	expiresAt: string
	sealed: SealedWireFixture
	revokeLookupId?: string
}

/** 43 characters of unpadded base64url — the real shape a 32-byte HMAC output
 * produces, not a hand-typed approximation. */
export function freshLookupId (): string {
	const id = randomBytes(32).toString('base64url')
	ALL_SECRETS.push(id)
	return id
}

/** The canonical 19-character datetime, no trailing suffix. */
export function canonicalExpiry (offsetMs = 600000): string {
	return new Date(Date.now() + offsetMs).toISOString().slice(0, 19)
}

export function validBody (): UploadBodyFixture {
	const nonce = randomBytes(12).toString('base64url')
	const ciphertext = randomBytes(48).toString('base64url')
	ALL_SECRETS.push(nonce, ciphertext)
	return {
		lookupId: freshLookupId(),
		expiresAt: canonicalExpiry(),
		sealed: { v: 1, nonce, ciphertext }
	}
}

/** Grows the sealed ciphertext until the serialized body is at least
 * `targetBytes` long. Padding the payload rather than adding a field keeps the
 * request VALID, so a refusal can only be about size. */
export function padBodyTo (body: UploadBodyFixture, targetBytes: number): UploadBodyFixture {
	const padded: UploadBodyFixture = {
		lookupId: body.lookupId,
		expiresAt: body.expiresAt,
		sealed: { v: body.sealed.v, nonce: body.sealed.nonce, ciphertext: body.sealed.ciphertext }
	}
	while (JSON.stringify(padded).length < targetBytes) {
		padded.sealed.ciphertext += 'A'
	}
	return padded
}

export function recordPath (dataDir: string, lookupId: string): string {
	return join(dataDir, 'records', `${lookupId}.json`)
}

export function ciphertextPath (dataDir: string, lookupId: string): string {
	return join(dataDir, 'ciphertext', `${lookupId}.json`)
}

export function markerPath (claimsDir: string, lookupId: string): string {
	return join(claimsDir, `${lookupId}.marker`)
}

export async function exists (path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/** Every entry under `dataDir`, recursively and sorted — the assertion surface
 * for "nothing was created anywhere". */
export async function listTree (dataDir: string): Promise<string[]> {
	return (await readdir(dataDir, { recursive: true })).map((entry) => String(entry)).sort()
}

describe('upload gates: the 401 family (D-17)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	/** Captured once and reused as the equality target: a 401 that distinguishes
	 * its cause is the defect, so the assertion is deep equality against this
	 * baseline rather than four independent status checks. */
	async function baseline (body: UploadBodyFixture): Promise<UploadResponse> {
		return await postUpload(harness.origin, body)
	}

	it('refuses a request with no authorization header at all, and writes nothing', async () => {
		const body = validBody()
		const response = await baseline(body)
		expect(response.status).to.equal(401)
		expect(response.json).to.deep.equal({ error: 'unauthorized' })
		expect(response.wwwAuthenticate, 'the challenge header must be present').to.not.equal(null)
		expect(await exists(recordPath(harness.dataDir, body.lookupId))).to.equal(false)
		expect(await exists(ciphertextPath(harness.dataDir, body.lookupId))).to.equal(false)
	})

	it('answers a wrong token with a response deep-equal to the no-header response, naming neither token', async () => {
		const noHeader = await baseline(validBody())
		const wrongToken = await postUpload(harness.origin, validBody(), authHeader('wrong-token'))

		expect(wrongToken.status).to.equal(noHeader.status)
		expect(wrongToken.json).to.deep.equal(noHeader.json)
		expect(wrongToken.text).to.equal(noHeader.text)
		expect(wrongToken.text).to.not.contain(UPLOAD_TOKEN)
		expect(wrongToken.text).to.not.contain('wrong-token')
	})

	it('answers a wrong scheme and a bare token identically to the no-header response', async () => {
		const noHeader = await baseline(validBody())

		const basicScheme = await postUpload(harness.origin, validBody(), { authorization: `Basic ${UPLOAD_TOKEN}` })
		const bareToken = await postUpload(harness.origin, validBody(), { authorization: UPLOAD_TOKEN })

		for (const response of [basicScheme, bareToken]) {
			expect(response.status).to.equal(noHeader.status)
			expect(response.json).to.deep.equal(noHeader.json)
			expect(response.text).to.equal(noHeader.text)
		}
	})

	it('answers a prefix token and a superstring token rather than erroring on a length mismatch', async () => {
		const noHeader = await baseline(validBody())

		const prefix = await postUpload(harness.origin, validBody(), authHeader(UPLOAD_TOKEN.slice(0, -1)))
		const superstring = await postUpload(harness.origin, validBody(), authHeader(`${UPLOAD_TOKEN}x`))

		for (const response of [prefix, superstring]) {
			expect(response.status).to.equal(401)
			expect(response.json).to.deep.equal(noHeader.json)
			expect(response.text).to.equal(noHeader.text)
		}

		// The same two cases driven directly: a raw-token constant-time compare
		// would THROW here, and that throw is itself a length oracle.
		expect(() => isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN.slice(0, -1)}`, UPLOAD_TOKEN)).to.not.throw()
		expect(isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN.slice(0, -1)}`, UPLOAD_TOKEN)).to.equal(false)
		expect(isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN}x`, UPLOAD_TOKEN)).to.equal(false)
		expect(isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN}`, UPLOAD_TOKEN)).to.equal(true)
	})

	it('refuses every upload when the configured token is empty, and the loader refuses that state outright', async () => {
		// Spreading the loaded configuration is the ONLY way to reach an empty
		// token, because the real loader rejects it as a required key.
		const unset = await startUploadService({ mutateConfig: (config) => ({ ...config, uploadToken: '' }) })
		try {
			const withToken = await postUpload(unset.origin, validBody(), authHeader())
			const withoutHeader = await postUpload(unset.origin, validBody())

			expect(withToken.status).to.equal(401)
			expect(withoutHeader.status).to.equal(401)
			expect(withToken.json).to.deep.equal({ error: 'unauthorized' })
			expect(withToken.text).to.equal(withoutHeader.text)
			expect(await listTree(join(unset.dataDir, 'records')).catch(() => [])).to.deep.equal([])
			expect(await listTree(join(unset.dataDir, 'ciphertext')).catch(() => [])).to.deep.equal([])

			// Directly, for the header-shape edge cases.
			expect(isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN}`, '')).to.equal(false)
			expect(isAuthorizedUpload(`Bearer ${UPLOAD_TOKEN}`, '   ')).to.equal(false)
			expect(isAuthorizedUpload(undefined, UPLOAD_TOKEN)).to.equal(false)
		} finally {
			await unset.close()
		}

		// Positive control: the PRIMARY control is a startup failure, and the
		// handler's refusal above is only the second layer.
		const dataDir = await mkdtemp(join(tmpdir(), 'brs-upload-cfg-'))
		const fixture = createFixtureDist()
		const env = baseUploadEnv(dataDir, fixture.distDir)
		delete env.BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN
		try {
			loadServiceConfig(env)
			expect.fail('expected loadServiceConfig to refuse a missing upload token')
		} catch (err) {
			expect(err).to.be.instanceOf(ServiceConfigError)
			expect((err as ServiceConfigError).key).to.equal('BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN')
		} finally {
			fixture.cleanup()
			await rm(dataDir, { recursive: true, force: true })
		}
	})

	it('positive control: the identical body with the correct bearer token is accepted and stored', async () => {
		const body = validBody()
		const response = await postUpload(harness.origin, body, authHeader())
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ ok: true })
		expect(await exists(recordPath(harness.dataDir, body.lookupId))).to.equal(true)
		expect(await exists(ciphertextPath(harness.dataDir, body.lookupId))).to.equal(true)
	})
})

describe('upload gates: the size ceiling names the limit (D-17)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('refuses an honest over-length content-length with a 413 that names the configured limit', async () => {
		const body = padBodyTo(validBody(), MAX_UPLOAD_BYTES + 300)
		expect(JSON.stringify(body).length).to.be.greaterThan(MAX_UPLOAD_BYTES)

		const response = await postUpload(harness.origin, body, authHeader())
		expect(response.status).to.equal(413)
		expect(response.json).to.deep.equal({ error: 'upload too large', limitBytes: MAX_UPLOAD_BYTES })
		expect(response.text).to.contain(String(MAX_UPLOAD_BYTES))
		expect(await exists(recordPath(harness.dataDir, body.lookupId))).to.equal(false)
		expect(await exists(ciphertextPath(harness.dataDir, body.lookupId))).to.equal(false)
	})

	it('refuses a chunked body with no content-length, where only the streaming counter can stop it', async () => {
		const body = padBodyTo(validBody(), MAX_UPLOAD_BYTES + 300)
		const serialized = JSON.stringify(body)
		const chunks: string[] = []
		for (let at = 0; at < serialized.length; at += 100) {
			chunks.push(serialized.slice(at, at + 100))
		}

		const outcome = await postChunkedUpload(harness.origin, chunks, authHeader())

		// The load-bearing half: the refusal to STORE is not best-effort.
		expect(await exists(recordPath(harness.dataDir, body.lookupId))).to.equal(false)
		expect(await exists(ciphertextPath(harness.dataDir, body.lookupId))).to.equal(false)
		// The best-effort half: the reader destroys the request stream when the
		// running counter trips, so a client that is still writing may never read
		// a response at all. IF one arrived, it must be the 413.
		if (outcome.status !== undefined) {
			expect(outcome.status).to.equal(413)
		}
		// The request was framed chunked, which is what makes the streaming
		// counter — and not the declared-length early exit — the thing under test.
		expect(chunks.length).to.be.greaterThan(1)
		// And the server's own outcome proves WHICH refusal happened: a
		// `bad-request` here would mean the body was read and then rejected.
		expect(harness.lines).to.have.lengthOf(1)
		expect(harness.lines[0]).to.contain('outcome=too-large')
	})

	it('answers an unauthenticated oversized upload with 401 and never discloses the limit', async () => {
		const body = padBodyTo(validBody(), 4096)
		const response = await postUpload(harness.origin, body)

		expect(response.status).to.equal(401)
		expect(response.json).to.deep.equal({ error: 'unauthorized' })
		expect(response.text).to.not.contain('limitBytes')
		expect(response.text).to.not.contain(String(MAX_UPLOAD_BYTES))
	})

	it('positive control: an authenticated body just under the ceiling is accepted', async () => {
		const body = padBodyTo(validBody(), MAX_UPLOAD_BYTES - 40)
		expect(JSON.stringify(body).length).to.be.lessThan(MAX_UPLOAD_BYTES)

		const response = await postUpload(harness.origin, body, authHeader())
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ ok: true })
	})
})

describe('upload gates: malformed requests are refused with a reason (D-17)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	/** The positive control every refusal below is paired against. */
	async function acceptedControl (): Promise<void> {
		const body = validBody()
		const response = await postUpload(harness.origin, body, authHeader())
		expect(response.status, 'the positive control must be accepted').to.equal(200)
		expect(response.json).to.deep.equal({ ok: true })
	}

	async function refusedWith (body: unknown, reason: string, lookupIds: string[] = []): Promise<void> {
		const response = await postUpload(harness.origin, body, authHeader())
		expect(response.status).to.equal(400)
		expect(response.json).to.deep.equal({ error: 'bad request', reason })
		expect(UPLOAD_INVALID_REASONS as readonly string[]).to.include(reason)
		for (const lookupId of lookupIds) {
			expect(await exists(recordPath(harness.dataDir, lookupId))).to.equal(false)
			expect(await exists(ciphertextPath(harness.dataDir, lookupId))).to.equal(false)
		}
	}

	it('refuses a body that is not JSON with reason json', async () => {
		await refusedWith('not json', 'json')
		await acceptedControl()
	})

	it('refuses an array and a bare string with reason body-shape', async () => {
		await refusedWith('[]', 'body-shape')
		await refusedWith('"a string"', 'body-shape')
		await acceptedControl()
	})

	it('refuses an extra top-level key with reason unknown-field', async () => {
		const body = validBody()
		await refusedWith({ ...body, authorityId: 'must-not-be-told' }, 'unknown-field', [body.lookupId])
		await acceptedControl()
	})

	it('refuses every non-conforming lookupId with reason lookup-id and creates nothing under dataDir', async () => {
		const template = validBody()
		const shapes = [
			'..',
			'../../etc/passwd',
			randomBytes(32).toString('base64url').slice(0, 42),
			`${randomBytes(32).toString('base64url')}A`,
			// 43 characters, but standard base64 rather than base64url: `+` and `/`
			// are outside the accepted charset, and `/` is a path separator.
			`${'A'.repeat(41)}+/`
		]
		for (const lookupId of shapes) {
			await refusedWith({ ...template, lookupId }, 'lookup-id')
		}

		// The load-bearing traversal assertion: the whole tree, before and after.
		const before = await listTree(harness.dataDir)
		const traversal = await postUpload(
			harness.origin,
			{ ...template, lookupId: '../../etc/passwd' },
			authHeader()
		)
		expect(traversal.status).to.equal(400)
		expect(await listTree(harness.dataDir)).to.deep.equal(before)

		await acceptedControl()
	})

	it('refuses a non-canonical expiresAt with reason expires-at', async () => {
		const template = validBody()
		await refusedWith({ ...template, expiresAt: `${canonicalExpiry()}Z` }, 'expires-at', [template.lookupId])
		await refusedWith({ ...template, expiresAt: 'not-a-datetime' }, 'expires-at', [template.lookupId])
		// The positive control for the canonical 19-character value is the
		// accepted control below, which carries exactly that shape.
		await acceptedControl()
	})

	it('refuses a malformed sealed wrapper with reason sealed, but does NOT gatekeep its version', async () => {
		const template = validBody()
		await refusedWith({ ...template, sealed: { v: 1, ciphertext: template.sealed.ciphertext } }, 'sealed')
		await refusedWith(
			{ ...template, sealed: { ...template.sealed, aad: 'extra' } },
			'sealed'
		)
		await refusedWith({ ...template, sealed: { ...template.sealed, v: '1' } }, 'sealed')
		await refusedWith({ ...template, sealed: { ...template.sealed, ciphertext: '' } }, 'sealed')

		// Seam rule 5, couriers do not reject: this service cannot read the blob,
		// so gatekeeping a format version it cannot interpret would break the next
		// producer for no security gain.
		const futureVersion = validBody()
		futureVersion.sealed.v = 99
		const accepted = await postUpload(harness.origin, futureVersion, authHeader())
		expect(accepted.status).to.equal(200)
		expect(await exists(recordPath(harness.dataDir, futureVersion.lookupId))).to.equal(true)

		await acceptedControl()
	})

	it('refuses a malformed or self-referential revokeLookupId with its own reason', async () => {
		const template = validBody()
		await refusedWith({ ...template, revokeLookupId: '..' }, 'revoke-lookup-id', [template.lookupId])
		await refusedWith({ ...template, revokeLookupId: 42 }, 'revoke-lookup-id', [template.lookupId])
		await refusedWith({ ...template, revokeLookupId: template.lookupId }, 'revoke-equals-lookup', [template.lookupId])

		// Directly, so the closed reason set is asserted at the source too.
		expect(() => parseUploadRequest({ ...template, revokeLookupId: template.lookupId })).to.throw()
		expect(parseUploadRequest(template).revokeLookupId).to.equal(undefined)

		await acceptedControl()
	})
})

describe('upload gates: outcomes reach the log through server.ts only', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('emits exactly one line for one unauthenticated request, carrying outcome=unauthorized', async () => {
		await postUpload(harness.origin, validBody())
		expect(harness.lines).to.have.lengthOf(1)
		expect(harness.lines[0]).to.match(
			/^bootstrap-rendezvous request route=upload outcome=unauthorized latency_ms=\d+$/
		)
	})

	it('maps a success, an over-length body and a malformed body to their own outcomes, one line each', async () => {
		await postUpload(harness.origin, validBody(), authHeader())
		await postUpload(harness.origin, padBodyTo(validBody(), MAX_UPLOAD_BYTES + 300), authHeader())
		await postUpload(harness.origin, 'not json', authHeader())

		expect(harness.lines).to.have.lengthOf(3)
		expect(harness.lines[0]).to.contain('outcome=ok')
		expect(harness.lines[1]).to.contain('outcome=too-large')
		expect(harness.lines[2]).to.contain('outcome=bad-request')
		for (const line of harness.lines) {
			expect(line).to.contain('route=upload')
		}
	})

	it('has never emitted a line carrying a lookupId, a sealed value or the operator token', async () => {
		expect(ALL_LINES.length, 'the scan would pass vacuously with no lines').to.be.greaterThan(0)
		expect(ALL_SECRETS.length, 'the scan would pass vacuously with no secrets').to.be.greaterThan(0)

		const offenders: string[] = []
		for (const line of ALL_LINES) {
			if (line.includes(UPLOAD_TOKEN)) offenders.push(`operator token in: ${line}`)
			for (const secret of ALL_SECRETS) {
				if (line.includes(secret)) offenders.push(`identifier or sealed value in: ${line}`)
			}
		}
		expect(offenders, offenders.join('; ')).to.deep.equal([])
	})
})
