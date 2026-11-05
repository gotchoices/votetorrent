import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { IBootstrapTransport, BootstrapRedemptionResult } from './bootstrap-transport.js'
import { assertCanonicalBootstrapDatetime } from './bootstrap-transport.js'
import type { SealedPayload } from './sealed-payload.js'

/**
 * filesystem-bootstrap-transport.ts — the D-06 Node-only filesystem
 * binding, `IBootstrapTransport`'s FIRST real binding (the second is the
 * pull-based REST binding, `rest-bootstrap-transport.ts`).
 *
 * **The bundling exclusion.** This module imports `node:fs/promises` and
 * is therefore NOT bundleable by React Native or by a browser. It must NOT
 * be added to `src/bootstrap/index.ts`, must NOT get an index re-export,
 * and must NOT become reachable from the package root barrel. Consumers
 * import the deep path
 * (`.../src/bootstrap/filesystem-bootstrap-transport.js`) directly. In
 * Phase 50 the only consumer is this package's own conformance suite.
 *
 * **On-disk layout — a locked contract, mirrored by the conformance
 * suite's staging harness:**
 *   - `{rootDir}/codes/{code}.json` — the code record: the code's
 *     `expiresAt` (19-char canonical, no `Z`) and the snapshot filename it
 *     grants.
 *   - `{rootDir}/snapshots/{name}.json` — a serialized SEALED WRAPPER
 *     (`{v, nonce, ciphertext}`): the 50-02 envelope sealed under the
 *     `contentKey` derived from that code's secret (D-04/D-05). It is NOT a
 *     serialized envelope, and this module never turns it back into one.
 *   - `{rootDir}/redeemed/{code}.marker` — the single-use marker. Its
 *     EXISTENCE is the single-use fact.
 *
 * **The trust posture, stated as a negative.** This module verifies
 * nothing and decides nothing about a snapshot's content. It couriers
 * whatever the staging side placed on disk unchanged; the consumer's
 * unseal -> parse -> `verifySnapshot({ expectedDigest })` sequence, run
 * entirely ABOVE this seam, is the whole trust anchor. Since
 * the document on disk is sealed under a key this binding never derives, it
 * now CANNOT inspect what it couriers even if it wanted to — the strictest
 * form of the posture this paragraph already claimed. No sentence in this
 * file claims any scope is enforced here.
 */

/** Validates an untrusted identifier before it is ever used to construct a
 * filesystem path. Rejects anything that is `'.'`, `'..'`, or contains
 * `'..'` as a substring, in addition to the character-class check. A
 * bootstrap code is attacker-supplied text that becomes a path segment;
 * this guard runs before every `join()` involving it, with no exceptions. */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

function assertSafeBootstrapIdentifier (value: string, label: string): void {
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new Error(
      `FilesystemBootstrapTransport: ${label} may not be '.', '..', or contain a '..' path-traversal segment (got: ${JSON.stringify(value)})`
    )
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `FilesystemBootstrapTransport: ${label} must match ${SAFE_IDENTIFIER_PATTERN.toString()} (got: ${JSON.stringify(value)})`
    )
  }
}

function isEnoent (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function isEexist (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

/** A random-enough discriminator for a temp filename so two concurrent
 * writers never collide on the temp name itself. Uses only globals
 * (`process`, `Date`, `Math`) — no extra import is warranted for this. */
function randomDiscriminator (): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** The on-disk `codes/{code}.json` shape. */
interface CodeRecord {
  /** 19-char canonical datetime, no `Z` suffix. */
  expiresAt: string
  /** The `snapshots/{snapshotFile}.json` filename this code grants
   * (without directory components — validated as a safe identifier
   * before every `join()`). */
  snapshotFile: string
}

export interface FilesystemBootstrapTransportOptions {
  rootDir: string
}

/**
 * `FilesystemBootstrapTransport` — the D-06 Node-only filesystem binding.
 * See the module header above for the on-disk layout, the trust posture,
 * and the RN/browser-bundling exclusion this class is built around.
 */
export class FilesystemBootstrapTransport implements IBootstrapTransport {
  private readonly rootDir: string
  private readonly codesDir: string
  private readonly snapshotsDir: string
  private readonly redeemedDir: string

  constructor (options: FilesystemBootstrapTransportOptions) {
    this.rootDir = options.rootDir
    this.codesDir = join(this.rootDir, 'codes')
    this.snapshotsDir = join(this.rootDir, 'snapshots')
    this.redeemedDir = join(this.rootDir, 'redeemed')
  }

  /**
   * Redeem a bearer bootstrap code. `code` is attacker-supplied text and is
   * validated BEFORE any filesystem call.
   *
   * Order of checks: unknown (no code record) -> expired (canonical
   * `expiresAt` not strictly in the future) -> used (the single-use marker
   * already exists) -> ok (the granted SEALED document is read and returned
   * verbatim, unopened).
   */
  async redeem (code: string): Promise<BootstrapRedemptionResult> {
    assertSafeBootstrapIdentifier(code, 'code')

    let record: CodeRecord
    try {
      const raw = await readFile(join(this.codesDir, `${code}.json`), 'utf8')
      record = JSON.parse(raw) as CodeRecord
    } catch (err) {
      if (isEnoent(err)) {
        // An unknown code is a normal refusal, not a fault — never throw.
        return { status: 'unknown' }
      }
      throw err
    }

    const expiresAt = assertCanonicalBootstrapDatetime(record.expiresAt, 'FilesystemBootstrapTransport.redeem')
    const nowCanonical = new Date().toISOString().slice(0, 19)
    // Raw string comparison — canonical form sorts lexicographically. Never
    // route either side through a Date-parsing conversion.
    if (!(expiresAt > nowCanonical)) {
      return { status: 'expired' }
    }

    const claimed = await this.claimSingleUse(code)
    if (!claimed) {
      return { status: 'used' }
    }

    assertSafeBootstrapIdentifier(record.snapshotFile, 'code record snapshotFile')
    const snapshotPath = join(this.snapshotsDir, `${record.snapshotFile}.json`)
    let text: string
    try {
      text = await readFile(snapshotPath, 'utf8')
    } catch {
      // Each call reads exactly one named document, so there is nothing to
      // skip past: a malformed or absent granted document is a thrown
      // Error, not a silent skip. The filename only — never document
      // content.
      throw new Error(`FilesystemBootstrapTransport.redeem: could not read the granted sealed payload document ${record.snapshotFile}.json`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // The filename only — never the document text. The document is a
      // sealed wrapper whose ciphertext covers registrant PII.
      throw new Error(`FilesystemBootstrapTransport.redeem: could not parse the granted sealed payload document ${record.snapshotFile}.json`)
    }
    // A CAST, NOT A VALIDATION — and deliberately so (seam rule 5). This
    // binding deserialized its own on-disk encoding and stops there. No
    // field check on the wrapper belongs here: `unsealPayload`, above the
    // seam, validates and owns the `malformed-wrapper` refusal.
    return { status: 'ok', sealed: parsed as SealedPayload }
  }

  /**
   * Claims the single-use marker for `code` atomically: writes the marker
   * body to a temp path in the SAME directory, then publishes it with
   * `link()`. `link()`'s `EEXIST` is the race-free claim — it fails if
   * another redemption already published the marker, and it publishes the
   * fully-written file in one indivisible step, so a reader can never
   * observe a partial marker.
   *
   * `rename()` is never used to publish: `rename()` silently OVERWRITES,
   * which would turn the single-use claim into a no-op and make a replayed
   * code succeed. `writeFile` is never used directly to the final path.
   *
   * Returns `true` if this call claimed the marker, `false` if it was
   * already claimed.
   */
  private async claimSingleUse (code: string): Promise<boolean> {
    await mkdir(this.redeemedDir, { recursive: true })
    const finalPath = join(this.redeemedDir, `${code}.marker`)
    const tmpPath = join(this.redeemedDir, `${code}.${randomDiscriminator()}.tmp`)
    try {
      // Marker body carries no timestamp — the current-instant clock read
      // in `redeem` above is this file's only one; the marker's EXISTENCE,
      // not its content, is the single-use fact.
      await writeFile(tmpPath, JSON.stringify({ code }), 'utf8')
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
}
