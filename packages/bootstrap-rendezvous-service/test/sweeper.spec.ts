import { expect } from 'chai'
import { mkdtemp, rm, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimSingleUse } from '../src/claim.js'
import type { SweepCounts, ServiceLogger, FatalEvent, LoggedRoute, LoggedOutcome } from '../src/logging.js'
import { createRendezvousStores, type RendezvousStores } from '../src/store.js'
import {
	canonicalMinusMinutes,
	sweepOnce,
	startSweeper,
	type SweeperHandle,
	type SweeperStore
} from '../src/sweeper.js'

/**
 * sweeper.spec.ts — the D-16 two-stage retention proof.
 *
 * **Nothing in this file waits on a wall clock, sleeps, or fakes a clock.**
 * Every lifecycle assertion drives `sweepOnce` directly with an injected
 * `nowCanonical` string, which is the entire reason that parameter exists. The
 * interval wiring is proven by *capturing the global scheduler* and invoking
 * the callback it was handed — not by letting a timer fire.
 *
 * The on-disk assertions are the load-bearing half. `SweepCounts` is three
 * integers, and three integers cannot distinguish "ciphertext dropped, record
 * kept" from "both dropped": only the filesystem can, so the central claim of
 * D-16 is asserted against the real temp `dataDir`.
 */

/** A real 43-character base64url id, the shape the KDF actually produces —
 * never a hand-typed approximation. */
function makeLookupId (seed: number): string {
	return Buffer.alloc(32, seed).toString('base64url')
}

/** The pinned instant every lifecycle test injects. With `GRACE = 60` the
 * grace horizon is exactly `'2026-08-27T11:00:00'`. */
const NOW = '2026-08-27T12:00:00'
const GRACE = 60
const GRACE_HORIZON = '2026-08-27T11:00:00'

/**
 * Shifts a canonical datetime by a signed number of minutes.
 *
 * Test-local on purpose: `canonicalMinusMinutes` refuses a negative `minutes`,
 * and the interval test needs a record in the *future* relative to a clock
 * reading it does not control. String surgery on a datetime is exactly the
 * class of bug this phase is avoiding, so this goes through a real date.
 */
function shiftCanonical (canonical: string, minutes: number): string {
	return new Date(new Date(`${canonical}Z`).getTime() + minutes * 60_000).toISOString().slice(0, 19)
}

/** Offsets, in minutes from the injected "now", for the seven lifecycle
 * records. Shared by the pinned-instant tests and the interval test so both
 * exercise one fixture. */
const OFFSETS = {
	A: 5, // live — still redeemable
	B: -5, // just expired, never redeemed
	C: -5, // just expired, already redeemed
	D: -90, // past grace, redeemed
	E: -90, // past grace, never redeemed
	F: 0, // exactly at expiry — the inclusive lower boundary
	G: -60 // exactly at the grace horizon — the inclusive upper boundary
} as const

type FixtureKey = keyof typeof OFFSETS

const IDS: Record<FixtureKey, string> = {
	A: makeLookupId(1),
	B: makeLookupId(2),
	C: makeLookupId(3),
	D: makeLookupId(4),
	E: makeLookupId(5),
	F: makeLookupId(6),
	G: makeLookupId(7)
}

/**
 * Seeds the seven-record lifecycle fixture through the REAL store API.
 *
 * Nothing here hand-writes a file: records go through `putRecord`, ciphertext
 * through `putCiphertext`, the used flag through `markRecordUsed`, and markers
 * through the real `claimSingleUse`. A fixture that writes bytes itself can
 * drift from the code under test without either one changing.
 */
async function seedLifecycleFixture (stores: RendezvousStores, now: string): Promise<Record<FixtureKey, string>> {
	const at = (key: FixtureKey): string => shiftCanonical(now, OFFSETS[key])

	// A — live, ciphertext present, never touched by the sweep.
	await stores.putRecord({ lookupId: IDS.A, expiresAt: at('A'), used: false })
	await stores.putCiphertext(IDS.A, 'sealed-A')

	// B — just expired, never redeemed: the stage-1-only case.
	await stores.putRecord({ lookupId: IDS.B, expiresAt: at('B'), used: false })
	await stores.putCiphertext(IDS.B, 'sealed-B')

	// C — just expired, already redeemed. `52-09` erased the ciphertext on
	// serve, so there is none here; the marker and the `used` flag survive.
	await stores.putRecord({ lookupId: IDS.C, expiresAt: at('C'), used: false })
	await stores.markRecordUsed(IDS.C)
	await claimSingleUse(stores.claimsDir, IDS.C)

	// D — past grace, redeemed: record and marker both go.
	await stores.putRecord({ lookupId: IDS.D, expiresAt: at('D'), used: false })
	await stores.markRecordUsed(IDS.D)
	await claimSingleUse(stores.claimsDir, IDS.D)

	// E — past grace and never redeemed: drained in ONE pass, ciphertext then
	// record.
	await stores.putRecord({ lookupId: IDS.E, expiresAt: at('E'), used: false })
	await stores.putCiphertext(IDS.E, 'sealed-E')

	// F — expiresAt exactly equal to now: the inclusive expiry boundary.
	await stores.putRecord({ lookupId: IDS.F, expiresAt: at('F'), used: false })
	await stores.putCiphertext(IDS.F, 'sealed-F')

	// G — expiresAt exactly equal to the grace horizon: the inclusive grace
	// boundary.
	await stores.putRecord({ lookupId: IDS.G, expiresAt: at('G'), used: false })

	return {
		A: at('A'), B: at('B'), C: at('C'), D: at('D'), E: at('E'), F: at('F'), G: at('G')
	}
}

async function exists (path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

const recordPath = (dataDir: string, id: string): string => join(dataDir, 'records', `${id}.json`)
const ciphertextPath = (dataDir: string, id: string): string => join(dataDir, 'ciphertext', `${id}.json`)

/** A counting logger stub. `sweep` resolves a promise created BEFORE the
 * invocation, which is what makes the interval test deterministic without any
 * delay at all. */
function makeLoggerStub (): {
	logger: ServiceLogger
	counts: { fatal: number, request: number, sweep: number }
	received: SweepCounts[]
	swept: Promise<void>
} {
	const counts = { fatal: 0, request: 0, sweep: 0 }
	const received: SweepCounts[] = []
	let resolveSwept: () => void = () => {}
	const swept = new Promise<void>((resolve) => { resolveSwept = resolve })
	const logger: ServiceLogger = {
		fatal (_event: FatalEvent, _message: string): void { counts.fatal++ },
		request (_route: LoggedRoute, _outcome: LoggedOutcome, _latencyMs: number): void { counts.request++ },
		sweep (c: SweepCounts): void {
			counts.sweep++
			received.push(c)
			resolveSwept()
		}
	}
	return { logger, counts, received, swept }
}

describe('sweeper', () => {
	let dataDir: string
	let stores: RendezvousStores

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'brs-sweep-'))
		// The REAL store, passed straight into `sweepOnce` with no cast. That is
		// what proves `SweeperStore` is a widening of `RendezvousStores` at
		// compile time — if the two shapes ever diverge, this file stops
		// compiling.
		stores = await createRendezvousStores(dataDir)
	})

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true })
	})

	describe('the two-stage retention sweep', () => {
		it('drops ciphertext at expiry and the record only past the grace window', async () => {
			const seeded = await seedLifecycleFixture(stores, NOW)

			// Pin the two boundary literals, so the inclusive-of-drop semantics
			// below are anchored to values this test can name.
			expect(seeded.F, 'F sits exactly at expiry').to.equal(NOW)
			expect(seeded.G, 'G sits exactly at the grace horizon').to.equal(GRACE_HORIZON)

			const counts = await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW })

			// B, E and F are the three ciphertext drops; D, E and G are the three
			// record drops; A, B, C and F are the four retained. Asserted as one
			// object so a compensating pair of errors cannot hide.
			expect(counts).to.deep.equal({ ciphertextDropped: 3, recordsDropped: 3, recordsRetained: 4 })

			// 1. THE CENTRAL CLAIM: for B the two stages are separately observable
			//    on disk — payload gone, payload-free record still there. No
			//    return value can assert this.
			expect(await exists(ciphertextPath(dataDir, IDS.B)), 'B ciphertext dropped at expiry').to.equal(false)
			expect(await exists(recordPath(dataDir, IDS.B)), 'B record survives its grace window').to.equal(true)

			// 2. A live code is still fully redeemable, bytes unchanged.
			expect(await readFile(ciphertextPath(dataDir, IDS.A), 'utf8')).to.equal('sealed-A')
			expect(await exists(recordPath(dataDir, IDS.A))).to.equal(true)

			// 3. Past the grace horizon nothing is left, and E proves the one-pass
			//    drain: ciphertext and record both gone in a single sweep.
			expect(await exists(recordPath(dataDir, IDS.D)), 'D record past grace').to.equal(false)
			expect(await exists(recordPath(dataDir, IDS.E)), 'E record past grace').to.equal(false)
			expect(await exists(recordPath(dataDir, IDS.G)), 'G record at the grace horizon').to.equal(false)
			expect(await exists(ciphertextPath(dataDir, IDS.E)), 'E drained in one pass').to.equal(false)

			// 4. A spent single use is NEVER re-armed: C's marker survives while
			//    its record does, and D's is retired with its record. Read the
			//    directory rather than guessing at the suffix.
			const claims = new Set(await readdir(stores.claimsDir))
			expect([...claims].some((n) => n.startsWith(IDS.C)), 'C marker survives inside the grace window').to.equal(true)
			expect([...claims].some((n) => n.startsWith(IDS.D)), 'D marker retired with its record').to.equal(false)

			// 5. The precision the grace window exists to preserve: C is still
			//    answerable as `used`, not as the generic `unknown`.
			const cRecord = JSON.parse(await readFile(recordPath(dataDir, IDS.C), 'utf8')) as { used: boolean }
			expect(cRecord.used, 'C is still precisely `used` during its grace window').to.equal(true)
		})

		it('is idempotent — a second identical sweep drops nothing and changes nothing', async () => {
			await seedLifecycleFixture(stores, NOW)
			await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW })

			const listing = async (): Promise<string[][]> => [
				(await readdir(join(dataDir, 'records'))).sort(),
				(await readdir(join(dataDir, 'ciphertext'))).sort(),
				(await readdir(stores.claimsDir)).sort()
			]
			const before = await listing()

			const second = await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW })
			expect(second).to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 4 })
			expect(await listing(), 'the three store directories are untouched by the second sweep').to.deep.equal(before)
		})

		it('resumes after a crash between the two stages without a phantom count', async () => {
			// A record past expiry but inside grace whose ciphertext is already
			// gone — exactly the state a crash between stage 1 and stage 2 leaves.
			const id = makeLookupId(11)
			await stores.putRecord({ lookupId: id, expiresAt: shiftCanonical(NOW, -5), used: false })
			await stores.putCiphertext(id, 'sealed')
			await stores.deleteCiphertext(id)

			const counts = await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW })
			expect(counts).to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 1 })
			expect(await exists(recordPath(dataDir, id))).to.equal(true)
		})

		it('rejects a nowCanonical that is not a canonical datetime, naming the field', async () => {
			// Positive control first: the same call with a valid value resolves.
			expect(await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW }))
				.to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 0 })

			let message = ''
			try {
				await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: `${NOW}Z` })
			} catch (err) {
				message = (err as Error).message
			}
			expect(message).to.contain('nowCanonical')
			expect(message).to.contain('no Z suffix')
		})
	})

	describe('hostile and unreadable ids off disk', () => {
		it('skips an unsafe id without touching its file and still sweeps the healthy records', async () => {
			// Two healthy records: one live, one past grace — the positive control
			// that the sweep did not simply abort.
			const live = makeLookupId(21)
			const doomed = makeLookupId(22)
			await stores.putRecord({ lookupId: live, expiresAt: shiftCanonical(NOW, 5), used: false })
			await stores.putRecord({ lookupId: doomed, expiresAt: shiftCanonical(NOW, -90), used: false })

			// Stray files that `listRecordIds` really does return: a wrong-shaped
			// name, and a NESTED one, which `list` yields as `evil/x` — an id
			// carrying a path separator.
			const strayFlat = join(dataDir, 'records', 'not-a-valid-lookup-id.json')
			await writeFile(strayFlat, '{}', 'utf8')
			await mkdir(join(dataDir, 'records', 'evil'), { recursive: true })
			const strayNested = join(dataDir, 'records', 'evil', 'x.json')
			await writeFile(strayNested, '{}', 'utf8')

			const counts = await sweepOnce({ store: stores, graceWindowMinutes: GRACE, nowCanonical: NOW })

			// Only the two healthy records are accounted for; a skipped id is
			// counted in NONE of the three fields.
			expect(counts).to.deep.equal({ ciphertextDropped: 0, recordsDropped: 1, recordsRetained: 1 })
			expect(await exists(strayFlat), 'an unparseable name is skipped, never deleted').to.equal(true)
			expect(await exists(strayNested), 'a nested name is skipped, never deleted').to.equal(true)
			expect(await exists(recordPath(dataDir, doomed)), 'the healthy expired record was still swept').to.equal(false)
			expect(await exists(recordPath(dataDir, live)), 'the healthy live record survives').to.equal(true)
		})

		it('guards an unsafe id BEFORE any store method receives it', async () => {
			// The previous test cannot prove ordering: the real store re-guards
			// every id inside `getRecord`, so a sweep with no guard of its own
			// still looks correct from the outside. This one uses an UNGUARDED
			// store, which is the only way to see whether the id reached it.
			const safe = makeLookupId(41)
			const received: string[] = []
			const store: SweeperStore = {
				claimsDir: join(dataDir, 'claims'),
				async listRecordIds () { return ['../../etc/passwd', 'evil/x', '.', safe] },
				async getRecord (lookupId: string) {
					received.push(lookupId)
					return { lookupId, expiresAt: shiftCanonical(NOW, 5), used: false }
				},
				async getCiphertext (lookupId: string) { received.push(lookupId); return undefined },
				async deleteCiphertext (lookupId: string) { received.push(lookupId) },
				async deleteRecord (lookupId: string) { received.push(lookupId) }
			}

			const counts = await sweepOnce({ store, graceWindowMinutes: GRACE, nowCanonical: NOW })
			expect(received, 'only the safe id ever reached the store').to.deep.equal([safe])
			expect(counts).to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 1 })
		})

		it('isolates a per-record store failure and keeps sweeping', async () => {
			const ids = [makeLookupId(31), makeLookupId(32), makeLookupId(33)]
			const seen: string[] = []
			const store: SweeperStore = {
				claimsDir: join(dataDir, 'claims'),
				async listRecordIds () { return ids },
				async getRecord (lookupId: string) {
					seen.push(lookupId)
					if (lookupId === ids[1]) throw new Error('transient EACCES')
					return { lookupId, expiresAt: shiftCanonical(NOW, 5), used: false }
				},
				async getCiphertext () { return undefined },
				async deleteCiphertext () { /* never reached */ },
				async deleteRecord () { /* never reached */ }
			}

			const counts = await sweepOnce({ store, graceWindowMinutes: GRACE, nowCanonical: NOW })
			expect(seen, 'the sweep continued past the failing record').to.deep.equal(ids)
			expect(counts).to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 2 })
			expect(counts.recordsDropped + counts.recordsRetained).to.be.at.most(ids.length)
		})

		it('does NOT isolate a listRecordIds failure — a broken store is loud', async () => {
			const base: SweeperStore = {
				claimsDir: join(dataDir, 'claims'),
				async listRecordIds () { return [] },
				async getRecord () { return undefined },
				async getCiphertext () { return undefined },
				async deleteCiphertext () { /* unused */ },
				async deleteRecord () { /* unused */ }
			}
			// Positive control: a resolving enumerator sweeps cleanly.
			expect(await sweepOnce({ store: base, graceWindowMinutes: GRACE, nowCanonical: NOW }))
				.to.deep.equal({ ciphertextDropped: 0, recordsDropped: 0, recordsRetained: 0 })

			const broken: SweeperStore = {
				...base,
				async listRecordIds (): Promise<string[]> { throw new Error('store enumeration is broken') }
			}
			let message = ''
			try {
				await sweepOnce({ store: broken, graceWindowMinutes: GRACE, nowCanonical: NOW })
			} catch (err) {
				message = (err as Error).message
			}
			expect(message).to.equal('store enumeration is broken')
		})
	})

	describe('canonicalMinusMinutes', () => {
		it('shifts a canonical datetime by whole minutes', () => {
			expect(canonicalMinusMinutes(NOW, 60, 'test')).to.equal(GRACE_HORIZON)
			expect(canonicalMinusMinutes(NOW, 0, 'test'), 'zero minutes is the identity').to.equal(NOW)
		})

		it('produces the same horizon under every host TZ', () => {
			// The guard against the local-time parse trap: a bare date-time form
			// with no offset parses as LOCAL time, so a horizon built without the
			// appended `Z` would shift by the host offset. A UTC-only CI machine
			// is blind to that without this test.
			const original = process.env.TZ
			try {
				const results: string[] = []
				for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
					process.env.TZ = zone
					results.push(canonicalMinusMinutes(NOW, 60, 'test'))
				}
				expect(results).to.deep.equal([GRACE_HORIZON, GRACE_HORIZON, GRACE_HORIZON])
			} finally {
				if (original === undefined) delete process.env.TZ
				else process.env.TZ = original
			}
		})

		it('rejects a Z-suffixed input, naming the argument', () => {
			expect(canonicalMinusMinutes(NOW, 1, 'positive-control')).to.be.a('string')
			expect(() => canonicalMinusMinutes(`${NOW}Z`, 60, 'graceHorizon'))
				.to.throw(/graceHorizon.*no Z suffix/)
		})

		it('rejects a non-19-character input, naming the argument', () => {
			expect(() => canonicalMinusMinutes('2026-08-27', 60, 'graceHorizon'))
				.to.throw(/graceHorizon.*canonical datetime/)
		})

		it('rejects a non-integer or negative minutes, naming the argument', () => {
			expect(() => canonicalMinusMinutes(NOW, 1.5, 'graceWindowMinutes'))
				.to.throw(/graceWindowMinutes.*1\.5/)
			expect(() => canonicalMinusMinutes(NOW, -1, 'graceWindowMinutes'))
				.to.throw(/graceWindowMinutes.*-1/)
			expect(() => canonicalMinusMinutes(NOW, Number.NaN, 'graceWindowMinutes'))
				.to.throw(/graceWindowMinutes/)
		})
	})

	/**
	 * The package's mocha script carries no `--exit` flag, so a leaked interval
	 * would hang the entire run. That is what makes the `stop()` assertions a
	 * real gate rather than a formality — and it is why every test here stops
	 * the handle it started, including the failure-path ones.
	 */
	describe('sweep interval wiring', () => {
		let realSetInterval: typeof globalThis.setInterval
		let realClearInterval: typeof globalThis.clearInterval
		let scheduled: { calls: number, callback: () => void, delay: number, unrefs: number, timer: unknown }
		let cleared: { calls: number, handles: unknown[] }
		let handles: SweeperHandle[]

		beforeEach(() => {
			realSetInterval = globalThis.setInterval
			realClearInterval = globalThis.clearInterval
			scheduled = { calls: 0, callback: () => {}, delay: -1, unrefs: 0, timer: undefined }
			cleared = { calls: 0, handles: [] }
			handles = []

			const fakeTimer = { unref: (): unknown => { scheduled.unrefs++; return fakeTimer } }
			scheduled.timer = fakeTimer

			globalThis.setInterval = ((cb: () => void, delay: number) => {
				scheduled.calls++
				scheduled.callback = cb
				scheduled.delay = delay
				return fakeTimer
			}) as unknown as typeof globalThis.setInterval
			globalThis.clearInterval = ((handle: unknown) => {
				cleared.calls++
				cleared.handles.push(handle)
			}) as unknown as typeof globalThis.clearInterval
		})

		afterEach(() => {
			try {
				for (const handle of handles) handle.stop()
			} finally {
				globalThis.setInterval = realSetInterval
				globalThis.clearInterval = realClearInterval
			}
		})

		/** A `SweeperStore` that counts its enumerations and finds nothing. */
		function countingStore (): { store: SweeperStore, listCalls: () => number } {
			let listCalls = 0
			return {
				store: {
					claimsDir: join(dataDir, 'claims'),
					async listRecordIds () { listCalls++; return [] },
					async getRecord () { return undefined },
					async getCiphertext () { return undefined },
					async deleteCiphertext () { /* unused */ },
					async deleteRecord () { /* unused */ }
				},
				listCalls: () => listCalls
			}
		}

		it('schedules exactly one interval at the configured period, unrefs it, and sweeps nothing eagerly', () => {
			const { store, listCalls } = countingStore()
			const { logger } = makeLoggerStub()
			handles.push(startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 30, logger }))

			expect(scheduled.calls, 'exactly one interval').to.equal(1)
			expect(scheduled.delay, 'seconds converted to milliseconds').to.equal(30_000)
			// `startService` calls this on the critical path to `listen`; a first
			// sweep before returning would turn a sweep failure into a boot
			// failure.
			expect(listCalls(), 'no eager sweep before returning').to.equal(0)
			// Defence in depth, not the mechanism: a MISSED stop() degrades to a
			// leaked timer rather than a process that will not exit.
			expect(scheduled.unrefs, 'the interval is unrefd').to.equal(1)
		})

		it('sweeps on the scheduled callback and reports through the single sweep channel', async () => {
			// The callback derives its own now from the real clock, so the fixture
			// is seeded relative to a reading taken here. Every offset stays on the
			// correct side of both boundaries no matter how long the test takes.
			const base = new Date().toISOString().slice(0, 19)
			await seedLifecycleFixture(stores, base)

			const { logger, counts, received, swept } = makeLoggerStub()
			handles.push(startSweeper({ store: stores, graceWindowMinutes: 60, sweepIntervalSeconds: 30, logger }))

			// Invoke the captured callback directly and await a promise the logger
			// stub resolves. No polling, no delay, no clock.
			scheduled.callback()
			await swept

			expect(received).to.deep.equal([{ ciphertextDropped: 3, recordsDropped: 3, recordsRetained: 4 }])
			expect(counts.sweep, 'reported exactly once').to.equal(1)
			// Exactly one logging channel out of this file.
			expect(counts.fatal, 'the sweeper never reports a fatal').to.equal(0)
			expect(counts.request, 'the sweeper never reports a request').to.equal(0)
		})

		it('stops the exact interval it created, idempotently', () => {
			const { store } = countingStore()
			const { logger } = makeLoggerStub()
			const handle = startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 30, logger })
			handles.push(handle)

			handle.stop()
			expect(cleared.calls).to.equal(1)
			expect(cleared.handles[0], 'cleared the handle setInterval returned').to.equal(scheduled.timer)

			// `RunningService.close` is reachable more than once (a SIGINT after an
			// explicit close), so a double clear must be harmless.
			expect(() => handle.stop()).to.not.throw()
			expect(cleared.calls, 'the second stop is a no-op').to.equal(1)
		})

		it('swallows a rejecting sweep without an unhandled rejection', async () => {
			const store: SweeperStore = {
				claimsDir: join(dataDir, 'claims'),
				async listRecordIds (): Promise<string[]> { throw new Error('store enumeration is broken') },
				async getRecord () { return undefined },
				async getCiphertext () { return undefined },
				async deleteCiphertext () { /* unused */ },
				async deleteRecord () { /* unused */ }
			}
			const { logger, counts } = makeLoggerStub()
			handles.push(startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 30, logger }))

			let unhandled = 0
			const listener = (): void => { unhandled++ }
			process.on('unhandledRejection', listener)
			try {
				expect(() => scheduled.callback(), 'the callback returns void and never throws').to.not.throw()
				// One event-loop turn — not a wall-clock wait.
				await new Promise<void>((resolve) => { setImmediate(resolve) })
				expect(unhandled, 'a failing sweep is never an unhandled rejection').to.equal(0)
				expect(counts.sweep, 'a failed sweep reports nothing').to.equal(0)
			} finally {
				process.removeListener('unhandledRejection', listener)
			}
		})

		it('refuses a non-positive sweepIntervalSeconds, naming the field', () => {
			const { store } = countingStore()
			const { logger } = makeLoggerStub()
			// Positive control in the same test.
			handles.push(startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 30, logger }))
			expect(scheduled.calls).to.equal(1)

			expect(() => startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 0, logger }))
				.to.throw(/sweepIntervalSeconds/)
			expect(() => startSweeper({ store, graceWindowMinutes: 60, sweepIntervalSeconds: 1.5, logger }))
				.to.throw(/sweepIntervalSeconds/)
			expect(scheduled.calls, 'a refused interval schedules nothing').to.equal(1)
		})
	})
})
