import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertCanonicalBootstrapDatetime } from '@votetorrent/vote-engine/bootstrap'
import { assertSafeLookupId, deleteClaimMarker } from '../claim.js'
import {
	readJsonBody,
	RequestBodyInvalidError,
	RequestBodyTooLargeError,
	sendJson,
	type RouteHandler
} from '../http.js'

/**
 * routes/upload.ts — `POST /bootstrap/uploads`, the write half of the
 * rendezvous.
 *
 * ## 1. What lands here
 *
 * The phone's encrypted push at mint. The request body is
 * `{ lookupId, expiresAt, sealed: { v, nonce, ciphertext }, revokeLookupId? }`
 * and the request carries `Authorization: Bearer <operator token>`. The
 * response is one of:
 *
 *   - `200 { ok: true }`
 *   - `401 { error: 'unauthorized' }`
 *   - `413 { error: 'upload too large', limitBytes: <configured ceiling> }`
 *   - `400 { error: 'bad request', reason: <closed-set token> }`
 *   - `500 { error: 'internal error' }` — produced by `server.ts`, not here.
 *
 * ## 2. The fixed step order, and why each step precedes the next
 *
 *   1. **Authorise** — before a single body byte is read, so an unauthenticated
 *      client can never make this process buffer up to the configured ceiling.
 *   2. **Read the body under the ceiling** — before validation, because
 *      validation needs a parsed value and the ceiling is what bounds the cost
 *      of producing one.
 *   3. **Validate** — before any store call, because the look-up identifiers
 *      become path segments and the character-class guard is the traversal
 *      control. Nothing touches the filesystem until both identifiers have
 *      passed it.
 *   4. **Take the store from the context** — before any write, because there is
 *      exactly one storage handle per process and this handler must use it
 *      rather than build a second one.
 *   5. **Revoke the prior code** — before anything new is written, so the
 *      window in which two codes are live is not merely small but empty.
 *   6. **Write the sealed blob, then the record** — in that order, because the
 *      record is what makes a code redeemable: a record with no blob would let
 *      a redemption burn a single-use code and receive nothing, and a burned
 *      code costs the officer a re-mint. If the second write fails, the first
 *      is undone (see §7).
 *   7. **Acknowledge** — only after both writes have resolved, because the
 *      phone drops its plaintext payload on this `200` and the officer is not
 *      shown a code until it arrives.
 *
 * ## 3. D-17 — the operator gate and the size ceiling
 *
 * Redemption needs no guessing rate limit (the secret is 160 bits), but an
 * ungated write endpoint is a disk-fill invitation this service cannot detect,
 * because it can read neither a real upload nor a junk one. So uploads are
 * gated by an operator-configured bearer token compared in constant time.
 *
 * The `401` is deliberately **indistinguishable** across all four causes — no
 * header at all, a header carrying a different scheme, a wrong token, and a
 * service whose configured token is empty. One fixed single-key body literal,
 * one fixed header set, no cause-specific detail. A `401` that told a caller
 * which of those it hit would be a free oracle over the operator's secret.
 *
 * The `413` is the one place a configured value is deliberately disclosed: its
 * body names the ceiling in bytes so an operator who hits it can act rather
 * than guess. That disclosure is scoped by step 1 — only a caller who already
 * holds the operator token can reach a `413` at all. An unauthenticated
 * oversized upload receives `401` and never `413`.
 *
 * ## 4. D-12 — a second mint revokes the first, and its chosen failure mode
 *
 * Push-at-mint would otherwise silently break a property the phone's own source
 * calls a security property: the phone forgets a replaced code, but this
 * service would still hold and honour it. By D-10 the service sees only a
 * look-up id and an expiry and cannot infer that two codes belong to one
 * authority, so the revoke must be explicit and phone-driven — it rides as an
 * optional field on this upload.
 *
 * **The failure mode is chosen, not incidental.** If the revoke throws, the
 * upload fails with `500` and no new record is written. If a write throws after
 * a successful revoke, the operator has **no live code** and the officer mints
 * again. Revoking *after* a successful write would instead risk a window in
 * which **two** codes are live — precisely the outcome D-12 exists to prevent.
 * Failing toward no-code is the safe direction and it is deliberate.
 *
 * ## 5. D-10 — what is persisted
 *
 * The record carries exactly `lookupId`, `expiresAt` and `used`. The stored
 * wrapper carries exactly `v`, `nonce` and `ciphertext`. Both are built as
 * **explicit literals**, never as a spread of the caller's object: a spread is
 * exactly how a fourth field leaks in. Re-serialising the wrapper touches only
 * the routing envelope this service owns and never the sealed bytes, whose
 * authentication tag covers the ciphertext and the look-up id and not any key
 * ordering here.
 *
 * ## 6. This handler never logs
 *
 * It returns a member of the closed outcome union and `server.ts` performs the
 * single logging call for every request. That one call site is what makes the
 * "no identifiers in the log stream" property auditable by inspection. A
 * logging call in a route module is a contract violation.
 *
 * Note that `'revoked'` is a member of that union but is never returned here: a
 * successful upload reports `'ok'` whether or not it carried a revoke, so a
 * development-mode log line cannot advertise which mints were re-mints.
 *
 * ## 7. The orphan-blob invariant is closed HERE, by name
 *
 * `52-10`'s retention sweep enumerates **records**, and the store exposes no
 * enumerator for sealed blobs, so that sweep is structurally incapable of ever
 * seeing a blob whose record is missing. Such a blob would be an indefinite
 * retention of data the operator can neither read nor delete — a D-16
 * violation, not litter.
 *
 * Because this handler writes the blob first, it is the only place that still
 * holds the look-up id at the moment the record write fails. Step 6b therefore
 * deletes the blob it just wrote before the error propagates, and **this is
 * what satisfies `52-10`'s invariant**; `52-10` inherits no orphan obligation.
 * The residual that survives is narrow and stated rather than hidden: a process
 * crash between the two writes, or a compensating delete that itself fails.
 * Both need a write-ahead journal to close. An ordinary record-write error is
 * fully handled.
 *
 * ## 8. A note for `52-09`
 *
 * A revoke can race an in-flight redemption of the code being revoked. The
 * redeemer may already hold the claim marker and then find the sealed blob
 * gone. `52-09` must answer a refusal in that case, never throw.
 *
 * ## 9. The store is `ctx.store`
 *
 * One storage instance, built once by `startService` and shared by every route.
 * This handler must never construct its own and must never read the configured
 * data directory to build one. Two handlers each holding their own storage
 * handles over one directory is a latent bug this project has already been
 * bitten by, where duplicated store handles contaminated state across scopes
 * that should have been isolated.
 *
 * ## 10. Errors never describe themselves
 *
 * The only `catch` around the storage steps is the compensating one, and it
 * rethrows the original error unchanged. Every storage failure therefore
 * reaches `server.ts`'s single catch, which answers a fixed body and logs only
 * an outcome. A catch that produced a response, a log line or a replacement
 * error is how a raw error message — which can embed a filesystem path — would
 * reach a client.
 */

/**
 * The complete, service-authored vocabulary of refusal reasons. This is the
 * only detail about a malformed request that ever reaches a client, and it is
 * exported so the spec asserts against the same literals this module emits
 * rather than against copies that can drift.
 */
export const UPLOAD_INVALID_REASONS = [
	'json',
	'body-shape',
	'unknown-field',
	'lookup-id',
	'expires-at',
	'sealed',
	'revoke-lookup-id',
	'revoke-equals-lookup'
] as const

export type UploadInvalidReason = (typeof UPLOAD_INVALID_REASONS)[number]

/** A malformed upload. `reason` is drawn from the closed set above; the
 * message adds nothing a client is told. */
export class UploadRequestInvalidError extends Error {
	readonly reason: UploadInvalidReason

	constructor (reason: UploadInvalidReason) {
		super(`bootstrap-rendezvous-service: upload request is invalid (${reason})`)
		this.name = 'UploadRequestInvalidError'
		this.reason = reason
	}
}

/**
 * The sealed wrapper as it arrives on the wire.
 *
 * Declared **locally** rather than importing `52-01`'s sealed-payload type on
 * purpose: this service is a courier that cannot read the blob, so it must not
 * take a compile-time dependency on the sealing implementation. Agreement
 * between the two declarations is proven by the conformance suite that drives
 * both halves, not by a shared type — a shared type would prove only that one
 * file was edited.
 */
export interface SealedWrapper {
	v: number
	nonce: string
	ciphertext: string
}

export interface UploadRequestBody {
	lookupId: string
	expiresAt: string
	sealed: SealedWrapper
	revokeLookupId?: string
}

/** The complete accepted key set of the request body. Anything else is a
 * refusal, not a tolerated extra — see `parseUploadRequest`. */
const ALLOWED_BODY_KEYS: readonly string[] = ['lookupId', 'expiresAt', 'sealed', 'revokeLookupId']

/** The complete accepted key set of the wrapper. Exactly these three. */
const ALLOWED_SEALED_KEYS: readonly string[] = ['v', 'nonce', 'ciphertext']

/**
 * Decides whether an `Authorization` header presents the operator token.
 *
 * Exported so the spec can drive its edge cases directly, in addition to — and
 * never instead of — driving them over real HTTP.
 */
export function isAuthorizedUpload (authorizationHeader: string | undefined, configuredToken: string): boolean {
	// An unset operator token refuses every upload; it can never mean "open".
	// The primary control for this state is the required-key throw in
	// `loadServiceConfig`, which refuses to start a service without a token.
	// This is the second layer, because `startService` also accepts a
	// hand-built configuration object that never went through that loader.
	if (configuredToken.trim() === '') return false
	if (authorizationHeader === undefined) return false

	// Split at the FIRST space. Array indexing would need an `undefined` branch
	// under `noUncheckedIndexedAccess` that adds nothing.
	const separator = authorizationHeader.indexOf(' ')
	if (separator === -1) return false

	// The scheme is not a secret, so a plain comparison is correct for it.
	const scheme = authorizationHeader.slice(0, separator).toLowerCase()
	if (scheme !== 'bearer') return false

	// The presented token is the remainder verbatim — not trimmed, not decoded.
	const presented = authorizationHeader.slice(separator + 1)

	// Compare DIGESTS, not raw tokens: constant-time comparison THROWS on a
	// length mismatch, and that throw is itself a length oracle for the
	// operator's secret. Two SHA-256 digests are always 32 bytes, so the
	// comparison is total and leaks no length. Neither token is ever logged,
	// echoed, or placed in an error message or a response body.
	const presentedDigest = createHash('sha256').update(presented, 'utf8').digest()
	const configuredDigest = createHash('sha256').update(configuredToken, 'utf8').digest()
	return timingSafeEqual(presentedDigest, configuredDigest)
}

/** A non-null, non-array object. Arrays are excluded explicitly because
 * `typeof []` is `'object'` and an array would otherwise pass every own-key
 * check below vacuously. */
function isPlainObject (value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates the wrapper without reading it.
 *
 * The value of `v` is deliberately NOT checked, neither field is base64url
 * decoded, and no unsealing is attempted. That is seam rule 5 — couriers do not
 * reject: a service that gatekept a format version it cannot read would break
 * the next producer for no security gain whatsoever.
 */
function parseSealedWrapper (value: unknown): SealedWrapper {
	if (!isPlainObject(value)) throw new UploadRequestInvalidError('sealed')

	const keys = Object.keys(value)
	if (keys.length !== ALLOWED_SEALED_KEYS.length) throw new UploadRequestInvalidError('sealed')
	for (const key of ALLOWED_SEALED_KEYS) {
		if (!keys.includes(key)) throw new UploadRequestInvalidError('sealed')
	}

	const version = value.v
	const nonce = value.nonce
	const ciphertext = value.ciphertext
	if (typeof version !== 'number' || !Number.isInteger(version)) throw new UploadRequestInvalidError('sealed')
	if (typeof nonce !== 'string' || nonce.length === 0) throw new UploadRequestInvalidError('sealed')
	if (typeof ciphertext !== 'string' || ciphertext.length === 0) throw new UploadRequestInvalidError('sealed')

	return { v: version, nonce, ciphertext }
}

/**
 * Validates an untrusted request body. Throws `UploadRequestInvalidError`.
 * Performs no I/O of any kind, so a refusal here cannot have touched the disk.
 */
export function parseUploadRequest (value: unknown): UploadRequestBody {
	if (!isPlainObject(value)) throw new UploadRequestInvalidError('body-shape')

	// Strict rejection of an unrecognised key is a D-10 control: an extra field
	// means the phone is telling this service something it must not know. The
	// honest cost is that a newer producer which adds a field needs a service
	// update — acceptable because one authority runs both halves.
	for (const key of Object.keys(value)) {
		if (!ALLOWED_BODY_KEYS.includes(key)) throw new UploadRequestInvalidError('unknown-field')
	}

	const lookupId = value.lookupId
	if (typeof lookupId !== 'string') throw new UploadRequestInvalidError('lookup-id')
	try {
		assertSafeLookupId(lookupId, 'upload lookupId')
	} catch {
		// The guard's own text quotes the offending value. That belongs in a
		// service log at most, never in a response, so only the reason travels.
		throw new UploadRequestInvalidError('lookup-id')
	}

	let expiresAt: string
	try {
		// The imported 19-character no-suffix guard — one implementation, not a
		// fourth local copy, and not the normaliser, which strips rather than
		// refuses.
		expiresAt = assertCanonicalBootstrapDatetime(value.expiresAt, 'upload expiresAt')
	} catch {
		throw new UploadRequestInvalidError('expires-at')
	}
	// Deliberately NOT rejected: an `expiresAt` already in the past. This
	// project has measured device clocks running roughly 45 seconds behind the
	// host, and a skew-based rejection would fail real mints for a bound the
	// retention sweep already enforces. Equally deliberately NOT capped: a
	// far-future value. A cap needs a new operator key, which belongs to the
	// plan that owns the configuration surface; the residual is recorded in the
	// threat model rather than silently ignored.

	const sealed = parseSealedWrapper(value.sealed)

	let revokeLookupId: string | undefined
	if (Object.prototype.hasOwnProperty.call(value, 'revokeLookupId')) {
		const candidate = value.revokeLookupId
		if (typeof candidate !== 'string') throw new UploadRequestInvalidError('revoke-lookup-id')
		try {
			assertSafeLookupId(candidate, 'upload revokeLookupId')
		} catch {
			throw new UploadRequestInvalidError('revoke-lookup-id')
		}
		// Revoking the identifier you are about to write indicates a derivation
		// bug on the producer, and refusing it costs nothing.
		if (candidate === lookupId) throw new UploadRequestInvalidError('revoke-equals-lookup')
		revokeLookupId = candidate
	}

	// An explicit literal, never a spread of the caller's object: a spread is
	// how a fourth field leaks through a validator that looked strict.
	if (revokeLookupId === undefined) {
		return { lookupId, expiresAt, sealed }
	}
	return { lookupId, expiresAt, sealed, revokeLookupId }
}

/**
 * The three-key wrapper projection, as stored.
 *
 * This parses and re-serialises the **wrapper** — a routing envelope this
 * service owns — and never the sealed bytes, which it cannot read. The
 * authentication tag covers the ciphertext bytes and the look-up id bound in as
 * associated data, neither of which a key projection touches, so integrity is
 * untouched while the guarantee that no extra field was stored is enforced.
 */
function sealedWireJson (sealed: SealedWrapper): string {
	return JSON.stringify({ v: sealed.v, nonce: sealed.nonce, ciphertext: sealed.ciphertext })
}

/**
 * Answers a refusal that happens before, or instead of, a completed body read.
 *
 * A refusal that never reads the request body would otherwise leave an
 * unconsumed body on a keep-alive socket, so the connection is closed and the
 * request stream is discarded once the response has been flushed.
 *
 * The close header is set BEFORE the response is written, because the response
 * writer merges previously-set headers and gives its own argument precedence.
 *
 * The stream is discarded only while it is still arriving. A body that has
 * already been fully received is left to the server's own discard path; tearing
 * the socket down underneath a response that has just been flushed is how a
 * well-formed refusal turns into a connection reset the client reads as a
 * network failure instead of a `401`.
 */
function refuseWithoutReadingBody (req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
	if (res.writableEnded || res.destroyed) return
	// When the ceiling tripped mid-stream the request socket is already gone;
	// writing to it would raise an asynchronous stream error that no caller can
	// catch.
	if (req.socket === null || req.socket.destroyed) return

	res.setHeader('connection', 'close')
	sendJson(res, status, body)
	res.once('finish', () => {
		if (!req.readableEnded && !req.complete && !req.destroyed) {
			req.destroy()
		}
	})
}

export const handleUpload: RouteHandler = async (req, res, ctx) => {
	// STEP 1 — authorise before a single body byte is read. This is what stops
	// an unauthenticated client from making the service buffer up to the
	// configured ceiling, and it is also why an unauthenticated oversized
	// upload receives 401 and never 413. The body literal below is fixed and
	// single-keyed: it is identical for every cause of a 401.
	if (!isAuthorizedUpload(req.headers.authorization, ctx.config.uploadToken)) {
		res.setHeader('www-authenticate', 'Bearer')
		refuseWithoutReadingBody(req, res, 401, { error: 'unauthorized' })
		return 'unauthorized'
	}

	// STEP 2 — read the body under the ceiling. The shared reader supplies both
	// halves of it: a declared-length early exit that rejects without draining,
	// and a running byte counter over the real stream that never trusts the
	// declared length.
	let raw: unknown
	try {
		raw = await readJsonBody(req, ctx.config.maxUploadBytes)
	} catch (err) {
		if (err instanceof RequestBodyTooLargeError) {
			// The named limit is what makes this refusal actionable for an
			// operator. Honest limitation: when the ceiling trips MID-STREAM the
			// reader has already destroyed the request stream, so the response
			// may not reach a client that is still writing. The declared-length
			// early exit is what makes the named-limit refusal reliably
			// deliverable for a well-behaved client.
			if (!res.writableEnded && !res.destroyed) {
				refuseWithoutReadingBody(req, res, 413, {
					error: 'upload too large',
					limitBytes: ctx.config.maxUploadBytes
				})
			}
			return 'too-large'
		}
		if (err instanceof RequestBodyInvalidError) {
			// Never echo the body: it carries sealed payload bytes.
			sendJson(res, 400, { error: 'bad request', reason: 'json' })
			return 'bad-request'
		}
		// Anything else reaches the single catch in `server.ts`.
		throw err
	}

	// STEP 3 — validate. Both look-up identifiers pass the character-class
	// guard here, before any key or path is built anywhere downstream.
	let body: UploadRequestBody
	try {
		body = parseUploadRequest(raw)
	} catch (err) {
		if (err instanceof UploadRequestInvalidError) {
			sendJson(res, 400, { error: 'bad request', reason: err.reason })
			return 'bad-request'
		}
		throw err
	}

	// STEP 4 — the one storage instance this process owns, taken from the
	// context. Never constructed here, and never rebuilt from the configured
	// data directory.
	const stores = ctx.store

	// STEP 5 — revoke, before anything new is written (D-12). The sealed blob
	// dies first, mirroring "blob early, record later". Dropping the claim
	// marker keeps the sweep's enumeration honest; it does not affect
	// redemption, because a redeemer with no record refuses at the first step.
	// An absent prior code is a successful no-op — the store's deletes swallow
	// a missing file.
	if (body.revokeLookupId !== undefined) {
		await stores.deleteCiphertext(body.revokeLookupId)
		await stores.deleteRecord(body.revokeLookupId)
		await deleteClaimMarker(stores.claimsDir, body.revokeLookupId)
	}

	// STEP 6a — the sealed blob first. The record is what makes a code
	// redeemable, so a record without its blob would let a redemption burn a
	// single-use code and receive nothing. Do not reorder these two writes to
	// avoid the compensation below: the compensation is the cheaper correction.
	await stores.putCiphertext(body.lookupId, sealedWireJson(body.sealed))

	// STEP 6b — the record, as an explicit three-field literal.
	try {
		await stores.putRecord({ lookupId: body.lookupId, expiresAt: body.expiresAt, used: false })
	} catch (recordWriteFailure) {
		// This compensation is what closes the orphan-blob invariant that
		// `52-10` cannot close: its sweep enumerates records, and there is no
		// enumerator for sealed blobs, so a blob whose record is missing is
		// invisible to it forever. The inner catch ignores the compensating
		// delete's own failure so a failing compensation cannot mask the
		// original fault with a second one. The surviving residual is a crash
		// between the two writes, or a compensating delete that itself fails —
		// both recorded in the threat model rather than hidden.
		try {
			await stores.deleteCiphertext(body.lookupId)
		} catch {
			// Deliberately ignored. The original fault below is the one that
			// must reach the caller.
		}
		// Rethrown unchanged: never swallowed, never replaced, never turned into
		// a response here.
		throw recordWriteFailure
	}

	// STEP 7 — acknowledge only now. The phone drops its payload on this ack
	// and the officer is not shown a code until it arrives, so it must not be
	// sent before both writes have resolved. The look-up id is not echoed;
	// there is nothing to gain by repeating it.
	sendJson(res, 200, { ok: true })
	return 'ok'
}
