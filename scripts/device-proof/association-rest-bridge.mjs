#!/usr/bin/env node
/**
 * association-rest-bridge.mjs — Phase 51 Plan 13, Task 1 (D-17's throwaway wire carrier).
 *
 * A single-file `node:http` relay serving BOTH the D-01 registration-request REST endpoints
 * (`rest-registration-transport.ts`, 48-10) and the D-08/D-18 association-request REST endpoints
 * (`rest-association-transport.ts`, 51-06), plus the authority-side staged-document listing
 * endpoints those two apps' own `attach-sync-bindings.ts` / `attach-association-sync-bindings.ts`
 * already declared as their bridge contract (51-10-SUMMARY.md).
 *
 * ============================================================================
 * WHAT THIS FILE IS — AND, LOAD-BEARING, WHAT IT IS NOT (T-51-13-07)
 * ============================================================================
 * This is a DUMB COURIER. It VERIFIES NOTHING and DECIDES NOTHING:
 *   - It never checks a `Signature` against a public key.
 *   - It never inspects `AttestationVerdict`-shaped content.
 *   - It never rejects a document for looking "wrong" — a schema CHECK three
 *     doors down (the real authority process's own INSERT) is the only
 *     authorization gate that exists anywhere in this ceremony (D-02).
 * All this file does is (a) compute the SAME `Digest()` the schema's own CHECK
 * constraints will recompute at INSERT time, so a device has something correct
 * to sign, and (b) hold submitted documents in a staging directory until the
 * real authority process comes and reads them. A bridge that verified or
 * decided anything would BE an authorization point wearing a courier's
 * clothing — exactly the failure this file's header must foreclose.
 *
 * ============================================================================
 * WHY THE DIGEST IS ENGINE-AUTHORITATIVE, NOT A REIMPLEMENTATION
 * ============================================================================
 * `rest-registration-transport.ts` and `rest-association-transport.ts` both
 * say the same thing in their own headers: "Resolves the digest via an
 * engine-authoritative handshake ... rather than reimplementing Digest()
 * client-side (it is the schema's function, and a TypeScript reimplementation
 * would fork it)." `Digest()` is `@optimystic/quereus-plugin-crypto`'s
 * length-prefixed, type-tagged canonical encoding, sha256, base64url-encoded
 * (see `packages/vote-engine/src/database/digest-vectors.ts`) — NOT a plain
 * string-join hash, and forking it by hand here would silently drift the
 * instant that plugin's encoding changes. This file therefore stands up ONE
 * `Database` instance and registers ONLY the crypto plugin against it
 * (`registerDbPlugins` — the exact call `packages/vote-engine/src/database/
 * initialize.ts` makes) — it never calls `initDB`/schema creation, never
 * inserts a business row into it, and never stores a submitted document
 * inside it. That instance exists for exactly one purpose: to run the literal
 * `select Digest(...) as d` statements the four digest handshakes below
 * reproduce field-for-field from `registration-engine.ts:1801-1802`,
 * `association-engine.ts:1004-1005`, and `association-engine.ts:1149-1150`.
 * A signature produced over this digest is therefore provably byte-identical
 * to what the real authority process's own schema CHECK will recompute —
 * this is the whole point of Plan 13's Task 1 smoke run (see the SUMMARY).
 *
 * ============================================================================
 * WHAT THIS FILE NEVER DOES (each load-bearing, each mechanically checkable)
 * ============================================================================
 *   - NEVER receives, stores, or logs a private key. Every submitted document
 *     carries an already-completed `Signature` (a public signerKey + a
 *     signature string) — never a raw scalar (D-01/D-08).
 *   - NEVER logs a request body, a signature, a device key, or a payload —
 *     only the HTTP method, the path, and (where one exists) a document id.
 *   - NEVER imports any of the four HTTP-framework/client packages the
 *     threat register (T-51-13-SC) grep-forbids for this file. Only Node's
 *     own `node:http`, `node:fs/promises`, `node:path`, `node:url`,
 *     `node:crypto` — plus a same-repo, already-vendored, dynamic import of
 *     the compiled `@quereus/quereus` engine and `packages/vote-engine`'s own
 *     `dist/database/initialize.js` for the digest oracle above. Neither is a
 *     NEW dependency — both already ship in this monorepo's own tree.
 *
 * ============================================================================
 * THE WIRE PROTOCOL SERVED (locked leg, mirrored from each binding's header)
 * ============================================================================
 * Registration (`rest-registration-transport.ts`, submitter-facing):
 *   - POST /registration-requests/digest  { init, requesterKey } -> { digest, submittedAt }
 *   - POST /registration-requests         { init, requesterKey, submittedAt, signature } -> { requestId }
 *   - GET  /registration-decisions?since={cursor}                -> { notices }
 * Registration (authority-side intake, this file's own invented shape — see
 * `attach-sync-bindings.ts`'s header, which documents the SAME contract):
 *   - GET  /staged-requests -> { staged: StagedRequestJson[], bridgeKeys: [] }
 *     (`bridgeKeys` is always `[]` here — this ceremony's requester is always
 *     a registrant, never a bridge, so `IssuerType` is always `'registrant'`.)
 * Association (`rest-association-transport.ts`, submitter-facing):
 *   - POST /association-requests/digest        { init, requesterKey } -> { digest, submittedAt }
 *   - POST /association-requests               { init, requesterKey, submittedAt, signature } -> { requestId }
 *   - POST /association-attestations/digest    { answer, requesterKey } -> { digest, requestId, nonce }
 *   - POST /association-attestations           { answer, requesterKey, signature } -> {}
 *   - GET  /association-decisions?since={cursor}                        -> { notices }
 * Association (authority-side intake, `attach-association-sync-bindings.ts`'s
 * own invented shape, quoted verbatim in 51-10-SUMMARY.md):
 *   - GET  /staged-association-requests     -> { staged: StagedAssociationRequestJson[] }
 *   - GET  /staged-association-attestations -> { staged: StagedAttestationJson[] }
 *   - POST /association-decisions           { requestId, status, challengeNonce?, reason?, decidedAt } -> { cursor }
 *
 * Every digest-handshake response echoes back the exact field(s) the binding
 * checks BEFORE signing (leg 1: `submittedAt`; leg 2: `requestId`/`nonce`) —
 * UNCHANGED. Altering an echo makes the binding refuse to sign, by design
 * (both bindings' own headers, item 8 / item 5 respectively).
 *
 * ============================================================================
 * PERSISTENCE
 * ============================================================================
 * Every submitted document is written to its own file under `--staging-dir`
 * (default: a fresh directory under `os.tmpdir()`, printed at startup) so a
 * bridge restart mid-ceremony does not lose a staged document. Decision logs
 * are append-only JSON arrays with a monotonic, zero-padded string cursor
 * (lexicographic order == arrival order), persisted the same way.
 *
 * Usage:
 *   node scripts/device-proof/association-rest-bridge.mjs [--port 8791] [--host 127.0.0.1] [--staging-dir <path>]
 *
 * `--host` defaults to LOOPBACK. Reaching this bridge from a physical phone needs an
 * explicit `--host <lan-ip>` (or `0.0.0.0`) — exposing an unauthenticated server on every
 * interface is a deliberate act, not a default (CR-04).
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Untrusted-identifier guard (CR-04, 51-REVIEW).
//
// Every id this bridge turns into a filename arrives in an UNAUTHENTICATED HTTP
// POST body, on a server the ceremony script tells you to bind to a LAN address
// so a physical phone can reach it. `path.join` does NOT normalize away a
// traversal — it RESOLVES it — so without this an attacker on the LAN can write
// attacker-controlled JSON to any `*.json` path the bridge process can reach
// (a LaunchAgent, a package.json, a tsconfig.json inside the checkout).
//
// Deliberately a verbatim port of the production sibling's guard,
// `assertSafeIdentifier` in
// `packages/vote-engine/src/association/transport/filesystem-association-transport.ts`,
// so the two cannot drift. Must run BEFORE any `path.join`, never after.
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

function assertSafeIdentifier (value, label) {
  if (typeof value !== 'string') {
    throw new Error(`association-rest-bridge: ${label} must be a string (got: ${typeof value})`)
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new Error(
      `association-rest-bridge: ${label} may not be '.', '..', or contain a '..' path-traversal segment (got: ${JSON.stringify(value)})`
    )
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `association-rest-bridge: ${label} must match ${SAFE_IDENTIFIER_PATTERN.toString()} (got: ${JSON.stringify(value)})`
    )
  }
}

// Cap on a single request body. Unbounded concatenation of every chunk lets one
// LAN client exhaust this process's memory; a staged association document is a
// few kB, so 1 MiB is generous.
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// CLI args — no dependency (no `commander`/`yargs`); a handful of `--flag value` pairs.
// ---------------------------------------------------------------------------
function parseArgs (argv) {
  // CR-04: default to loopback. Exposing this unauthenticated server on every
  // interface must be a deliberate act — `run-two-party-ceremony.sh` always passes
  // `--host` explicitly, so the D-17 ceremony is unaffected by this default.
  const args = { port: 8791, host: '127.0.0.1', stagingDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--staging-dir') args.stagingDir = argv[++i]
    else throw new Error(`association-rest-bridge: unrecognized argument ${a}`)
  }
  return args
}

// ---------------------------------------------------------------------------
// The digest oracle — see the file header's "WHY THE DIGEST IS ENGINE-
// AUTHORITATIVE" section. Resolves BOTH modules via relative filesystem paths
// (never a bare-specifier import from this script's own location, which sits
// outside every candidate's node_modules tree) so this file needs no new
// dependency and no package.json edit of its own.
// ---------------------------------------------------------------------------
async function loadDigestOracle () {
  const quereusCandidates = [
    path.join(REPO_ROOT, 'packages/vote-engine/node_modules/@quereus/quereus/dist/src/index.js'),
    path.join(REPO_ROOT, 'node_modules/@quereus/quereus/dist/src/index.js')
  ]
  const quereusPath = quereusCandidates.find((p) => existsSync(p))
  if (quereusPath === undefined) {
    throw new Error(
      `association-rest-bridge: could not locate @quereus/quereus under any of: ${quereusCandidates.join(', ')} — run yarn install`
    )
  }
  const initPath = path.join(REPO_ROOT, 'packages/vote-engine/dist/database/initialize.js')
  if (!existsSync(initPath)) {
    throw new Error(
      `association-rest-bridge: ${initPath} does not exist — run "cd packages/vote-engine && yarn build" first (run-two-party-ceremony.sh does this for you)`
    )
  }

  const { Database } = await import(pathToFileURL(quereusPath).href)
  const { registerDbPlugins } = await import(pathToFileURL(initPath).href)

  // ONE Database instance, crypto-plugin-only (never initDB/schema, never a
  // business-row INSERT) — see the file header. Digest() is the SAME
  // SQL scalar the real authority's own schema CHECKs invoke.
  const db = new Database()
  await registerDbPlugins(db)

  async function digest (...args) {
    const placeholders = args.map((_, i) => `:a${i}`).join(', ')
    const bindings = Object.fromEntries(args.map((v, i) => [`a${i}`, v]))
    const row = await db.prepare(`select Digest(${placeholders}) as d`).get(bindings)
    if (!row || row.d == null) {
      throw new Error('association-rest-bridge: Digest() returned null — crypto plugin not registered?')
    }
    return row.d
  }

  return { digest }
}

// ---------------------------------------------------------------------------
// Staging store — one JSON file per submitted document, plus two append-only
// decision logs. Every read/write is scoped under `stagingDir`.
// ---------------------------------------------------------------------------
function createStagingStore (stagingDir) {
  const dirs = {
    registrationRequests: path.join(stagingDir, 'registration-requests'),
    associationRequests: path.join(stagingDir, 'association-requests'),
    associationAttestations: path.join(stagingDir, 'association-attestations')
  }
  const decisionFiles = {
    registration: path.join(stagingDir, 'registration-decisions.json'),
    association: path.join(stagingDir, 'association-decisions.json')
  }
  let registrationDecisionSeq = 0
  let associationDecisionSeq = 0

  async function init () {
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
    for (const file of Object.values(decisionFiles)) {
      if (!existsSync(file)) await writeFile(file, '[]', 'utf8')
    }
    registrationDecisionSeq = (await readDecisions(decisionFiles.registration)).length
    associationDecisionSeq = (await readDecisions(decisionFiles.association)).length
  }

  async function readDecisions (file) {
    const raw = await readFile(file, 'utf8').catch(() => '[]')
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function appendDecision (file, prefix, seqRef, notice) {
    const decisions = await readDecisions(file)
    seqRef.value += 1
    const cursor = `${prefix}${String(seqRef.value).padStart(6, '0')}`
    const stamped = { ...notice, cursor }
    decisions.push(stamped)
    await writeFile(file, JSON.stringify(decisions, null, 2), 'utf8')
    return cursor
  }

  async function stageDoc (dir, id, doc) {
    // CR-04: `id` comes straight out of an unauthenticated POST body, and this
    // server can be bound to a LAN address. Validate BEFORE the join — see
    // `assertSafeIdentifier`'s comment at the top of this file. A missing id
    // (which used to produce `undefined.json`) is rejected here too.
    assertSafeIdentifier(id, 'document id')
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(doc, null, 2), 'utf8')
  }

  async function readStagedDocs (dir) {
    if (!existsSync(dir)) return []
    const files = await readdir(dir)
    const docs = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await readFile(path.join(dir, file), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      try {
        docs.push(JSON.parse(raw))
      } catch {
        // A partially-written file from a killed prior run — skip it rather
        // than crash the whole listing.
      }
    }
    return docs
  }

  const registrationSeqRef = { value: 0 }
  const associationSeqRef = { value: 0 }

  return {
    dirs,
    init,
    async stageRegistrationRequest (doc) { await stageDoc(dirs.registrationRequests, doc.id, doc) },
    async stagedRegistrationRequests () { return await readStagedDocs(dirs.registrationRequests) },
    async stageAssociationRequest (doc) { await stageDoc(dirs.associationRequests, doc.requestId, doc) },
    async stagedAssociationRequests () { return await readStagedDocs(dirs.associationRequests) },
    async stageAssociationAttestation (doc) { await stageDoc(dirs.associationAttestations, doc.requestId, doc) },
    async stagedAssociationAttestations () { return await readStagedDocs(dirs.associationAttestations) },
    async registrationDecisionsSince (since) {
      const all = await readDecisions(decisionFiles.registration)
      return since === undefined ? all : all.filter((n) => n.cursor > since)
    },
    async publishRegistrationDecision (notice) {
      registrationSeqRef.value = registrationDecisionSeq
      const cursor = await appendDecision(decisionFiles.registration, 'r', registrationSeqRef, notice)
      registrationDecisionSeq = registrationSeqRef.value
      return cursor
    },
    async associationDecisionsSince (since) {
      const all = await readDecisions(decisionFiles.association)
      return since === undefined ? all : all.filter((n) => n.cursor > since)
    },
    async publishAssociationDecision (notice) {
      associationSeqRef.value = associationDecisionSeq
      const cursor = await appendDecision(decisionFiles.association, 'd', associationSeqRef, notice)
      associationDecisionSeq = associationSeqRef.value
      return cursor
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function sendJson (res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(json)
}

async function readJsonBody (req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      // CR-04: bound the read. Without this one LAN client can exhaust memory
      // by streaming forever into a `chunks` array nothing ever caps.
      throw new Error(`association-rest-bridge: request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  return JSON.parse(raw)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const stagingDir = args.stagingDir ?? mkdtempSync(path.join(tmpdir(), 'votetorrent-association-bridge-'))
  await mkdir(stagingDir, { recursive: true })

  console.log('=== association-rest-bridge.mjs (Phase 51 Plan 13) ===')
  console.log(`Staging directory: ${stagingDir}`)
  console.log('Loading the digest oracle (Database + registerDbPlugins, crypto plugin only)...')
  const { digest } = await loadDigestOracle()
  console.log('Digest oracle ready.')

  const store = createStagingStore(stagingDir)
  await store.init()

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname
    console.log(`${method} ${pathname}`)

    handleRequest(method, pathname, url, req, res).catch((err) => {
      console.error(`association-rest-bridge: request handler threw for ${method} ${pathname}:`, err instanceof Error ? err.message : String(err))
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    })
  })

  async function handleRequest (method, pathname, url, req, res) {
    // --- Registration: submitter-facing (rest-registration-transport.ts) ---
    if (method === 'POST' && pathname === '/registration-requests/digest') {
      const { init, requesterKey } = await readJsonBody(req)
      const payload = JSON.stringify(init.payload)
      const payloadCid = await digest(payload)
      const issuerType = init.issuerType ?? 'registrant'
      const bridgeId = init.bridgeId ?? null
      const d = await digest(init.id, init.authorityId, requesterKey, issuerType, bridgeId, payloadCid, init.submittedAt)
      sendJson(res, 200, { digest: d, submittedAt: init.submittedAt })
      return
    }
    if (method === 'POST' && pathname === '/registration-requests') {
      const { init, requesterKey, submittedAt, signature } = await readJsonBody(req)
      await store.stageRegistrationRequest({ id: init.id, init, requesterKey, submittedAt, signature })
      console.log(`  -> staged registration request id=${init.id}`)
      sendJson(res, 200, { requestId: init.id })
      return
    }
    if (method === 'GET' && pathname === '/registration-decisions') {
      const since = url.searchParams.get('since') ?? undefined
      const notices = await store.registrationDecisionsSince(since)
      sendJson(res, 200, { notices })
      return
    }
    // --- Registration: authority-side intake (attach-sync-bindings.ts) -----
    if (method === 'GET' && pathname === '/staged-requests') {
      const staged = await store.stagedRegistrationRequests()
      sendJson(res, 200, { staged, bridgeKeys: [] })
      return
    }

    // --- Association: submitter-facing (rest-association-transport.ts) -----
    if (method === 'POST' && pathname === '/association-requests/digest') {
      const { init, requesterKey } = await readJsonBody(req)
      const d = await digest(init.id, init.authorityId, init.registrantId, requesterKey, init.electionId ?? null, init.submittedAt)
      sendJson(res, 200, { digest: d, submittedAt: init.submittedAt })
      return
    }
    if (method === 'POST' && pathname === '/association-requests') {
      const { init, requesterKey, submittedAt, signature } = await readJsonBody(req)
      await store.stageAssociationRequest({ requestId: init.id, init, requesterKey, submittedAt, signature })
      console.log(`  -> staged association request id=${init.id}`)
      sendJson(res, 200, { requestId: init.id })
      return
    }
    if (method === 'POST' && pathname === '/association-attestations/digest') {
      const { answer, requesterKey } = await readJsonBody(req)
      const attestationJson = JSON.stringify(answer.attestation)
      const d = await digest(answer.requestId, answer.nonce, attestationJson, answer.deviceHash ?? null)
      sendJson(res, 200, { digest: d, requestId: answer.requestId, nonce: answer.nonce })
      return
    }
    if (method === 'POST' && pathname === '/association-attestations') {
      const { answer, requesterKey, signature } = await readJsonBody(req)
      await store.stageAssociationAttestation({ requestId: answer.requestId, answer, requesterKey, signature })
      console.log(`  -> staged association attestation id=${answer.requestId}`)
      sendJson(res, 200, {})
      return
    }
    if (method === 'GET' && pathname === '/association-decisions') {
      const since = url.searchParams.get('since') ?? undefined
      const notices = await store.associationDecisionsSince(since)
      sendJson(res, 200, { notices })
      return
    }
    // --- Association: authority-side intake (attach-association-sync-bindings.ts) ---
    if (method === 'GET' && pathname === '/staged-association-requests') {
      const staged = await store.stagedAssociationRequests()
      sendJson(res, 200, { staged })
      return
    }
    if (method === 'GET' && pathname === '/staged-association-attestations') {
      const staged = await store.stagedAssociationAttestations()
      sendJson(res, 200, { staged })
      return
    }
    if (method === 'POST' && pathname === '/association-decisions') {
      const notice = await readJsonBody(req)
      const cursor = await store.publishAssociationDecision(notice)
      console.log(`  -> published association decision id=${notice.requestId} status=${notice.status}`)
      sendJson(res, 200, { cursor })
      return
    }
    // A bridge-invented symmetry endpoint (no app calls this today — see
    // 51-13-SUMMARY.md — but a bridge is otherwise incomplete without it, and
    // it costs nothing to serve).
    if (method === 'POST' && pathname === '/registration-decisions') {
      const notice = await readJsonBody(req)
      const cursor = await store.publishRegistrationDecision(notice)
      console.log(`  -> published registration decision id=${notice.requestId} status=${notice.status}`)
      sendJson(res, 200, { cursor })
      return
    }

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, stagingDir })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, args.host, () => resolve())
  })
  const address = server.address()
  console.log(`Listening on http://${address.address}:${address.port}`)
  console.log('Endpoints served: /registration-requests/digest, /registration-requests, /registration-decisions,')
  console.log('  /staged-requests, /association-requests/digest, /association-requests,')
  console.log('  /association-attestations/digest, /association-attestations, /association-decisions,')
  console.log('  /staged-association-requests, /staged-association-attestations, /health')

  const shutdown = () => {
    console.log(`\nShutting down. Staging directory preserved at: ${stagingDir}`)
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('association-rest-bridge: fatal:', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
