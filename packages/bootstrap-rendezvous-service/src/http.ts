import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServiceConfig } from './config.js'
import type { LoggedOutcome, ServiceLogger } from './logging.js'
import type { RendezvousStores } from './store.js'

/**
 * http.ts — the request/response contracts every route module implements, plus
 * the two response helpers and the one body reader they all share.
 *
 * **The one rule that makes the logging property auditable:** a `RouteHandler`
 * **returns** its outcome and never logs. `server.ts` performs the single
 * logging call for every request, from one call site, which is what lets a
 * reviewer verify by inspection that no identifier can reach the log stream.
 *
 * `readJsonBody` is implemented **fully here rather than stubbed**, because
 * both the upload route (`52-08`) and the redemption route (`52-09`) need it
 * and neither may edit the other's file.
 *
 * **Note for the `52-08` author.** `readJsonBody` already gives you the
 * streaming byte ceiling. What remains for the upload gate is the
 * constant-time bearer comparison — use `node:crypto`'s `timingSafeEqual`;
 * this service is Node-only, so the React-Native-polyfill gap recorded
 * elsewhere in this project does not apply here — and mapping
 * `RequestBodyTooLargeError` to a `413` whose body names
 * `ctx.config.maxUploadBytes`.
 */

/** Everything a route handler is given besides the raw request and response. */
export interface ServiceContext {
	config: ServiceConfig
	logger: ServiceLogger
	store: RendezvousStores
}

/**
 * A route handler. It receives the **raw** `IncomingMessage` — the dispatcher
 * deliberately does not drain the body, because the upload endpoint owns its
 * own streaming size ceiling and a pre-drained body would put that ceiling in
 * the wrong file.
 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: ServiceContext) => Promise<LoggedOutcome>

/** The one JSON response shape in the service. */
export function sendJson (res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify(body))
}

/**
 * The documented not-implemented response every stub route returns. The helper
 * is permanent even though every one of its current callers is temporary.
 */
export function sendNotImplemented (res: ServerResponse): LoggedOutcome {
	sendJson(res, 501, { error: 'not implemented' })
	return 'not-implemented'
}

export class RequestBodyTooLargeError extends Error {
	readonly limitBytes: number

	constructor (limitBytes: number) {
		super(`bootstrap-rendezvous-service: request body exceeds the ${limitBytes}-byte limit`)
		this.name = 'RequestBodyTooLargeError'
		this.limitBytes = limitBytes
	}
}

export class RequestBodyInvalidError extends Error {
	constructor () {
		// A fixed message. Never the raw body: it carries the operator bearer
		// token and the sealed payload bytes.
		super('bootstrap-rendezvous-service: request body is not valid JSON')
		this.name = 'RequestBodyInvalidError'
	}
}

/**
 * Reads and parses a JSON request body under a hard byte ceiling.
 *
 * `Content-Length` is used only as an early exit — it can be absent, and it can
 * lie — so the running byte count over the actual stream is the real ceiling.
 * Once the count passes `limitBytes` the socket is destroyed rather than
 * drained, so an attacker cannot make the process hold an unbounded buffer.
 *
 * An empty body resolves to `undefined`. A malformed body rejects with
 * `RequestBodyInvalidError`, whose message never contains the body.
 */
export async function readJsonBody (req: IncomingMessage, limitBytes: number): Promise<unknown> {
	const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10)
	if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
		throw new RequestBodyTooLargeError(limitBytes)
	}

	return await new Promise<unknown>((resolve, reject) => {
		const chunks: Buffer[] = []
		let total = 0
		let settled = false

		const fail = (err: Error): void => {
			if (settled) return
			settled = true
			reject(err)
		}

		req.on('data', (chunk: Buffer) => {
			if (settled) return
			total += chunk.length
			if (total > limitBytes) {
				req.destroy()
				fail(new RequestBodyTooLargeError(limitBytes))
				return
			}
			chunks.push(chunk)
		})

		req.on('error', () => {
			fail(new Error('bootstrap-rendezvous-service: request stream failed before the body was read'))
		})

		req.on('end', () => {
			if (settled) return
			settled = true
			const raw = Buffer.concat(chunks).toString('utf8')
			if (raw.length === 0) {
				resolve(undefined)
				return
			}
			try {
				resolve(JSON.parse(raw))
			} catch {
				reject(new RequestBodyInvalidError())
			}
		})
	})
}
