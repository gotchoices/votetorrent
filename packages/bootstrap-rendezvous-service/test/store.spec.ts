import { expect } from 'chai'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	assertNoNetworkHandleGrowth,
	captureNetworkHandleCensus,
	createRendezvousStores,
	type RendezvousRecord,
	type RendezvousStores
} from '../src/store.js'

/**
 * store.spec.ts — the D-10 serialized-bytes gate, the store round-trips, the
 * path-traversal refusals, and the D-21 construction census.
 *
 * The D-10 test reads the RAW FILE, not the returned object. A test that only
 * checks the three expected fields on the way back out cannot detect a fourth
 * field on disk, which is where the disclosure would actually live.
 */

/** A real 43-char base64url id, built the way the KDF builds it. */
function makeLookupId (seed: number): string {
	const bytes = new Uint8Array(32)
	for (let i = 0; i < 32; i++) bytes[i] = (seed * 37 + i * 11) & 0xff
	return Buffer.from(bytes).toString('base64url')
}

/** 19 characters, no trailing `Z`. */
const EXPIRES_AT = '2026-08-29T13:45:00'

async function exists (path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

function messageOfThrow (fn: () => void): string {
	try {
		fn()
	} catch (err) {
		return (err as Error).message
	}
	throw new Error('expected the call to throw, but it returned normally')
}

async function messageOfReject (fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn()
	} catch (err) {
		return (err as Error).message
	}
	throw new Error('expected the call to reject, but it resolved')
}

describe('store round-trips', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-store-'))
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	it('putRecord then getRecord round-trips exactly the three fields', async () => {
		const lookupId = makeLookupId(1)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		const got = await stores.getRecord(lookupId)
		expect(got).to.deep.equal({ lookupId, expiresAt: EXPIRES_AT, used: false })
	})

	it('getRecord returns undefined for an unknown lookupId', async () => {
		expect(await stores.getRecord(makeLookupId(2))).to.equal(undefined)
	})

	it('markRecordUsed flips used and leaves the other two byte-identical', async () => {
		const lookupId = makeLookupId(3)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		const path = join(dataDir, 'records', `${lookupId}.json`)
		const before = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

		await stores.markRecordUsed(lookupId)

		const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
		expect(after['used']).to.equal(true)
		expect(after['lookupId']).to.equal(before['lookupId'])
		expect(after['expiresAt']).to.equal(before['expiresAt'])
		expect(Object.keys(after).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		expect(await stores.getRecord(lookupId)).to.deep.equal({ lookupId, expiresAt: EXPIRES_AT, used: true })
	})

	it('markRecordUsed rejects, naming only the method, when the record is absent', async () => {
		const message = await messageOfReject(async () => stores.markRecordUsed(makeLookupId(4)))
		expect(message).to.include('markRecordUsed')
		expect(message).to.include('no record')
	})

	it('deleteRecord removes the record and is a no-op when it is already gone', async () => {
		const lookupId = makeLookupId(5)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		await stores.deleteRecord(lookupId)
		expect(await stores.getRecord(lookupId)).to.equal(undefined)
		await stores.deleteRecord(lookupId) // must not reject
	})

	it('listRecordIds returns [] on a fresh dataDir', async () => {
		expect(await stores.listRecordIds()).to.deep.equal([])
	})

	it('listRecordIds returns every stored lookupId and nothing else', async () => {
		const ids = [makeLookupId(6), makeLookupId(7), makeLookupId(8)]
		for (const lookupId of ids) {
			await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		}
		// ciphertext lives under a different basePath, so it must not appear here
		await stores.putCiphertext(makeLookupId(9), 'sealed-blob')
		expect((await stores.listRecordIds()).sort()).to.deep.equal(ids.slice().sort())
	})
})

describe('store D-10 payload-free record', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-d10-'))
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	const EXTRAS = ['authorityId', 'networkSid', 'snapshotJson', 'ciphertext'] as const

	it('persists exactly lookupId, expiresAt and used even when handed four extra properties', async () => {
		const lookupId = makeLookupId(11)
		const smuggled = {
			lookupId,
			expiresAt: EXPIRES_AT,
			used: false,
			authorityId: 'AUTHORITY-SHOULD-NOT-BE-STORED',
			networkSid: 'NETWORK-SHOULD-NOT-BE-STORED',
			snapshotJson: '{"roll":"SHOULD-NOT-BE-STORED"}',
			ciphertext: 'CIPHERTEXT-SHOULD-NOT-BE-STORED'
		} as unknown as RendezvousRecord

		await stores.putRecord(smuggled)

		const raw = await readFile(join(dataDir, 'records', `${lookupId}.json`), 'utf8')
		expect(Object.keys(JSON.parse(raw) as object).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		// Assert on the RAW STRING too: a key-set check alone would not catch a
		// value smuggled into one of the three permitted fields' bytes.
		for (const extra of EXTRAS) {
			expect(raw).to.not.include(extra)
			expect(raw).to.not.include('SHOULD-NOT-BE-STORED')
		}
	})

	it('keeps the serialized key set at exactly three after markRecordUsed', async () => {
		const lookupId = makeLookupId(12)
		await stores.putRecord({
			lookupId,
			expiresAt: EXPIRES_AT,
			used: false,
			authorityId: 'nope'
		} as unknown as RendezvousRecord)
		await stores.markRecordUsed(lookupId)
		const raw = await readFile(join(dataDir, 'records', `${lookupId}.json`), 'utf8')
		expect(Object.keys(JSON.parse(raw) as object).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
		expect(raw).to.not.include('authorityId')
	})

	it('does not smuggle a fourth field back out of a hostile on-disk record', async () => {
		const lookupId = makeLookupId(13)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		// Simulate an older or hostile writer that wrote a fourth field directly.
		const path = join(dataDir, 'records', `${lookupId}.json`)
		const { writeFile } = await import('node:fs/promises')
		await writeFile(path, JSON.stringify({ lookupId, expiresAt: EXPIRES_AT, used: false, authorityId: 'leak' }), 'utf8')
		const got = await stores.getRecord(lookupId)
		expect(Object.keys(got as object).sort()).to.deep.equal(['expiresAt', 'lookupId', 'used'])
	})
})

describe('store expiresAt canonical-datetime validation', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-dt-'))
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	it('accepts a 19-character no-Z expiresAt (positive control)', async () => {
		const lookupId = makeLookupId(21)
		expect(EXPIRES_AT).to.have.lengthOf(19)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		expect((await stores.getRecord(lookupId))?.expiresAt).to.equal(EXPIRES_AT)
	})

	it('rejects a Z-suffixed expiresAt, naming the canonical-datetime violation', async () => {
		const lookupId = makeLookupId(22)
		const message = await messageOfReject(async () =>
			stores.putRecord({ lookupId, expiresAt: `${EXPIRES_AT}Z`, used: false })
		)
		expect(message).to.include('putRecord expiresAt')
		expect(message).to.include('19-character canonical datetime with no Z suffix')
		// and nothing was written
		expect(await exists(join(dataDir, 'records', `${lookupId}.json`))).to.equal(false)
	})

	it('rejects a millisecond-bearing expiresAt', async () => {
		const message = await messageOfReject(async () =>
			stores.putRecord({ lookupId: makeLookupId(23), expiresAt: '2026-08-29T13:45:00.000', used: false })
		)
		expect(message).to.include('19-character canonical datetime with no Z suffix')
	})
})

describe('store ciphertext is opaque and separately erasable', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-ct-'))
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	it('round-trips an opaque string byte-for-byte', async () => {
		const lookupId = makeLookupId(31)
		const sealed = '{"v":1,"n":"3q2-7w","c":"not-parseable-as-an-envelope","x":"\\u00e9"}'
		await stores.putCiphertext(lookupId, sealed)
		expect(await stores.getCiphertext(lookupId)).to.equal(sealed)
	})

	it('getCiphertext returns undefined for an unknown lookupId', async () => {
		expect(await stores.getCiphertext(makeLookupId(32))).to.equal(undefined)
	})

	it('deleteCiphertext on an unknown lookupId resolves without error', async () => {
		await stores.deleteCiphertext(makeLookupId(33))
	})

	it('records and ciphertext land under different directories', async () => {
		const lookupId = makeLookupId(34)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: false })
		await stores.putCiphertext(lookupId, 'sealed-blob')
		const recordPath = join(dataDir, 'records', `${lookupId}.json`)
		const ciphertextPath = join(dataDir, 'ciphertext', `${lookupId}.json`)
		expect(recordPath).to.not.equal(ciphertextPath)
		expect(await exists(recordPath)).to.equal(true)
		expect(await exists(ciphertextPath)).to.equal(true)
		expect(await readFile(recordPath, 'utf8')).to.not.equal(await readFile(ciphertextPath, 'utf8'))
	})

	it('deleteCiphertext leaves the record intact (ciphertext early, record later)', async () => {
		const lookupId = makeLookupId(35)
		await stores.putRecord({ lookupId, expiresAt: EXPIRES_AT, used: true })
		await stores.putCiphertext(lookupId, 'sealed-blob')
		await stores.deleteCiphertext(lookupId)
		expect(await stores.getCiphertext(lookupId)).to.equal(undefined)
		expect(await stores.getRecord(lookupId)).to.deep.equal({ lookupId, expiresAt: EXPIRES_AT, used: true })
	})

	it('exposes claimsDir under the dataDir and creates it', async () => {
		expect(stores.dataDir).to.equal(dataDir)
		expect(stores.claimsDir).to.equal(join(dataDir, 'claims'))
		expect(await exists(stores.claimsDir)).to.equal(true)
	})
})

describe('store path-traversal refusals', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-guard-'))
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	const BAD: Array<[string, string, RegExp]> = [
		['..', '..', /path-traversal segment/],
		['a traversal path', '../../etc/passwd', /path-traversal segment/],
		['a wrong-length id', 'abc', /must match/],
		['a wrong-charset id', `${makeLookupId(41).slice(0, 42)}/`, /must match/]
	]

	for (const [title, bad, reason] of BAD) {
		it(`putRecord rejects ${title} before any filesystem call`, async () => {
			const message = await messageOfReject(async () =>
				stores.putRecord({ lookupId: bad, expiresAt: EXPIRES_AT, used: false })
			)
			expect(message).to.include('putRecord lookupId')
			expect(message).to.match(reason)
		})

		it(`getRecord rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.getRecord(bad))
			expect(message).to.include('getRecord lookupId')
			expect(message).to.match(reason)
		})

		it(`markRecordUsed rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.markRecordUsed(bad))
			expect(message).to.include('markRecordUsed lookupId')
			expect(message).to.match(reason)
		})

		it(`deleteRecord rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.deleteRecord(bad))
			expect(message).to.include('deleteRecord lookupId')
			expect(message).to.match(reason)
		})

		it(`putCiphertext rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.putCiphertext(bad, 'sealed'))
			expect(message).to.include('putCiphertext lookupId')
			expect(message).to.match(reason)
		})

		it(`getCiphertext rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.getCiphertext(bad))
			expect(message).to.include('getCiphertext lookupId')
			expect(message).to.match(reason)
		})

		it(`deleteCiphertext rejects ${title}`, async () => {
			const message = await messageOfReject(async () => stores.deleteCiphertext(bad))
			expect(message).to.include('deleteCiphertext lookupId')
			expect(message).to.match(reason)
		})
	}

	it('nothing escaped the dataDir — the refusals left no stray files (positive control follows)', async () => {
		// Positive control: the same operations on a well-formed id do work, so the
		// refusals above are the guard firing, not the store being broken.
		const good = makeLookupId(42)
		await stores.putRecord({ lookupId: good, expiresAt: EXPIRES_AT, used: false })
		await stores.putCiphertext(good, 'sealed')
		expect(await exists(join(dataDir, 'records', `${good}.json`))).to.equal(true)
		expect(await exists(join(dataDir, 'ciphertext', `${good}.json`))).to.equal(true)
		expect(await stores.listRecordIds()).to.deep.equal([good])
	})
})

describe('store D-21 construction adds zero network handles', () => {
	it('createRendezvousStores leaves the network-handle census unchanged', async () => {
		const dataDir = await mkdtemp(join(tmpdir(), 'brs-d21-'))
		try {
			const before = captureNetworkHandleCensus()
			const stores = await createRendezvousStores(dataDir)
			const after = captureNetworkHandleCensus()
			expect(after).to.deep.equal(before)
			// and the store's own internal assertion agrees
			expect(() => { assertNoNetworkHandleGrowth(before, 'test') }).to.not.throw()
			// a real construction, not a no-op
			expect(stores.claimsDir).to.equal(join(dataDir, 'claims'))
		} finally {
			await rm(dataDir, { recursive: true, force: true })
		}
	})

	it('detects a REAL network handle — the instrument is not blind (negative control)', async () => {
		// Without this, the zero-growth assertion above could pass vacuously: a
		// census that can never see anything would report no growth forever. Open a
		// genuine TCP listener and prove the same helper fires on it, naming the
		// handle kind and nothing else (no address, no port).
		const { createServer } = await import('node:net')
		const before = captureNetworkHandleCensus()
		const server = createServer()
		await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
		try {
			const after = captureNetworkHandleCensus()
			expect(after.length).to.be.greaterThan(before.length)
			const message = messageOfThrow(() => { assertNoNetworkHandleGrowth(before, 'synthetic listener') })
			expect(message).to.include('synthetic listener')
			expect(message).to.include('added network handles')
			expect(message).to.include('TCPServerWrap')
			expect(message).to.not.include('127.0.0.1')
			expect(message).to.not.include(String((server.address() as { port: number }).port))
		} finally {
			await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
		}
	})

	it('creating the stores while a listener is already open still reports zero growth', async () => {
		// Growth, not an absolute count, is the comparison: a caller may already own
		// an HTTP listener and that must not be blamed on the store.
		const { createServer } = await import('node:net')
		const server = createServer()
		await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
		const dataDir = await mkdtemp(join(tmpdir(), 'brs-d21b-'))
		try {
			const before = captureNetworkHandleCensus()
			expect(before).to.include('TCPServerWrap')
			await createRendezvousStores(dataDir)
			expect(captureNetworkHandleCensus()).to.deep.equal(before)
		} finally {
			await rm(dataDir, { recursive: true, force: true })
			await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
		}
	})
})
