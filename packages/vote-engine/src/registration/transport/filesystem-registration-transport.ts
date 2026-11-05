import { mkdir, readdir, readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IRegistrationRequestTransport, RegistrationDecisionNotice } from './registration-request-transport.js'
import { assertKnownRegistrationStatus } from './registration-request-transport.js'

/**
 * filesystem-registration-transport.ts — the D-01 filesystem drop-file
 * binding, `IRegistrationRequestTransport`'s FIRST real binding.
 *
 * **What this is.** D-01 requires two real bindings for the seam declared in
 * `registration-request-transport.ts`, not one: this module is the first —
 * a filesystem drop-file courier over `node:fs/promises`. The second is a
 * pull-based REST binding (48-10). A third, peer-cluster binding exists and
 * is `code-complete, unverified` (D-11) — it is not this module's concern
 * and this module has no dependency on it.
 *
 * **The two-process split, and why.** The submit side (a voter device or a
 * bulk-import bridge) *stages* a signed request document into `rootDir`. It
 * writes a JSON file and touches nothing else. The authority side *reads*
 * staged documents (`readStagedRequests`) and hands each one, unchanged, to
 * `RegistrationEngine.submitRegistrationRequest`, which performs the INSERT
 * through the authority app's OWN Quereus/LevelDB connection. **The reason
 * is a single sentence: the RN app is the sole writer to its own
 * Quereus/LevelDB handle, and a shared cross-process handle is a known
 * defect class in this project** (a shared storage handle has previously
 * contaminated `count(*)` across networks). A bridge process must never open
 * the app's database — the drop-file is the only medium that crosses the
 * process boundary.
 *
 * **The trust posture, stated as a negative.** This module verifies nothing
 * and decides nothing. A staged document is fully attacker-controlled if the
 * staging directory is writable by more than the intended submitter — a
 * document appearing in the staging directory conveys NO authority
 * whatsoever. The requester-key signature carried inside the document,
 * checked by the schema's row-level `SignatureValid` CHECK when the
 * authority-side intake performs the INSERT, is the entire authorization
 * gate (D-02). Do not add a "looks fine" pre-filter here — anything that
 * inspects a staged document beyond shape-checking its JSON members could be
 * mistaken for validation, and this module must never become that.
 *
 * **The bundling exclusion.** This module imports `node:fs/promises` and is
 * therefore NOT bundleable by React Native. It must NOT be added to
 * `registration/index.ts`, must NOT get a `transport/index.ts` barrel, and
 * must NOT become reachable from `@votetorrent/vote-engine`'s root barrel.
 * Consumers import the deep path
 * (`.../registration/transport/filesystem-registration-transport.js`)
 * directly. A barrel re-export would drag `node:fs` into the RN app bundle —
 * exactly the failure class this project has hit before.
 *
 * No sentence in this file claims that the `'vrg'` label gates anything.
 *
 * Known limitation, accepted not ignored: neither `requests/` nor
 * `decisions/` is ever pruned by this module, and a staged document's full
 * `RegisterInit` (real registrant PII) sits unencrypted on disk between
 * staging and intake. Both are recorded, out-of-scope-for-this-phase
 * findings — see the plan's threat model (T-48-09-07, T-48-09-08).
 */

/** Local restatement of the seam's signature union (not exported by
 * `registration-request-transport.ts`, so this module redeclares it rather
 * than importing a private type — matching `local-authority-transport.ts`'s
 * own local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * A function supplied by whoever wires this binding to a real submitter,
 * resolving the digest bytes a requester must sign over a
 * `RegistrationRequestInit` + requester key.
 *
 * 1. This transport treats the digest as OPAQUE and computes nothing
 *    itself — the injected function, not the courier, knows the schema.
 * 2. The remaining hazard, unchanged: the bytes that satisfy the schema's
 *    `SignatureValid` CHECK are produced by a `Digest(...)` expression whose
 *    argument order is fixed by the schema. If this function's field order
 *    does not match that CHECK field-for-field, every staged request will be
 *    accepted by this module and then rejected at INSERT time, and the
 *    failure will surface a phase away from its cause.
 * 3. The hazard that is closed, and must not be re-opened: this function
 *    must read `SubmittedAt` from `init.submittedAt` and nowhere else.
 *    Earlier the timestamp was generated authority-side at INSERT, so a
 *    staged offline signature could never verify — the submitter could not
 *    know the value. It now belongs to the submitter, so a digest function
 *    (or this courier) that substitutes a clock reading would sign one value
 *    and store another, resurrecting exactly the defect this shape was
 *    changed to remove.
 */
export type RequestDigestFn = (init: RegistrationRequestInit, requesterKey: string) => Promise<Uint8Array>

/**
 * The on-disk submit-side JSON shape written into `requests/`.
 *
 * `version` exists so a future shape change is a detectable skip rather than
 * a silent misparse — an unknown `version` is skipped, never coerced.
 *
 * The line an executor is most likely to blur: `stagedAt` is this courier's
 * own write-time marker and is in NO digest; `init.submittedAt` is the
 * submitter's signed instant and is inside DG-1. They are different values
 * with different owners, they may legitimately differ, and neither may ever
 * be substituted for the other.
 */
export interface StagedRequestDocument {
  version: 1
  requestId: string
  init: RegistrationRequestInit
  requesterKey: string
  signature: Signature
  /** This courier's own write-time marker, ISO-Z. In NO digest. */
  stagedAt: string
}

/**
 * The on-disk authority-side JSON shape written into `decisions/`.
 *
 * `status` reuses the vote-core `RegistrationRequestStatus` union so a
 * binding cannot invent a fourth status code. `reason` carries the recorded
 * rejection reason on an `'r'` decision (D-06).
 */
export interface DecisionDocument {
  version: 1
  requestId: string
  status: RegistrationRequestStatus
  reason?: string
  /** ISO-Z. The authority's own decision-time marker. */
  decidedAt: string
}

/** What `readStagedRequests` yields: the parsed `StagedRequestDocument` plus
 * the cursor (its allocated sequence number, as a string) it was read at. */
export interface StagedRequest extends StagedRequestDocument {
  cursor: string
}

/**
 * The authority-side half of the protocol — deliberately NOT declared on
 * `IRegistrationRequestTransport`, because that interface is the
 * SUBMITTER's view.
 *
 * This interface is transport-agnostic despite living in the filesystem
 * module for now. The REST binding (48-10) must IMPORT it rather than
 * re-declare it: two declarations would let the shared conformance suite's
 * two branches drift apart, which is precisely the outcome D-01's
 * one-suite/two-bindings requirement exists to prevent.
 */
export interface IRegistrationRequestIntake {
  /** The authority-side intake read. A caller hands each result to
   * `RegistrationEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)` —
   * passing the already-resolved `Signature`, never a callback, because the
   * authority does not hold and must never hold the requester's key. */
  readStagedRequests(sinceCursor?: string): Promise<StagedRequest[]>
  /** Publishes a decision outcome, resolving to the allocated cursor. */
  publishDecision(decision: Omit<DecisionDocument, 'version'>): Promise<string>
}

export interface FilesystemTransportOptions {
  /** Root directory. `requests/` and `decisions/` subdirectories are
   * created under it on demand. */
  rootDir: string
  /** Injected digest function used only when `submitRequest` is given a
   * signing callback instead of an already-resolved `Signature`. */
  computeDigest?: RequestDigestFn
}

/** Every document filename is `<seq>-<requestId>.json`, where `<seq>` is a
 * 16-digit zero-padded decimal integer. Zero-padding to a fixed width is
 * what makes lexicographic filename ordering identical to numeric ordering,
 * which is what makes the cursor a plain string comparison instead of a
 * parse — an executor who "simplifies" the padding away silently breaks
 * ordering at the 10th document. */
const SEQ_WIDTH = 16
const MAX_WRITE_ATTEMPTS = 32
const DOCUMENT_FILENAME_PATTERN = /^(\d{16})-(.+)\.json$/
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * Validates an untrusted identifier before it is ever used to construct a
 * filesystem path. Rejects anything that is `'.'`, `'..'`, or contains `'..'`
 * as a substring, in addition to the character-class check. `join()` does
 * NOT normalize away a traversal — it RESOLVES it, which is the bug — so
 * this check must run before any `join()` call, never after.
 */
function assertSafeIdentifier (value: string, label: string): void {
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new Error(
      `FilesystemRegistrationTransport: ${label} may not be '.', '..', or contain a '..' path-traversal segment (got: ${JSON.stringify(value)})`
    )
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `FilesystemRegistrationTransport: ${label} must match ${SAFE_IDENTIFIER_PATTERN.toString()} (got: ${JSON.stringify(value)})`
    )
  }
}

/** A random-enough discriminator for a temp filename so two concurrent
 * writers never collide on the temp name itself. Uses only globals
 * (`process`, `Date`, `Math`) — no extra import is warranted for this. */
function randomDiscriminator (): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isEnoent (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function isEexist (err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

interface RawDocument {
  seq: string
  file: string
  body: Record<string, unknown>
}

/**
 * `FilesystemRegistrationTransport` — the D-01 filesystem drop-file binding.
 * See the module header above for the two-process split, the trust posture,
 * and the RN-bundling exclusion this class is built around.
 */
export class FilesystemRegistrationTransport implements IRegistrationRequestTransport, IRegistrationRequestIntake {
  /** Filenames skipped while reading either directory, and why. A caller
   * reporting sync errors must surface the filename ONLY, never a document
   * value — a staged payload is registrant PII.
   *
   * WR-11: this array reports the MOST RECENT read only — it is cleared at the head of every
   * `readDocuments` pass (i.e. of every `readStagedRequests` / `pollDecisions` call). It was
   * previously a lifetime accumulator on a long-lived instance, which had two consequences on a
   * repeating sync: a permanently-malformed file was re-appended on EVERY poll, so the array grew
   * without bound; and a host mapping `skipped` into `TransportSyncReport.errorItemIds` — exactly
   * the adaptation `bulk-import-sync-model.ts` documents as intended — rendered the same item id
   * N times after N syncs. "Errors from the last sync" is the only reading that matches how the
   * value is consumed. Read it immediately after the read call that produced it; do not treat it
   * as a running log. */
  public readonly skipped: Array<{ file: string; reason: string }> = []

  private readonly rootDir: string
  private readonly computeDigest?: RequestDigestFn
  private readonly requestsDir: string
  private readonly decisionsDir: string

  constructor (options: FilesystemTransportOptions) {
    this.rootDir = options.rootDir
    this.computeDigest = options.computeDigest
    this.requestsDir = join(this.rootDir, 'requests')
    this.decisionsDir = join(this.rootDir, 'decisions')
  }

  /** Creates both subdirectories if they do not exist. Idempotent. Called
   * at the head of every other public method so a caller cannot forget it. */
  async ensureLayout (): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true })
    await mkdir(this.decisionsDir, { recursive: true })
  }

  /**
   * Stages a signed registration request document. The bridge case needs no
   * separate method: it is expressed entirely through `init.issuerType` /
   * `init.bridgeId`, which this module copies through verbatim and without
   * interpretation — one submit path, one signature discipline, regardless
   * of issuer (D-03). This transport never receives, derives, or persists
   * key material: it holds either a finished `Signature` or a callback
   * (D-01).
   *
   * `init.submittedAt` is copied through byte-for-byte alongside them: this
   * module must never generate, default, normalise, re-format, round, or
   * otherwise "fix" it, and must never fall back to a clock when it is
   * absent — an `init` without a usable `submittedAt` is a caller error, not
   * something to repair here. A courier that rewrote that field would
   * invalidate a signature it never touched, and the failure would surface
   * as a `SignatureValid` CHECK rejection at INSERT time with nothing at the
   * crime scene.
   */
  async submitRequest (
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    // Path safety BEFORE any filesystem call whatsoever — including
    // ensureLayout below.
    assertSafeIdentifier(init.id, 'init.id')
    await this.ensureLayout()

    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      if (!this.computeDigest) {
        throw new Error(
          'FilesystemRegistrationTransport.submitRequest: a signing callback was supplied but no computeDigest option was injected at construction'
        )
      }
      const digest = await this.computeDigest(init, requesterKey)
      signature = await signatureOrCallback(digest)
    } else {
      signature = signatureOrCallback
    }

    const doc: StagedRequestDocument = {
      version: 1,
      requestId: init.id,
      init,
      requesterKey,
      signature,
      // This courier's own write-time marker. Deliberately NOT init.submittedAt.
      stagedAt: new Date().toISOString()
    }
    await this.writeDocumentAtomically(this.requestsDir, init.id, doc)
    return init.id
  }

  /**
   * Pull model — the authority calls out and polls; it hosts no inbound
   * listener (matching the seam's own documented reasoning). Cursors
   * advance monotonically; a caller passing a STALE cursor gets
   * re-delivery, which is explicitly the correct failure mode — the
   * contract permits duplicates and forbids loss, so a caller must be
   * idempotent on `requestId`.
   */
  async pollDecisions (sinceCursor?: string): Promise<RegistrationDecisionNotice[]> {
    await this.ensureLayout()
    const docs = await this.readDocuments(this.decisionsDir, sinceCursor)
    const notices: RegistrationDecisionNotice[] = []
    for (const { seq, file, body } of docs) {
      const requestId = body.requestId
      const status = body.status
      const decidedAt = body.decidedAt
      if (typeof requestId !== 'string' || typeof status !== 'string' || typeof decidedAt !== 'string') {
        this.skipped.push({ file, reason: 'decision document missing a required member' })
        continue
      }
      const reason = typeof body.reason === 'string' ? body.reason : undefined
      // WR-10: the seam's shared status guard, replacing a bare `status as
      // RegistrationRequestStatus` coercion that let a drop file carrying `"approved"` or
      // `"deleted"` through as a well-typed notice whose downstream `switch (notice.status)` then
      // took no branch — a decision silently LOST, which this seam's contract forbids
      // ("re-delivery is permitted; loss is not").
      //
      // This THROWS rather than joining the `skipped` accumulator above, and the asymmetry is
      // deliberate: a document missing a member is one malformed file to step over, while an
      // unknown status CODE means the producer and the schema disagree about the vocabulary —
      // every subsequent notice from that producer would be mis-decided the same way. The REST
      // binding already made exactly this call; this binding now agrees with it, which is what
      // D-01's "one shared conformance suite with identical assertions" actually requires.
      const knownStatus = assertKnownRegistrationStatus(status, 'FilesystemRegistrationTransport.pollDecisions')
      notices.push({
        requestId,
        status: knownStatus,
        reason,
        cursor: seq
      })
    }
    return notices
  }

  /**
   * The authority-side intake read. This module opens no database — the
   * caller hands each result to
   * `RegistrationEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)`,
   * which runs the INSERT through the app's OWN database connection.
   *
   * That pre-resolved signature verifies because `SubmittedAt` is the
   * submitter's own `init.submittedAt` — the staging-time signer knew every
   * byte it signed. The engine stamps its own intake time into a separate
   * `ReceivedAt` column that is in NO digest, and rejects a `submittedAt`
   * implausibly far from it. Both the stamping and the skew bound are the
   * ENGINE's calls: this module forwards the document as it found it and
   * makes no plausibility judgement of its own — a request rejected
   * downstream for skew is a correct outcome, not a courier bug to work
   * around.
   */
  async readStagedRequests (sinceCursor?: string): Promise<StagedRequest[]> {
    await this.ensureLayout()
    const docs = await this.readDocuments(this.requestsDir, sinceCursor)
    const result: StagedRequest[] = []
    for (const { seq, file, body } of docs) {
      const requestId = body.requestId
      const init = body.init
      const requesterKey = body.requesterKey
      const signature = body.signature
      const stagedAt = body.stagedAt
      if (
        typeof requestId !== 'string' ||
        init === null || typeof init !== 'object' ||
        typeof requesterKey !== 'string' ||
        signature === null || typeof signature !== 'object' ||
        typeof stagedAt !== 'string'
      ) {
        this.skipped.push({ file, reason: 'staged request document missing a required member' })
        continue
      }
      result.push({
        version: 1,
        requestId,
        init: init as RegistrationRequestInit,
        requesterKey,
        signature: signature as Signature,
        stagedAt,
        cursor: seq
      })
    }
    return result
  }

  /** Writes a decision document (adding `version: 1`) and returns the
   * allocated cursor. */
  async publishDecision (decision: Omit<DecisionDocument, 'version'>): Promise<string> {
    assertSafeIdentifier(decision.requestId, 'decision.requestId')
    await this.ensureLayout()
    const doc: DecisionDocument = { version: 1, ...decision }
    return await this.writeDocumentAtomically(this.decisionsDir, decision.requestId, doc)
  }

  /**
   * Allocates the next sequence number, writes `body` to a same-directory
   * temp file, and publishes it via `link()` — the atomicity and
   * exclusivity primitive. `link()` fails with `EEXIST` if another writer
   * already claimed that seq, and it publishes the fully-written file in one
   * indivisible step, so a reader can never observe a partial document.
   *
   * `writeFile` is never used directly to the FINAL path, and `rename()` is
   * never used either: `rename()` silently OVERWRITES, which would turn a
   * seq collision into a LOST document rather than a retried one.
   */
  private async writeDocumentAtomically (dirPath: string, requestId: string, body: unknown): Promise<string> {
    const json = JSON.stringify(body, null, 2)
    let seq = await this.nextSeqCandidate(dirPath)

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const seqStr = seq.toString().padStart(SEQ_WIDTH, '0')
      const finalPath = join(dirPath, `${seqStr}-${requestId}.json`)
      const tmpPath = join(dirPath, `${seqStr}-${requestId}.${randomDiscriminator()}.tmp`)

      try {
        await writeFile(tmpPath, json, 'utf8')
        try {
          // link() — same directory (link() across filesystems fails).
          await link(tmpPath, finalPath)
          return seqStr
        } catch (linkErr) {
          if (isEexist(linkErr)) {
            seq += 1
            continue
          }
          throw linkErr
        }
      } finally {
        await unlink(tmpPath).catch((unlinkErr: unknown) => {
          if (!isEnoent(unlinkErr)) throw unlinkErr
        })
      }
    }

    throw new Error(
      `FilesystemRegistrationTransport: exhausted ${MAX_WRITE_ATTEMPTS} sequence-allocation attempts writing '${requestId}' into ${dirPath}`
    )
  }

  /** Reads `dirPath`, parses the leading 16-digit `<seq>` from every entry
   * ending in `.json`, and returns the candidate seq (max + 1, or 1 for an
   * empty directory). */
  private async nextSeqCandidate (dirPath: string): Promise<number> {
    const entries = await readdir(dirPath)
    let max = 0
    for (const entry of entries) {
      const match = DOCUMENT_FILENAME_PATTERN.exec(entry)
      if (!match) continue
      const n = Number(match[1])
      if (n > max) max = n
    }
    return max + 1
  }

  /**
   * Reads every `<16-digit>-<id>.json` entry in `dirPath` newer than
   * `sinceCursor` (plain string comparison — this is what the zero-padded
   * seq buys), parses it, and returns the raw parsed bodies.
   *
   * A SINGLE bad document must never take down an intake batch: an
   * unreadable file, invalid JSON, an unsafe `requestId` parsed out of the
   * filename, or an unknown/missing `version` causes that entry to be
   * SKIPPED — recorded in `skipped` (filename only, never document
   * content) — and reading continues with its siblings. This pattern alone
   * excludes in-flight `.tmp` files, since they never match the
   * `<16-digit>-<id>.json` pattern.
   */
  private async readDocuments (dirPath: string, sinceCursor?: string): Promise<RawDocument[]> {
    // WR-11: `skipped` reports THIS read, not every read since construction. Cleared here — the
    // single funnel both public read paths (`readStagedRequests`, `pollDecisions`) go through —
    // rather than in each of them, so a future third read path cannot forget it. `skipped` is
    // `readonly` (the reference, not the contents), so the length reset is the correct idiom;
    // reassigning it would break every caller holding the array.
    this.skipped.length = 0
    const entries = await readdir(dirPath)
    const candidates = entries
      .map((file) => {
        const match = DOCUMENT_FILENAME_PATTERN.exec(file)
        return match ? { file, seq: match[1]!, requestId: match[2]! } : null
      })
      .filter((c): c is { file: string; seq: string; requestId: string } => c !== null)
      .filter((c) => sinceCursor === undefined || c.seq > sinceCursor)
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

    const out: RawDocument[] = []
    for (const candidate of candidates) {
      try {
        // Site 3: a requestId parsed back out of an untrusted filename.
        assertSafeIdentifier(candidate.requestId, 'requestId (parsed from filename)')
        const raw = await readFile(join(dirPath, candidate.file), 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.version !== 1) {
          throw new Error(`unknown or missing document version: ${JSON.stringify(parsed.version)}`)
        }
        out.push({ seq: candidate.seq, file: candidate.file, body: parsed })
      } catch (err) {
        this.skipped.push({
          file: candidate.file,
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return out
  }
}
