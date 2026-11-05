import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServiceConfig } from '../src/config.js'
import { createServiceLogger } from '../src/logging.js'
import { createRendezvousStores } from '../src/store.js'
import { startService, type RunningService } from '../src/server.js'
import {
	FORBIDDEN_REDEEM_BODY_KEYS,
	REDEEM_INVALID_REASONS,
	REDEEM_REQUEST_MAX_BYTES
} from '../src/routes/redeem.js'
import { createFixtureDist } from './helpers/fixture-dist.js'

/**
 * redeem-ordering.spec.ts — the four-state refusal ordering, the D-04 secret
 * refusal, and the closed reason vocabulary, all proven over real HTTP.
 *
 * **Every assertion here goes through `startService`.** Calling `handleRedeem`
 * directly would prove the function correct while leaving it unreachable, which
 * is the exact failure class this project has paid for twice — a verifier that
 * was correct, tested and never injected, and a composed shell no test ever
 * mounted. Direct calls to `parseRedeemRequest` are permitted in ADDITION, for
 * edge cases awkward to drive over the wire; never instead.
 *
 * This file also owns the shared fixtures. `redeem-single-use.spec.ts` imports
 * them from here rather than keeping a second copy of the same builders.
 */

/* ------------------------------------------------------------------ */
/* Shared harness                                                      */
/* ------------------------------------------------------------------ */

/** Every `lookupId`, `nonce` and `ciphertext` this suite has ever minted. The
 * log-hygiene case scans every emitted line against this list. */
export const mintedValues: string[] = []

/** Every `reason` token any response in this suite has carried. The closed
 * vocabulary case asserts each one is a declared member. */
export const observedReasons: string[] = []

/** Every log line emitted by every service this suite has closed. */
export const emittedLines: string[] = []

const openServices: RunningService[] = []
const openDirs: string[] = []
const distCleanups: Array<() => void> = []

export interface RedeemHarness {
	origin: string
	dataDir: string
	lines: string[]
}

/** A real 43-character base64url value — the shape the key derivation actually
 * produces, never a hand-typed approximation. */
export function freshLookupId (): string {
	const value = randomBytes(32).toString('base64url')
	mintedValues.push(value)
	return value
}

/** Canonical 19-character datetime, no `Z`. Datetime fixtures live here and
 * never under `src/`, where a source guard refuses a fourth copy of the
 * pattern. */
export function canonical (offsetMs: number): string {
	return new Date(Date.now() + offsetMs).toISOString().slice(0, 19)
}

/** A throwaway data root, cleaned up after the test that created it. */
export async function createDataDir (): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'brs-redeem-'))
	openDirs.push(dir)
	return dir
}

/**
 * Starts the REAL service on an ephemeral loopback port.
 *
 * The configuration is built through the real `loadServiceConfig` rather than a
 * hand-written literal, so this file cannot rot when a later plan adds a field.
 * The upload bearer key is supplied because the loader REQUIRES it even though
 * redemption never reads it — do not delete it.
 *
 * The sweeper is overridden to a no-op so the suite carries no background timer
 * and no wall-clock wait. Nothing overrides the storage handle: the point is to
 * exercise the very instance `startService` builds and hands to the handler.
 */
export async function startRedeemService (dataDir?: string): Promise<RedeemHarness> {
	const root = dataDir ?? await createDataDir()
	const fixture = createFixtureDist()
	distCleanups.push(fixture.cleanup)

	const config = loadServiceConfig({
		BOOTSTRAP_RENDEZVOUS_PORT: '0',
		BOOTSTRAP_RENDEZVOUS_DATA_DIR: root,
		BOOTSTRAP_RENDEZVOUS_DIST_DIR: fixture.distDir,
		BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN: 'redeem-spec-upload-token',
		BOOTSTRAP_RENDEZVOUS_DEV_LOGGING: 'true'
	})

	const lines: string[] = []
	const service = await startService(config, {
		logger: createServiceLogger({ mode: 'development', sink: (line) => lines.push(line) }),
		startSweeper: () => ({ stop: () => undefined })
	})
	openServices.push(service)

	return { origin: `http://127.0.0.1:${service.port}`, dataDir: root, lines }
}

/** Closes every service and removes every directory this test created. */
export async function closeRedeemServices (): Promise<void> {
	while (openServices.length > 0) {
		const service = openServices.pop()
		await service?.close()
	}
	while (distCleanups.length > 0) {
		distCleanups.pop()?.()
	}
	while (openDirs.length > 0) {
		const dir = openDirs.pop()
		if (dir !== undefined) await rm(dir, { recursive: true, force: true })
	}
}

/** Hands every line a closed service emitted to the whole-file log scan. */
export function harvestLines (harness: RedeemHarness | undefined): void {
	if (harness === undefined) return
	emittedLines.push(...harness.lines)
}

export interface RedeemResponse {
	status: number
	headers: Headers
	text: string
	json: Record<string, unknown> | undefined
}

async function post (origin: string, body: string | undefined): Promise<RedeemResponse> {
	const response = await fetch(`${origin}/bootstrap/redemptions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body })
	})
	const text = await response.text()
	let parsed: Record<string, unknown> | undefined
	try {
		parsed = JSON.parse(text) as Record<string, unknown>
	} catch {
		parsed = undefined
	}
	const reason = parsed?.['reason']
	if (typeof reason === 'string') observedReasons.push(reason)
	return { status: response.status, headers: response.headers, text, json: parsed }
}

/** Posts a JSON-serialized value. `undefined` sends no body at all. */
export async function postRedeem (origin: string, body: unknown): Promise<RedeemResponse> {
	return await post(origin, JSON.stringify(body))
}

/** Posts the literal bytes given, for the cases where the body must not be
 * valid JSON — or must not exist. */
export async function postRedeemRaw (origin: string, raw: string | undefined): Promise<RedeemResponse> {
	return await post(origin, raw)
}

export interface StagedWrapper {
	v: number
	nonce: string
	ciphertext: string
}

export interface StageOptions {
	lookupId: string
	expiresAt: string
	used?: boolean
	withCiphertext?: boolean
}

/**
 * Stages a record and its sealed wrapper DIRECTLY, before the service is
 * started against that data root.
 *
 * This is not the banned second-handle pattern. It is test-side staging that
 * completes before the service reads, not a second handle held by a request
 * handler; `FileKVStore` holds no open descriptors and no cache, so there is
 * nothing to desynchronise. The upload endpoint is deliberately not used to
 * stage — it lands in the same wave, and depending on it would serialise two
 * plans meant to run in parallel.
 */
export async function stage (dataDir: string, options: StageOptions): Promise<StagedWrapper> {
	const stores = await createRendezvousStores(dataDir)
	await stores.putRecord({
		lookupId: options.lookupId,
		expiresAt: options.expiresAt,
		used: options.used === true
	})
	const wrapper: StagedWrapper = {
		v: 1,
		nonce: randomBytes(12).toString('base64url'),
		ciphertext: randomBytes(48).toString('base64url')
	}
	mintedValues.push(wrapper.nonce, wrapper.ciphertext)
	if (options.withCiphertext !== false) {
		await stores.putCiphertext(options.lookupId, JSON.stringify(wrapper))
	}
	return wrapper
}

export function recordPath (dataDir: string, lookupId: string): string {
	return join(dataDir, 'records', `${lookupId}.json`)
}

export function ciphertextPath (dataDir: string, lookupId: string): string {
	return join(dataDir, 'ciphertext', `${lookupId}.json`)
}

export function markerPath (dataDir: string, lookupId: string): string {
	return join(dataDir, 'claims', `${lookupId}.marker`)
}

export async function exists (path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/** Every file under `dir`, as sorted paths relative to it. */
export async function listTree (dir: string): Promise<string[]> {
	const found: string[] = []
	const walk = async (current: string, prefix: string): Promise<void> => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const label = `${prefix}${entry.name}`
			if (entry.isDirectory()) await walk(join(current, entry.name), `${label}/`)
			else found.push(label)
		}
	}
	await walk(dir, '')
	return found.sort()
}

export async function claimMarkers (dataDir: string): Promise<string[]> {
	try {
		return (await readdir(join(dataDir, 'claims'))).sort()
	} catch {
		return []
	}
}

/* ------------------------------------------------------------------ */
/* The four states                                                     */
/* ------------------------------------------------------------------ */

describe('redeem ordering: the four states (D-08)', function () {
	this.timeout(15000)

	let harness: RedeemHarness | undefined

	afterEach(async () => {
		harvestLines(harness)
		harness = undefined
		await closeRedeemServices()
	})

	it('answers unknown for a lookupId that was never staged', async () => {
		harness = await startRedeemService()
		const response = await postRedeem(harness.origin, { lookupId: freshLookupId() })

		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ status: 'unknown' })
		expect(Object.keys(response.json ?? {})).to.deep.equal(['status'])
		expect(response.json).to.not.have.property('sealed')
	})

	it('answers expired without burning the code — the ciphertext survives and no claim is taken', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const wrapper = await stage(dataDir, { lookupId, expiresAt: canonical(-60_000) })
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ status: 'expired' })

		// The load-bearing half: the refusal short-circuited BEFORE the claim.
		expect(await exists(ciphertextPath(dataDir, lookupId)), 'an expired refusal must not erase the payload').to.equal(true)
		expect(await claimMarkers(dataDir), 'an expired refusal must not burn the code').to.deep.equal([])
		expect(response.text).to.not.contain(wrapper.ciphertext)
	})

	it('answers used from the durable flag without taking a claim', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		await stage(dataDir, { lookupId, expiresAt: canonical(60_000), used: true })
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ status: 'used' })
		expect(await claimMarkers(dataDir), 'a flag refusal must not create a marker').to.deep.equal([])
	})

	it('positive control: a live record is served as ok with the staged wrapper verbatim', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const wrapper = await stage(dataDir, { lookupId, expiresAt: canonical(60_000), used: false })
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.status).to.equal(200)
		expect(response.json?.['status']).to.equal('ok')
		expect(response.json?.['sealed']).to.deep.equal(wrapper)
		expect(Object.keys(response.json?.['sealed'] as object).sort()).to.deep.equal(['ciphertext', 'nonce', 'v'])
		expect(Object.keys(response.json ?? {}).sort()).to.deep.equal(['sealed', 'status'])
	})

	it('applies the ordering, not merely the outcomes: expiry precedes the used check', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		await stage(dataDir, { lookupId, expiresAt: canonical(-60_000), used: true })
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.json).to.deep.equal({ status: 'expired' })
	})

	it('treats the record, not the blob, as what makes a code redeemable', async () => {
		// A ciphertext with no record is the residual a crashed mint would leave.
		// It must be UNREACHABLE rather than servable, which is why the upload
		// side writes the payload first and the record last.
		const dataDir = await createDataDir()
		const orphan = freshLookupId()
		const stores = await createRendezvousStores(dataDir)
		await stores.putCiphertext(orphan, JSON.stringify({ v: 1, nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' }))
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId: orphan })
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ status: 'unknown' })
		expect(await exists(ciphertextPath(dataDir, orphan))).to.equal(true)
	})

	it('never lets a refusal carry a payload', async () => {
		const dataDir = await createDataDir()
		const missing = freshLookupId()
		const expired = freshLookupId()
		const spent = freshLookupId()
		const expiredWrapper = await stage(dataDir, { lookupId: expired, expiresAt: canonical(-60_000) })
		const spentWrapper = await stage(dataDir, { lookupId: spent, expiresAt: canonical(60_000), used: true })
		harness = await startRedeemService(dataDir)

		for (const lookupId of [missing, expired, spent]) {
			const response = await postRedeem(harness.origin, { lookupId })
			for (const secretValue of [expiredWrapper.ciphertext, expiredWrapper.nonce, spentWrapper.ciphertext, spentWrapper.nonce]) {
				expect(response.text, 'a refusal must never carry payload bytes').to.not.contain(secretValue)
			}
		}
	})
})

/* ------------------------------------------------------------------ */
/* Every answer is HTTP 200                                            */
/* ------------------------------------------------------------------ */

describe('redeem ordering: every answer is HTTP 200 (the D-25 precondition)', function () {
	this.timeout(15000)

	let harness: RedeemHarness | undefined

	afterEach(async () => {
		harvestLines(harness)
		harness = undefined
		await closeRedeemServices()
	})

	it('answers 200 for unknown, expired, used and ok alike', async () => {
		// `RestBootstrapTransport.requestJson` throws on ANY non-2xx response
		// (`rest-bootstrap-transport.ts:222-224`), so a non-2xx refusal would
		// surface to the client as a transport error, the status vocabulary
		// check would never run, and the dashboard's three distinct refusal
		// strings would be unreachable.
		const dataDir = await createDataDir()
		const missing = freshLookupId()
		const expired = freshLookupId()
		const spent = freshLookupId()
		const live = freshLookupId()
		await stage(dataDir, { lookupId: expired, expiresAt: canonical(-60_000) })
		await stage(dataDir, { lookupId: spent, expiresAt: canonical(60_000), used: true })
		await stage(dataDir, { lookupId: live, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)

		const expectations: Array<[string, string]> = [
			[missing, 'unknown'],
			[expired, 'expired'],
			[spent, 'used'],
			[live, 'ok']
		]
		for (const [lookupId, expected] of expectations) {
			const response = await postRedeem(harness.origin, { lookupId })
			expect(response.status, `${expected} must answer 200`).to.equal(200)
			expect(response.status).to.be.lessThan(400)
			expect(response.json?.['status']).to.equal(expected)
		}
	})

	it('opens no additional channel alongside the status word', async () => {
		// The status word itself is a deliberate, considered disclosure to the
		// legitimate holder — the refusal copy depends on it and must not be
		// collapsed. What is asserted here is only that no ADDITIONAL signal
		// rides alongside it.
		const dataDir = await createDataDir()
		const missing = freshLookupId()
		const expired = freshLookupId()
		await stage(dataDir, { lookupId: expired, expiresAt: canonical(-60_000) })
		harness = await startRedeemService(dataDir)

		const unknownResponse = await postRedeem(harness.origin, { lookupId: missing })
		const expiredResponse = await postRedeem(harness.origin, { lookupId: expired })

		expect(unknownResponse.headers.get('content-type')).to.equal(expiredResponse.headers.get('content-type'))
		expect(unknownResponse.headers.get('cache-control')).to.equal('no-store')
		expect(expiredResponse.headers.get('cache-control')).to.equal('no-store')

		const names = (response: RedeemResponse): string[] => [...response.headers.keys()].sort()
		expect(names(unknownResponse)).to.deep.equal(names(expiredResponse))
	})
})

/* ------------------------------------------------------------------ */
/* D-04: a lookupId, never a secret                                    */
/* ------------------------------------------------------------------ */

describe('redeem ordering: the request carries a lookupId, never a secret (D-04)', function () {
	this.timeout(15000)

	let harness: RedeemHarness | undefined

	afterEach(async () => {
		harvestLines(harness)
		harness = undefined
		await closeRedeemServices()
	})

	it('refuses the pre-reshape body shape by name and touches nothing on disk', async () => {
		const dataDir = await createDataDir()
		harness = await startRedeemService(dataDir)
		const offered = '0123456789abcdef0123456789abcdef01234567'
		const before = await listTree(dataDir)

		const response = await postRedeem(harness.origin, { code: offered })

		expect(response.status).to.equal(400)
		expect(response.json?.['reason']).to.equal('secret-offered')
		expect(response.json).to.not.have.property('status')
		expect(response.text, 'the offending value must never be echoed').to.not.contain(offered)
		// The load-bearing assertion: nothing was created, so no derivation was
		// even attempted.
		expect(await listTree(dataDir)).to.deep.equal(before)
	})

	it('refuses a bare secret, and refuses a valid lookupId that also offers one', async () => {
		harness = await startRedeemService()

		const bare = await postRedeem(harness.origin, { secret: 'x' })
		expect(bare.status).to.equal(400)
		expect(bare.json?.['reason']).to.equal('secret-offered')

		// The one that matters most: a body carrying a valid lookupId AND a
		// secret must be refused outright, never partially honoured.
		const both = await postRedeem(harness.origin, { lookupId: freshLookupId(), code: 'x' })
		expect(both.status).to.equal(400)
		expect(both.json?.['reason']).to.equal('secret-offered')
		expect(both.json).to.not.have.property('status')
	})

	it('refuses an offered content key', async () => {
		harness = await startRedeemService()
		const response = await postRedeem(harness.origin, { contentKey: 'x' })
		expect(response.status).to.equal(400)
		expect(response.json?.['reason']).to.equal('secret-offered')
	})

	it('names exactly the three refused members', () => {
		expect([...FORBIDDEN_REDEEM_BODY_KEYS]).to.deep.equal(['code', 'secret', 'contentKey'])
	})

	it('positive control: the same endpoint serves a staged live code', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const wrapper = await stage(dataDir, { lookupId, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.status).to.equal(200)
		expect(response.json?.['status']).to.equal('ok')
		expect(response.json?.['sealed']).to.deep.equal(wrapper)
	})
})

/* ------------------------------------------------------------------ */
/* Malformed requests                                                  */
/* ------------------------------------------------------------------ */

describe('redeem ordering: malformed requests are refused with a reason', function () {
	this.timeout(15000)

	let harness: RedeemHarness | undefined

	afterEach(async () => {
		harvestLines(harness)
		harness = undefined
		await closeRedeemServices()
	})

	it('refuses a body that is not JSON, and a request with no body at all', async () => {
		const dataDir = await createDataDir()
		harness = await startRedeemService(dataDir)
		const before = await listTree(dataDir)

		const notJson = await postRedeemRaw(harness.origin, 'not json')
		expect(notJson.status).to.equal(400)
		expect(notJson.json?.['reason']).to.equal('json')

		// An empty body resolves to `undefined`, which must be refused rather
		// than treated as an empty object.
		const empty = await postRedeemRaw(harness.origin, undefined)
		expect(empty.status).to.equal(400)
		expect(empty.json?.['reason']).to.equal('body-shape')

		expect(await listTree(dataDir)).to.deep.equal(before)
	})

	it('refuses every non-object JSON body with body-shape', async () => {
		const dataDir = await createDataDir()
		harness = await startRedeemService(dataDir)
		const before = await listTree(dataDir)

		for (const body of [[], 'a string', null, 42]) {
			const response = await postRedeem(harness.origin, body)
			expect(response.status, `${JSON.stringify(body)} must be refused`).to.equal(400)
			expect(response.json?.['reason']).to.equal('body-shape')
		}
		expect(await listTree(dataDir)).to.deep.equal(before)
	})

	it('refuses an extra top-level key with unknown-field', async () => {
		// Strict rejection is a design control: an extra field means the client
		// is telling this service something it must not know. The cost is a
		// service update when the protocol grows, which is acceptable because
		// one authority runs both halves.
		const dataDir = await createDataDir()
		harness = await startRedeemService(dataDir)
		const before = await listTree(dataDir)

		const response = await postRedeem(harness.origin, {
			lookupId: freshLookupId(),
			expiresAt: canonical(60_000)
		})
		expect(response.status).to.equal(400)
		expect(response.json?.['reason']).to.equal('unknown-field')
		expect(await listTree(dataDir)).to.deep.equal(before)
	})

	it('refuses every lookupId outside the fixed base64url shape before any path is built', async () => {
		const dataDir = await createDataDir()
		harness = await startRedeemService(dataDir)
		const before = await listTree(dataDir)

		const hostile: unknown[] = [
			'..',
			'../../etc/passwd',
			'A'.repeat(42),
			'A'.repeat(44),
			`${'A'.repeat(41)}+/`,
			'',
			1
		]
		for (const lookupId of hostile) {
			const response = await postRedeem(harness.origin, { lookupId })
			expect(response.status, `${JSON.stringify(lookupId)} must be refused`).to.equal(400)
			expect(response.json?.['reason']).to.equal('lookup-id')
			expect(response.text, 'the guard message quotes its input and must not be forwarded').to.not.contain('passwd')
		}

		// The traversal assertion: nothing was created or read anywhere.
		expect(await listTree(dataDir)).to.deep.equal(before)
	})

	it('refuses a body over the ceiling with 413, and does not name the limit', async () => {
		harness = await startRedeemService()
		// Padding the lookupId VALUE keeps this a single oversized string field,
		// so the ceiling is what refuses it rather than the shape check.
		const oversized = JSON.stringify({ lookupId: 'A'.repeat(REDEEM_REQUEST_MAX_BYTES + 64) })
		expect(oversized.length).to.be.greaterThan(REDEEM_REQUEST_MAX_BYTES)

		const response = await postRedeemRaw(harness.origin, oversized)
		expect(response.status).to.equal(413)
		expect(response.json).to.deep.equal({ error: 'request too large' })
		// The deliberate asymmetry: the upload 413 DOES name its limit, because
		// its caller is an authenticated operator. Redemption is
		// unauthenticated, so the configured value stays undisclosed.
		expect(response.json).to.not.have.property('limitBytes')
		expect(response.text).to.not.contain(String(REDEEM_REQUEST_MAX_BYTES))
	})

	it('emits reasons only from the closed exported vocabulary', async () => {
		expect([...REDEEM_INVALID_REASONS]).to.deep.equal([
			'json',
			'body-shape',
			'unknown-field',
			'secret-offered',
			'lookup-id'
		])
		expect(observedReasons.length, 'the refusal cases above must have produced reasons').to.be.greaterThan(0)
		for (const reason of observedReasons) {
			expect([...REDEEM_INVALID_REASONS], `${reason} is not a declared reason`).to.include(reason)
		}
	})
})

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

describe('redeem ordering: outcomes reach the log through server.ts only', function () {
	this.timeout(15000)

	let harness: RedeemHarness | undefined

	afterEach(async () => {
		harvestLines(harness)
		harness = undefined
		await closeRedeemServices()
	})

	it('writes exactly one line per request, carrying the handler outcome', async () => {
		harness = await startRedeemService()
		await postRedeem(harness.origin, { lookupId: freshLookupId() })

		expect(harness.lines).to.have.lengthOf(1)
		expect(harness.lines[0]).to.match(/^bootstrap-rendezvous request route=redeem outcome=unknown latency_ms=\d+$/)
	})

	it('forwards ok, expired, used, bad-request and too-large verbatim', async () => {
		const dataDir = await createDataDir()
		const live = freshLookupId()
		const expired = freshLookupId()
		const spent = freshLookupId()
		await stage(dataDir, { lookupId: live, expiresAt: canonical(60_000) })
		await stage(dataDir, { lookupId: expired, expiresAt: canonical(-60_000) })
		await stage(dataDir, { lookupId: spent, expiresAt: canonical(60_000), used: true })
		harness = await startRedeemService(dataDir)

		await postRedeem(harness.origin, { lookupId: live })
		await postRedeem(harness.origin, { lookupId: expired })
		await postRedeem(harness.origin, { lookupId: spent })
		await postRedeemRaw(harness.origin, 'not json')
		await postRedeemRaw(harness.origin, JSON.stringify({ lookupId: 'A'.repeat(REDEEM_REQUEST_MAX_BYTES + 64) }))

		const outcomes = harness.lines.map((line) => line.replace(/^.*outcome=/, '').replace(/ latency_ms=\d+$/, ''))
		expect(outcomes).to.deep.equal(['ok', 'expired', 'used', 'bad-request', 'too-large'])
		for (const line of harness.lines) {
			expect(line).to.match(/^bootstrap-rendezvous request route=redeem outcome=[a-z-]+ latency_ms=\d+$/)
		}
	})

	it('never lets a lookupId, a nonce or a ciphertext reach the log stream', async () => {
		expect(emittedLines.length, 'earlier cases must have emitted lines to scan').to.be.greaterThan(0)
		expect(mintedValues.length, 'earlier cases must have minted values to scan for').to.be.greaterThan(0)
		for (const line of emittedLines) {
			for (const value of mintedValues) {
				expect(line, `a log line disclosed ${value.slice(0, 8)}...`).to.not.contain(value)
			}
		}
	})
})
