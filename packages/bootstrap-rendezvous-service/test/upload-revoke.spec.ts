import { expect } from 'chai'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { claimSingleUse } from '../src/claim.js'
import {
	authHeader,
	canonicalExpiry,
	ciphertextPath,
	exists,
	freshLookupId,
	markerPath,
	postUpload,
	recordPath,
	startUploadService,
	validBody,
	type UploadHarness
} from './upload-gates.spec.js'

/**
 * upload-revoke.spec.ts — the D-12 ordering proof, the D-16 orphan-blob
 * compensation proof, and the D-10 serialized-bytes assertion.
 *
 * The harness, the fixture builders and the path helpers are imported from
 * `upload-gates.spec.ts` rather than duplicated: two copies of a fixture
 * builder drift, and a drifted builder is how a gate quietly stops testing what
 * it names. No `test/helpers/upload-harness.ts` module was created — the
 * exports on the gates spec are the single copy.
 *
 * Every failure below is forced by making the STORE's publish step impossible —
 * a directory planted at exactly the path a temp-then-rename write must land on
 * — rather than by stubbing the store. A stub would prove the handler's control
 * flow; a planted directory proves the real store's real error travels the real
 * path.
 */

/** Every `.json` entry directly under one of the two store directories. */
async function storedJsonNames (dataDir: string, kind: 'records' | 'ciphertext'): Promise<string[]> {
	try {
		return (await readdir(join(dataDir, kind))).filter((name) => name.endsWith('.json')).sort()
	} catch {
		return []
	}
}

/** Plants a directory where a temp-then-rename publish must land, so the write
 * fails deterministically and the failure comes from the real store. */
async function blockPublishAt (path: string): Promise<void> {
	await mkdir(path, { recursive: true })
}

describe('upload revoke: a second mint revokes the first (D-12)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('stores a code, and a real redemption claim leaves a marker beside it', async () => {
		const codeA = validBody()
		const accepted = await postUpload(harness.origin, codeA, authHeader())
		expect(accepted.status).to.equal(200)
		expect(await exists(recordPath(harness.dataDir, codeA.lookupId))).to.equal(true)
		expect(await exists(ciphertextPath(harness.dataDir, codeA.lookupId))).to.equal(true)

		// The real post-redemption state, produced by the real claim primitive.
		expect(await claimSingleUse(harness.claimsDir, codeA.lookupId)).to.equal(true)
		expect(await exists(markerPath(harness.claimsDir, codeA.lookupId))).to.equal(true)
	})

	it('erases the prior code entirely — record, ciphertext and claim marker — when a second mint revokes it', async () => {
		const codeA = validBody()
		expect((await postUpload(harness.origin, codeA, authHeader())).status).to.equal(200)
		await claimSingleUse(harness.claimsDir, codeA.lookupId)
		expect(await exists(markerPath(harness.claimsDir, codeA.lookupId))).to.equal(true)

		const codeB = { ...validBody(), revokeLookupId: codeA.lookupId }
		const response = await postUpload(harness.origin, codeB, authHeader())
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ ok: true })

		expect(await exists(recordPath(harness.dataDir, codeA.lookupId))).to.equal(false)
		expect(await exists(ciphertextPath(harness.dataDir, codeA.lookupId))).to.equal(false)
		expect(await exists(markerPath(harness.claimsDir, codeA.lookupId))).to.equal(false)

		expect(await exists(recordPath(harness.dataDir, codeB.lookupId))).to.equal(true)
		expect(await exists(ciphertextPath(harness.dataDir, codeB.lookupId))).to.equal(true)
		expect(await storedJsonNames(harness.dataDir, 'records')).to.deep.equal([`${codeB.lookupId}.json`])
	})

	it('treats a revoke of an identifier that was never uploaded as a successful no-op', async () => {
		// The prior code may already have been redeemed or swept, so this must not
		// be an error.
		const neverUploaded = freshLookupId()
		const codeC = { ...validBody(), revokeLookupId: neverUploaded }

		const response = await postUpload(harness.origin, codeC, authHeader())
		expect(response.status).to.equal(200)
		expect(response.json).to.deep.equal({ ok: true })
		expect(await exists(recordPath(harness.dataDir, codeC.lookupId))).to.equal(true)
		expect(await exists(ciphertextPath(harness.dataDir, codeC.lookupId))).to.equal(true)
	})
})

describe('upload revoke: the ordering is load-bearing, not incidental (D-12)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('applies the revoke even when the new write fails, leaving the prior code dead and no new code live', async () => {
		const codeA = validBody()
		expect((await postUpload(harness.origin, codeA, authHeader())).status).to.equal(200)
		await claimSingleUse(harness.claimsDir, codeA.lookupId)

		const codeB = { ...validBody(), revokeLookupId: codeA.lookupId }
		// Force the NEW write to fail deterministically.
		await blockPublishAt(ciphertextPath(harness.dataDir, codeB.lookupId))

		// The negative control, captured BEFORE the failing request: a test that
		// passed because A had never been written would be indistinguishable from
		// a test that passed because the revoke ran.
		const priorRecordExisted = await exists(recordPath(harness.dataDir, codeA.lookupId))
		const priorCiphertextExisted = await exists(ciphertextPath(harness.dataDir, codeA.lookupId))
		const priorMarkerExisted = await exists(markerPath(harness.claimsDir, codeA.lookupId))
		expect(priorRecordExisted, 'the prior code must have existed for this test to mean anything').to.equal(true)
		expect(priorCiphertextExisted).to.equal(true)
		expect(priorMarkerExisted).to.equal(true)

		const linesBefore = harness.lines.length
		const response = await postUpload(harness.origin, codeB, authHeader())

		// The fixed body server.ts sends: no message, no path, no reason.
		expect(response.status).to.equal(500)
		expect(response.json).to.deep.equal({ error: 'internal error' })
		expect(Object.keys(response.json as Record<string, unknown>)).to.deep.equal(['error'])
		expect(response.text).to.not.contain(harness.dataDir)

		// The three load-bearing post-conditions. Any two of them alone do not
		// distinguish revoke-before-write from revoke-after-write.
		expect(await exists(recordPath(harness.dataDir, codeA.lookupId))).to.equal(false)
		expect(await exists(ciphertextPath(harness.dataDir, codeA.lookupId))).to.equal(false)
		expect(await exists(markerPath(harness.claimsDir, codeA.lookupId))).to.equal(false)
		expect(await exists(recordPath(harness.dataDir, codeB.lookupId))).to.equal(false)
		// The chosen failure mode: the operator is left with no live code and the
		// officer mints again, which is strictly safer than a window in which two
		// codes are live.
		expect(await storedJsonNames(harness.dataDir, 'records')).to.deep.equal([])

		// The failure travelled through server.ts's catch rather than being
		// swallowed in the handler.
		const emitted = harness.lines.slice(linesBefore)
		expect(emitted).to.have.lengthOf(1)
		expect(emitted[0]).to.contain('outcome=error')
		expect(emitted[0]).to.contain('route=upload')
	})
})

describe('upload revoke: a failed record write leaves no orphan ciphertext (D-16)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('deletes the ciphertext it just wrote when the record write fails', async () => {
		// The liveness control: a spec that reported "gone" for a blob that was
		// never written could not tell a working compensation from a broken write.
		const healthy = validBody()
		expect((await postUpload(harness.origin, healthy, authHeader())).status).to.equal(200)
		expect(await exists(ciphertextPath(harness.dataDir, healthy.lookupId))).to.equal(true)

		const codeD = validBody()
		// Force ONLY the record write to fail; the ciphertext path is left healthy
		// so the blob really is written before the failure.
		await blockPublishAt(recordPath(harness.dataDir, codeD.lookupId))

		const response = await postUpload(harness.origin, codeD, authHeader())
		expect(response.status).to.equal(500)
		expect(response.json).to.deep.equal({ error: 'internal error' })

		// Asserted against the STORE DIRECTORY, never against a return value or a
		// response field: this is the invariant 52-10's record-based sweep is
		// structurally unable to check, because there is no ciphertext enumerator.
		expect(await exists(ciphertextPath(harness.dataDir, codeD.lookupId))).to.equal(false)
		const ciphertextEntries = await readdir(join(harness.dataDir, 'ciphertext'))
		const residue = ciphertextEntries.filter((name) => name.startsWith(codeD.lookupId))
		expect(residue, `a temp-file residue must not pass as a clean result: ${residue.join(', ')}`).to.deep.equal([])

		// The healthy code from the liveness control is untouched — the
		// compensation deleted exactly one blob, the one it had just written.
		expect(await exists(ciphertextPath(harness.dataDir, healthy.lookupId))).to.equal(true)
	})
})

describe('upload revoke: the stored record is payload-free (D-10)', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('persists exactly lookupId, expiresAt and used, with no payload substring anywhere in the bytes', async () => {
		const body = { ...validBody(), revokeLookupId: freshLookupId() }
		expect((await postUpload(harness.origin, body, authHeader())).status).to.equal(200)

		const raw = await readFile(recordPath(harness.dataDir, body.lookupId), 'utf8')
		const parsed = JSON.parse(raw) as Record<string, unknown>
		expect(Object.keys(parsed).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		expect(parsed.used).to.equal(false)
		expect(parsed.expiresAt).to.equal(body.expiresAt)
		expect(parsed.lookupId).to.equal(body.lookupId)

		// A test that only checked the three expected fields could not detect a
		// fourth, so the raw text is scanned as well.
		for (const forbidden of ['ciphertext', 'nonce', 'sealed', 'revokeLookupId', 'authorityId', 'snapshot']) {
			expect(raw, `the record must not mention ${forbidden}`).to.not.contain(forbidden)
		}
		expect(raw).to.not.contain(body.sealed.ciphertext)
		expect(raw).to.not.contain(body.sealed.nonce)
		expect(raw).to.not.contain(body.revokeLookupId)
	})

	it('stores the wrapper as an explicit three-key projection, whatever order it arrived in', async () => {
		const body = validBody()
		expect((await postUpload(harness.origin, body, authHeader())).status).to.equal(200)

		const raw = await readFile(ciphertextPath(harness.dataDir, body.lookupId), 'utf8')
		const parsed = JSON.parse(raw) as Record<string, unknown>
		expect(Object.keys(parsed).sort()).to.deep.equal(['ciphertext', 'nonce', 'v'])
		expect(parsed.v).to.equal(body.sealed.v)
		expect(parsed.nonce).to.equal(body.sealed.nonce)
		expect(parsed.ciphertext).to.equal(body.sealed.ciphertext)

		// A wrapper whose keys arrive in a different order still lands as the same
		// three keys: the projection is an explicit literal, not a spread.
		const reordered = validBody()
		const shuffled = {
			lookupId: reordered.lookupId,
			expiresAt: reordered.expiresAt,
			sealed: {
				ciphertext: reordered.sealed.ciphertext,
				v: reordered.sealed.v,
				nonce: reordered.sealed.nonce
			}
		}
		expect((await postUpload(harness.origin, shuffled, authHeader())).status).to.equal(200)
		const shuffledRaw = await readFile(ciphertextPath(harness.dataDir, reordered.lookupId), 'utf8')
		expect(Object.keys(JSON.parse(shuffledRaw) as Record<string, unknown>).sort()).to.deep.equal([
			'ciphertext',
			'nonce',
			'v'
		])
	})

	it('keeps the record and the ciphertext in separate files under separate directories', async () => {
		const body = validBody()
		expect((await postUpload(harness.origin, body, authHeader())).status).to.equal(200)

		const record = recordPath(harness.dataDir, body.lookupId)
		const ciphertext = ciphertextPath(harness.dataDir, body.lookupId)
		expect(record).to.not.equal(ciphertext)
		expect(record).to.contain(join(harness.dataDir, 'records'))
		expect(ciphertext).to.contain(join(harness.dataDir, 'ciphertext'))
		expect(await readFile(record, 'utf8')).to.not.equal(await readFile(ciphertext, 'utf8'))
	})
})

describe('upload revoke: a repeated upload is idempotent', () => {
	let harness: UploadHarness

	beforeEach(async () => {
		harness = await startUploadService()
	})

	afterEach(async () => {
		await harness.close()
	})

	it('accepts the identical body twice and leaves exactly one record behind', async () => {
		// The phone retries after a lost acknowledgement, and the fail-closed mint
		// flow strands the officer if a retry is rejected. A collision on a
		// distinct lookupId is not a consideration — that is 160 bits of entropy
		// per mint.
		const body = { ...validBody(), expiresAt: canonicalExpiry() }

		const first = await postUpload(harness.origin, body, authHeader())
		const second = await postUpload(harness.origin, body, authHeader())
		expect(first.status).to.equal(200)
		expect(second.status).to.equal(200)
		expect(first.json).to.deep.equal({ ok: true })
		expect(second.json).to.deep.equal({ ok: true })

		expect(await storedJsonNames(harness.dataDir, 'records')).to.deep.equal([`${body.lookupId}.json`])
		expect(await storedJsonNames(harness.dataDir, 'ciphertext')).to.deep.equal([`${body.lookupId}.json`])

		const parsed = JSON.parse(await readFile(recordPath(harness.dataDir, body.lookupId), 'utf8')) as Record<string, unknown>
		expect(Object.keys(parsed).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		expect(parsed.used).to.equal(false)
	})
})
