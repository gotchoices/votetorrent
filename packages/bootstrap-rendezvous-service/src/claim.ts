import { mkdir, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * claim.ts — the single-use claim, and the only mutual-exclusion primitive
 * this service has.
 *
 * **The load-bearing fact, in one sentence:** `link(2)`'s atomic `EEXIST` is
 * the only mutual-exclusion primitive available here, because `rename(2)` —
 * which is what `atomicWriteFile` and therefore `FileKVStore.set()` publish
 * with — silently OVERWRITES and is last-writer-wins (`atomic-write.ts:55-57`
 * admits exactly this in its own comment: "the adapter is already
 * last-writer-wins with no cross-process lock").
 *
 * Consequences, stated so no later reader has to re-derive them:
 *
 * - `FileKVStore.set()` must NEVER be used as an exclusion primitive. It is
 *   torn-write safety (temp -> fsync -> rename -> dir-fsync) and nothing more.
 *   It looks like it serialises concurrent writers. It does not. Eight
 *   concurrent `set()` calls on one key all resolve without error and leave
 *   exactly one arbitrary value behind — `test/claim.spec.ts` keeps that
 *   negative control alive on purpose.
 * - The marker's EXISTENCE, not its content, is the single-use fact. The body
 *   is written only so that `link()` has something to publish; nothing ever
 *   reads it, and nothing may ever start to.
 * - The marker is published by `link()` from a temp sibling in the SAME
 *   directory, so a reader can never observe a partially written marker.
 *
 * The idiom is reproduced verbatim in structure from
 * `packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts:205-227`.
 * That method and its helpers are module-private there (the file has no
 * `export` before line 83), so they are re-expressed here rather than imported.
 *
 * This module imports from `node:fs/promises` and `node:path` only.
 */

/**
 * The `lookupId` character class and length.
 *
 * 43 characters is unpadded base64url of a 32-byte HMAC-SHA256 output, which is
 * what the phase's KDF decision fixes `lookupId` to be. This is deliberately
 * NARROWER than `filesystem-bootstrap-transport.ts:43`'s
 * `SAFE_IDENTIFIER_PATTERN` (`/^[A-Za-z0-9_.-]{1,128}$/`): the base64url
 * charset excludes `.` and `/` entirely, so `..` is unrepresentable by
 * construction, and the fixed length removes the whole variable-length class.
 */
export const LOOKUP_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Validates an untrusted `lookupId` before it is ever used to construct a
 * filesystem path or a KV key.
 *
 * Two stages, keeping the shape of the vote-engine guard: the explicit
 * path-traversal refusal first, so the failure is named for what it is, then
 * the character-class/length check.
 *
 * The message includes the offending value. A `lookupId` is a public routing
 * identifier — the secret half is the content key, which never leaves the phone
 * or the browser — so naming it does not violate the never-log-payload rule.
 */
export function assertSafeLookupId (value: string, label: string): void {
	if (value === '.' || value === '..' || value.includes('..')) {
		throw new Error(
			`bootstrap-rendezvous-service: ${label} may not be '.', '..', or contain a '..' path-traversal segment (got: ${JSON.stringify(value)})`
		)
	}
	if (!LOOKUP_ID_PATTERN.test(value)) {
		throw new Error(
			`bootstrap-rendezvous-service: ${label} must match ${LOOKUP_ID_PATTERN.toString()} (got: ${JSON.stringify(value)})`
		)
	}
}

/** `true` when `err` is a Node `ENOENT`. */
export function isEnoent (err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** `true` when `err` is a Node `EEXIST` — the race-free "already claimed" signal. */
export function isEexist (err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

/** A random-enough discriminator for a temp filename so two concurrent writers
 * never collide on the temp name itself, before the `link()` race is even
 * decided. Uses only globals (`process`, `Date`, `Math`) — no extra import is
 * warranted for this. */
function randomDiscriminator (): string {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Claims the single-use marker for `lookupId` atomically.
 *
 * Writes the marker body to a temp path in the SAME directory, then publishes
 * it with `link()`. `link()` fails with `EEXIST` if another caller already
 * published the marker, and it publishes the fully-written file in one
 * indivisible step.
 *
 * Returns `true` if THIS call claimed the marker, `false` if it was already
 * claimed. Never throws on the already-claimed path.
 */
export async function claimSingleUse (claimsDir: string, lookupId: string): Promise<boolean> {
	assertSafeLookupId(lookupId, 'lookupId')
	await mkdir(claimsDir, { recursive: true })
	const finalPath = join(claimsDir, `${lookupId}.marker`)
	const tmpPath = join(claimsDir, `${lookupId}.${randomDiscriminator()}.tmp`)
	try {
		// Body carries no timestamp and no payload; the marker's EXISTENCE is
		// the single-use fact.
		await writeFile(tmpPath, JSON.stringify({ lookupId }), 'utf8')
		try {
			await link(tmpPath, finalPath)
			return true
		} catch (linkErr) {
			if (isEexist(linkErr)) return false
			throw linkErr
		}
	} finally {
		await unlink(tmpPath).catch((unlinkErr: unknown) => {
			if (!isEnoent(unlinkErr)) throw unlinkErr
		})
	}
}

/**
 * Deletes the claim marker for `lookupId`, swallowing `ENOENT`.
 *
 * Exists so the retention sweeper never constructs this path itself — the
 * `.marker` suffix and the guard both live here, in one place.
 */
export async function deleteClaimMarker (claimsDir: string, lookupId: string): Promise<void> {
	assertSafeLookupId(lookupId, 'lookupId')
	await unlink(join(claimsDir, `${lookupId}.marker`)).catch((err: unknown) => {
		if (!isEnoent(err)) throw err
	})
}
