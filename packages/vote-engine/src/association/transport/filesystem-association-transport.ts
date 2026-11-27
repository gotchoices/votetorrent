import { mkdir, readdir, readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssociationAttestationAnswer, AssociationRequestInit, AssociationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IAssociationRequestTransport, AssociationDecisionNotice } from './association-request-transport.js'
import { assertKnownAssociationStatus } from './association-request-transport.js'

/**
 * filesystem-association-transport.ts — the D-08 filesystem drop-file
 * binding, one of `IAssociationRequestTransport`'s TWO required real
 * bindings (this file's registration-side sibling and structural analog is
 * `packages/vote-engine/src/registration/transport/filesystem-registration-transport.ts`,
 * 48-09).
 *
 * **What this is.** D-08 requires two real bindings for the seam declared in
 * `association-request-transport.ts`, not one: this module is the
 * filesystem drop-file courier over `node:fs/promises`. The second is a
 * pull-based REST binding (`rest-association-transport.ts`, 51-06). A
 * third, peer-cluster binding is reserved-and-skipped — it is not this
 * module's concern and this module has no dependency on it.
 *
 * **The two-process split, and why.** The submit side (a voter device) stages
 * a signed document into `rootDir`. It writes a JSON file and touches
 * nothing else. The authority side *reads* staged documents
 * (`readStagedRequests` / `readStagedAttestations`) and hands each one,
 * unchanged, to the association engine, which performs the write through the
 * authority app's OWN Quereus/LevelDB connection. **The reason is a single
 * sentence: the RN app is the sole writer to its own Quereus/LevelDB handle,
 * and a shared cross-process handle is a known defect class in this project**
 * (a shared storage handle has previously contaminated `count(*)` across
 * networks). A bridge process must never open the app's database — the
 * drop-file is the only medium that crosses the process boundary.
 *
 * **The trust posture, stated as a negative.** This module verifies nothing
 * and decides nothing. A staged document is fully attacker-controlled if the
 * staging directory is writable by more than the intended submitter — a
 * document appearing in the staging directory conveys NO authority
 * whatsoever. The requester-key signature carried inside the document,
 * checked by the schema's row-level `SignatureValid` CHECK when the
 * authority-side intake performs the write, is the entire authorization gate
 * (D-02). Do not add a "looks fine" pre-filter here — anything that inspects
 * a staged document beyond shape-checking its JSON members could be mistaken
 * for validation, and this module must never become that.
 *
 * **The bundling exclusion.** This module imports `node:fs/promises` and is
 * therefore NOT bundleable by React Native. It must NOT be added to
 * `association/index.ts`, must NOT get a `transport/index.ts` barrel entry,
 * and must NOT become reachable from `@votetorrent/vote-engine`'s root
 * barrel. Consumers import the deep path
 * (`.../association/transport/filesystem-association-transport.js`)
 * directly. A barrel re-export would drag `node:fs` into the RN app bundle —
 * exactly the failure class this project has hit before (Phase 44's
 * `@peculiar` device-boot wall).
 *
 * **THREE subdirectories, not two.** `requests/`, `attestations/`,
 * `decisions/`. D-18's second message (the attestation answer) needs its own
 * staged-document shape and its own read path — mixing it into `requests/`
 * would force the shared conformance suite to branch on payload shape, which
 * D-08's "identical assertions" requirement forbids.
 *
 * No sentence in this file claims that the `'vrg'` label gates anything.
 *
 * Known limitation, accepted not ignored: none of `requests/`,
 * `attestations/`, or `decisions/` is ever pruned by this module, and a
 * staged document's full payload (real registrant PII / device attestation
 * data) sits unencrypted on disk between staging and intake. Both are
 * recorded, out-of-scope-for-this-phase findings — matching the
 * registration sibling's own accepted limitation.
 *
 * **Never log a document body, a filename containing a requester field, a
 * signature, or any registrant PII.** `skipped` below reports filenames
 * only, exactly like the registration sibling.
 */

/** Local restatement of the seam's signature union (not exported by
 * `association-request-transport.ts`, so this module redeclares it rather
 * than importing a private type — matching the registration sibling's own
 * local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * A function supplied by whoever wires this binding to a real submitter,
 * resolving the digest bytes a requester must sign over an
 * `AssociationRequestInit` + requester key (leg 1, `submitRequest`).
 *
 * This transport treats the digest as OPAQUE and computes nothing itself —
 * the injected function, not the courier, knows the schema. The bytes that
 * satisfy the schema's `SignatureValid` CHECK are produced by a `Digest(...)`
 * expression whose argument order is fixed by the schema; if this function's
 * field order does not match that CHECK field-for-field, every staged
 * request will be accepted by this module and then rejected at write time,
 * a phase away from its cause.
 *
 * This function must read `SubmittedAt` from `init.submittedAt` and nowhere
 * else — it belongs to the submitter, so a digest function (or this courier)
 * that substitutes a clock reading would sign one value and store another.
 */
export type RequestDigestFn = (init: AssociationRequestInit, requesterKey: string) => Promise<Uint8Array>

/**
 * The leg-2 counterpart of `RequestDigestFn`, resolving the digest bytes a
 * requester must sign over an `AssociationAttestationAnswer` + requester key
 * (D-18's distinct second message). Kept as a SEPARATE injected function,
 * never folded into `RequestDigestFn`, because the two legs assert
 * structurally different things and sign different digest tuples.
 */
export type AttestationDigestFn = (answer: AssociationAttestationAnswer, requesterKey: string) => Promise<Uint8Array>

/**
 * The on-disk submit-side JSON shape written into `requests/`.
 *
 * `version` exists so a future shape change is a detectable skip rather than
 * a silent misparse — an unknown `version` is skipped, never coerced.
 *
 * The line an executor is most likely to blur: `stagedAt` is this courier's
 * own write-time marker and is in NO digest; `init.submittedAt` is the
 * submitter's signed instant. They are different values with different
 * owners, they may legitimately differ, and neither may ever be substituted
 * for the other.
 */
export interface StagedAssociationRequestDocument {
  version: 1
  requestId: string
  init: AssociationRequestInit
  requesterKey: string
  signature: Signature
  /** This courier's own write-time marker, ISO-Z. In NO digest. */
  stagedAt: string
}

/**
 * The on-disk submit-side JSON shape written into `attestations/` — D-18's
 * distinct second message. Deliberately NOT merged into
 * `StagedAssociationRequestDocument`: the two legs assert structurally
 * different things (an ask vs. an attestation answer) and this seam's
 * conformance suite asserts each SEPARATELY.
 */
export interface StagedAttestationDocument {
  version: 1
  requestId: string
  answer: AssociationAttestationAnswer
  requesterKey: string
  signature: Signature
  /** This courier's own write-time marker, ISO-Z. In NO digest. */
  stagedAt: string
}

/**
 * The on-disk authority-side JSON shape written into `decisions/`.
 *
 * `status` reuses the vote-core `AssociationRequestStatus` union so a
 * binding cannot invent a fifth status code. `challengeNonce` is present
 * ONLY on a `'c'` (challenge issued) notice — it is how the voter learns the
 * nonce it must attest against. `reason` carries the recorded rejection
 * reason on an `'r'` decision.
 */
export interface AssociationDecisionDocument {
  version: 1
  requestId: string
  status: AssociationRequestStatus
  challengeNonce?: string
  reason?: string
  /** ISO-Z. The authority's own decision-time marker. */
  decidedAt: string
}

/** What `readStagedRequests` yields: the parsed `StagedAssociationRequestDocument`
 * plus the cursor (its allocated sequence number, as a string) it was read at. */
export interface StagedAssociationRequest extends StagedAssociationRequestDocument {
  cursor: string
}

/** What `readStagedAttestations` yields: the parsed `StagedAttestationDocument`
 * plus the cursor it was read at. */
export interface StagedAttestation extends StagedAttestationDocument {
  cursor: string
}

/**
 * The authority-side half of the protocol — deliberately NOT declared on
 * `IAssociationRequestTransport`, because that interface is the
 * SUBMITTER's view.
 *
 * This interface is transport-agnostic despite living in the filesystem
 * module for now. The REST binding (`rest-association-transport.ts`) does
 * NOT need to implement it — the authority-side intake for the REST binding
 * lives in whatever dev-only bridge server serves those endpoints, not in
 * the client-facing `RestAssociationTransport` class. A future P2P binding
 * that DOES need this shape must IMPORT it rather than re-declare it,
 * exactly as `p2p-registration-transport.ts:56-60` imports its registration
 * counterpart: two declarations would let the shared conformance suite's
 * branches drift apart, which is precisely the outcome D-08's
 * one-suite/two-bindings requirement exists to prevent.
 */
export interface IAssociationRequestIntake {
  /** The authority-side intake read for leg 1. A caller hands each result to
   * the association engine's submit-request method, passing the
   * already-resolved `Signature`, never a callback, because the authority
   * does not hold and must never hold the requester's key. */
  readStagedRequests(sinceCursor?: string): Promise<StagedAssociationRequest[]>
  /** The authority-side intake read for leg 2 (D-18). */
  readStagedAttestations(sinceCursor?: string): Promise<StagedAttestation[]>
  /** Publishes a decision outcome (including a `'c'` challenge-issued
   * notice), resolving to the allocated cursor. */
  publishDecision(decision: Omit<AssociationDecisionDocument, 'version'>): Promise<string>
}

export interface FilesystemTransportOptions {
  /** Root directory. `requests/`, `attestations/`, and `decisions/`
   * subdirectories are created under it on demand. */
  rootDir: string
  /** Injected digest function used only when `submitRequest` is given a
   * signing callback instead of an already-resolved `Signature`. */
  computeDigest?: RequestDigestFn
  /** Injected digest function used only when `submitAttestation` is given a
   * signing callback instead of an already-resolved `Signature`. */
  computeAttestationDigest?: AttestationDigestFn
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
      `FilesystemAssociationTransport: ${label} may not be '.', '..', or contain a '..' path-traversal segment (got: ${JSON.stringify(value)})`
    )
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `FilesystemAssociationTransport: ${label} must match ${SAFE_IDENTIFIER_PATTERN.toString()} (got: ${JSON.stringify(value)})`
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
 * `FilesystemAssociationTransport` — the D-08 filesystem drop-file binding.
 * See the module header above for the two-process split, the trust posture,
 * the three-subdirectory layout, and the RN-bundling exclusion this class is
 * built around.
 */
export class FilesystemAssociationTransport implements IAssociationRequestTransport, IAssociationRequestIntake {
  /** Filenames skipped while reading any of the three directories, and why.
   * A caller reporting sync errors must surface the filename ONLY, never a
   * document value — a staged payload is registrant PII / device attestation
   * data.
   *
   * WR-10: this array reports the MOST RECENT read only — it is cleared at
   * the head of every `readDocuments` pass (i.e. of every
   * `readStagedRequests` / `readStagedAttestations` / `pollDecisions` call).
   * Read it immediately after the read call that produced it; do not treat
   * it as a running log — matching the registration sibling's documented
   * rationale verbatim. */
  public readonly skipped: Array<{ file: string; reason: string }> = []

  private readonly rootDir: string
  private readonly computeDigest?: RequestDigestFn
  private readonly computeAttestationDigest?: AttestationDigestFn
  private readonly requestsDir: string
  private readonly attestationsDir: string
  private readonly decisionsDir: string

  constructor (options: FilesystemTransportOptions) {
    this.rootDir = options.rootDir
    this.computeDigest = options.computeDigest
    this.computeAttestationDigest = options.computeAttestationDigest
    this.requestsDir = join(this.rootDir, 'requests')
    this.attestationsDir = join(this.rootDir, 'attestations')
    this.decisionsDir = join(this.rootDir, 'decisions')
  }

  /** Creates all three subdirectories if they do not exist. Idempotent.
   * Called at the head of every other public method so a caller cannot
   * forget it. */
  async ensureLayout (): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true })
    await mkdir(this.attestationsDir, { recursive: true })
    await mkdir(this.decisionsDir, { recursive: true })
  }

  /**
   * Stages a signed association request document (leg 1). This transport
   * never receives, derives, or persists key material: it holds either a
   * finished `Signature` or a callback (D-01/D-08).
   *
   * `init.submittedAt` is copied through byte-for-byte: this module must
   * never generate, default, normalise, re-format, round, or otherwise "fix"
   * it, and must never fall back to a clock when it is absent — an `init`
   * without a usable `submittedAt` is a caller error, not something to
   * repair here. A courier that rewrote that field would invalidate a
   * signature it never touched, and the failure would surface as a
   * `SignatureValid` CHECK rejection at write time with nothing at the crime
   * scene.
   */
  async submitRequest (
    init: AssociationRequestInit,
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
          'FilesystemAssociationTransport.submitRequest: a signing callback was supplied but no computeDigest option was injected at construction'
        )
      }
      const digest = await this.computeDigest(init, requesterKey)
      signature = await signatureOrCallback(digest)
    } else {
      signature = signatureOrCallback
    }

    const doc: StagedAssociationRequestDocument = {
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
   * Stages a signed attestation-answer document (leg 2, D-18). Not a widened
   * `submitRequest` — a distinct second message with its own digest tuple
   * and its own staged shape, written into a THIRD subdirectory.
   *
   * `answer.requestId` is the identifier used for path safety and for the
   * filename, before any filesystem call. `answer` is copied through
   * verbatim, exactly as `init` is on leg 1.
   */
  async submitAttestation (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    // Path safety BEFORE any filesystem call whatsoever — including
    // ensureLayout below.
    assertSafeIdentifier(answer.requestId, 'answer.requestId')
    await this.ensureLayout()

    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      if (!this.computeAttestationDigest) {
        throw new Error(
          'FilesystemAssociationTransport.submitAttestation: a signing callback was supplied but no computeAttestationDigest option was injected at construction'
        )
      }
      const digest = await this.computeAttestationDigest(answer, requesterKey)
      signature = await signatureOrCallback(digest)
    } else {
      signature = signatureOrCallback
    }

    const doc: StagedAttestationDocument = {
      version: 1,
      requestId: answer.requestId,
      answer,
      requesterKey,
      signature,
      // This courier's own write-time marker. In NO digest.
      stagedAt: new Date().toISOString()
    }
    await this.writeDocumentAtomically(this.attestationsDir, answer.requestId, doc)
  }

  /**
   * Pull model — the authority calls out and polls; it hosts no inbound
   * listener (matching the seam's own documented reasoning). Cursors
   * advance monotonically; a caller passing a STALE cursor gets
   * re-delivery, which is explicitly the correct failure mode — the
   * contract permits duplicates and forbids loss, so a caller must be
   * idempotent on `requestId`.
   */
  async pollDecisions (sinceCursor?: string): Promise<AssociationDecisionNotice[]> {
    await this.ensureLayout()
    const docs = await this.readDocuments(this.decisionsDir, sinceCursor)
    const notices: AssociationDecisionNotice[] = []
    for (const { seq, file, body } of docs) {
      const requestId = body.requestId
      const status = body.status
      const decidedAt = body.decidedAt
      if (typeof requestId !== 'string' || typeof status !== 'string' || typeof decidedAt !== 'string') {
        this.skipped.push({ file, reason: 'decision document missing a required member' })
        continue
      }
      const reason = typeof body.reason === 'string' ? body.reason : undefined
      const challengeNonce = typeof body.challengeNonce === 'string' ? body.challengeNonce : undefined
      // WR-10: the seam's shared status guard. This THROWS rather than
      // joining the `skipped` accumulator above, and the asymmetry is
      // deliberate: a document missing a member is one malformed file to
      // step over, while an unknown status CODE means the producer and the
      // schema disagree about the vocabulary — every subsequent notice from
      // that producer would be mis-decided the same way. The REST binding
      // makes exactly this call too, which is what D-08's "one shared
      // conformance suite with identical assertions" actually requires.
      const knownStatus = assertKnownAssociationStatus(status, 'FilesystemAssociationTransport.pollDecisions')
      notices.push({
        requestId,
        status: knownStatus,
        challengeNonce,
        reason,
        cursor: seq
      })
    }
    return notices
  }

  /**
   * The authority-side intake read for leg 1. This module opens no
   * database — the caller hands each result to the association engine,
   * which runs the write through the app's OWN database connection.
   */
  async readStagedRequests (sinceCursor?: string): Promise<StagedAssociationRequest[]> {
    await this.ensureLayout()
    const docs = await this.readDocuments(this.requestsDir, sinceCursor)
    const result: StagedAssociationRequest[] = []
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
        init: init as AssociationRequestInit,
        requesterKey,
        signature: signature as Signature,
        stagedAt,
        cursor: seq
      })
    }
    return result
  }

  /**
   * The authority-side intake read for leg 2 (D-18). Mirrors
   * `readStagedRequests` exactly, reading `attestations/` instead of
   * `requests/` and parsing the `answer` member instead of `init`.
   */
  async readStagedAttestations (sinceCursor?: string): Promise<StagedAttestation[]> {
    await this.ensureLayout()
    const docs = await this.readDocuments(this.attestationsDir, sinceCursor)
    const result: StagedAttestation[] = []
    for (const { seq, file, body } of docs) {
      const requestId = body.requestId
      const answer = body.answer
      const requesterKey = body.requesterKey
      const signature = body.signature
      const stagedAt = body.stagedAt
      if (
        typeof requestId !== 'string' ||
        answer === null || typeof answer !== 'object' ||
        typeof requesterKey !== 'string' ||
        signature === null || typeof signature !== 'object' ||
        typeof stagedAt !== 'string'
      ) {
        this.skipped.push({ file, reason: 'staged attestation document missing a required member' })
        continue
      }
      result.push({
        version: 1,
        requestId,
        answer: answer as AssociationAttestationAnswer,
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
  async publishDecision (decision: Omit<AssociationDecisionDocument, 'version'>): Promise<string> {
    assertSafeIdentifier(decision.requestId, 'decision.requestId')
    await this.ensureLayout()
    const doc: AssociationDecisionDocument = { version: 1, ...decision }
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
      `FilesystemAssociationTransport: exhausted ${MAX_WRITE_ATTEMPTS} sequence-allocation attempts writing '${requestId}' into ${dirPath}`
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
    // WR-10: `skipped` reports THIS read, not every read since construction. Cleared here — the
    // single funnel every read path (`readStagedRequests`, `readStagedAttestations`,
    // `pollDecisions`) goes through — rather than in each of them, so a future fourth read path
    // cannot forget it. `skipped` is `readonly` (the reference, not the contents), so the length
    // reset is the correct idiom; reassigning it would break every caller holding the array.
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
