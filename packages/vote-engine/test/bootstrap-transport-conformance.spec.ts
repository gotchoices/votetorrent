/**
 * bootstrap-transport-conformance.spec.ts — Phase 50 Plan 03 (D-06): the
 * shared bootstrap-transport conformance suite. Repointed at the real
 * rendezvous service by Phase 52 Plan 13 (D-27).
 *
 * ============================================================================
 * 1. WHAT THIS PROVES
 * ============================================================================
 * D-06's claim is that `IBootstrapTransport`'s real bindings are
 * INTERCHANGEABLE. The only evidence for interchangeability is that the SAME
 * assertions ran against both. This file makes that mechanically true, not
 * merely claimed: six conformance cases are written EXACTLY ONCE, inside one
 * exported function delimited by a matching pair of numbered-comment
 * sentinels (see below). That function is called exactly ONCE per entry, in
 * a loop over a two-entry binding table. Six case literals therefore produce
 * TWELVE passing tests. If an executor ever duplicates the body per binding
 * instead of sharing it, the case count inside the sentinel region rises
 * above six and the structural regression gate fails: a duplicated body is a
 * GATE FAILURE, not a style preference.
 *
 * ============================================================================
 * 1b. WHAT D-06 CHANGED
 * ============================================================================
 * Under D-06 the bindings courier SEALED WRAPPERS, not envelopes: a binding
 * returns `{ status, sealed? }` and never opens what it carries. This suite
 * therefore SEALS AT THE SOURCE — inside each factory's `stageCode`, so the
 * shared body never has to know how a binding stores things — and UNSEALS IN
 * THE SHARED BODY, through the single `openDelivered` helper that expresses
 * the consumer half of D-06 exactly once. Tampering is likewise applied at
 * the source: unseal, mutate, re-seal, write back, so what the courier
 * carries is a legitimately-sealed payload with mutated content.
 *
 * A cursor-shaped freshness/re-delivery case over a pull-style method is
 * GONE, with the method itself, under D-07. It must not come back: a keyless
 * pull has no out-of-band digest to verify against, and a shared current
 * document has no single key that opens it. The case count moved 6 → 5 when
 * that case was deleted and 5 → 6 again in `52-13` for an entirely different,
 * NEW case (see section 1c). The pull-style method itself stays deleted, and
 * a structural gate keeps its name at zero occurrences.
 *
 * ============================================================================
 * 1c. WHAT 52-13 CHANGED — THE REPOINT (D-27)
 * ============================================================================
 * **The REST binding's far side is now the real service.** From Phase 50 until
 * `52-13` this file carried a hand-written in-test HTTP receiver with a `Map`
 * behind it, and the REST binding was graded against that. A conformance suite
 * that tests a mock proves the mock — and that is exactly what let a whole
 * phase ship believing the protocol had a server, with this suite green the
 * entire time, because the only thing it ever proved was that the binding
 * agreed with a fixture written by the same hand, in the same file, on the same
 * afternoon.
 *
 * The receiver is DELETED. `makeRestBinding` now starts the real
 * `bootstrap-rendezvous-service` on an ephemeral loopback port through
 * `createTestService`, imported by relative path from that package's
 * `test/helpers/`, and drives it over a real socket with the real global
 * `fetch` through the real REST binding.
 *
 * Three consequences worth stating out loud:
 *
 *  - `stageCode` is no longer a map insertion. It derives the D-04 key split,
 *    seals the envelope, and performs a real authenticated
 *    `POST /bootstrap/uploads`. Staging can therefore FAIL, and when it does it
 *    fails loudly and names the service.
 *  - `tamperStagedTableContent` unseals, mutates, re-seals and RE-UPLOADS.
 *  - A new `corruptStagedCiphertext` flips one ciphertext character and
 *    re-uploads, which is a different failure at a different layer — see
 *    section 1d.
 *
 * **Why a relative cross-package import rather than a package specifier.** The
 * service already depends on THIS package, so naming it as a devDependency here
 * would create a workspace cycle and, worse, a build-order cycle: a package
 * specifier resolves through the service's `exports` map to its `dist/`, and
 * building that `dist/` needs this package's. The relative specifier resolves to
 * the service's TypeScript SOURCE, which ts-node transpiles in-process, so only
 * this package has to be built. (The bare package specifier is deliberately not
 * written out anywhere in this file — a structural gate in section G counts zero
 * occurrences of it, so that the deep-source imports above can never quietly be
 * replaced by barrel imports.)
 *
 * **And it does have to be built, before every run.** The spec imports the seam
 * and both bindings from SOURCE; the service, transpiled in the same process,
 * imports the same seam from this package's `dist/`. A stale `dist/` therefore
 * makes the service behave like the OLD seam while the spec exercises the NEW
 * one, with symptoms that point nowhere. The service package's
 * `test-service-factory.spec.ts` asserts the built barrel is present and
 * exports the unsealer, with a rebuild-me message, so that hour of confusion
 * costs one line instead.
 *
 * ============================================================================
 * 1d. THE TWO TAMPERING MODES ARE NOT THE SAME MODE
 * ============================================================================
 * The wrapper is AEAD-protected, with the look-up id bound in as associated
 * data. "Tampering" is therefore two genuinely different things:
 *
 *  - CONTENT TAMPERING AT THE SOURCE — the plaintext envelope is mutated and
 *    then re-sealed CORRECTLY. It unseals cleanly, parses cleanly, and is
 *    rejected by `verifySnapshot` with `digest-mismatch`. What this proves is
 *    that the TRUST ANCHOR still works: unsealing succeeded, so the payload
 *    really was sealed by someone holding the secret, and it is still refused,
 *    because the expected digest read off the phone out of band is what makes a
 *    snapshot authentic rather than merely self-consistent. Sealing adds
 *    confidentiality and changes nothing about integrity.
 *  - CIPHERTEXT CORRUPTION IN TRANSIT OR AT REST — one base64url character of
 *    `sealed.ciphertext` is replaced. The unsealer refuses with
 *    `authentication-failed` BEFORE anything is parsed. What this proves is
 *    that the SEAL works: a service that mutated a byte of the blob it holds,
 *    or a hostile operator that tried to, cannot produce anything the consumer
 *    will open.
 *
 * The corruption is length-preserving and alphabet-valid on purpose. Same
 * length means the same decoded byte count, so the structural check and the
 * nonce-length check both still pass and the refusal CANNOT be
 * `malformed-wrapper` — which the case asserts explicitly, and which is what
 * makes the observed reason a real statement about the authentication tag
 * rather than about the JSON.
 *
 * Neither binding rejects either mode. Couriers do not reject; both cases
 * assert the delivered result is `ok` and carries exactly the three wrapper
 * members.
 *
 * ============================================================================
 * 2. NO THIRD SLOT
 * ============================================================================
 * Unlike the D-01 registration seam's conformance suite there is no reserved
 * peer-cluster entry here — D-06 excludes a peer-cluster binding outright,
 * and this suite has no dependency on that layer. Both binding-table entries
 * run. There is no reserved pending entry in this file and a later reader must
 * not add one.
 *
 * ============================================================================
 * 3. DECLARED BLIND SPOT
 * ============================================================================
 * This suite proves the two real bindings agree WITH EACH OTHER, that the REST
 * binding and the REAL SERVICE agree with each other, that the service speaks
 * the locked wire protocol, and that a tampered payload stays detectable
 * through both bindings. It does NOT prove the producer's export path or the
 * consumer's commit path — those remain untested here.
 *
 * ============================================================================
 * 4. WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT
 * ============================================================================
 * Neither binding REJECTS a tampered snapshot — they are couriers. What is
 * proven is that tampering is detectable at the same point, with the same
 * evidence, through either binding, and that neither binding launders a
 * tampered payload by re-digesting the mutated content.
 *
 * ============================================================================
 * 5. NO CLAIM OF SCOPE ENFORCEMENT
 * ============================================================================
 * No sentence in this file claims that any scope is enforced in this seam.
 *
 * ============================================================================
 * 6. READING A FAILURE
 * ============================================================================
 * Three regions, deliberately layered. Which one is red decides the verdict —
 * no bisecting required.
 *
 *  - `conformance: service wire contract` RED
 *      → THE SERVICE BROKE. Look in
 *        `packages/bootstrap-rendezvous-service/src/routes/`. That block drives
 *        the service with raw `fetch` and never constructs a client binding at
 *        all, so no client code is implicated.
 *  - `service wire contract` GREEN and `conformance: rest` RED
 *      → THE CLIENT BINDING BROKE
 *        (`packages/vote-engine/src/bootstrap/rest-bootstrap-transport.ts`), or
 *        the shared case is wrong. The service answered correctly; the binding
 *        mis-sent or mis-parsed it.
 *  - `conformance: rest` AND `conformance: filesystem` RED on the SAME case
 *      → THE SHARED CASE OR THE SEAM (`bootstrap-transport.ts`), not either
 *        binding. Two independent implementations do not break identically by
 *        coincidence.
 *  - Only `conformance: filesystem` RED
 *      → THE FILESYSTEM BINDING (`filesystem-bootstrap-transport.ts`).
 *  - The `rest` harness throwing during `stageCode`, with a message opening
 *    `SERVICE WIRE (upload):`
 *      → THE SERVICE'S UPLOAD ENDPOINT. Surfaced at staging, on purpose, rather
 *        than three lines later as an inexplicable `unknown`.
 *
 * Every assertion in the shared body carries a `claim(...)` message naming the
 * binding AND what is on the far side of the courier, so a reader learns from
 * the assertion line alone whether a server was even involved.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { expect } from 'chai'
import type { IBootstrapTransport, BootstrapRedemptionResult } from '../src/bootstrap/bootstrap-transport.js'
import { FilesystemBootstrapTransport } from '../src/bootstrap/filesystem-bootstrap-transport.js'
import { RestBootstrapTransport } from '../src/bootstrap/rest-bootstrap-transport.js'
import { deriveBootstrapKeys, sealPayload, unsealPayload } from '../src/bootstrap/sealed-payload.js'
import type { BootstrapKeySplit, SealedPayload } from '../src/bootstrap/sealed-payload.js'
import { parseSnapshot } from '../src/bootstrap/snapshot-codec.js'
import { buildSnapshot, verifySnapshot } from '../src/bootstrap/snapshot-manifest.js'
import type { BootstrapSnapshot, SnapshotTables } from '../src/bootstrap/snapshot-types.js'
import {
  createTestService,
  type TestServiceHandle
} from '../../bootstrap-rendezvous-service/test/helpers/create-test-service.js'

// ---------------------------------------------------------------------------
// A. The shared fixture — ONE builder, used by both harnesses, so a
// divergence between the bindings can never hide behind two separate
// fixture constructions.
// ---------------------------------------------------------------------------

/** A distinctive registrant-PII stand-in used nowhere else in this file. */
const PII_MARKER = 'bootstrap-conformance-registrant-pii-marker'

/** Table names present in every fixture snapshot — used by the
 * error-message hygiene case. */
const FIXTURE_TABLE_NAMES = ['User', 'Network'] as const

const FIXTURE_NETWORK_HASH = 'bootstrap-conformance-fixture-network-hash'

const GENERATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

function buildFixtureTables (): SnapshotTables {
  return {
    User: [
      { Id: 'fixture-user-1', Name: PII_MARKER, Active: true }
    ],
    Network: [
      { Id: 'fixture-network-1', Hash: 'fixture-network-row-hash-1' },
      { Id: 'fixture-network-2', Hash: 'fixture-network-row-hash-2' }
    ]
  }
}

/** Builds one snapshot envelope through 50-02's own `buildSnapshot`,
 * containing two tables, one row carrying `PII_MARKER`, and a real
 * manifest, digest and schema hash. Called fresh per test so each case
 * starts from an independent envelope, while always going through this one
 * declaration — never two separately-implemented fixtures. */
function buildFixtureSnapshot (generatedAt?: string): BootstrapSnapshot {
  return buildSnapshot({
    networkHash: FIXTURE_NETWORK_HASH,
    tables: buildFixtureTables(),
    generatedAt
  })
}

/** The fixed 32-hex prefix of every conformance code; the remaining 8 hex
 * digits are the sequence counter, so successive calls differ. */
const CODE_PREFIX_HEX = 'c0de51ec7e57a1b2c3d4e5f60718293a'

let codeSeq = 0
/** A 40-character lowercase-hex code. The SHAPE is fixed, not cosmetic: the
 * REST binding derives the `lookupId` it transmits from these bytes (D-04),
 * and the filesystem binding uses the same string as a path segment. */
function nextCode (): string {
  codeSeq += 1
  return `${CODE_PREFIX_HEX}${codeSeq.toString(16).padStart(8, '0')}`
}

/** A canonical (19-char, no `Z`) datetime strictly in the past. */
function canonicalPast (): string {
  return new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)
}

/** A canonical (19-char, no `Z`) datetime far enough in the future that no
 * conformance run can outlive it. */
function canonicalFuture (): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 19)
}

/**
 * The D-04 key split for a conformance code. Hex-decoded with a LOCAL loop
 * rather than a library helper: `@noble/hashes`'s `hexToBytes` embeds two
 * characters of the offending string in its `RangeError`, and the offending
 * string here would be a bearer secret.
 */
function keysForCode (code: string): BootstrapKeySplit {
  const bytes = new Uint8Array(code.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(code.slice(i * 2, i * 2 + 2), 16)
  }
  return deriveBootstrapKeys(bytes)
}

/** Seal an envelope under a code's own `contentKey` — what a producer stages,
 * and what a courier is then given to carry unopened. */
function sealFor (code: string, envelope: BootstrapSnapshot): SealedPayload {
  return sealPayload(JSON.stringify(envelope), keysForCode(code))
}

/**
 * The D-27 attribution message. Every `expect` in the shared body passes this
 * as chai's second argument, so a red line names the binding AND what was on
 * the far side of the courier — which is how a reader tells a service defect
 * from a binding defect without bisecting.
 */
function claim (binding: ConformanceHarness, text: string): string {
  return `[${binding.label}] far side: ${binding.sideLabel} — ${text}`
}

/**
 * Replaces ONE character of a base64url string with a different, still-valid
 * base64url character, preserving length.
 *
 * Length preservation is the whole point. Same length means the same decoded
 * byte count, so the unsealer's structural check and its nonce-length check
 * both still pass and the refusal cannot be `malformed-wrapper`. The observed
 * `authentication-failed` is therefore a genuine statement about the
 * authentication tag rather than about the JSON.
 */
function corruptBase64Url (value: string): string {
  const index = Math.floor(value.length / 2)
  const original = value[index]
  const replacement = original === 'A' ? 'B' : 'A'
  const corrupted = `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
  if (corrupted === value) throw new Error('corruptBase64Url: the corruption was a no-op')
  if (corrupted.length !== value.length) throw new Error('corruptBase64Url: the corruption changed the length')
  return corrupted
}

/**
 * The CONSUMER HALF OF D-06, expressed exactly once: a delivered result
 * carries an unopened wrapper, and only the code's own key turns it back into
 * an envelope. Every case that needs an envelope goes through here, so no
 * case can accidentally assert against something a courier had already
 * opened.
 *
 * `verifySnapshot` is deliberately NOT called here — the order is unseal,
 * then parse, then verify, and the verify step belongs to the individual
 * cases that make a claim about it.
 */
function openDelivered (result: BootstrapRedemptionResult, code: string): BootstrapSnapshot {
  expect(result.sealed, 'a delivered ok result must carry a sealed payload').to.not.equal(undefined)
  const opened = unsealPayload(result.sealed, keysForCode(code))
  expect(
    opened.ok,
    `expected unsealPayload to succeed (reason if failed: ${opened.ok ? '' : opened.reason})`
  ).to.equal(true)
  const plaintext = opened.ok ? opened.plaintext : ''
  const parsed = parseSnapshot(plaintext)
  expect(
    parsed.ok,
    `expected parseSnapshot to succeed on the unsealed plaintext (reason if failed: ${parsed.ok ? '' : parsed.reason})`
  ).to.equal(true)
  if (!parsed.ok) throw new Error('unreachable: parseSnapshot failure already asserted')
  return parsed.envelope
}

// ---------------------------------------------------------------------------
// B. The harness contract — parameterize over construction, not over a bare
// transport, since the two bindings' storage shapes differ entirely
// (on-disk documents vs. a running service process).
// ---------------------------------------------------------------------------

interface StageCodeOptions {
  expiresAt: string
  snapshot: BootstrapSnapshot
}

interface ConformanceHarness {
  readonly label: string
  /**
   * The D-27 attribution carrier: a human sentence naming what is on the FAR
   * SIDE of the courier. A reader of a failure must be able to tell, from the
   * assertion message alone, whether a server was even involved — otherwise
   * "which side broke" is a paragraph rather than a mechanism.
   */
  readonly sideLabel: string
  readonly transport: IBootstrapTransport
  /** Stages a code granting `opts.snapshot`. The envelope is SEALED here,
   * inside the factory, under the code's own `contentKey` — so the shared
   * body never has to know how a binding stores things. */
  stageCode: (code: string, opts: StageCodeOptions) => Promise<void>
  /** Mutates a cell value (never the row count, the `digest`, or the
   * `manifest`) of the MOST RECENTLY staged code's snapshot, AT THE SOURCE:
   * unseal, mutate, re-seal, write back — before the courier ever sees it,
   * which is precisely what the tampering case is about. Isolates the digest
   * check: row counts stay consistent so the manifest check still passes, and
   * only the recomputed content digest disagrees with the untouched `digest`
   * field. The re-seal is CORRECT, so the failure lands at `verifySnapshot`
   * with `digest-mismatch`. Contrast `corruptStagedCiphertext` below. */
  tamperStagedTableContent: () => Promise<void>
  /** Flips one base64url character of the MOST RECENTLY staged code's
   * ciphertext, leaving the wrapper structurally perfect and the same length.
   * The authentication tag check therefore fails and the unsealer refuses with
   * `authentication-failed` BEFORE anything is parsed — a different failure, at
   * a different layer, from `tamperStagedTableContent` above. */
  corruptStagedCiphertext: () => Promise<void>
  /** Arranges for the source to fail genuinely (not merely refuse) on the
   * next `redeem` call, and returns the code to redeem to trigger it. */
  makeFailingSource: () => Promise<string>
  close: () => Promise<void>
}

interface ConformanceCase {
  label: string
  mode: 'run'
  make: () => Promise<ConformanceHarness>
}

// ---------------------------------------------------------------------------
// C. Factory 1 — filesystem.
// ---------------------------------------------------------------------------
async function makeFilesystemBinding (): Promise<ConformanceHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bootstrap-conformance-fs-'))
  const codesDir = join(rootDir, 'codes')
  const snapshotsDir = join(rootDir, 'snapshots')
  await mkdir(codesDir, { recursive: true })
  await mkdir(snapshotsDir, { recursive: true })

  const transport = new FilesystemBootstrapTransport({ rootDir })
  let snapshotFileSeq = 0
  let lastSnapshotFile: string | undefined
  let lastStagedCode: string | undefined

  return {
    label: 'filesystem',
    sideLabel: 'on-disk documents under a temp rootDir (no service process)',
    transport,
    async stageCode (code, opts) {
      snapshotFileSeq += 1
      const snapshotFile = `snap-${snapshotFileSeq}`
      // The document on disk is a SEALED WRAPPER, never an envelope — the
      // binding reads it, deserializes it, and carries it unopened.
      await writeFile(join(snapshotsDir, `${snapshotFile}.json`), JSON.stringify(sealFor(code, opts.snapshot)), 'utf8')
      await writeFile(join(codesDir, `${code}.json`), JSON.stringify({ expiresAt: opts.expiresAt, snapshotFile }), 'utf8')
      lastSnapshotFile = snapshotFile
      lastStagedCode = code
    },
    async tamperStagedTableContent () {
      if (lastSnapshotFile === undefined || lastStagedCode === undefined) {
        throw new Error('makeFilesystemBinding.tamperStagedTableContent: no snapshot has been staged yet')
      }
      const filePath = join(snapshotsDir, `${lastSnapshotFile}.json`)
      const keys = keysForCode(lastStagedCode)
      const opened = unsealPayload(JSON.parse(await readFile(filePath, 'utf8')), keys)
      if (!opened.ok) {
        throw new Error(`makeFilesystemBinding.tamperStagedTableContent: staged document would not open (${opened.reason})`)
      }
      const parsed = JSON.parse(opened.plaintext) as { tables: { User: Array<{ Name: string }> } }
      parsed.tables.User[0]!.Name = `${parsed.tables.User[0]!.Name}-tampered`
      // Re-sealed, so what the courier carries is a legitimately sealed
      // payload with mutated content — the tampering happened at the source.
      await writeFile(filePath, JSON.stringify(sealPayload(JSON.stringify(parsed), keys)), 'utf8')
    },
    async corruptStagedCiphertext () {
      if (lastSnapshotFile === undefined) {
        throw new Error('makeFilesystemBinding.corruptStagedCiphertext: no snapshot has been staged yet')
      }
      const filePath = join(snapshotsDir, `${lastSnapshotFile}.json`)
      // This mutates the WRAPPER the binding will courier, never the envelope
      // inside it — the envelope is unreachable without the key, which is
      // precisely the property being demonstrated.
      const wrapper = JSON.parse(await readFile(filePath, 'utf8')) as SealedPayload
      const corrupted: SealedPayload = {
        v: wrapper.v,
        nonce: wrapper.nonce,
        ciphertext: corruptBase64Url(wrapper.ciphertext)
      }
      await writeFile(filePath, JSON.stringify(corrupted), 'utf8')
    },
    async makeFailingSource () {
      // A corrupted (not merely absent) granted document is a genuine source
      // fault the binding cannot refuse its way past — it must throw. The
      // code and snapshot-file names below are never derived from or
      // containing one another, so neither leaks into the other's error text.
      const code = nextCode()
      const snapshotFile = 'snap-corrupted'
      await writeFile(join(snapshotsDir, `${snapshotFile}.json`), 'not valid json {{{', 'utf8')
      await writeFile(join(codesDir, `${code}.json`), JSON.stringify({ expiresAt: canonicalFuture(), snapshotFile }), 'utf8')
      return code
    },
    async close () {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// D. Factory 2 — REST, driving the REAL bootstrap-rendezvous-service (D-27).
//
// There is no receiver written in this file, and a structural gate in section
// G keeps it that way. What follows is the REAL PRODUCER FLOW against a real
// process: derive the key split, seal the envelope, and push it with the
// operator bearer token over a real socket.
// ---------------------------------------------------------------------------

interface StagedRecord {
  code: string
  expiresAt: string
  sealed: SealedPayload
}

/**
 * The authenticated push (D-17). It ASSERTS ITS OWN RESULT, loudly, and that
 * loudness is deliberate D-27 attribution: a service that cannot accept an
 * upload must fail this suite AT STAGING, with a message naming the service,
 * rather than surfacing three lines later as an inexplicable `unknown` from a
 * redemption nobody can explain.
 *
 * The message carries the observed HTTP status and nothing else — never the
 * operator token, never the ciphertext.
 */
async function uploadSealed (
  service: TestServiceHandle,
  body: { lookupId: string, expiresAt: string, sealed: SealedPayload }
): Promise<void> {
  const response = await fetch(`${service.baseUrl}/bootstrap/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${service.uploadToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  if (response.status !== 200) {
    throw new Error(
      `SERVICE WIRE (upload): the bootstrap-rendezvous-service refused a well-formed authenticated upload with status ${response.status}. Staging cannot proceed; look in the service's upload route, not in the client binding.`
    )
  }
  const acknowledgement = await response.json() as { ok?: unknown }
  if (acknowledgement.ok !== true) {
    throw new Error(
      'SERVICE WIRE (upload): the bootstrap-rendezvous-service answered 200 but the acknowledgement was not { ok: true }. Staging cannot proceed; look in the service\'s upload route, not in the client binding.'
    )
  }
}

async function makeRestBinding (): Promise<ConformanceHarness> {
  const service = await createTestService()

  // NO `headers` OPTION, on purpose. Redemption is unauthenticated by design
  // (D-17 gates the WRITE endpoint, not the read). Handing the binding the
  // operator upload token here would quietly prove the opposite of what D-17
  // says, and would mask a service that had wrongly started gating redemptions.
  const transport = new RestBootstrapTransport({ baseUrl: service.baseUrl })

  let lastStaged: StagedRecord | undefined

  /** The real producer flow: derive (D-04), seal (D-03), authenticated push
   * (D-17). Never a map insertion, and never the raw secret on the wire — only
   * the derived lookup half travels. Declared as a named local so
   * `makeFailingSource` can reuse it without reaching through `this`. */
  const stage = async (code: string, opts: StageCodeOptions): Promise<void> => {
    const keys = keysForCode(code)
    const sealed = sealFor(code, opts.snapshot)
    await uploadSealed(service, { lookupId: keys.lookupId, expiresAt: opts.expiresAt, sealed })
    lastStaged = { code, expiresAt: opts.expiresAt, sealed }
  }

  return {
    label: 'rest',
    sideLabel: `the real bootstrap-rendezvous-service at ${service.baseUrl}`,
    transport,
    stageCode: stage,
    async tamperStagedTableContent () {
      if (lastStaged === undefined) {
        throw new Error('makeRestBinding.tamperStagedTableContent: no snapshot has been staged yet')
      }
      const keys = keysForCode(lastStaged.code)
      const opened = unsealPayload(lastStaged.sealed, keys)
      if (!opened.ok) {
        throw new Error(`makeRestBinding.tamperStagedTableContent: staged payload would not open (${opened.reason})`)
      }
      const parsed = JSON.parse(opened.plaintext) as { tables: { User: Array<{ Name: string }> } }
      parsed.tables.User[0]!.Name = `${parsed.tables.User[0]!.Name}-tampered`
      const resealed = sealPayload(JSON.stringify(parsed), keys)
      // Re-uploaded under the SAME look-up id and expiry, which overwrites the
      // stored blob: the payload store publishes through an atomic rename and
      // is last-writer-wins, as `52-03` documents. Safe here only because the
      // code has not been claimed yet.
      await uploadSealed(service, { lookupId: keys.lookupId, expiresAt: lastStaged.expiresAt, sealed: resealed })
      lastStaged = { code: lastStaged.code, expiresAt: lastStaged.expiresAt, sealed: resealed }
    },
    async corruptStagedCiphertext () {
      if (lastStaged === undefined) {
        throw new Error('makeRestBinding.corruptStagedCiphertext: no snapshot has been staged yet')
      }
      // Models a service, a disk, or a network that mutated the blob it was
      // holding — or a hostile operator who tried to.
      const keys = keysForCode(lastStaged.code)
      const corrupted: SealedPayload = {
        v: lastStaged.sealed.v,
        nonce: lastStaged.sealed.nonce,
        ciphertext: corruptBase64Url(lastStaged.sealed.ciphertext)
      }
      await uploadSealed(service, { lookupId: keys.lookupId, expiresAt: lastStaged.expiresAt, sealed: corrupted })
      lastStaged = { code: lastStaged.code, expiresAt: lastStaged.expiresAt, sealed: corrupted }
    },
    async makeFailingSource () {
      // The fault is injected INSIDE the running service, through the store
      // override the service's own start options expose, so it travels the real
      // dispatcher and emerges as a real 500. It is the exact mirror of the
      // filesystem harness's corrupted on-disk document.
      //
      // Specifically NOT implemented by closing the socket: that would prove
      // the transport handles a dead endpoint, which is a different claim.
      // The code is staged normally first, so the record genuinely exists and
      // the shared case's positive control means something.
      const code = nextCode()
      await stage(code, { expiresAt: canonicalFuture(), snapshot: buildFixtureSnapshot() })
      service.failNextRecordRead()
      return code
    },
    async close () {
      // The factory owns its own temp directories and its own sweep handle.
      await service.close()
    }
  }
}

// ---------------------------------------------------------------------------
// E. The binding table — two entries, both running. No reserved slot.
// ---------------------------------------------------------------------------
const CONFORMANCE_BINDINGS: ConformanceCase[] = [
  { label: 'filesystem', mode: 'run', make: makeFilesystemBinding },
  { label: 'rest', mode: 'run', make: makeRestBinding }
]

// ---------------------------------------------------------------------------
// F. The shared body — declared once, inside sentinels.
// ---------------------------------------------------------------------------
// #region SHARED-CONFORMANCE-BODY
export function runBootstrapTransportConformance (testCase: ConformanceCase): void {
  describe('bootstrap transport conformance: ' + testCase.label, () => {
    let binding: ConformanceHarness

    beforeEach(async () => {
      // Construction happens HERE, never at describe-registration time.
      binding = await testCase.make()
    })

    afterEach(async () => {
      await binding.close()
    })

    // "Verbatim" is now a STRONGER claim than it was: the envelope is sealed
    // at the source, carried by a courier that never opens it, and unsealed
    // here — so equality below proves it survived sealing AND couriering
    // unchanged, not merely that a courier copied an object.
    it('redeems a staged code and couriers the sealed envelope through verbatim', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      const result = await binding.transport.redeem(code)
      expect(result.status, claim(binding, 'a freshly staged code must redeem ok')).to.equal('ok')
      const delivered = openDelivered(result, code)
      expect(delivered.networkHash, claim(binding, 'networkHash must survive the courier')).to.equal(snapshot.networkHash)
      expect(delivered.schemaHash, claim(binding, 'schemaHash must survive the courier')).to.equal(snapshot.schemaHash)
      expect(delivered.generatedAt, claim(binding, 'generatedAt must survive the courier')).to.equal(snapshot.generatedAt)
      expect(delivered.manifest, claim(binding, 'the manifest must survive the courier')).to.deep.equal(snapshot.manifest)
      expect(delivered.digest, claim(binding, 'the digest must survive the courier')).to.equal(snapshot.digest)
      expect(
        GENERATED_AT_PATTERN.test(delivered.generatedAt),
        claim(binding, 'generatedAt must stay canonical: 19 characters, no trailing Z')
      ).to.equal(true)

      const verified = verifySnapshot(delivered)
      expect(
        verified.ok,
        claim(binding, `expected verifySnapshot to succeed (reason if failed: ${verified.ok ? '' : verified.reason})`)
      ).to.equal(true)
    })

    it('refuses a second redemption of the same code as used, carrying no data', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      // Positive control: the first redemption succeeds.
      const first = await binding.transport.redeem(code)
      expect(first.status, claim(binding, 'the first redemption must succeed')).to.equal('ok')

      // A cheap, permanent D-04 canary: what the courier carried is a
      // WRAPPER, with exactly the three wrapper members and nothing else. An
      // envelope leaking back into this slot — or a binding "helpfully"
      // annotating the wrapper — fails here immediately.
      expect(
        Object.keys(first.sealed as unknown as Record<string, unknown>).sort(),
        claim(binding, 'the delivered wrapper must carry exactly v, nonce and ciphertext')
      ).to.deep.equal(['ciphertext', 'nonce', 'v'])

      const second = await binding.transport.redeem(code)
      expect(second.status, claim(binding, 'delivery is at-most-once: a second redemption must refuse')).to.equal('used')
      expect(second.sealed, claim(binding, 'a refusal must carry no sealed payload')).to.equal(undefined)
    })

    it('refuses expired and unknown codes with their own distinguishable reasons, alongside a fresh success', async () => {
      const expiredCode = nextCode()
      await binding.stageCode(expiredCode, { expiresAt: canonicalPast(), snapshot: buildFixtureSnapshot() })
      const expiredResult = await binding.transport.redeem(expiredCode)
      expect(expiredResult.status, claim(binding, 'a past expiry must refuse as expired')).to.equal('expired')
      expect(expiredResult.sealed, claim(binding, 'an expired refusal must carry no sealed payload')).to.equal(undefined)

      const unknownCode = nextCode() // never staged
      const unknownResult = await binding.transport.redeem(unknownCode)
      expect(unknownResult.status, claim(binding, 'a code that was never staged must refuse as unknown')).to.equal('unknown')
      expect(unknownResult.sealed, claim(binding, 'an unknown refusal must carry no sealed payload')).to.equal(undefined)

      expect(
        expiredResult.status,
        claim(binding, 'expired and unknown must stay distinguishable — D-25 gives them different copy')
      ).to.not.equal(unknownResult.status)

      // Positive control in the same test: a freshly staged code still succeeds.
      const freshCode = nextCode()
      const freshSnapshot = buildFixtureSnapshot()
      await binding.stageCode(freshCode, { expiresAt: canonicalFuture(), snapshot: freshSnapshot })
      const freshResult = await binding.transport.redeem(freshCode)
      expect(freshResult.status, claim(binding, 'a fresh code must still succeed after two refusals')).to.equal('ok')
      expect(
        openDelivered(freshResult, freshCode),
        claim(binding, 'the fresh envelope must arrive intact')
      ).to.deep.equal(freshSnapshot)
    })

    it('delivers a tampered payload unchanged and stays detectable, without laundering it', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      await binding.tamperStagedTableContent()

      const result = await binding.transport.redeem(code)
      expect(result.status, claim(binding, 'couriers do not reject: a tampered payload is still delivered')).to.equal('ok')
      const delivered = openDelivered(result, code)
      // The binding did not recompute the digest over the mutated content.
      expect(
        delivered.digest,
        claim(binding, 'the courier must not launder tampering by re-digesting mutated content')
      ).to.equal(snapshot.digest)

      const verified = verifySnapshot(delivered)
      expect(verified.ok, claim(binding, 'a tampered snapshot must fail verifySnapshot')).to.equal(false)
      expect(
        verified.ok ? '' : verified.reason,
        claim(binding, 'a correctly re-sealed but content-tampered payload fails at the DIGEST, not at the seal')
      ).to.equal('digest-mismatch')

      // Positive control: an untampered redemption from the same harness verifies clean.
      const cleanCode = nextCode()
      const cleanSnapshot = buildFixtureSnapshot()
      await binding.stageCode(cleanCode, { expiresAt: canonicalFuture(), snapshot: cleanSnapshot })
      const cleanResult = await binding.transport.redeem(cleanCode)
      const cleanVerified = verifySnapshot(openDelivered(cleanResult, cleanCode))
      expect(cleanVerified.ok, claim(binding, 'an untampered redemption must verify clean')).to.equal(true)
    })

    // THE CONTRAST WITH THE CASE ABOVE, stated once: that case proves a
    // re-sealed but content-tampered payload unseals CLEANLY and fails later,
    // at `verifySnapshot`, with `digest-mismatch` — the out-of-band expected
    // digest is the trust anchor, exactly as `snapshot-types.ts` requires. This
    // case proves a corrupted ciphertext never gets that far. Two mutations,
    // two named reasons, two layers.
    it('couriers a corrupted ciphertext unchanged and refuses it at unseal, not at the digest check', async () => {
      const code = nextCode()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot: buildFixtureSnapshot() })

      await binding.corruptStagedCiphertext()

      const result = await binding.transport.redeem(code)
      expect(result.status, claim(binding, 'couriers do not reject: a corrupted wrapper is still delivered')).to.equal('ok')
      expect(result.sealed, claim(binding, 'a delivered ok result must carry a sealed payload')).to.not.equal(undefined)
      expect(
        Object.keys(result.sealed as unknown as Record<string, unknown>).sort(),
        claim(binding, 'the courier did not open the wrapper: exactly v, nonce and ciphertext arrived')
      ).to.deep.equal(['ciphertext', 'nonce', 'v'])

      const opened = unsealPayload(result.sealed, keysForCode(code))
      expect(opened.ok, claim(binding, 'a corrupted ciphertext must not unseal')).to.equal(false)
      const reason = opened.ok ? '' : opened.reason
      expect(
        reason,
        claim(binding, 'the authentication tag check must be what fires — this is a statement about the seal')
      ).to.equal('authentication-failed')
      expect(
        reason,
        claim(binding, 'the wrapper is structurally perfect and the same length, so malformed-wrapper would mean the STRUCTURAL check fired instead of the tag check and this case would prove nothing')
      ).to.not.equal('malformed-wrapper')
      expect(
        Object.prototype.hasOwnProperty.call(opened, 'plaintext'),
        claim(binding, 'a failed unseal must carry no plaintext member at all')
      ).to.equal(false)

      // Positive control in the same test: an untampered code from the same
      // harness still opens and still verifies.
      const cleanCode = nextCode()
      const cleanSnapshot = buildFixtureSnapshot()
      await binding.stageCode(cleanCode, { expiresAt: canonicalFuture(), snapshot: cleanSnapshot })
      const cleanResult = await binding.transport.redeem(cleanCode)
      const cleanVerified = verifySnapshot(openDelivered(cleanResult, cleanCode))
      expect(cleanVerified.ok, claim(binding, 'an uncorrupted redemption must verify clean')).to.equal(true)
    })

    it('leaks neither the bearer code nor snapshot content in a source-failure error message', async () => {
      const goodCode = nextCode()
      await binding.stageCode(goodCode, { expiresAt: canonicalFuture(), snapshot: buildFixtureSnapshot() })
      // Positive control: the harness succeeds before the source is broken.
      const positiveControl = await binding.transport.redeem(goodCode)
      expect(positiveControl.status, claim(binding, 'the harness must be healthy before the fault is armed')).to.equal('ok')

      const failingCode = await binding.makeFailingSource()
      let thrown: Error | undefined
      try {
        await binding.transport.redeem(failingCode)
      } catch (err) {
        thrown = err instanceof Error ? err : new Error(String(err))
      }
      expect(thrown, claim(binding, 'a genuinely broken source must make redeem throw, not refuse')).to.not.equal(undefined)

      const message = thrown!.message
      expect(message.length, claim(binding, 'the thrown error must say something')).to.be.greaterThan(0)
      expect(message.includes(failingCode), claim(binding, 'an error must never echo the bearer code')).to.equal(false)
      expect(message.includes(PII_MARKER), claim(binding, 'an error must never echo registrant PII')).to.equal(false)
      for (const tableName of FIXTURE_TABLE_NAMES) {
        expect(
          message.includes(tableName),
          claim(binding, `an error must never name a snapshot table (${tableName})`)
        ).to.equal(false)
      }
    })
  })
}
// #endregion SHARED-CONFORMANCE-BODY

for (const testCase of CONFORMANCE_BINDINGS) runBootstrapTransportConformance(testCase)

// ---------------------------------------------------------------------------
// F2. The service wire contract (D-27).
//
// This block drives the RUNNING SERVICE with the raw global `fetch` and NEVER
// constructs a client binding of any kind. That absence is the entire point:
// when this block is green and the `rest` conformance block is red, the defect
// is provably in the client binding, not in the service. Every assertion
// message opens with the literal prefix `SERVICE WIRE: `.
//
// Placed AFTER the binding loop and BEFORE section G, so it sits outside the
// shared-body sentinels and cannot disturb the case-count gate.
// ---------------------------------------------------------------------------

interface WireResponse {
  status: number
  body: Record<string, unknown>
}

describe('bootstrap transport conformance: service wire contract', () => {
  let service: TestServiceHandle

  before(async () => {
    service = await createTestService()
  })

  after(async () => {
    await service.close()
  })

  /** Returns the raw status and parsed body. Asserts NOTHING — every case owns
   * its own assertions, so no expectation hides inside a helper. */
  async function postRedeem (lookupId: string): Promise<WireResponse> {
    return await postJson(`${service.baseUrl}/bootstrap/redemptions`, { lookupId })
  }

  async function postUpload (body: unknown, token?: string): Promise<WireResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    return await postJson(`${service.baseUrl}/bootstrap/uploads`, body, headers)
  }

  async function postJson (url: string, body: unknown, headers?: Record<string, string>): Promise<WireResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers ?? { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsed = {}
    }
    return { status: response.status, body: parsed }
  }

  /** Uploads a sealed fixture snapshot for `code`, returning its look-up id. */
  async function upload (code: string, expiresAt: string): Promise<string> {
    const keys = keysForCode(code)
    const sealed = sealFor(code, buildFixtureSnapshot())
    const response = await postUpload({ lookupId: keys.lookupId, expiresAt, sealed }, service.uploadToken)
    expect(response.status, 'SERVICE WIRE: staging an upload for a wire case must succeed').to.equal(200)
    return keys.lookupId
  }

  it('answers ALL FOUR redemption outcomes with HTTP 200 — the precondition D-25 depends on', async () => {
    // Why this is not a style preference: the REST binding's request helper
    // throws on ANY non-2xx (rest-bootstrap-transport.ts:222-224). A 404 for
    // `unknown` or a 410 for `expired` would surface as a transport error, the
    // seam's status guard would never run, and D-25's three distinct refusal
    // strings would become unreachable. A service that "improved" these status
    // codes would delete a user-facing feature with an HTTP status code.
    const unknown = await postRedeem(keysForCode(nextCode()).lookupId)

    const expiredLookupId = await upload(nextCode(), canonicalPast())
    const expired = await postRedeem(expiredLookupId)

    const usedLookupId = await upload(nextCode(), canonicalFuture())
    const firstUse = await postRedeem(usedLookupId)
    const used = await postRedeem(usedLookupId)

    const okLookupId = await upload(nextCode(), canonicalFuture())
    const ok = await postRedeem(okLookupId)

    for (const [name, response] of [
      ['unknown', unknown],
      ['expired', expired],
      ['first use', firstUse],
      ['used', used],
      ['ok', ok]
    ] as const) {
      expect(response.status, `SERVICE WIRE: the ${name} answer must be HTTP 200`).to.equal(200)
    }

    expect(unknown.body.status, 'SERVICE WIRE: an unrecognised look-up id answers unknown').to.equal('unknown')
    expect(expired.body.status, 'SERVICE WIRE: a past expiry answers expired').to.equal('expired')
    expect(firstUse.body.status, 'SERVICE WIRE: the positive control — a fresh code answers ok').to.equal('ok')
    expect(used.body.status, 'SERVICE WIRE: a second redemption answers used').to.equal('used')
    expect(ok.body.status, 'SERVICE WIRE: a fresh code answers ok').to.equal('ok')
  })

  it('answers with exactly the body key sets the seam expects, and never echoes a secret', async () => {
    const okLookupId = await upload(nextCode(), canonicalFuture())
    const ok = await postRedeem(okLookupId)
    expect(Object.keys(ok.body).sort(), 'SERVICE WIRE: an ok body carries exactly status and sealed').to.deep.equal([
      'sealed',
      'status'
    ])
    // A permanent D-04 canary: the service is holding an OPAQUE WRAPPER, not an
    // envelope. An extra member here means it opened, annotated, or re-shaped
    // something it cannot read.
    expect(
      Object.keys(ok.body.sealed as Record<string, unknown>).sort(),
      'SERVICE WIRE: the sealed wrapper carries exactly v, nonce and ciphertext'
    ).to.deep.equal(['ciphertext', 'nonce', 'v'])

    const unknown = await postRedeem(keysForCode(nextCode()).lookupId)
    const used = await postRedeem(okLookupId)
    const expired = await postRedeem(await upload(nextCode(), canonicalPast()))

    for (const [name, response] of [
      ['unknown', unknown],
      ['used', used],
      ['expired', expired]
    ] as const) {
      expect(Object.keys(response.body).sort(), `SERVICE WIRE: the ${name} body carries exactly status`).to.deep.equal([
        'status'
      ])
      expect(
        Object.prototype.hasOwnProperty.call(response.body, 'sealed'),
        `SERVICE WIRE: the ${name} refusal must carry no sealed member`
      ).to.equal(false)
    }

    for (const [name, response] of [
      ['ok', ok],
      ['unknown', unknown],
      ['used', used],
      ['expired', expired]
    ] as const) {
      for (const forbidden of ['code', 'secret', 'contentKey']) {
        expect(
          Object.prototype.hasOwnProperty.call(response.body, forbidden),
          `SERVICE WIRE: the ${name} body must never carry a ${forbidden} member`
        ).to.equal(false)
      }
    }
  })

  it('checks expiry BEFORE single use, matching the filesystem binding precedence exactly', async () => {
    // A code that is BOTH expired and already used must answer expired. The
    // sequence is identical in both halves below apart from the second upload's
    // expiry, so the only thing under test is the precedence.
    const expiredCode = nextCode()
    const expiredLookupId = await upload(expiredCode, canonicalFuture())
    const burn = await postRedeem(expiredLookupId)
    expect(burn.body.status, 'SERVICE WIRE: the code must be genuinely burned before the precedence check').to.equal('ok')
    // Re-uploaded with a PAST expiry. The single-use marker survives an upload
    // (only a revoke clears it), so this record is now both used and expired.
    await upload(expiredCode, canonicalPast())
    const bothExpiredAndUsed = await postRedeem(expiredLookupId)
    expect(
      bothExpiredAndUsed.body.status,
      'SERVICE WIRE: a code that is both expired and used answers expired — expiry is checked first, exactly as filesystem-bootstrap-transport.ts:114-155 orders it'
    ).to.equal('expired')

    // Positive control: the identical sequence with a FUTURE expiry answers used.
    const usedCode = nextCode()
    const usedLookupId = await upload(usedCode, canonicalFuture())
    const firstUse = await postRedeem(usedLookupId)
    expect(firstUse.body.status, 'SERVICE WIRE: the control code must burn cleanly too').to.equal('ok')
    await upload(usedCode, canonicalFuture())
    const usedOnly = await postRedeem(usedLookupId)
    expect(
      usedOnly.body.status,
      'SERVICE WIRE: the same sequence without the expiry answers used, so the case above really did isolate the precedence'
    ).to.equal('used')
  })

  it('gates the upload endpoint behind the operator bearer token and acknowledges with exactly { ok: true }', async () => {
    // The D-17 gate, observed from the wire. `52-08`'s own spec proves it
    // exhaustively; this case exists so a CONFORMANCE run cannot be green
    // against a service whose write endpoint has come unhinged.
    const code = nextCode()
    const keys = keysForCode(code)
    const body = {
      lookupId: keys.lookupId,
      expiresAt: canonicalFuture(),
      sealed: sealFor(code, buildFixtureSnapshot())
    }

    const refused = await postUpload(body)
    expect(refused.status, 'SERVICE WIRE: an upload with no authorization header must be refused').to.equal(401)
    expect(refused.body, 'SERVICE WIRE: the 401 body is a fixed single-keyed literal').to.deep.equal({
      error: 'unauthorized'
    })

    // It wrote NOTHING: the look-up id is still unrecognised.
    const afterRefusal = await postRedeem(keys.lookupId)
    expect(afterRefusal.status, 'SERVICE WIRE: a redemption is still HTTP 200 after a refused upload').to.equal(200)
    expect(afterRefusal.body.status, 'SERVICE WIRE: a refused upload must have stored nothing').to.equal('unknown')

    const accepted = await postUpload(body, service.uploadToken)
    expect(accepted.status, 'SERVICE WIRE: the positive control — the identical body with the token').to.equal(200)
    expect(accepted.body, 'SERVICE WIRE: the acknowledgement is exactly { ok: true }').to.deep.equal({ ok: true })

    const afterAcceptance = await postRedeem(keys.lookupId)
    expect(afterAcceptance.body.status, 'SERVICE WIRE: the accepted upload is redeemable').to.equal('ok')
  })

  it('answers a malformed redemption with 400 and no status member, which is NOT one of the four answers', async () => {
    // The pre-52-05 wire shape. D-04 observed on the wire: a client still
    // posting the secret fails LOUDLY rather than having its secret quietly
    // accepted and ignored. A 400 carries no `status`, so it can never be
    // mistaken for a redemption answer, and the offered value is never echoed.
    const offered = 'anything'
    const response = await postJson(`${service.baseUrl}/bootstrap/redemptions`, { code: offered })

    expect(response.status, 'SERVICE WIRE: a body offering the secret is a protocol error, not a refusal').to.equal(400)
    expect(
      Object.prototype.hasOwnProperty.call(response.body, 'status'),
      'SERVICE WIRE: a 400 must carry no status member — it is not one of the four redemption answers'
    ).to.equal(false)
    expect(
      JSON.stringify(response.body).includes(offered),
      'SERVICE WIRE: a 400 must never echo the offered value'
    ).to.equal(false)

    // Positive control: the correct wire shape against the same service.
    const okLookupId = await upload(nextCode(), canonicalFuture())
    const ok = await postRedeem(okLookupId)
    expect(ok.status, 'SERVICE WIRE: the correct wire shape still answers 200').to.equal(200)
    expect(ok.body.status, 'SERVICE WIRE: the correct wire shape still answers ok').to.equal('ok')
  })
})

// ---------------------------------------------------------------------------
// G. Structural self-tests. These read THIS FILE's own source text (and, for
// the barrel gate, the barrel's source), so the properties that make this
// suite meaningful — the body is shared, no third slot exists, both
// bindings route through one fixture and one envelope declaration, and the
// REST binding's far side is a REAL SERVICE — are permanent regression tests
// rather than paragraphs someone has to remember to read.
// ---------------------------------------------------------------------------
function findRepoRoot (startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('findRepoRoot: reached the filesystem root without finding a directory containing both package.json and .git')
}

const REPO_ROOT = findRepoRoot(process.cwd())
const THIS_FILE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'test', 'bootstrap-transport-conformance.spec.ts')
const BARREL_SOURCE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'src', 'bootstrap', 'index.ts')

// These gates read THIS FILE's own source text, so every marker string is
// built via concatenation rather than written as one contiguous literal —
// otherwise the gate's own source line would itself count as an extra
// occurrence of the marker it is trying to count.
const REGION_START_MARKER = '// #' + 'region SHARED-CONFORMANCE-BODY'
const REGION_END_MARKER = '// #' + 'endregion SHARED-CONFORMANCE-BODY'
const CONFORMANCE_FN_NAME = 'runBootstrapTransportConf' + 'ormance'
const BUILD_FIXTURE_FN_DECLARATION_TEXT = 'function ' + 'buildFixtureSnapshot'
const VOTE_ENGINE_BARREL_SPECIFIER = '@votetorrent' + '/vote-engine'
const IN_TEST_SERVER_FACTORY = 'create' + 'Server'
const NODE_HTTP_SPECIFIER = 'node' + ':http'
const NODE_NET_SPECIFIER = 'node' + ':net'
const REAL_SERVICE_FACTORY_SPECIFIER = 'create-test-' + 'service.js'
const UPLOAD_ENDPOINT_PATH = '/bootstrap/' + 'uploads'
const DELETED_PULL_METHOD = 'pull' + 'Snapshot'
const FORBIDDEN_PEER_CLUSTER_TERMS = [
  'p' + '2p',
  'Cadre' + 'Node',
  'str' + 'and',
  'optimys' + 'tic',
  'db-' + 'p' + '2p'
]

describe('bootstrap transport conformance: structure', () => {
  const thisFileSource = readFileSync(THIS_FILE_PATH, 'utf8')

  it('declares the conformance body exactly once and shares it across every binding', () => {
    const start = thisFileSource.indexOf(REGION_START_MARKER)
    const end = thisFileSource.indexOf(REGION_END_MARKER)
    expect(start).to.be.greaterThan(-1)
    expect(end).to.be.greaterThan(start)
    expect(thisFileSource.split(REGION_START_MARKER).length - 1).to.equal(1)
    expect(thisFileSource.split(REGION_END_MARKER).length - 1).to.equal(1)

    const region = thisFileSource.slice(start, end)
    // SIX, not five. 52-05 moved this pin 6 → 5 when it deleted the pull-style
    // case; 52-13 moves it 5 → 6 for an entirely different, NEW case: the
    // corrupted-ciphertext case that separates an AEAD failure from a digest
    // mismatch. This is NOT the deleted pull-style case returning — the gate
    // below keeps that method's name at zero occurrences in this file.
    expect((region.match(/\bit\s*\(/g) ?? []).length).to.equal(6)
    expect(thisFileSource.split(DELETED_PULL_METHOD).length - 1).to.equal(0)
    expect(thisFileSource.split(CONFORMANCE_FN_NAME).length - 1).to.equal(2)

    expect(/testCase\.label\s*===/.test(region)).to.equal(false)
    expect(/label\s*===\s*'filesystem'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'rest'/.test(region)).to.equal(false)
    expect(/instanceof\s+(FilesystemBootstrapTransport|RestBootstrapTransport)/.test(region)).to.equal(false)
  })

  it('drives the REST binding against the real service, not an in-test stand-in', () => {
    const whatAFailureMeans =
      'D-27 REGRESSION: someone reintroduced an in-test HTTP receiver into the conformance suite, and the suite has gone back to proving a mock rather than proving the shipped service. The REST binding must be driven by the real bootstrap-rendezvous-service, started on an ephemeral loopback port by createTestService.'

    expect(thisFileSource.split(IN_TEST_SERVER_FACTORY).length - 1, whatAFailureMeans).to.equal(0)
    expect(thisFileSource.split(NODE_HTTP_SPECIFIER).length - 1, whatAFailureMeans).to.equal(0)
    expect(thisFileSource.split(NODE_NET_SPECIFIER).length - 1, whatAFailureMeans).to.equal(0)
    expect(thisFileSource.split(REAL_SERVICE_FACTORY_SPECIFIER).length - 1, whatAFailureMeans).to.be.greaterThan(0)
    // Staging is a real authenticated push, not a map insertion.
    expect(thisFileSource.split(UPLOAD_ENDPOINT_PATH).length - 1, whatAFailureMeans).to.be.greaterThan(0)
  })

  it('carries no reserved third slot and no skips', () => {
    expect((thisFileSource.match(/describe\.skip/g) ?? []).length).to.equal(0)
    expect((thisFileSource.match(/\bit\.skip\s*\(/g) ?? []).length).to.equal(0)
    expect((thisFileSource.match(/\.only\(/g) ?? []).length).to.equal(0)

    // Scoped to the binding-table array literal itself (not the
    // `ConformanceCase` interface's own `mode: 'run'` field-type
    // declaration, which would otherwise be a third, spurious match).
    const declStart = thisFileSource.indexOf('const CONFORMANCE_BINDINGS')
    const literalStart = thisFileSource.indexOf('= [', declStart)
    const literalEnd = thisFileSource.indexOf(']', literalStart)
    expect(declStart).to.be.greaterThan(-1)
    expect(literalStart).to.be.greaterThan(declStart)
    expect(literalEnd).to.be.greaterThan(literalStart)
    const tableLiteral = thisFileSource.slice(literalStart, literalEnd)
    expect((tableLiteral.match(/mode:\s*'run'/g) ?? []).length).to.equal(2)
    expect((tableLiteral.match(/mode:\s*'skip'/g) ?? []).length).to.equal(0)
    for (const term of FORBIDDEN_PEER_CLUSTER_TERMS) {
      expect(
        thisFileSource.toLowerCase().includes(term.toLowerCase()),
        `this suite must carry no peer-cluster dependency: found forbidden term ${term}`
      ).to.equal(false)
    }
  })

  it('routes both bindings through one fixture and one envelope declaration', () => {
    expect(thisFileSource.includes("from '../src/bootstrap/filesystem-bootstrap-transport.js'")).to.equal(true)
    expect(thisFileSource.includes("from '../src/bootstrap/rest-bootstrap-transport.js'")).to.equal(true)
    expect(thisFileSource.includes(VOTE_ENGINE_BARREL_SPECIFIER)).to.equal(false)
    expect(thisFileSource.split(BUILD_FIXTURE_FN_DECLARATION_TEXT).length - 1).to.equal(1)

    for (const typeName of ['BootstrapSnapshot', 'SnapshotManifest', 'SnapshotTables']) {
      expect(
        new RegExp(`(interface|type)\\s+${typeName}\\b`).test(thisFileSource),
        `must not re-declare ${typeName} (owned by 50-02's snapshot-types.ts)`
      ).to.equal(false)
    }
  })

  it('proves the filesystem binding is barrel-excluded', () => {
    const barrelSource = readFileSync(BARREL_SOURCE_PATH, 'utf8')
    const barrelCode = barrelSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(barrelCode.includes('filesystem-bootstrap-transport')).to.equal(false)
    expect(barrelCode.includes('node:')).to.equal(false)
  })
})
