import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { ENV_ALLOW_STALE_DIST, ENV_DIST_DIR, type ServiceConfig } from './config.js'
import { sendJson, type RouteHandler } from './http.js'
import type { LoggedOutcome } from './logging.js'

/**
 * static.ts — the fallback handler for every path outside the reserved
 * `/bootstrap/` API prefix, plus the dist provenance gate that decides whether
 * this process is allowed to serve that directory at all.
 *
 * ## Why one process serves both halves
 *
 * The dashboard sets its API base URL to `window.location.origin`
 * (`apps/VoteTorrentDashboard/src/screens/Bootstrap.tsx:55`), and the file's own
 * header explains why there is no build-time override: the dashboard's
 * `assert:no-polyfills` gate fails the build on any read of a build-time
 * injected environment value under `src/`. So the API and the built `dist/`
 * must share one origin, or the shipped client cannot reach the API at all.
 * Serving both from this process is what makes that true with no CORS story and
 * no extra configuration surface.
 *
 * ## Why this file is hand-rolled
 *
 * There is no static-file-serving dependency in this repository, and there is
 * not going to be one. `express`, `fastify` and `serve-static` are deliberately
 * absent and must stay absent — the whole point of this service is a small,
 * auditable surface whose dependency list a reviewer can read in one sitting.
 * Everything below is `node:fs`, `node:path`, `node:crypto` and `node:http`.
 *
 * ## What it serves, and from where
 *
 * Everything comes from `ctx.config.distDir` — an operator-configured path,
 * never a build-time copy into this package. The parsed field is the contract;
 * the environment variable behind it is `BOOTSTRAP_RENDEZVOUS_DIST_DIR` and
 * nothing outside `config.ts` reads it.
 *
 * ## The stale-`dist/` gate, and where it runs
 *
 * A stale build silently serves old JavaScript against a new API. This project
 * has already paid for that defect class more than once; the failure mode is a
 * screen that looks fine and behaves as though a fix were never made. The
 * countermeasure is `assertDistProvenance`, and it runs in **two layers**:
 *
 *   - **Primary — at startup.** `runMain` calls `assertDistProvenance(config)`
 *     after `loadServiceConfig` and *before* `startService` binds the port, so a
 *     `dist/` that is missing, that is really the dashboard's source root, that
 *     references an asset which is not on disk, that contains an extension this
 *     file cannot type, or that is older than the configured source tree, makes
 *     the process refuse to listen at all.
 *   - **Secondary — per request.** `handleStatic` calls the same memoised
 *     function, which catches a `dist/` mutated *after* a healthy startup (an
 *     operator rebuilding under a running process). In the normal path it is a
 *     cache hit and costs nothing.
 *
 * Because the result is memoised per configuration, the filesystem walk happens
 * once per process no matter which layer triggers it.
 *
 * ## Two rules this file does not get to break
 *
 * 1. **It makes no call into the service log, of any kind.** A handler returns
 *    its `LoggedOutcome` and `server.ts` performs the single request-logging
 *    call for the whole package. That one call site is what makes the
 *    no-identifiers-in-the-log-stream property auditable by inspection.
 * 2. **It formats, parses and compares no datetime.** Staleness is compared as
 *    a numeric `Stats.mtimeMs` and nothing else, so no date literal and no date
 *    format string appears here and the package's source guard stays green.
 */

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

/**
 * Every extension this service is willing to type, keyed by the lower-cased
 * extension **including its leading dot**.
 *
 * The table is deliberately a closed list rather than a lookup into a MIME
 * database: `inspectDistProvenance` refuses to start against a `dist/` holding
 * an extension that is absent from it, so an unfamiliar file type is an
 * operator-visible failure instead of an `application/octet-stream` the browser
 * silently declines to execute. That refusal is what keeps this table honest as
 * the dashboard's build changes.
 */
export const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
	'.html': 'text/html; charset=utf-8',
	// The WHATWG-specified value. `application/javascript` is obsolete.
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json'
})

/** The declared type for a path, or `application/octet-stream` when the
 * extension is not in the table. It never guesses and never throws. */
export function contentTypeForPath (filePath: string): string {
	const extension = path.extname(filePath).toLowerCase()
	return MIME_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Request resolution
// ---------------------------------------------------------------------------

export type DistRequestResolution =
	| { kind: 'file', absolutePath: string }
	| { kind: 'fallback' }
	| { kind: 'api' }
	| { kind: 'reject', reason: string }

/** The reserved API prefix, restated here rather than imported from
 * `server.ts`, so this module keeps a one-way dependency on `http.ts` alone and
 * the check below cannot be removed by editing the dispatcher. */
const API_PREFIX = '/bootstrap/'
const API_PREFIX_BARE = '/bootstrap'

const REASON_MALFORMED_URL = 'malformed request URL'
const REASON_MALFORMED_ESCAPE = 'malformed percent-escape in request path'
const REASON_NUL = 'NUL byte in request path'
const REASON_BACKSLASH = 'backslash segment in request path'
const REASON_DOTDOT = '".." segment in request path'
const REASON_ESCAPES_DIST = 'resolved path escapes the dist directory'

/**
 * Splits the raw request target at the first `?` or `#`, giving the path
 * portion **before** any parser has normalised it.
 *
 * This exists because the WHATWG URL parser is a normaliser, not a validator:
 * `new URL('/assets/../../secret.txt', base).pathname` is `/secret.txt`, and
 * `new URL('/a\\..\\..\\b', base).pathname` is `/b`. Both traversals are gone
 * by the time `.pathname` is read, so a guard that inspects only `.pathname`
 * can never see them and would report a clean resolution for a hostile input.
 * The segment checks below therefore run over the raw path as well as over the
 * parsed one.
 */
function rawPathOf (requestUrl: string): string {
	const cut = requestUrl.search(/[?#]/)
	return cut === -1 ? requestUrl : requestUrl.slice(0, cut)
}

/** Decodes, distinguishing a `URIError` from every other failure so the caller
 * can name the offence precisely. */
function decodeOrNull (value: string): string | null {
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

/** The three refusals that are about the *shape* of a path rather than about
 * where it lands. Returns the reason, or `null` when the path is acceptable.
 * Order is fixed: NUL, then backslash, then `..`. */
function shapeRejection (decodedPath: string): string | null {
	if (decodedPath.includes('\0')) {
		return REASON_NUL
	}
	if (decodedPath.includes('\\')) {
		return REASON_BACKSLASH
	}
	if (decodedPath.split('/').some((segment) => segment === '..')) {
		return REASON_DOTDOT
	}
	return null
}

/**
 * Classifies a request target against a **realpath'd** dist root. Performs no
 * file I/O whatsoever — it is pure path arithmetic, so it is cheap enough to
 * run on every request and testable without a filesystem.
 *
 * The order of the steps below is load-bearing; do not reorder them.
 */
export function resolveDistRequest (distRealPath: string, requestUrl: string): DistRequestResolution {
	// 1. Parse. The parse is what drops the query string and the fragment.
	let pathname: string
	try {
		pathname = new URL(requestUrl, 'http://127.0.0.1').pathname
	} catch {
		return { kind: 'reject', reason: REASON_MALFORMED_URL }
	}

	// 2. The reserved API prefix, before anything else. `server.ts` already
	//    reserves it and never routes it here, so this branch is defence in
	//    depth — but placing it first means an API path can never reach the
	//    single-page-application fallback under any input, including a future
	//    refactor of the dispatch table.
	if (pathname === API_PREFIX_BARE || pathname.startsWith(API_PREFIX)) {
		return { kind: 'api' }
	}

	// 3. Decode, before any segment check. `%2e%2e` is `..`, so a check that
	//    ran before this line would be inert. Both the raw target and the
	//    parsed pathname are decoded, for the reason given on `rawPathOf`.
	const decodedRaw = decodeOrNull(rawPathOf(requestUrl))
	const decodedPathname = decodeOrNull(pathname)
	if (decodedRaw === null || decodedPathname === null) {
		return { kind: 'reject', reason: REASON_MALFORMED_ESCAPE }
	}

	// 4. Refuse by shape, naming the offence. Nothing here is normalised away:
	//    a request that contains a traversal is refused, not repaired.
	const rejection = shapeRejection(decodedRaw) ?? shapeRejection(decodedPathname)
	if (rejection !== null) {
		return { kind: 'reject', reason: rejection }
	}

	// 5. Root means the entry document.
	const isRoot = decodedPathname === '/' || decodedPathname === ''
	const target = isRoot ? 'index.html' : decodedPathname.slice(1)

	// 6. Containment backstop. Step 4 already refuses every `..` segment; this
	//    check is what still holds if that ever weakens, and it is the only
	//    thing that catches a percent-encoded separator producing an absolute
	//    target with no `..` in it anywhere.
	const absolutePath = path.resolve(distRealPath, target)
	if (absolutePath !== distRealPath && !absolutePath.startsWith(distRealPath + path.sep)) {
		return { kind: 'reject', reason: REASON_ESCAPES_DIST }
	}

	// 7. A known extension means a file lookup; anything else is a bookmark or
	//    a client route and gets the single-page-application fallback, with no
	//    stat needed to decide.
	//
	//    Note what this does NOT do: a path WITH a known extension that is not
	//    on disk is answered `404` by `handleStatic`, never with `index.html`.
	//    Serving an HTML document in place of a missing `.js` file is the
	//    browser-parses-HTML-as-JavaScript failure this whole design exists to
	//    avoid.
	const extension = path.extname(target).toLowerCase()
	if (isRoot || Object.prototype.hasOwnProperty.call(MIME_TYPES_BY_EXTENSION, extension)) {
		return { kind: 'file', absolutePath }
	}
	return { kind: 'fallback' }
}

// ---------------------------------------------------------------------------
// Dist provenance
// ---------------------------------------------------------------------------

/**
 * A refusal to serve a directory. Its message is the operator's only signal, so
 * every one of them names the offending value and the remedy. These are
 * operator-facing diagnostics printed by `main.ts`, which is safe precisely
 * because they are service-authored: they never carry a foreign error's text.
 */
export class DistProvenanceError extends Error {
	constructor (message: string) {
		super(message)
		this.name = 'DistProvenanceError'
	}
}

export interface DistStaleness {
	newestSourcePath: string
	newestSourceMtimeMs: number
	newestAssetMtimeMs: number
}

export interface DistProvenance {
	/** The `realpathSync`'d root. Every containment check is made against this
	 * value, never against the operator's raw string, so a symlinked
	 * configuration cannot smuggle a request outside the tree. */
	distDir: string
	indexHtmlPath: string
	indexHtmlMtimeMs: number
	entryScriptHref: string | null
	entryStylesheetHref: string | null
	/** The first 16 hex characters of the entry script's SHA-256. This exists so
	 * a user-acceptance run can compare what the service SERVES against what the
	 * browser FETCHED — the same grep-the-served-bundle-for-a-marker discipline
	 * this project already relies on for device proofs. */
	entryScriptSha256Prefix: string | null
	assetCount: number
	newestAssetMtimeMs: number
	missingReferencedAssets: string[]
	unmappedExtensions: string[]
	looksLikeSourceDir: boolean
	staleAgainstSource: DistStaleness | null
}

const BUILD_COMMAND = 'yarn workspace votetorrent-dashboard build'
const SOURCE_REFERENCE_PREFIX = '/src/'
const SOURCE_WALK_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** Every `src="…"` and `href="…"` value, in document order. One pass, both
 * quote styles. */
const REFERENCE_PATTERN = /(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>/gi
const LINK_TAG_PATTERN = /<link\b([^>]*)>/gi
const MODULE_TYPE_PATTERN = /\btype\s*=\s*["']module["']/i
const STYLESHEET_REL_PATTERN = /\brel\s*=\s*["']stylesheet["']/i
const SRC_ATTRIBUTE_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i
const HREF_ATTRIBUTE_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i
/** `http:`, `https:`, `data:`, `mailto:` — anything this service does not own. */
const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i

function attributeValue (attributes: string, pattern: RegExp): string | null {
	const match = pattern.exec(attributes)
	if (match === null) return null
	return match[1] ?? match[2] ?? null
}

/** A reference this service is responsible for resolving, or `null` when it
 * belongs to somebody else (an absolute URL, a data URI, a fragment). */
function distRelativeReference (value: string): string | null {
	const trimmed = value.trim()
	if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
	if (ABSOLUTE_SCHEME_PATTERN.test(trimmed)) return null
	return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}

function walkDistFiles (dir: string, into: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// Dotfiles and dot-directories are build detritus, not shipped assets.
		if (entry.name.startsWith('.')) continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			walkDistFiles(full, into)
			continue
		}
		// Deliberately `isFile()`, not "everything else": a symbolic link is not
		// a shipped asset, and the request path refuses to serve one anyway.
		if (entry.isFile()) into.push(full)
	}
}

function walkNewestSourceFile (dir: string, current: { filePath: string, mtimeMs: number } | null): { filePath: string, mtimeMs: number } | null {
	let newest = current
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		// An unreadable source directory disables staleness detection rather
		// than manufacturing a refusal out of a permissions problem.
		return newest
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			if (SOURCE_WALK_SKIPPED_DIRECTORIES.has(entry.name)) continue
			newest = walkNewestSourceFile(full, newest)
			continue
		}
		if (!entry.isFile()) continue
		const mtimeMs = statSync(full).mtimeMs
		if (newest === null || mtimeMs > newest.mtimeMs) {
			newest = { filePath: full, mtimeMs }
		}
	}
	return newest
}

/**
 * Reads a built `dist/` and reports everything that could make it the wrong
 * directory to serve. Pure in the sense that matters: it returns a struct and
 * never throws for a healthy dist, so the *policy* about what is fatal lives in
 * one place (`assertDistProvenance`) rather than being scattered through the
 * scan.
 *
 * Synchronous on purpose — it runs once per process, never per request.
 */
export function inspectDistProvenance (distDir: string, options: { sourceDir?: string }): DistProvenance {
	const distReal = realpathSync(distDir)
	const indexHtmlPath = path.join(distReal, 'index.html')
	const indexHtmlExists = existsSync(indexHtmlPath)
	const indexHtml = indexHtmlExists ? readFileSync(indexHtmlPath, 'utf8') : ''
	const indexHtmlMtimeMs = indexHtmlExists ? statSync(indexHtmlPath).mtimeMs : 0

	// --- what index.html claims -------------------------------------------
	let looksLikeSourceDir = false
	const missingReferencedAssets: string[] = []
	REFERENCE_PATTERN.lastIndex = 0
	let reference: RegExpExecArray | null
	while ((reference = REFERENCE_PATTERN.exec(indexHtml)) !== null) {
		const value = reference[1] ?? reference[2] ?? ''
		if (value.trim().startsWith(SOURCE_REFERENCE_PREFIX)) {
			// The dashboard's SOURCE index really does reference `/src/app.css`
			// and `/src/main.tsx`; a built one never does. This is precisely the
			// operator-pointed-at-the-wrong-directory case.
			looksLikeSourceDir = true
			continue
		}
		const relative = distRelativeReference(value)
		if (relative === null) continue
		if (!existsSync(path.join(distReal, relative)) && !missingReferencedAssets.includes(value)) {
			missingReferencedAssets.push(value)
		}
	}

	// --- the entry points --------------------------------------------------
	let entryScriptHref: string | null = null
	SCRIPT_TAG_PATTERN.lastIndex = 0
	let scriptTag: RegExpExecArray | null
	while ((scriptTag = SCRIPT_TAG_PATTERN.exec(indexHtml)) !== null) {
		const attributes = scriptTag[1] ?? ''
		if (!MODULE_TYPE_PATTERN.test(attributes)) continue
		const src = attributeValue(attributes, SRC_ATTRIBUTE_PATTERN)
		if (src !== null && src.trim() !== '') {
			entryScriptHref = src
			break
		}
	}

	let entryStylesheetHref: string | null = null
	LINK_TAG_PATTERN.lastIndex = 0
	let linkTag: RegExpExecArray | null
	while ((linkTag = LINK_TAG_PATTERN.exec(indexHtml)) !== null) {
		const attributes = linkTag[1] ?? ''
		if (!STYLESHEET_REL_PATTERN.test(attributes)) continue
		const href = attributeValue(attributes, HREF_ATTRIBUTE_PATTERN)
		if (href !== null && href.trim() !== '') {
			entryStylesheetHref = href
			break
		}
	}

	let entryScriptSha256Prefix: string | null = null
	if (entryScriptHref !== null) {
		const relative = distRelativeReference(entryScriptHref)
		if (relative !== null) {
			const entryPath = path.join(distReal, relative)
			if (existsSync(entryPath) && statSync(entryPath).isFile()) {
				entryScriptSha256Prefix = createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 16)
			}
		}
	}

	// --- what is actually on disk -----------------------------------------
	const files: string[] = []
	walkDistFiles(distReal, files)
	const unmappedExtensions: string[] = []
	let newestAssetMtimeMs = 0
	for (const file of files) {
		const mtimeMs = statSync(file).mtimeMs
		if (mtimeMs > newestAssetMtimeMs) newestAssetMtimeMs = mtimeMs
		const extension = path.extname(file).toLowerCase()
		if (extension === '') continue
		if (Object.prototype.hasOwnProperty.call(MIME_TYPES_BY_EXTENSION, extension)) continue
		if (!unmappedExtensions.includes(extension)) unmappedExtensions.push(extension)
	}

	// --- is the build older than the code it came from? --------------------
	let staleAgainstSource: DistStaleness | null = null
	if (options.sourceDir !== undefined && options.sourceDir !== '') {
		const newestSource = walkNewestSourceFile(options.sourceDir, null)
		// Numeric millisecond comparison and nothing else. No datetime is ever
		// formatted, parsed or compared as a string in this file.
		if (newestSource !== null && newestSource.mtimeMs > newestAssetMtimeMs) {
			staleAgainstSource = {
				newestSourcePath: newestSource.filePath,
				newestSourceMtimeMs: newestSource.mtimeMs,
				newestAssetMtimeMs
			}
		}
	}

	return {
		distDir: distReal,
		indexHtmlPath,
		indexHtmlMtimeMs,
		entryScriptHref,
		entryStylesheetHref,
		entryScriptSha256Prefix,
		assetCount: files.length,
		newestAssetMtimeMs,
		missingReferencedAssets,
		unmappedExtensions,
		looksLikeSourceDir,
		staleAgainstSource
	}
}

type ProvenanceCacheEntry = { ok: true, provenance: DistProvenance } | { ok: false, error: DistProvenanceError }

/** Memoised per configuration, so the filesystem walk happens once per process
 * no matter which of the two layers triggers it. A refusal is memoised too, so
 * a broken dist fails identically on every request instead of flapping. */
const provenanceCache = new Map<string, ProvenanceCacheEntry>()

/** Test-only. Production never calls this: the whole point of the memo is that
 * the walk happens once for the life of the process. */
export function resetDistProvenanceCache (): void {
	provenanceCache.clear()
}

export type DistProvenanceConfig = Pick<ServiceConfig, 'distDir' | 'distSourceDir' | 'allowStaleDist'>

function evaluateDistProvenance (config: DistProvenanceConfig): DistProvenance {
	if (!existsSync(config.distDir)) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: ${ENV_DIST_DIR} points at ${JSON.stringify(config.distDir)}, which does not exist. Build the dashboard with \`${BUILD_COMMAND}\` and point ${ENV_DIST_DIR} at the dist/ directory it emits.`
		)
	}
	const distReal = realpathSync(config.distDir)
	if (!statSync(distReal).isDirectory()) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: ${ENV_DIST_DIR} points at ${JSON.stringify(config.distDir)}, which is not a directory. Build the dashboard with \`${BUILD_COMMAND}\` and point ${ENV_DIST_DIR} at the dist/ directory it emits.`
		)
	}

	const indexHtmlPath = path.join(distReal, 'index.html')
	if (!existsSync(indexHtmlPath)) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: ${JSON.stringify(indexHtmlPath)} is missing, so ${JSON.stringify(distReal)} is not a built dashboard. Build it with \`${BUILD_COMMAND}\` and point ${ENV_DIST_DIR} at the dist/ directory it emits.`
		)
	}

	const provenance = inspectDistProvenance(distReal, { sourceDir: config.distSourceDir })

	if (provenance.looksLikeSourceDir) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: ${JSON.stringify(distReal)} looks like the dashboard source directory rather than its build output — its index.html still references ${JSON.stringify(provenance.entryScriptHref ?? SOURCE_REFERENCE_PREFIX)}, which only the un-built index does. Run \`${BUILD_COMMAND}\` and point ${ENV_DIST_DIR} at the dist/ directory it emits.`
		)
	}

	if (provenance.missingReferencedAssets.length > 0) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: the index.html in ${JSON.stringify(distReal)} references ${provenance.missingReferencedAssets.map((href) => JSON.stringify(href)).join(', ')}, which ${provenance.missingReferencedAssets.length === 1 ? 'is' : 'are'} not on disk. That is a half-written or partly-deleted build; re-run \`${BUILD_COMMAND}\`. Serving it would hand the browser an index that fetches assets which answer 404.`
		)
	}

	if (provenance.unmappedExtensions.length > 0) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: ${JSON.stringify(distReal)} holds ${provenance.unmappedExtensions.join(', ')}, which this service cannot type. Add the extension to MIME_TYPES_BY_EXTENSION in src/static.ts rather than letting the browser receive application/octet-stream and silently decline to use the file.`
		)
	}

	const stale = provenance.staleAgainstSource
	if (stale !== null && !config.allowStaleDist) {
		throw new DistProvenanceError(
			`bootstrap-rendezvous-service: the build in ${JSON.stringify(distReal)} is older than the source it came from. ${JSON.stringify(stale.newestSourcePath)} was modified at ${Math.round(stale.newestSourceMtimeMs)} ms, while the newest built asset is from ${Math.round(stale.newestAssetMtimeMs)} ms. Re-run \`${BUILD_COMMAND}\`. A stale build serves old JavaScript against a new API and looks perfectly healthy while doing it. If you genuinely intend to serve it anyway, set ${ENV_ALLOW_STALE_DIST}=1 as a deliberate opt-in.`
		)
	}

	return provenance
}

/**
 * The gate. Refuses, in order: a `distDir` that is missing or is not a
 * directory; a missing `index.html`; the dashboard's source root; an
 * `index.html` referencing an asset that is not on disk; an extension this
 * service cannot type; and a build older than its configured source tree.
 *
 * Exported so an operator preflight and a user-acceptance run can call it
 * directly, as well as `runMain`.
 */
export function assertDistProvenance (config: DistProvenanceConfig): DistProvenance {
	const key = JSON.stringify([config.distDir, config.distSourceDir ?? null, config.allowStaleDist === true])
	const cached = provenanceCache.get(key)
	if (cached !== undefined) {
		if (cached.ok) return cached.provenance
		throw cached.error
	}

	try {
		const provenance = evaluateDistProvenance(config)
		provenanceCache.set(key, { ok: true, provenance })
		return provenance
	} catch (err) {
		const error = err instanceof DistProvenanceError
			? err
			: new DistProvenanceError(
				`bootstrap-rendezvous-service: ${ENV_DIST_DIR} points at ${JSON.stringify(config.distDir)}, which could not be inspected. Build the dashboard with \`${BUILD_COMMAND}\` and make sure the directory is readable by this process.`
			)
		provenanceCache.set(key, { ok: false, error })
		throw error
	}
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

const NOT_FOUND_BODY = 'not found\n'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
/**
 * `index.html` is served `no-cache` deliberately. A cached entry document pins
 * the browser to a hashed asset that a rebuild has already superseded, which is
 * the stale-bundle failure carried into the HTTP layer. The hashed assets
 * themselves are immutable by construction, so they get the opposite treatment.
 */
const REVALIDATE_CACHE_CONTROL = 'no-cache'

/** A plain-text 404. Never `index.html`: an HTML document served in place of a
 * missing module is exactly the failure this design exists to avoid. */
function sendPlainNotFound (res: ServerResponse, headOnly: boolean): LoggedOutcome {
	res.writeHead(404, {
		'content-type': 'text/plain; charset=utf-8',
		'content-length': String(Buffer.byteLength(NOT_FOUND_BODY))
	})
	if (headOnly) {
		res.end()
	} else {
		res.end(NOT_FOUND_BODY)
	}
	return 'not-found'
}

async function serveFile (
	res: ServerResponse,
	provenance: DistProvenance,
	absolutePath: string,
	headOnly: boolean
): Promise<LoggedOutcome> {
	let stats
	try {
		// `lstat`, not `stat`. The containment check cannot see through a link,
		// so a symbolic link planted inside the dist root is refused
		// unconditionally rather than followed to wherever it points.
		stats = await lstat(absolutePath)
	} catch {
		return sendPlainNotFound(res, headOnly)
	}
	if (stats.isSymbolicLink() || !stats.isFile()) {
		return sendPlainNotFound(res, headOnly)
	}

	const contents = await readFile(absolutePath)
	const assetsRoot = path.join(provenance.distDir, 'assets') + path.sep
	res.writeHead(200, {
		'content-type': contentTypeForPath(absolutePath),
		'content-length': String(contents.byteLength),
		'cache-control': absolutePath.startsWith(assetsRoot) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL
	})
	if (headOnly) {
		res.end()
	} else {
		res.end(contents)
	}
	return 'ok'
}

/**
 * Serves the dashboard's built `dist/` for every path outside the reserved API
 * prefix. Returns its outcome and performs no logging — `server.ts` owns the
 * package's single request-logging call site.
 */
export const handleStatic: RouteHandler = async (req, res, ctx) => {
	let provenance: DistProvenance
	try {
		provenance = assertDistProvenance(ctx.config)
	} catch {
		// The refusal message names filesystem paths, so it goes to the
		// operator through the startup gate and never to the client.
		sendJson(res, 500, { error: 'internal error' })
		return 'error'
	}

	try {
		const resolution = resolveDistRequest(provenance.distDir, req.url ?? '/')

		if (resolution.kind === 'api') {
			sendJson(res, 404, { error: 'not found' })
			return 'not-found'
		}

		if (resolution.kind === 'reject') {
			// The specific reason is diagnostic — it describes path shapes an
			// attacker supplied — and is deliberately not serialised back.
			sendJson(res, 400, { error: 'bad request' })
			return 'bad-request'
		}

		const method = req.method ?? 'GET'
		if (method !== 'GET' && method !== 'HEAD') {
			res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
			res.end(JSON.stringify({ error: 'method not allowed' }))
			return 'method-not-allowed'
		}

		const absolutePath = resolution.kind === 'file' ? resolution.absolutePath : provenance.indexHtmlPath
		return await serveFile(res, provenance, absolutePath, method === 'HEAD')
	} catch {
		if (!res.headersSent) {
			sendJson(res, 500, { error: 'internal error' })
		}
		return 'error'
	}
}
