import { expect } from 'chai'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRendezvousStores } from '../src/store.js'
import {
	canonical,
	ciphertextPath,
	claimMarkers,
	closeRedeemServices,
	createDataDir,
	exists,
	freshLookupId,
	harvestLines,
	markerPath,
	postRedeem,
	recordPath,
	stage,
	startRedeemService,
	type RedeemHarness,
	type RedeemResponse,
	type StagedWrapper
} from './redeem-ordering.spec.js'

/**
 * redeem-single-use.spec.ts — the concurrency proof, the erase-on-disk proof,
 * and the at-most-once residuals.
 *
 * The fixtures are imported from `redeem-ordering.spec.ts` rather than copied,
 * so there is exactly one definition of the harness, the staging helper and the
 * path builders.
 *
 * **The core proof of this plan is the eight-way storm below, and it is not an
 * extra.** It asserts exact literal counts, because "at least one succeeded"
 * cannot tell `link(2)`'s atomic `EEXIST` apart from a read-then-write check
 * that two requests can both pass.
 */

function outcomesOf (harness: RedeemHarness): string[] {
	return harness.lines.map((line) => line.replace(/^.*outcome=/, '').replace(/ latency_ms=\d+$/, ''))
}

/* ------------------------------------------------------------------ */
/* D-08: exactly one winner                                            */
/* ------------------------------------------------------------------ */

describe('redeem single-use: two simultaneous redemptions, exactly one wins (D-08)', function () {
	this.timeout(20000)

	let harness: RedeemHarness
	let dataDir: string
	let lookupId: string
	let wrapper: StagedWrapper
	let results: RedeemResponse[]

	beforeEach(async () => {
		dataDir = await createDataDir()
		lookupId = freshLookupId()
		wrapper = await stage(dataDir, { lookupId, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)
		// The same counting discipline `claim.spec.ts` applies to
		// `claimSingleUse` itself, now driven through the whole HTTP stack.
		results = await Promise.all([...Array(8)].map(async () => await postRedeem(harness.origin, { lookupId })))
	})

	afterEach(async () => {
		harvestLines(harness)
		await closeRedeemServices()
	})

	it('yields exactly one ok and exactly seven used, every one of them a 200', async () => {
		expect(results.filter((r) => r.json?.['status'] === 'ok')).to.have.lengthOf(1)
		expect(results.filter((r) => r.json?.['status'] === 'used')).to.have.lengthOf(7)
		expect(results.filter((r) => r.status === 200)).to.have.lengthOf(8)
		expect(results.filter((r) => r.json?.['sealed'] !== undefined)).to.have.lengthOf(1)
	})

	it('hands the single winner the real payload, not an empty shell', async () => {
		const winner = results.find((r) => r.json?.['status'] === 'ok')
		expect(winner).to.not.equal(undefined)
		expect(winner?.json?.['sealed']).to.deep.equal(wrapper)
	})

	it('leaves the payload erased, the record marked, and exactly one claim marker', async () => {
		expect(await exists(ciphertextPath(dataDir, lookupId))).to.equal(false)
		expect(await exists(recordPath(dataDir, lookupId))).to.equal(true)
		const record = JSON.parse(await readFile(recordPath(dataDir, lookupId), 'utf8')) as { used: boolean }
		expect(record.used).to.equal(true)
		expect(await claimMarkers(dataDir)).to.deep.equal([`${lookupId}.marker`])
	})

	it('answers used to a ninth, sequential attempt after the storm', async () => {
		const ninth = await postRedeem(harness.origin, { lookupId })
		expect(ninth.status).to.equal(200)
		expect(ninth.json).to.deep.equal({ status: 'used' })
	})
})

/* ------------------------------------------------------------------ */
/* D-16: erase on serve                                                */
/* ------------------------------------------------------------------ */

describe('redeem single-use: the ciphertext is erased on serve (D-16)', function () {
	this.timeout(20000)

	let harness: RedeemHarness

	afterEach(async () => {
		harvestLines(harness)
		await closeRedeemServices()
	})

	it('leaves no payload anywhere under the store directory once the response arrives', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		await stage(dataDir, { lookupId, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)

		// The liveness control: without this, the case could pass because the
		// blob was never written rather than because it was erased.
		expect(await exists(ciphertextPath(dataDir, lookupId)), 'the payload must exist before the request').to.equal(true)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.json?.['status']).to.equal('ok')

		// Asserted against the store DIRECTORY, never against a return value,
		// and immediately after the response resolves — no polling, no retry, no
		// timer. That is only possible because the handler awaits the erase
		// BEFORE it writes the response.
		expect(await exists(ciphertextPath(dataDir, lookupId))).to.equal(false)
		const remaining = await readdir(join(dataDir, 'ciphertext'))
		expect(remaining.filter((name) => name.startsWith(lookupId)), 'a temp-file residue must not pass as a clean result').to.deep.equal([])
	})

	it('keeps the payload-free record with used set and exactly three fields', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const expiresAt = canonical(60_000)
		await stage(dataDir, { lookupId, expiresAt })
		harness = await startRedeemService(dataDir)

		expect((await postRedeem(harness.origin, { lookupId })).json?.['status']).to.equal('ok')

		expect(await exists(recordPath(dataDir, lookupId))).to.equal(true)
		const record = JSON.parse(await readFile(recordPath(dataDir, lookupId), 'utf8')) as Record<string, unknown>
		expect(record['used']).to.equal(true)
		expect(Object.keys(record).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		expect(record['expiresAt']).to.equal(expiresAt)
	})
})

/* ------------------------------------------------------------------ */
/* The claim and the flag are each load-bearing                        */
/* ------------------------------------------------------------------ */

describe('redeem single-use: the claim and the flag are each independently load-bearing', function () {
	this.timeout(20000)

	let harness: RedeemHarness

	afterEach(async () => {
		harvestLines(harness)
		await closeRedeemServices()
	})

	it('answers used from the flag alone when the marker is lost', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		await stage(dataDir, { lookupId, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)

		expect((await postRedeem(harness.origin, { lookupId })).json?.['status']).to.equal('ok')
		await unlink(markerPath(dataDir, lookupId))

		const second = await postRedeem(harness.origin, { lookupId })
		expect(second.status).to.equal(200)
		expect(second.json).to.deep.equal({ status: 'used' })
		expect(second.json).to.not.have.property('sealed')
	})

	it('answers used from the marker alone when the flag is lost', async () => {
		// Models a mark that failed AFTER the payload was erased — the exact
		// residual the handler's step 9 documents. The correct answer survives,
		// which is why that failure is not swallowed.
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const expiresAt = canonical(60_000)
		await stage(dataDir, { lookupId, expiresAt })
		harness = await startRedeemService(dataDir)

		expect((await postRedeem(harness.origin, { lookupId })).json?.['status']).to.equal('ok')
		const stores = await createRendezvousStores(dataDir)
		await stores.putRecord({ lookupId, expiresAt, used: false })
		expect(await exists(markerPath(dataDir, lookupId))).to.equal(true)

		const second = await postRedeem(harness.origin, { lookupId })
		expect(second.status).to.equal(200)
		expect(second.json).to.deep.equal({ status: 'used' })
		expect(second.json).to.not.have.property('sealed')
	})

	it('answers unknown without throwing when both the marker and the flag are lost', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const expiresAt = canonical(60_000)
		await stage(dataDir, { lookupId, expiresAt })
		harness = await startRedeemService(dataDir)

		expect((await postRedeem(harness.origin, { lookupId })).json?.['status']).to.equal('ok')
		await unlink(markerPath(dataDir, lookupId))
		const stores = await createRendezvousStores(dataDir)
		await stores.putRecord({ lookupId, expiresAt, used: false })

		const second = await postRedeem(harness.origin, { lookupId })
		expect(second.status).to.equal(200)
		expect(second.json).to.deep.equal({ status: 'unknown' })
		expect(outcomesOf(harness)).to.deep.equal(['ok', 'unknown'])
		expect(outcomesOf(harness)).to.not.include('error')
	})
})

/* ------------------------------------------------------------------ */
/* Absent is a refusal; corrupt is a fault                             */
/* ------------------------------------------------------------------ */

describe('redeem single-use: the revoke race answers a refusal, never a fault', function () {
	this.timeout(20000)

	let harness: RedeemHarness

	afterEach(async () => {
		harvestLines(harness)
		await closeRedeemServices()
	})

	it('answers unknown for a live record whose payload is gone, and burns the claim doing it', async () => {
		// The state a concurrent revoke leaves behind between the record read
		// and the payload read.
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		await stage(dataDir, { lookupId, expiresAt: canonical(60_000), withCiphertext: false })
		harness = await startRedeemService(dataDir)

		const first = await postRedeem(harness.origin, { lookupId })
		expect(first.status).to.equal(200)
		expect(first.json).to.deep.equal({ status: 'unknown' })
		expect(outcomesOf(harness)).to.deep.equal(['unknown'])
		expect(outcomesOf(harness), 'a missing blob is a refusal, not a 500').to.not.include('error')

		// At-most-once made visible: the claim burned and nothing was delivered.
		// A fresh mint is the operator's recovery; the retention sweep bounds how
		// long the stranded record rests.
		expect(await exists(markerPath(dataDir, lookupId))).to.equal(true)
		const second = await postRedeem(harness.origin, { lookupId })
		expect(second.status).to.equal(200)
		expect(second.json).to.deep.equal({ status: 'used' })
		expect(second.json).to.not.have.property('sealed')
	})

	it('answers 500 with the fixed body for a corrupt stored wrapper', async () => {
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const corrupt = 'not valid json {{{'
		await stage(dataDir, { lookupId, expiresAt: canonical(60_000), withCiphertext: false })
		const stores = await createRendezvousStores(dataDir)
		await stores.putCiphertext(lookupId, corrupt)
		harness = await startRedeemService(dataDir)

		const response = await postRedeem(harness.origin, { lookupId })
		expect(response.status).to.equal(500)
		expect(response.json).to.deep.equal({ error: 'internal error' })
		expect(response.json).to.not.have.property('message')
		expect(response.json).to.not.have.property('reason')
		expect(response.text).to.not.contain(lookupId)
		expect(response.text).to.not.contain(corrupt)
		expect(response.text).to.not.contain(dataDir)
		expect(outcomesOf(harness)).to.deep.equal(['error'])
	})
})

/* ------------------------------------------------------------------ */
/* Expiry is a raw string comparison                                   */
/* ------------------------------------------------------------------ */

describe('redeem single-use: expiry is a raw string comparison', function () {
	this.timeout(20000)

	let harness: RedeemHarness

	afterEach(async () => {
		harvestLines(harness)
		await closeRedeemServices()
	})

	it('refuses one second in the past and serves one minute in the future', async () => {
		const dataDir = await createDataDir()
		const past = freshLookupId()
		const future = freshLookupId()
		await stage(dataDir, { lookupId: past, expiresAt: canonical(-1000) })
		await stage(dataDir, { lookupId: future, expiresAt: canonical(60_000) })
		harness = await startRedeemService(dataDir)

		expect((await postRedeem(harness.origin, { lookupId: past })).json).to.deep.equal({ status: 'expired' })
		expect((await postRedeem(harness.origin, { lookupId: future })).json?.['status']).to.equal('ok')
	})

	it('rejects a Z-suffixed stored expiry rather than silently stripping it', async () => {
		// Written directly, bypassing `putRecord`, which validates on write —
		// this case models a corrupt or hostile store. A 20-character
		// `Z`-suffixed value would be far in the future if it were parsed as a
		// date; the canonical NORMALISER would have stripped the `Z` and made
		// the comparison silently wrong, which is exactly why the strict guard
		// is used instead.
		const dataDir = await createDataDir()
		const lookupId = freshLookupId()
		const expiresAt = canonical(60_000)
		await stage(dataDir, { lookupId, expiresAt })
		await mkdir(join(dataDir, 'records'), { recursive: true })
		await writeFile(
			recordPath(dataDir, lookupId),
			JSON.stringify({ lookupId, expiresAt: `${expiresAt}Z`, used: false }),
			'utf8'
		)
		harness = await startRedeemService(dataDir)

		const rejected = await postRedeem(harness.origin, { lookupId })
		expect(rejected.status).to.equal(500)
		expect(rejected.json).to.deep.equal({ error: 'internal error' })
		expect(outcomesOf(harness)).to.deep.equal(['error'])
		// The fault happened before the claim, so nothing was burned by it.
		expect(await exists(markerPath(dataDir, lookupId))).to.equal(false)

		// Positive control: the same record with the Z removed is served.
		await writeFile(
			recordPath(dataDir, lookupId),
			JSON.stringify({ lookupId, expiresAt, used: false }),
			'utf8'
		)
		const accepted = await postRedeem(harness.origin, { lookupId })
		expect(accepted.status).to.equal(200)
		expect(accepted.json?.['status']).to.equal('ok')
	})
})
