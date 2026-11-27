/**
 * config.ts — the single operator-configuration surface for the **Bootstrap
 * Rendezvous Service**: the plain-HTTP store-and-forward process that holds one
 * sealed blob it cannot read, for at most ten minutes, and hands it over exactly
 * once.
 *
 * **Read this before adding a key.** This is NOT the libp2p circuit relay's
 * configuration. It has no peers, no multiaddrs, no strand and no cadre, and it
 * never dials anything. Every variable therefore carries the
 * `BOOTSTRAP_RENDEZVOUS_` prefix so that a future reader can never confuse one
 * of these keys with the unrelated libp2p `CONTROL_ADDR` multiaddr settings.
 * A bare `BOOTSTRAP_*` key is a naming defect here, not a shorthand.
 *
 * **Two properties this module owns, both of which are startup failures rather
 * than warnings:**
 *
 * 1. *Loopback by default.* The deployment posture is plain HTTP bound to
 *    loopback with TLS terminated by a reverse proxy the operator supplies. A
 *    non-loopback bind host is therefore **refused** unless the operator sets
 *    the explicit opt-in, so a missing proxy fails loudly instead of quietly
 *    exposing bearer traffic on a public interface. The refusal happens here,
 *    at config load, well before anything calls `server.listen`.
 *
 * 2. *Production-silent logging by default.* `logMode` is derived **solely**
 *    from `BOOTSTRAP_RENDEZVOUS_DEV_LOGGING`. There is deliberately no
 *    framework-convention environment variable that can flip request logging
 *    on — a misconfigured deployment must fail toward silence, never toward
 *    accidentally logging identifiers. Do not introduce one.
 *
 * Every parse below fails loud with a `ServiceConfigError` naming the offending
 * key. In particular the two opt-in flags **throw** on any unrecognised value
 * instead of defaulting to `false`: a typo such as `yes` must not silently
 * disable the loopback safeguard, and it must equally not silently disable dev
 * logging that an operator believed they had enabled.
 */

/** Every operator knob, already parsed and validated. Nothing downstream
 * re-reads the environment. */
export interface ServiceConfig {
	bindHost: string
	port: number
	allowNonLoopbackBind: boolean
	uploadToken: string
	maxUploadBytes: number
	graceWindowMinutes: number
	sweepIntervalSeconds: number
	dataDir: string
	distDir: string
	/**
	 * The dashboard's **source** root — `apps/VoteTorrentDashboard/src` — used
	 * only to detect a `dist/` that is older than the code it was built from.
	 * `undefined` (the default) disables staleness detection and leaves the
	 * self-consistency checks on `distDir` active.
	 */
	distSourceDir?: string
	/**
	 * The deliberate opt-in that permits serving a `dist/` older than
	 * `distSourceDir`. Default `false`: a stale build silently serving old
	 * JavaScript against a new API is a failure this service refuses to start
	 * into.
	 */
	allowStaleDist: boolean
	logMode: 'production' | 'development'
}

/** The three spellings of "this socket is not reachable from off-host". */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set<string>(['127.0.0.1', '::1', 'localhost'])

export const DEFAULT_BIND_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787
/** 8 MiB. A sealed voter-roll envelope is far smaller; this is a disk-fill
 * ceiling, not a sizing estimate. */
export const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** How long a payload-free record survives past its own `expiresAt` so the
 * service can still answer `used`/`expired` instead of degrading to the weaker
 * `unknown`. */
export const DEFAULT_GRACE_WINDOW_MINUTES = 60
export const DEFAULT_SWEEP_INTERVAL_SECONDS = 60

export const ENV_BIND_HOST = 'BOOTSTRAP_RENDEZVOUS_BIND_HOST'
export const ENV_PORT = 'BOOTSTRAP_RENDEZVOUS_PORT'
export const ENV_ALLOW_NON_LOOPBACK = 'BOOTSTRAP_RENDEZVOUS_ALLOW_NON_LOOPBACK'
export const ENV_UPLOAD_TOKEN = 'BOOTSTRAP_RENDEZVOUS_UPLOAD_TOKEN'
export const ENV_DATA_DIR = 'BOOTSTRAP_RENDEZVOUS_DATA_DIR'
export const ENV_DIST_DIR = 'BOOTSTRAP_RENDEZVOUS_DIST_DIR'
export const ENV_DIST_SOURCE_DIR = 'BOOTSTRAP_RENDEZVOUS_DIST_SOURCE_DIR'
export const ENV_ALLOW_STALE_DIST = 'BOOTSTRAP_RENDEZVOUS_ALLOW_STALE_DIST'
export const ENV_MAX_UPLOAD_BYTES = 'BOOTSTRAP_RENDEZVOUS_MAX_UPLOAD_BYTES'
export const ENV_GRACE_WINDOW_MINUTES = 'BOOTSTRAP_RENDEZVOUS_GRACE_WINDOW_MINUTES'
export const ENV_SWEEP_INTERVAL_SECONDS = 'BOOTSTRAP_RENDEZVOUS_SWEEP_INTERVAL_SECONDS'
export const ENV_DEV_LOGGING = 'BOOTSTRAP_RENDEZVOUS_DEV_LOGGING'

/** A configuration fault, carrying the name of the environment variable the
 * operator has to fix. `main.ts` prints this message verbatim, which is safe
 * precisely because every message below is service-authored. */
export class ServiceConfigError extends Error {
	readonly key: string

	constructor (key: string, message: string) {
		super(message)
		this.name = 'ServiceConfigError'
		this.key = key
	}
}

/** Required string keys: absent, empty or whitespace-only is a hard failure. */
function requireString (env: Record<string, string | undefined>, key: string, what: string): string {
	const raw = env[key]
	if (raw === undefined || raw.trim() === '') {
		throw new ServiceConfigError(key, `bootstrap-rendezvous-service: ${key} is required — supply ${what}.`)
	}
	return raw.trim()
}

/** Integer keys. Rejects `NaN`, trailing garbage (`Number.parseInt` would
 * happily accept `8787abc`), and anything at or below zero. `port` alone is
 * allowed to be `0` so tests and the conformance harness can bind an ephemeral
 * port. */
function parseInteger (
	env: Record<string, string | undefined>,
	key: string,
	defaultValue: number,
	options: { allowZero?: boolean, max?: number } = {}
): number {
	const raw = env[key]
	if (raw === undefined || raw.trim() === '') {
		return defaultValue
	}
	const trimmed = raw.trim()
	const parsed = Number.parseInt(trimmed, 10)
	if (!Number.isInteger(parsed) || String(parsed) !== trimmed) {
		throw new ServiceConfigError(key, `bootstrap-rendezvous-service: ${key} must be an integer (received: ${JSON.stringify(raw)}).`)
	}
	const floor = options.allowZero === true ? 0 : 1
	if (parsed < floor) {
		throw new ServiceConfigError(
			key,
			`bootstrap-rendezvous-service: ${key} must be ${options.allowZero === true ? 'zero or greater' : 'greater than zero'} (received: ${JSON.stringify(raw)}).`
		)
	}
	if (options.max !== undefined && parsed > options.max) {
		throw new ServiceConfigError(key, `bootstrap-rendezvous-service: ${key} must be no greater than ${options.max} (received: ${JSON.stringify(raw)}).`)
	}
	return parsed
}

/** Opt-in flags. Throwing on an unrecognised value — rather than defaulting to
 * `false` — is the whole point: a typo must never silently turn a safeguard
 * off. */
function parseOptIn (raw: string | undefined, key: string): boolean {
	if (raw === undefined) {
		return false
	}
	const normalised = raw.trim().toLowerCase()
	if (normalised === '' || normalised === '0' || normalised === 'false') {
		return false
	}
	if (normalised === '1' || normalised === 'true') {
		return true
	}
	throw new ServiceConfigError(
		key,
		`bootstrap-rendezvous-service: ${key} must be one of 1, true, 0 or false (received: ${JSON.stringify(raw)}). It is deliberately not tolerant: an unrecognised value would silently leave the flag off.`
	)
}

/**
 * Refuses a non-loopback bind host unless the operator opted in explicitly.
 *
 * This is a startup failure, never a warning. It is asserted twice — once here
 * at config load, and once again in `startService`, which also accepts a
 * hand-built `ServiceConfig` from tests and from the conformance harness and
 * therefore cannot rely on `loadServiceConfig` having run.
 */
export function assertLoopbackOrOptedIn (bindHost: string, allowNonLoopbackBind: boolean): void {
	if (allowNonLoopbackBind || LOOPBACK_HOSTS.has(bindHost)) {
		return
	}
	throw new ServiceConfigError(
		ENV_ALLOW_NON_LOOPBACK,
		`refusing to bind non-loopback host ${JSON.stringify(bindHost)}. This service speaks plain HTTP and expects to be reached on loopback only, with TLS terminated by a reverse proxy the operator supplies. If you genuinely intend to expose this socket directly, set ${ENV_ALLOW_NON_LOOPBACK}=1 as a deliberate opt-in.`
	)
}

/**
 * Parses and validates the whole operator surface.
 *
 * Takes the environment as an argument rather than reading the process
 * environment directly, so no test ever mutates a global.
 */
export function loadServiceConfig (env: Record<string, string | undefined>): ServiceConfig {
	const rawBindHost = env[ENV_BIND_HOST]
	const bindHost = rawBindHost === undefined || rawBindHost.trim() === '' ? DEFAULT_BIND_HOST : rawBindHost.trim()

	const port = parseInteger(env, ENV_PORT, DEFAULT_PORT, { allowZero: true, max: 65535 })
	const allowNonLoopbackBind = parseOptIn(env[ENV_ALLOW_NON_LOOPBACK], ENV_ALLOW_NON_LOOPBACK)
	const uploadToken = requireString(env, ENV_UPLOAD_TOKEN, 'the shared bearer secret the mint side sends with every upload')
	const dataDir = requireString(env, ENV_DATA_DIR, 'a writable directory for records, ciphertext and claim markers')
	const distDir = requireString(env, ENV_DIST_DIR, "the path to the dashboard's built dist/ directory")
	const rawDistSourceDir = env[ENV_DIST_SOURCE_DIR]
	const distSourceDir =
		rawDistSourceDir === undefined || rawDistSourceDir.trim() === '' ? undefined : rawDistSourceDir.trim()
	const allowStaleDist = parseOptIn(env[ENV_ALLOW_STALE_DIST], ENV_ALLOW_STALE_DIST)
	const maxUploadBytes = parseInteger(env, ENV_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES)
	const graceWindowMinutes = parseInteger(env, ENV_GRACE_WINDOW_MINUTES, DEFAULT_GRACE_WINDOW_MINUTES)
	const sweepIntervalSeconds = parseInteger(env, ENV_SWEEP_INTERVAL_SECONDS, DEFAULT_SWEEP_INTERVAL_SECONDS)
	const devLogging = parseOptIn(env[ENV_DEV_LOGGING], ENV_DEV_LOGGING)

	// Derived from the opt-in flag and from nothing else. Production is the
	// default so a misconfigured deployment fails toward silence.
	const logMode: 'production' | 'development' = devLogging ? 'development' : 'production'

	// Refuse a bad bind host here, at load, rather than at listen time.
	assertLoopbackOrOptedIn(bindHost, allowNonLoopbackBind)

	return {
		bindHost,
		port,
		allowNonLoopbackBind,
		uploadToken,
		maxUploadBytes,
		graceWindowMinutes,
		sweepIntervalSeconds,
		dataDir,
		distDir,
		distSourceDir,
		allowStaleDist,
		logMode
	}
}
