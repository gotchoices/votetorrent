/**
 * logging.ts — the Bootstrap Rendezvous Service's entire logging surface. This
 * is the leaf module: it imports nothing else from this package, so every other
 * module may depend on it and the dependency graph stays a DAG.
 *
 * **Logging splits by mode.**
 *   - *development*: one line per request (route, outcome, latency) and one
 *     line per sweep (three counts). Enabled only by the explicit
 *     `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING` opt-in.
 *   - *production*: **fatal startup errors only**. `request` and `sweep` call
 *     the sink zero times. This is the default.
 *
 * **The accepted cost, stated plainly so nobody "fixes" it by accident:** in
 * production an operator cannot distinguish a healthy service from one refusing
 * every redemption. That is the deliberate trade for a service whose whole job
 * is to hold something it must not be able to describe.
 *
 * **The controlling property: no log line this service can emit is capable of
 * carrying an identifier, a client address, or a payload byte — in either
 * mode.** That is enforced *structurally*, not by convention: `request` and
 * `sweep` accept only closed string unions and numbers, so there is no
 * parameter through which a code's derived look-up id could travel. Widening
 * either signature to `string` or to an options object would silently destroy
 * this property; do not do it.
 *
 * **The contract on `fatal`'s `message`, for every future caller.** It is for
 * **service-authored** text only — a `ServiceConfigError` message, or a fixed
 * template written in this repository. It must **never** be a caught foreign
 * error's `.message`, which can embed filesystem paths, request bodies, or the
 * operator bearer token. Pass `errorClass(err)` instead. This mirrors the
 * status-and-path-only discipline in the REST bootstrap transport, which puts
 * only the status code and the request path into a thrown error and never the
 * response body.
 */

export type LogMode = 'production' | 'development'

/** Which of the service's four dispatch destinations handled the request.
 * `unrouted` covers a path under the reserved API prefix that matched no
 * route. */
export type LoggedRoute = 'upload' | 'redeem' | 'static' | 'unrouted'

/**
 * The closed outcome vocabulary. The first four names — `ok`, `unknown`,
 * `expired`, `used` — deliberately mirror the locked redemption vocabulary in
 * `@votetorrent/vote-engine`'s bootstrap transport, so a development log reads
 * in the same words the protocol speaks. The rest are transport-level outcomes
 * with no equivalent there.
 */
export type LoggedOutcome =
	| 'ok'
	| 'unknown'
	| 'expired'
	| 'used'
	| 'revoked'
	| 'unauthorized'
	| 'too-large'
	| 'bad-request'
	| 'not-found'
	| 'method-not-allowed'
	| 'not-implemented'
	| 'error'

/** The only events that survive the production-silent default. */
export type FatalEvent = 'config-invalid' | 'bind-refused' | 'listen-failed' | 'startup-failed'

/**
 * The retention sweep's report. Declared here rather than in `sweeper.ts` so
 * the dependency edge runs sweeper -> logging and never the reverse.
 */
export interface SweepCounts {
	ciphertextDropped: number
	recordsDropped: number
	recordsRetained: number
}

export interface ServiceLogger {
	/** `message` must be service-authored. See the module header. */
	fatal(event: FatalEvent, message: string): void
	request(route: LoggedRoute, outcome: LoggedOutcome, latencyMs: number): void
	sweep(counts: SweepCounts): void
}

export interface LoggerOptions {
	mode: LogMode
	/** Injectable for tests. The default writes to standard error. */
	sink?: (line: string) => void
}

const LINE_PREFIX = 'bootstrap-rendezvous'

function defaultSink (line: string): void {
	process.stderr.write(`${line}\n`)
}

export function createServiceLogger (options: LoggerOptions): ServiceLogger {
	const sink = options.sink ?? defaultSink
	const emitPerEvent = options.mode === 'development'

	return {
		fatal (event: FatalEvent, message: string): void {
			sink(`${LINE_PREFIX} fatal event=${event} message=${message}`)
		},
		request (route: LoggedRoute, outcome: LoggedOutcome, latencyMs: number): void {
			if (!emitPerEvent) return
			sink(`${LINE_PREFIX} request route=${route} outcome=${outcome} latency_ms=${Math.round(latencyMs)}`)
		},
		sweep (counts: SweepCounts): void {
			if (!emitPerEvent) return
			sink(
				`${LINE_PREFIX} sweep ciphertext_dropped=${counts.ciphertextDropped} records_dropped=${counts.recordsDropped} records_retained=${counts.recordsRetained}`
			)
		}
	}
}

/**
 * Reduces any thrown value to its class name and nothing else. A foreign
 * error's `.message` can carry a filesystem path, a request body, or the
 * operator bearer token; its class name carries none of those and is still
 * enough to tell an `ENOENT` apart from a `TypeError`.
 */
export function errorClass (err: unknown): string {
	return (err as { name?: string } | null | undefined)?.name ?? 'Error'
}
