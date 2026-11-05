import { assertCanonicalBootstrapDatetime } from '@votetorrent/vote-engine/bootstrap'
import { assertSafeLookupId, deleteClaimMarker } from './claim.js'
import type { ServiceLogger, SweepCounts } from './logging.js'
import type { RendezvousRecord } from './store.js'

/**
 * sweeper.ts — the retention sweep. **The only reclaim path this service has.**
 *
 * No sweeper of any kind existed anywhere in this codebase before this file.
 * Expiry is a lazy request-time comparison at every other site, which answers
 * "may this be served?" and never "may this still rest on disk?". Those are
 * different questions and only this file asks the second one.
 *
 * ## The two stages, and why collapsing them deletes the feature
 *
 * The retention rule is **"ciphertext early, record later"**, and the gap
 * between the two stages is the whole deliverable.
 *
 * - **Stage 1, at `expiresAt`:** a never-redeemed record's ciphertext is
 *   erased. Confidentiality is the point — an unredeemed sealed blob must not
 *   rest on the operator's disk past the short span the redemption window
 *   fixes. A record that was already redeemed had its ciphertext erased on
 *   serve, so this stage is normally a no-op for it.
 * - **Stage 2, at `expiresAt` plus `graceWindowMinutes`:** the payload-free
 *   record itself is dropped, together with its claim marker.
 *
 * A redemption is answered from the record alone: `unknown` when there is no
 * record, `used` when the flag is set, `expired` when the span has passed. Drop
 * the record at `expiresAt` and every late redemption collapses to the generic
 * `unknown`, and the three distinct refusal strings the client shows have
 * nothing left to distinguish. **A "simplification" into a single
 * drop-at-expiry pass has silently deleted the feature.** Do not make it.
 *
 * ## Every freshness decision is a raw string comparison
 *
 * Canonical datetimes here are 19 characters with no trailing `Z`, and that
 * form sorts lexicographically, so `a > b` on the raw strings *is* the
 * chronological comparison. Neither side of any comparison in this file is ever
 * routed through a date parser: two textually different strings that resolve to
 * the same instant are still different values, and a parser would erase that
 * distinction. The guard is imported from the vote-engine bootstrap barrel
 * rather than reimplemented, so this package adds no further copy of the
 * pattern.
 *
 * ## The single date construction, and the `Z` it appends
 *
 * Stage 2 needs a horizon `graceWindowMinutes` earlier than now, and that is
 * arithmetic rather than comparison — the one thing raw strings cannot do. It
 * is confined to `canonicalMinusMinutes`, which shifts **`nowCanonical`** once
 * per sweep instead of shifting each record's `expiresAt`. That direction was
 * chosen for two reasons. It performs exactly one date construction per sweep
 * rather than one per record. And — the security-relevant half — **`expiresAt`,
 * which arrives off the wire, is never handed to a date constructor at all.**
 * Only the service's own clock reading is.
 *
 * ## This file makes no filesystem call of its own
 *
 * It constructs no path and imports no filesystem or path module. `store.ts`
 * and `claim.ts` own path construction, and that single ownership is what keeps
 * the traversal guard in one place instead of two.
 *
 * ## The report channel is three integers, deliberately
 *
 * `SweepCounts` is three numbers and nothing else, so no parameter exists
 * through which a look-up id, a client address or a payload byte could travel.
 * `sweepOnce` does not report at all — it *returns* its counts. The interval
 * callback makes exactly one reporting call and no other. The accepted cost,
 * of the same shape this service's logging module already accepts: a skipped
 * hostile id cannot be reported at all, and a persistently failing sweep is
 * invisible in production. In development the presence of periodic sweep lines
 * is the health signal, and their absence is the alarm.
 *
 * ## The invariant this sweep depends on but cannot itself enforce
 *
 * **No ciphertext may ever exist without its record.** The sweep enumerates
 * *records*; the store exposes no ciphertext enumerator, so a sealed blob whose
 * record is missing is structurally invisible here and would rest forever.
 *
 * That is not left open. The control is on the write side, in the upload
 * handler: it writes ciphertext first — the inverse order would leave a
 * redeemable record with nothing to serve, burning a single-use code and
 * violating at-most-once delivery — and then wraps the record write in a `try`
 * whose `catch` awaits `deleteCiphertext(lookupId)` before rethrowing the
 * original error unchanged, with an inner catch so a failed compensation cannot
 * mask the original fault (`52-08` Task 1 step 6b). An ordinary record-write
 * error is therefore fully handled.
 *
 * **The narrow surviving residual, accepted:** a process crash between the two
 * writes, or a compensating delete that itself fails. Closing that needs a
 * write-ahead journal, which is out of scope for a service whose retention
 * bound is ten minutes.
 */

/**
 * The structural subset of the record store that the sweep actually touches.
 *
 * This is a deliberate narrowing of the full store contract, and a **widening**
 * of what the callers may pass — the real store object satisfies it
 * structurally with no cast, so the existing call site cannot break. The point
 * is that it documents the sweeper's blast radius in its own signature: the
 * sweeper cannot write a record, cannot mint a claim and cannot store
 * ciphertext, because those methods are not in the type it holds. That is a
 * stronger statement than a comment could make.
 */
export interface SweeperStore {
	readonly claimsDir: string
	listRecordIds(): Promise<string[]>
	getRecord(lookupId: string): Promise<RendezvousRecord | undefined>
	getCiphertext(lookupId: string): Promise<string | undefined>
	deleteCiphertext(lookupId: string): Promise<void>
	deleteRecord(lookupId: string): Promise<void>
}

export interface SweepOptions {
	store: SweeperStore
	graceWindowMinutes: number
	/** Injected canonical "now", 19 characters, no trailing `Z`. Passing it in
	 * is what lets a test drive the sweep without waiting on a wall clock. */
	nowCanonical: string
}

export interface SweeperOptions {
	store: SweeperStore
	graceWindowMinutes: number
	sweepIntervalSeconds: number
	logger: ServiceLogger
}

export interface SweeperHandle {
	stop(): void
}

/**
 * Returns the canonical datetime `minutes` earlier than `canonical`.
 *
 * The one place in this file that touches a date object, and the only place
 * that needs to: see the module header for why the shift is applied to the
 * service's own clock reading rather than to a record's `expiresAt`.
 */
export function canonicalMinusMinutes (canonical: string, minutes: number, where: string): string {
	assertCanonicalBootstrapDatetime(canonical, where)
	if (!Number.isSafeInteger(minutes) || minutes < 0) {
		throw new Error(
			`bootstrap-rendezvous-service: ${where} must be a non-negative whole number of minutes (got: ${String(minutes)})`
		)
	}
	// The appended `Z` is LOAD-BEARING. ECMAScript parses a bare date-time form
	// carrying no offset as LOCAL time, so omitting it would shift the horizon
	// by the host's UTC offset and make the grace window wrong on every machine
	// outside UTC — a defect a UTC-only CI run would never surface. The spec
	// pins this by running the same call under three time zones.
	const epochMs = new Date(`${canonical}Z`).getTime()
	if (!Number.isFinite(epochMs)) {
		throw new Error(`bootstrap-rendezvous-service: ${where} did not resolve to a real instant (got: ${canonical})`)
	}
	const shifted = new Date(epochMs - minutes * 60_000).toISOString().slice(0, 19)
	// Re-validated on the way out, so a nonsensical horizon fails loudly here
	// instead of silently corrupting every comparison downstream of it.
	return assertCanonicalBootstrapDatetime(shifted, where)
}

/**
 * One pure, directly drivable sweep step.
 *
 * Takes its "now" as a parameter and reports nothing: the caller decides what
 * to do with the counts. Every lifecycle test drives this directly, which is
 * why no test in this package needs a clock.
 */
export async function sweepOnce (options: SweepOptions): Promise<SweepCounts> {
	assertCanonicalBootstrapDatetime(options.nowCanonical, 'bootstrap-rendezvous-service: sweepOnce nowCanonical')
	// Computed ONCE per sweep, never once per record.
	const graceHorizon = canonicalMinusMinutes(
		options.nowCanonical,
		options.graceWindowMinutes,
		'bootstrap-rendezvous-service: sweepOnce graceWindowMinutes'
	)

	// Deliberately NOT wrapped in a try/catch. A store that cannot enumerate is
	// a real failure, not a per-record hiccup, and this must reject so a
	// fundamentally broken store is loud rather than silently reporting a
	// perfectly clean sweep of zero records forever.
	const ids = await options.store.listRecordIds()

	let ciphertextDropped = 0
	let recordsDropped = 0
	let recordsRetained = 0

	// Sequential, with an `await` per record — never `Promise.all`. A sweep is a
	// background reclaim with no latency budget, and serialising it bounds the
	// file-descriptor and memory pressure it can place on a service that is
	// concurrently serving redemptions.
	for (const id of ids) {
		try {
			// FIRST, before any store method receives `id`. This value came off
			// disk and would otherwise become a path segment; the enumerator
			// recurses into subdirectories and returns `subdir/name`, so a
			// separator-bearing id is a reachable case rather than a theoretical
			// one. This guard is the traversal control.
			assertSafeLookupId(id, 'sweep lookupId')

			const record = await options.store.getRecord(id)
			// Deleted between the enumeration and the read — another process
			// redeemed and reclaimed it. A benign race, not an error, and counted
			// in nothing.
			if (record === undefined) continue

			// Inclusive at the boundary: `expiresAt === nowCanonical` is expired.
			const expired = !(record.expiresAt > options.nowCanonical)
			if (!expired) {
				// A live record's ciphertext must stay — it is still redeemable.
				recordsRetained++
				continue
			}

			// ---- Stage 1: ciphertext, at expiry ----
			// The probed value is never bound to a variable, never returned, never
			// reported and never retained; only its PRESENCE is read. That presence
			// check is what makes the count idempotent — a blanket delete would
			// report a drop on every later sweep of the same already-empty record.
			// The full read happens at most once per record in the store's
			// lifetime, because every later probe hits an absent file and returns
			// cheaply. A record with `used === true` normally takes this branch as
			// a no-op, since the redemption route erases ciphertext on serve — and
			// "normally" is exactly why the probe, not the flag, is the source of
			// truth here.
			if ((await options.store.getCiphertext(id)) !== undefined) {
				// CIPHERTEXT BEFORE RECORD, ALWAYS. A crash between the two stages
				// leaves ciphertext gone and the record present, which the next
				// sweep resolves by skipping stage 1 and re-evaluating stage 2 —
				// convergent. The reverse order would leave ciphertext with no
				// record, which nothing in this design can ever reclaim.
				await options.store.deleteCiphertext(id)
				ciphertextDropped++
			}

			// ---- Stage 2: the payload-free record, past the grace window ----
			// Inclusive at the boundary too: `expiresAt === graceHorizon` is past
			// grace.
			const pastGrace = !(record.expiresAt > graceHorizon)
			if (pastGrace) {
				await options.store.deleteRecord(id)
				// The claim marker is retired ONLY in the branch that deletes the
				// record, and never before it. The marker's existence IS the
				// single-use fact; deleting it while the record survives would
				// re-arm a spent code for a second claim, converting a retention
				// sweep into a privilege escalation. It goes after the record so a
				// crash between the two leaves an inert orphan marker rather than a
				// live record whose marker has vanished.
				await deleteClaimMarker(options.store.claimsDir, id)
				recordsDropped++
			} else {
				recordsRetained++
			}
		} catch {
			// One corrupt record file, one unreadable blob, one transient EACCES
			// must not abort the sweep for every record after it. A skipped record
			// is counted in NONE of the three fields — it was neither retained by
			// decision nor dropped.
			//
			// The consequence, stated rather than hidden: a record that cannot be
			// parsed is skipped on every future sweep and never reclaimed. Deleting
			// a file the service cannot understand is a data-destroying action on
			// an unknown, and it is deliberately not taken.
			continue
		}
	}

	return { ciphertextDropped, recordsDropped, recordsRetained }
}

/**
 * Starts the periodic sweep and returns the handle the service closes on
 * shutdown.
 */
export function startSweeper (options: SweeperOptions): SweeperHandle {
	// Re-asserted at the point that actually schedules. Configuration parsing
	// already rejects values at or below zero, but the service also accepts a
	// hand-built config from tests and from the conformance harness, so the
	// guard belongs here too and not only at the parse.
	if (!Number.isSafeInteger(options.sweepIntervalSeconds) || options.sweepIntervalSeconds <= 0) {
		throw new Error(
			`bootstrap-rendezvous-service: sweepIntervalSeconds must be a positive whole number of seconds (got: ${String(options.sweepIntervalSeconds)})`
		)
	}

	// SCHEDULE ONLY — no sweep runs before this function returns. The service
	// calls it on the critical path to binding the socket, and a first-sweep
	// failure must surface as a background no-op, never as a startup failure.
	// The first sweep happens at the first tick.
	const timer = setInterval(() => {
		// The callback's own clock reading, and the only one in this file. This
		// is the value the module header calls "the service's own clock reading":
		// it is the sole input that ever reaches a date constructor.
		const nowCanonical = new Date().toISOString().slice(0, 19)
		// A plain non-async callback returning `void`, so the scheduler is never
		// handed a promise it would drop. The terminal catch is ordered AFTER the
		// reporting call so a throw from the sink is caught too.
		//
		// The swallow is honest, not lazy, and its cost is real: there is no
		// channel to report a failed sweep. The sweep report takes three numbers,
		// the fatal-event vocabulary has no sweep member, and widening either
		// would put a new reporting call site outside the request path and
		// destroy the single-call-site property that makes the no-identifiers
		// guarantee auditable by inspection. So a persistently failing sweep is
		// invisible in production — recorded in the module header as an accepted
		// cost — and the interval survives to try again on the next tick rather
		// than taking down a process that is serving redemptions.
		void sweepOnce({
			store: options.store,
			graceWindowMinutes: options.graceWindowMinutes,
			nowCanonical
		}).then((counts: SweepCounts) => { options.logger.sweep(counts) }).catch(() => { /* see above */ })
	}, options.sweepIntervalSeconds * 1000)

	// Defence in depth, NOT the mechanism. `stop()` is the mechanism; this only
	// ensures that a MISSED `stop()` degrades to a leaked timer rather than a
	// process that will not exit. Guarded so this file assumes no particular
	// timer object shape and a spec can substitute a fake. The package's test
	// invocation carries no flag that would force an exit, so a genuinely
	// un-stoppable interval hangs the suite instead of passing silently — that
	// is deliberate.
	timer.unref?.()

	let stopped = false
	return {
		stop (): void {
			// The service's close path is reachable more than once (a signal after
			// an explicit close), so a double clear must be harmless.
			if (stopped) return
			stopped = true
			clearInterval(timer)
		}
	}
}
