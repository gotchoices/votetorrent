import type { IncomingMessage, ServerResponse } from 'node:http'
import { assertCanonicalBootstrapDatetime } from '@votetorrent/vote-engine/bootstrap'
import { assertSafeLookupId, claimSingleUse } from '../claim.js'
import {
	readJsonBody,
	RequestBodyInvalidError,
	RequestBodyTooLargeError,
	sendJson,
	type RouteHandler
} from '../http.js'

/**
 * routes/redeem.ts — `POST /bootstrap/redemptions`.
 *
 * ## 1. What this route is
 *
 * The B-1 half of the wire protocol locked at
 * `packages/vote-engine/src/bootstrap/rest-bootstrap-transport.ts:35-44`. It is
 * the read half of the rendezvous and the half that decides whether a code is
 * spent.
 *
 *   request  `{ lookupId }`
 *   response `{ status, sealed? }`, `sealed` present IF AND ONLY IF
 *            `status === 'ok'`
 *
 * The request is keyed on the **derived look-up id** and never on the raw
 * secret the officer read aloud (D-04). That split is forced, not preferred:
 * the seam's `redeem(code)` is handed the secret, so if the secret were posted
 * here this service could derive the payload's content key from the very
 * request that asks for the payload and the sealing would be decoration. The
 * secret half never reaches this process at all.
 *
 * ## 2. WARNING — every redemption answer is HTTP 200
 *
 * `unknown`, `expired`, `used` and `ok` are all `200`. This is forced by the
 * client, not a stylistic choice: `RestBootstrapTransport.requestJson` throws
 * on any non-2xx response (`rest-bootstrap-transport.ts:222-224`) carrying only
 * the status code and the path. A `404` for `unknown` or a `410` for `expired`
 * would therefore make the binding raise a transport error instead of returning
 * a status, `assertKnownBootstrapRedemptionStatus` would never run, and the
 * dashboard's three distinct refusal strings would be unreachable — D-25 would
 * be silently deleted by an HTTP status code. Changing any of the four to a
 * non-2xx code is a breaking protocol change.
 *
 * `400`, `413` and `500` are **not** redemption answers. They carry no `status`
 * member at all; they mean the caller is not speaking the protocol, or the
 * service is broken, and the client correctly turns each into a thrown error.
 *
 * **A deliberate asymmetry with the upload route.** Its `413` names the
 * configured limit because that caller is an authenticated operator who can act
 * on it. Redemption is unauthenticated, so this `413` does **not** disclose the
 * configured value — it would widen a scoped disclosure to anyone on the
 * network for no operator benefit. Do not "fix" the inconsistency.
 *
 * ## 3. The fixed step order, and why each step precedes the next
 *
 *   validate -> look up -> expiry -> used flag -> CLAIM -> read the payload ->
 *   erase the payload -> mark the record -> respond
 *
 * Validation comes first so a hostile look-up id never reaches a path join and
 * a body offering a secret never reaches storage. The three refusals come next,
 * cheapest and most specific first, so a request that was never going to be
 * served does not burn anything.
 *
 * **D-08 — the claim is taken BEFORE anything is served.** The atomic claim is
 * what serialises two concurrent redemptions; it is the only thing standing
 * between two simultaneous requests and two deliveries. Nothing may be read out
 * of the payload store above it, and nothing may be handed out before it. The
 * two shipped bindings disagreed about this ordering and the phase settled it
 * in favour of the filesystem binding's discipline.
 *
 * ## 4. At-most-once delivery — stated plainly, not softened
 *
 * Claiming before serving means a crash, or a response lost in transit after
 * the claim, burns the code and delivers nothing. That is the deliberate
 * choice. The alternative — serve, then claim — risks handing the same one-shot
 * bearer credential out twice, which is strictly worse for a credential read
 * aloud in a room.
 *
 * What the holder then sees is a subsequent attempt reporting `used`, not
 * `unknown`. That precision is exactly why D-16 keeps the payload-free record
 * alive through a grace window past its own expiry instead of dropping it at
 * expiry: the answer stays precise rather than degrading to the weaker
 * `unknown`. The operator's recovery is to mint a new code.
 *
 * ## 5. D-16 — the serve half: payload early, record later
 *
 * The payload is erased as part of serving, and the payload-free record
 * survives with `used === true`. The retention sweep owns the later
 * grace-window drop of the record and of its claim marker; this handler never
 * deletes a record and never deletes a claim marker.
 *
 * ## 6. Exclusion is link(2), and only link(2)
 *
 * `claimSingleUse` is the sole mutual-exclusion primitive this service has.
 * `FileKVStore.set` publishes through `atomicWriteFile`'s `rename(2)`, which
 * silently overwrites and is last-writer-wins; it cannot exclude, and eight
 * concurrent writes to one key all succeed.
 *
 * The `used` flag read at step 4 is a durable convenience and **not** the
 * exclusion primitive — two concurrent requests both read `false` there.
 * Deleting the claim because the flag "already handles used" reopens the race;
 * `test/redeem-single-use.spec.ts` keeps a mutation proof of exactly that.
 *
 * ## 7. Expiry is a raw string comparison
 *
 * Two 19-character canonical datetimes with no `Z` suffix, compared with `>`.
 * Canonical form sorts lexicographically. `Date.parse` appears nowhere, and the
 * only clock read in this file is the argument-free current instant. The guard
 * is IMPORTED from the seam, never re-declared: three copies of that pattern
 * already exist in this repository and a fourth is refused by a source guard,
 * so datetime fixtures live only under `test/`. The canonical NORMALISER is
 * also deliberately not used — it silently strips a trailing `Z` rather than
 * rejecting it, which would turn a malformed stored value into a
 * silently-wrong comparison instead of a loud fault.
 *
 * ## 8. The store is `ctx.store`
 *
 * One `RendezvousStores` instance, built once by `startService` and shared by
 * every route. This handler must never construct its own. Two handlers each
 * holding their own storage handles over one directory is a latent bug this
 * project has already been bitten by.
 *
 * ## 9. This handler makes zero logger calls
 *
 * It returns a `LoggedOutcome`; `server.ts` performs the single logging call
 * for every request. That one call site is what makes the no-identifiers
 * property auditable by inspection.
 *
 * ## 10. The revoke race
 *
 * A concurrent second mint revokes the first by deleting its payload and its
 * record. A redeemer can therefore hold the claim and then find the payload
 * gone. That is answered as a refusal and never as a throw — see the branch at
 * step 7 below for which refusal, and why it is `unknown` rather than `used`.
 *
 * ## 11. No decision identifiers on the wire
 *
 * Decision and plan identifiers are fine in these comments. They are forbidden
 * in every `reason` token, error message and response body this module can emit
 * to a client.
 */

/**
 * The request body ceiling, in bytes.
 *
 * The body is fixed by the wire protocol at a single 43-character string, so
 * `{"lookupId":"..."}` is roughly 60 bytes and 1024 leaves about seventeen
 * times headroom.
 *
 * It is a module constant and deliberately **not** an operator knob: the bound
 * is structural — a property of the protocol's body shape — rather than
 * deployment-dependent. `ctx.config.maxUploadBytes` is an *upload* ceiling of 8
 * MiB and would be both semantically wrong and needlessly generous on an
 * unauthenticated endpoint. If the body shape ever grows enough that operators
 * need to tune this, the constant moves to `src/config.ts`.
 */
export const REDEEM_REQUEST_MAX_BYTES = 1024

/**
 * The closed, service-authored refusal vocabulary. Exported so the specs assert
 * against the same literals the handler emits rather than hand-copied strings,
 * and so a sixth reason cannot be added without a test noticing.
 */
export const REDEEM_INVALID_REASONS = ['json', 'body-shape', 'unknown-field', 'secret-offered', 'lookup-id'] as const

export type RedeemInvalidReason = typeof REDEEM_INVALID_REASONS[number]

/**
 * D-04 made explicit and testable.
 *
 * The pre-reshape wire shape posted the secret itself, and a client still doing
 * so must fail LOUDLY with its own named reason rather than have its secret
 * quietly ignored by a generic shape check. These three names are refused
 * inputs, never capabilities: nothing in this module can derive anything from
 * one, and the offending value is never read, echoed or stored.
 */
export const FORBIDDEN_REDEEM_BODY_KEYS = ['code', 'secret', 'contentKey'] as const

/**
 * A malformed redemption request. `reason` is the only detail that ever reaches
 * a client — never the offending value, and never a guard's own message, which
 * quotes what it refused.
 */
export class RedeemRequestInvalidError extends Error {
	readonly reason: string

	constructor (reason: RedeemInvalidReason) {
		super(`bootstrap-rendezvous-service: redemption request is invalid (${reason})`)
		this.name = 'RedeemRequestInvalidError'
		this.reason = reason
	}
}

/**
 * The three-field routing envelope this service carries.
 *
 * Declared LOCALLY here on purpose, and the duplication with the upload route's
 * identical local declaration is deliberate. Importing that route's type would
 * create an import edge between two route modules owned by different plans in
 * one wave; importing the seam's sealed-payload type would couple a courier to
 * the cipher it must not be able to read. Wire agreement between the two
 * endpoints is proven by the conformance suite driving both end to end, not by
 * a shared type.
 *
 * This is NOT an instance of the banned duplication. That rule is about the
 * canonical-datetime guard, which is imported above and never re-declared.
 */
interface SealedWrapper {
	v: number
	nonce: string
	ciphertext: string
}

/** One member. That is the whole request. */
export interface RedeemRequestBody {
	lookupId: string
}

/**
 * Validates an untrusted parsed body. Performs no I/O and throws
 * `RedeemRequestInvalidError` on anything it will not accept.
 */
export function parseRedeemRequest (value: unknown): RedeemRequestBody {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new RedeemRequestInvalidError('body-shape')
	}

	const body = value as Record<string, unknown>
	const keys = Object.keys(body)

	// Checked BEFORE the general unknown-key sweep so a body offering a secret
	// yields its own named refusal rather than a shape complaint a reader could
	// mistake for a typo.
	for (const forbidden of FORBIDDEN_REDEEM_BODY_KEYS) {
		if (keys.includes(forbidden)) {
			throw new RedeemRequestInvalidError('secret-offered')
		}
	}

	// Strict rejection is a design control: an extra field means the client is
	// telling this service something it must not know. The cost — a service
	// update when the protocol grows — is acceptable because one authority runs
	// both halves.
	for (const key of keys) {
		if (key !== 'lookupId') {
			throw new RedeemRequestInvalidError('unknown-field')
		}
	}

	const lookupId = body['lookupId']
	if (typeof lookupId !== 'string') {
		throw new RedeemRequestInvalidError('lookup-id')
	}
	try {
		assertSafeLookupId(lookupId, 'redemption lookupId')
	} catch {
		// The guard's own text quotes the offending value. It belongs in a
		// service log at most, never in a response.
		throw new RedeemRequestInvalidError('lookup-id')
	}

	// An explicit literal, never a spread of the caller's object.
	return { lookupId }
}

/**
 * The one response path in this module, refusals included.
 *
 * Two reasons for the uniform `cache-control`, both load-bearing. A redemption
 * response carries a one-shot sealed payload and must not be stored by the
 * reverse proxy the deployment posture puts in front of this service. And
 * applying the header uniformly means the response HEADERS never distinguish
 * one outcome from another, so the only thing that differs between `unknown`
 * and `expired` is the documented status word itself.
 */
function answer (res: ServerResponse, status: number, body: unknown): void {
	res.setHeader('cache-control', 'no-store')
	sendJson(res, status, body)
}

/**
 * Used only on the oversized-body path, where the body reader's
 * `Content-Length` early exit rejects WITHOUT draining, so an unconsumed body
 * would otherwise be left on a keep-alive socket.
 *
 * `connection: close` is set before answering because `writeHead` merges
 * previously-set headers and gives its own argument precedence.
 *
 * The upload route has an equivalent private helper. The duplication exists
 * because neither plan may edit the other's file nor `http.ts`; consolidating
 * the two belongs to whoever owns `http.ts`.
 */
function closeWithoutDrainingBody (req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
	res.setHeader('connection', 'close')
	res.once('finish', () => {
		if (!req.readableEnded) {
			req.destroy()
		}
	})
	answer(res, status, body)
}

/**
 * Projects a stored document to the three-key wire envelope.
 *
 * **Absent is a refusal; corrupt is a fault.** A document that will not parse,
 * or that does not carry an integer version plus a non-empty nonce and a
 * non-empty payload, is a corrupt store and a genuine service fault: it throws,
 * and the dispatcher turns it into a fixed `500`. The thrown error names only
 * the KIND of failure — never the document text, never the look-up id.
 *
 * The result is an explicit three-key literal rather than a spread, so a
 * hostile or older writer cannot smuggle a fourth member out through the
 * response.
 *
 * Note what is parsed here: the routing envelope, which this service owns and
 * must be able to shape-check. Never the payload inside it, which this service
 * cannot read.
 */
function projectSealedWrapper (document: string): SealedWrapper {
	let parsed: unknown
	try {
		parsed = JSON.parse(document)
	} catch {
		throw new Error('bootstrap-rendezvous-service: a stored sealed wrapper is not parseable JSON')
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('bootstrap-rendezvous-service: a stored sealed wrapper is not a JSON object')
	}
	const candidate = parsed as Record<string, unknown>
	const version = candidate['v']
	const nonce = candidate['nonce']
	const ciphertext = candidate['ciphertext']
	if (
		!Number.isInteger(version) ||
		typeof nonce !== 'string' || nonce.length === 0 ||
		typeof ciphertext !== 'string' || ciphertext.length === 0
	) {
		throw new Error('bootstrap-rendezvous-service: a stored sealed wrapper is missing its version, nonce or payload')
	}
	return { v: version as number, nonce, ciphertext }
}

/**
 * The redemption handler.
 *
 * There is deliberately **no `catch`** around the storage steps below. Every
 * storage failure must reach the dispatcher's single catch, which sends a fixed
 * body and logs only an outcome. A catch here that produced a response, a log
 * line or a replacement error is exactly how a raw error text — which can embed
 * a filesystem path — reaches a client. The single `undefined` check on the
 * stored payload is a value test, not a catch, and is the only non-fatal
 * handling of a missing artifact in this file.
 */
export const handleRedeem: RouteHandler = async (req, res, ctx) => {
	// 1. Read the body under the structural ceiling.
	let rawBody: unknown
	try {
		rawBody = await readJsonBody(req, REDEEM_REQUEST_MAX_BYTES)
	} catch (err) {
		if (err instanceof RequestBodyTooLargeError) {
			// The socket may already have been destroyed by the byte counter.
			if (!res.writableEnded && !res.destroyed) {
				// No limit disclosed: this caller is unauthenticated.
				closeWithoutDrainingBody(req, res, 413, { error: 'request too large' })
			}
			return 'too-large'
		}
		if (err instanceof RequestBodyInvalidError) {
			answer(res, 400, { error: 'bad request', reason: 'json' })
			return 'bad-request'
		}
		throw err
	}

	// 2. Validate. Nothing below this line runs for a malformed request.
	let request: RedeemRequestBody
	try {
		request = parseRedeemRequest(rawBody)
	} catch (err) {
		if (err instanceof RedeemRequestInvalidError) {
			answer(res, 400, { error: 'bad request', reason: err.reason })
			return 'bad-request'
		}
		throw err
	}
	const lookupId = request.lookupId

	// 3. The single store instance the dispatcher built at startup.
	const stores = ctx.store

	// 4. `unknown` — an unrecognised look-up id is a normal refusal, never a
	// throw, and it short-circuits before anything is claimed or served.
	const record = await stores.getRecord(lookupId)
	if (record === undefined) {
		answer(res, 200, { status: 'unknown' })
		return 'unknown'
	}

	// 5. `expired` — a RAW STRING comparison of two 19-character canonical
	// datetimes; canonical form sorts lexicographically. A stored value that
	// fails the guard is a corrupt store rather than a refusal, so the throw is
	// allowed to propagate to the dispatcher's fixed 500. It happens before the
	// claim, so no code is burned by it.
	const expiresAt = assertCanonicalBootstrapDatetime(record.expiresAt, 'handleRedeem')
	const nowCanonical = new Date().toISOString().slice(0, 19)
	if (!(expiresAt > nowCanonical)) {
		answer(res, 200, { status: 'expired' })
		return 'expired'
	}

	// 6a. `used` from the durable flag. This is the precision fact that lets a
	// late attempt answer `used` rather than degrading to `unknown`. It is
	// explicitly NOT the exclusion primitive: two concurrent requests both read
	// `false` here. Deleting 6b because "6a already handles used" reopens the
	// race.
	if (record.used) {
		answer(res, 200, { status: 'used' })
		return 'used'
	}

	// 6b. The exclusion primitive: link(2)'s atomic EEXIST. Nothing may be read
	// out of the payload store above this line.
	const claimed = await claimSingleUse(stores.claimsDir, lookupId)
	if (!claimed) {
		answer(res, 200, { status: 'used' })
		return 'used'
	}

	// 7. Read the payload. `undefined` here is the revoke race: a concurrent
	// second mint deleted this code's payload and record between step 4 and
	// now. It is answered as a refusal and never thrown.
	//
	// `unknown` rather than `used` is deliberate. The code was SUPERSEDED by a
	// new mint, and the "not recognised" copy tells the holder to ask the
	// officer for the current code, which is the correct next action. `used`
	// would say "already used", which is false and sends the holder down the
	// wrong path.
	//
	// The record may already be gone, so the record is deliberately NOT marked
	// here — marking throws when there is nothing to mark. The claim is spent
	// regardless: at-most-once, as documented above.
	const storedDocument = await stores.getCiphertext(lookupId)
	if (storedDocument === undefined) {
		answer(res, 200, { status: 'unknown' })
		return 'unknown'
	}
	const sealed = projectSealedWrapper(storedDocument)

	// 8. Erase, BEFORE the response is written, so the erasure is a completed
	// fact rather than a race with the client and a lost response cannot leave a
	// servable blob behind. This is the "payload early, record later" ordering,
	// and it matches the revoke path, which also erases the payload first. If
	// this throws, the dispatcher answers 500; the code is already burned by the
	// claim, and the retention sweep reclaims the blob at expiry, so the
	// residual is bounded by the ten-minute code span.
	await stores.deleteCiphertext(lookupId)

	// 9. Mark the record. The failure analysis, recorded so nobody "hardens"
	// this into a swallow: if it throws, the response is a 500, the payload is
	// already gone, and the NEXT attempt still answers `used` — because the
	// claim marker, not the flag, is the single-use fact. The flag is the
	// redundancy that keeps the answer precise after the sweep, and both
	// directions of that redundancy are asserted by the single-use spec.
	await stores.markRecordUsed(lookupId)

	// 10. Serve. The look-up id is not echoed; the client already has it.
	answer(res, 200, { status: 'ok', sealed })
	return 'ok'
}
