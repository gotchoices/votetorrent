import { expect } from 'chai'
import { mkdtemp, rm, readdir, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKVStore } from '@optimystic/db-p2p-storage-fs'
import {
	LOOKUP_ID_PATTERN,
	assertSafeLookupId,
	claimSingleUse,
	deleteClaimMarker
} from '../src/claim.js'

/**
 * claim.spec.ts — the D-20 concurrency proof and the negative control that
 * explains why `link(2)` is required rather than merely preferred.
 */

/** A real 43-char base64url id, built the way the KDF builds it, not typed by hand. */
function makeLookupId (seed: number): string {
	const bytes = new Uint8Array(32)
	for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7) & 0xff
	return Buffer.from(bytes).toString('base64url')
}

describe('claim', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'brs-claim-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('yields exactly one winner across eight concurrent claims on one lookupId', async () => {
		const lookupId = makeLookupId(1)
		const results = await Promise.all([...Array(8)].map(async () => claimSingleUse(dir, lookupId)))
		expect(results).to.have.lengthOf(8)
		expect(results.filter(Boolean).length).to.equal(1)
		expect(results.filter((r) => r === false).length).to.equal(7)
	})

	it('resolves false on a second sequential claim of an already-claimed lookupId', async () => {
		const lookupId = makeLookupId(2)
		expect(await claimSingleUse(dir, lookupId)).to.equal(true)
		expect(await claimSingleUse(dir, lookupId)).to.equal(false)
	})

	it('writes a marker whose EXISTENCE is the fact, carrying only the lookupId', async () => {
		const lookupId = makeLookupId(3)
		await claimSingleUse(dir, lookupId)
		const raw = await readFile(join(dir, `${lookupId}.marker`), 'utf8')
		expect(Object.keys(JSON.parse(raw)).sort()).to.deep.equal(['lookupId'])
	})

	it('leaves no .tmp residue after a successful claim', async () => {
		const lookupId = makeLookupId(4)
		await claimSingleUse(dir, lookupId)
		const entries = await readdir(dir)
		expect(entries.filter((e) => e.endsWith('.tmp'))).to.deep.equal([])
	})

	it('leaves no .tmp residue after an already-claimed outcome', async () => {
		const lookupId = makeLookupId(5)
		await claimSingleUse(dir, lookupId)
		await claimSingleUse(dir, lookupId)
		const entries = await readdir(dir)
		expect(entries.filter((e) => e.endsWith('.tmp'))).to.deep.equal([])
	})

	it('leaves no .tmp residue after eight concurrent claims', async () => {
		const lookupId = makeLookupId(6)
		await Promise.all([...Array(8)].map(async () => claimSingleUse(dir, lookupId)))
		const entries = await readdir(dir)
		expect(entries.filter((e) => e.endsWith('.tmp'))).to.deep.equal([])
	})

	it('rethrows a non-EEXIST error and still leaves no .tmp residue', async function () {
		const lookupId = makeLookupId(7)
		// Force a genuine non-EEXIST failure: make `claimsDir` unwritable so the
		// temp write itself fails with EACCES. The `finally` must then swallow
		// the ENOENT from unlinking a temp file that was never created, and the
		// original error must propagate unchanged — `claimSingleUse` converts
		// ONLY EEXIST into `false`.
		await chmod(dir, 0o555)
		let threw: unknown
		try {
			await claimSingleUse(dir, lookupId)
		} catch (err) {
			threw = err
		} finally {
			await chmod(dir, 0o755)
		}
		if (threw === undefined) {
			// Running as root defeats the permission bits; nothing to assert.
			this.skip()
			return
		}
		expect((threw as NodeJS.ErrnoException).code).to.not.equal('EEXIST')
		const entries = await readdir(dir)
		expect(entries.filter((e) => e.endsWith('.tmp'))).to.deep.equal([])
	})

	it('returns false rather than throwing when the final path already exists', async () => {
		const lookupId = makeLookupId(70)
		await claimSingleUse(dir, lookupId)
		expect(await claimSingleUse(dir, lookupId)).to.equal(false)
		expect((await readdir(dir)).filter((e) => e.endsWith('.tmp'))).to.deep.equal([])
	})

	it('deleteClaimMarker removes the marker and is a no-op when it is absent', async () => {
		const lookupId = makeLookupId(8)
		await claimSingleUse(dir, lookupId)
		await deleteClaimMarker(dir, lookupId)
		expect((await readdir(dir)).filter((e) => e.endsWith('.marker'))).to.deep.equal([])
		await deleteClaimMarker(dir, lookupId) // must not throw
		// and the lookupId is claimable again once the marker is gone
		expect(await claimSingleUse(dir, lookupId)).to.equal(true)
	})
})

/** Captures the thrown message so BOTH the label and the reason fragment can be
 * asserted. Chai's `.and.to.throw()` rebinds the subject to the Error object,
 * so chaining two `.throw()` matchers silently asserts the wrong thing. */
function messageOfThrow (fn: () => void): string {
	try {
		fn()
	} catch (err) {
		return (err as Error).message
	}
	throw new Error('expected the call to throw, but it returned normally')
}

describe('claim assertSafeLookupId', () => {
	const positive = makeLookupId(99)

	it('accepts a real 43-char base64url lookupId (positive control)', () => {
		expect(positive).to.have.lengthOf(43)
		expect(LOOKUP_ID_PATTERN.test(positive)).to.equal(true)
		expect(() => assertSafeLookupId(positive, 'lookupId')).to.not.throw()
	})

	it('the positive control is usable as a claim key', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'brs-claim-pos-'))
		try {
			expect(await claimSingleUse(dir, positive)).to.equal(true)
			expect(await readdir(dir)).to.deep.equal([`${positive}.marker`])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	const traversalCases: Array<[string, string]> = [
		['..', '..'],
		['a/../../etc/passwd', 'a/../../etc/passwd']
	]

	for (const [title, value] of traversalCases) {
		it(`rejects ${title} naming the traversal reason`, () => {
			const message = messageOfThrow(() => assertSafeLookupId(value, 'redeem lookupId'))
			expect(message).to.include('redeem lookupId')
			expect(message).to.include("may not be '.', '..', or contain a '..' path-traversal segment")
			expect(message).to.include(JSON.stringify(value))
		})
	}

	it("rejects '.' naming the traversal reason", () => {
		const message = messageOfThrow(() => assertSafeLookupId('.', 'redeem lookupId'))
		expect(message).to.include('redeem lookupId')
		expect(message).to.include("may not be '.', '..', or contain a '..' path-traversal segment")
	})

	const patternCases: Array<[string, string]> = [
		['a 42-char base64url string', makeLookupId(11).slice(0, 42)],
		['a 44-char base64url string', `${makeLookupId(12)}A`],
		['the empty string', ''],
		['a 43-char string containing +', `${makeLookupId(13).slice(0, 42)}+`],
		['a 43-char string containing /', `${makeLookupId(14).slice(0, 42)}/`]
	]

	for (const [title, value] of patternCases) {
		it(`rejects ${title} naming the pattern`, () => {
			expect(value === '' || value.length === 42 || value.length === 43 || value.length === 44).to.equal(true)
			const message = messageOfThrow(() => assertSafeLookupId(value, 'upload lookupId'))
			expect(message).to.include('upload lookupId')
			expect(message).to.include('must match /^[A-Za-z0-9_-]{43}$/')
			expect(message).to.include(JSON.stringify(value))
		})
	}

	it('refuses a malformed lookupId before any filesystem call reaches a path join', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'brs-claim-neg-'))
		try {
			await rm(dir, { recursive: true, force: true }) // the dir does not exist
			let threw: unknown
			try {
				await claimSingleUse(dir, '..')
			} catch (err) {
				threw = err
			}
			expect((threw as Error).message).to.match(/path-traversal segment/)
			// mkdir was never reached, so the directory was not created
			let existed = true
			try {
				await readdir(dir)
			} catch {
				existed = false
			}
			expect(existed).to.equal(false)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('claim D-20 negative control: FileKVStore.set cannot exclude', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'brs-kv-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('eight concurrent set() calls all succeed and leave exactly one of the eight values', async () => {
		// THIS is the reason `link(2)` is required. `FileKVStore.set` publishes
		// with `atomicWriteFile`, which is temp -> fsync -> rename -> dir-fsync.
		// The rename is atomic per-reader but LAST-WRITER-WINS: it silently
		// overwrites. No writer learns that it lost, so `set()` can never answer
		// "was I first?" and can never be a single-use claim.
		const store = new FileKVStore(dir)
		const key = makeLookupId(21)
		const values = [...Array(8)].map((_v, i) => `writer-${i}`)
		const settled = await Promise.allSettled(values.map(async (v) => store.set(key, v)))
		expect(settled.every((s) => s.status === 'fulfilled')).to.equal(true)
		const survivor = await store.get(key)
		expect(values).to.include(survivor)
	})
})
