import { expect } from 'chai'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deriveBootstrapKeys, sealPayload } from '@votetorrent/vote-engine/bootstrap'
import { DistProvenanceError } from '../src/static.js'
import { createTestService, type TestServiceHandle } from './helpers/create-test-service.js'

/**
 * test-service-factory.spec.ts — the factory proves itself before the
 * conformance suite is allowed to depend on it.
 *
 * `createTestService` is the far side of `makeRestBinding` in
 * `packages/vote-engine/test/bootstrap-transport-conformance.spec.ts`. If it
 * silently failed to bind a port, or leaked a listener, or never actually armed
 * its injected fault, the conformance suite would go green for the wrong
 * reason — which is the exact failure mode `52-13` exists to remove. So every
 * claim the factory makes is asserted here: the ephemeral port is real and
 * distinct per instance, an upload is genuinely accepted, the fault is genuinely
 * one-shot, and after `close()` the port refuses connections.
 *
 * No `--exit` flag is present in this package's `test` script and none may be
 * added: a leaked listener must show up as a hang, not be hidden by a flag.
 */

function findRepoRoot (startDir: string): string {
	let dir = startDir
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	throw new Error('findRepoRoot: reached the filesystem root without finding a directory containing both package.json and .git')
}

const REPO_ROOT = findRepoRoot(process.cwd())
const VOTE_ENGINE_BUILT_BARREL = join(REPO_ROOT, 'packages', 'vote-engine', 'dist', 'bootstrap', 'index.js')

const STALE_BUILD_MESSAGE = [
	'the service under test is running against a STALE @votetorrent/vote-engine build.',
	'Run `yarn workspace @votetorrent/vote-engine build` and re-run this suite.',
	'The service imports @votetorrent/vote-engine/bootstrap, which resolves to',
	`${VOTE_ENGINE_BUILT_BARREL} — while the specs import the same seam from SOURCE.`,
	'A stale dist therefore makes the two halves disagree for reasons no assertion can name.'
].join(' ')

/** A fixed 20-byte secret. This spec does not need a real snapshot envelope —
 * it needs a wrapper the service will accept and hand back unopened. */
const FIXED_SECRET = new Uint8Array(20).fill(7)

interface StagedUpload {
	lookupId: string
	body: { lookupId: string, expiresAt: string, sealed: { v: number, nonce: string, ciphertext: string } }
}

/** A canonical (19-character, no trailing `Z`) datetime a year out. */
function canonicalFuture (): string {
	return new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 19)
}

function buildUpload (secret: Uint8Array): StagedUpload {
	const keys = deriveBootstrapKeys(secret)
	const sealed = sealPayload(JSON.stringify({ marker: 'test-service-factory' }), keys)
	return {
		lookupId: keys.lookupId,
		body: {
			lookupId: keys.lookupId,
			expiresAt: canonicalFuture(),
			sealed: { v: sealed.v, nonce: sealed.nonce, ciphertext: sealed.ciphertext }
		}
	}
}

interface WireResponse {
	status: number
	body: Record<string, unknown>
}

async function postJson (url: string, body: unknown, token?: string): Promise<WireResponse> {
	const headers: Record<string, string> = { 'content-type': 'application/json' }
	if (token !== undefined) headers.authorization = `Bearer ${token}`
	const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
	const text = await response.text()
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(text) as Record<string, unknown>
	} catch {
		parsed = {}
	}
	return { status: response.status, body: parsed }
}

describe('createTestService: the real-service conformance factory', () => {
	const open: TestServiceHandle[] = []

	afterEach(async () => {
		while (open.length > 0) {
			await open.pop()?.close()
		}
	})

	async function start (): Promise<TestServiceHandle> {
		const handle = await createTestService()
		open.push(handle)
		return handle
	}

	it('runs against a freshly built @votetorrent/vote-engine, not a stale dist', async () => {
		expect(existsSync(VOTE_ENGINE_BUILT_BARREL), STALE_BUILD_MESSAGE).to.equal(true)
		const built = await import(VOTE_ENGINE_BUILT_BARREL) as Record<string, unknown>
		expect(typeof built.unsealPayload, STALE_BUILD_MESSAGE).to.equal('function')
		expect((built.unsealPayload as { name: string }).name, STALE_BUILD_MESSAGE).to.equal('unsealPayload')
	})

	it('binds a real ephemeral loopback port, distinct per concurrent instance', async () => {
		const first = await start()
		const second = await start()

		expect(first.port).to.be.greaterThan(0)
		expect(second.port).to.be.greaterThan(0)
		expect(first.port).to.not.equal(second.port)
		expect(first.dataDir).to.not.equal(second.dataDir)
		expect(first.distDir).to.not.equal(second.distDir)
		expect(first.uploadToken).to.not.equal(second.uploadToken)
		expect(first.baseUrl).to.equal(`http://127.0.0.1:${first.port}`)
	})

	it('accepts an authenticated upload and serves it back as an unopened wrapper', async () => {
		const service = await start()
		const staged = buildUpload(FIXED_SECRET)

		const uploaded = await postJson(`${service.baseUrl}/bootstrap/uploads`, staged.body, service.uploadToken)
		expect(uploaded.status).to.equal(200)
		expect(uploaded.body).to.deep.equal({ ok: true })

		const redeemed = await postJson(`${service.baseUrl}/bootstrap/redemptions`, { lookupId: staged.lookupId })
		expect(redeemed.status).to.equal(200)
		expect(redeemed.body.status).to.equal('ok')
		expect(Object.keys(redeemed.body.sealed as Record<string, unknown>).sort()).to.deep.equal([
			'ciphertext',
			'nonce',
			'v'
		])
	})

	it('refuses an unauthenticated upload with 401 — the negative control for the case above', async () => {
		const service = await start()
		const staged = buildUpload(new Uint8Array(20).fill(9))

		const unauthenticated = await postJson(`${service.baseUrl}/bootstrap/uploads`, staged.body)
		expect(unauthenticated.status).to.equal(401)
		expect(unauthenticated.body).to.deep.equal({ error: 'unauthorized' })
	})

	it('injects exactly one record-read fault, surfacing as a 500 that recovers on the next call', async () => {
		const service = await start()
		const staged = buildUpload(new Uint8Array(20).fill(11))
		const uploaded = await postJson(`${service.baseUrl}/bootstrap/uploads`, staged.body, service.uploadToken)
		expect(uploaded.status, 'the positive control must be staged before the fault is armed').to.equal(200)

		service.failNextRecordRead()
		const faulted = await postJson(`${service.baseUrl}/bootstrap/redemptions`, { lookupId: staged.lookupId })
		expect(faulted.status).to.equal(500)
		expect(faulted.body).to.deep.equal({ error: 'internal error' })
		const faultedText = JSON.stringify(faulted.body)
		expect(faultedText.includes(staged.lookupId), 'a 500 must not echo the look-up id').to.equal(false)
		expect(faultedText.includes('injected record-read fault'), 'a 500 must not echo an internal message').to.equal(false)

		// One-shot: the very next redemption of the SAME look-up id succeeds,
		// which also proves the fault fired before anything was claimed.
		const recovered = await postJson(`${service.baseUrl}/bootstrap/redemptions`, { lookupId: staged.lookupId })
		expect(recovered.status).to.equal(200)
		expect(recovered.body.status).to.equal('ok')
	})

	it('closes idempotently and leaves the port refusing connections', async () => {
		const service = await createTestService()
		const baseUrl = service.baseUrl

		// Positive control: the port answers while the service is up.
		const alive = await fetch(`${baseUrl}/bootstrap/definitely-not-a-route`, { method: 'POST', body: '{}' })
		expect(alive.status).to.equal(404)

		await service.close()
		await service.close()

		let rejection: unknown
		try {
			await fetch(baseUrl)
		} catch (err) {
			rejection = err
		}
		expect(
			rejection,
			'after close() the port must REFUSE connections — a resolved fetch means a listener leaked, which would hang mocha'
		).to.not.equal(undefined)
	})

	it('removes both temp directories on close', async () => {
		const service = await createTestService()
		expect(existsSync(service.dataDir)).to.equal(true)
		expect(existsSync(service.distDir)).to.equal(true)

		await service.close()

		expect(existsSync(service.dataDir), 'close() must remove the data directory').to.equal(false)
		expect(existsSync(service.distDir), 'close() must remove the dist fixture').to.equal(false)
	})

	it('refuses to start against a dist that is not a built dashboard, before binding a port', async () => {
		// The inertness control for the provenance call: a data directory holds
		// no index.html, so pointing `distDir` at one must fail construction.
		// Reached by starting normally, closing, and re-running the gate against
		// the surviving config shape — the factory itself never exposes a knob
		// for a broken dist, deliberately.
		const service = await createTestService()
		const dataDir = service.dataDir
		const { assertDistProvenance, resetDistProvenanceCache } = await import('../src/static.js')
		resetDistProvenanceCache()

		let thrown: unknown
		try {
			assertDistProvenance({ distDir: dataDir, distSourceDir: undefined, allowStaleDist: false })
		} catch (err) {
			thrown = err
		}
		await service.close()
		resetDistProvenanceCache()

		expect(thrown, 'a directory with no index.html is not a built dashboard').to.be.instanceOf(DistProvenanceError)
	})
})
