// p2p-staging-fixture.ts — Phase 62 Plan 15: the shared in-process test harness both
// `test/p2p-staging-transport.spec.ts` and the two conformance sidecars build on.
//
// `createP2pStagingFixture()` resolves a real `createTestNetwork()`/`addTestAuthority()` network
// (the real votetorrent schema, real UDFs — `Digest()`, `SignatureValid`, `SignatureValidP256`),
// a Quereus-backed `StagingSqlPort` (`makePort`), and a sealer/opener pair built DIRECTLY on
// 62-04's `sealToRecipients`/`openEnvelope` — test stand-ins for 62-14's `createIntakeSealer`/
// opener (same wave; consumed by interface only, never imported here).
//
// Never read or log a private key in an assertion message — `rawRows` and `makePort` surface
// only what the real strand rows would carry.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { bytesToUtf8 } from '@noble/ciphers/utils.js'
import type { SqlParameters } from '@quereus/quereus'
import type { Signature } from '@votetorrent/vote-core'
import {
  sealToRecipients,
  openEnvelope,
  serializeEnvelope,
  generateEncryptionKeyPair
} from '../../src/crypto/index.js'
import type { EnvelopeBinding, EnvelopeRecipient } from '../../src/crypto/index.js'
import type {
  StagingSealer,
  StagingOpener,
  StagingOpenResult,
  StagingDecisionSigner,
  StagingSqlPort
} from '../../src/registration/transport/p2p-staging-seam.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './test-context.js'
import type { TestAuthorityContext } from './test-context.js'
import { randomTestKeyPair } from './keys.js'

/** One of the fixture's two sealing recipients — a test stand-in for a 62-21/62-14-provisioned
 * `UserEncryptionKey` row. `secretKey` is held only in this test process's own memory. */
export interface P2pStagingFixtureRecipient {
  readonly userId: string
  readonly publicKey: string
  readonly secretKey: Uint8Array
}

export interface P2pStagingFixturePortOptions {
  /** Replaces `InitJson`/`AnswerJson` on any row returned by `query()` whose `RequestId` this map
   * names — models a hostile relay serving re-sealed or transplanted bytes on the delivery path.
   * The schema refuses UPDATE and DELETE (D-07), so a port-level overlay is the only place such a
   * tamper can live in this test harness. */
  overlay?: Map<string, string>
  /** Runs before an insert whose SQL starts with `insert into <table>` is forwarded to the real
   * database — the race tests' hook for landing a conflicting row at the SAME cursor just before
   * the transport's own insert lands. */
  beforeInsert?: (table: string, params: Record<string, unknown>) => void | Promise<void>
}

export interface P2pStagingFixturePort extends StagingSqlPort {
  close(): Promise<void>
}

export interface P2pStagingFixture {
  net: Awaited<ReturnType<typeof createTestNetwork>>
  auth: TestAuthorityContext
  db: TestAuthorityContext['ctx']['db']
  /** The sealer's two recipients: `net.user.id` and `'officer-b'`. */
  recipients: readonly [P2pStagingFixtureRecipient, P2pStagingFixtureRecipient]
  /** Seals to both `recipients`, bound to `auth.authority.id`. */
  sealer: StagingSealer
  /** Opens as `recipients[0]` (`net.user.id`). */
  opener: StagingOpener
  /** Opens as a THIRD key that is never a recipient — every open through this opener reports
   * `'not-a-recipient'`. */
  outsiderOpener: StagingOpener
  /** Signs as `net.user` (the founding 'vrg' officer), authorityId `auth.authority.id`. */
  decisionSigner: StagingDecisionSigner
  /** A fresh Quereus-backed `StagingSqlPort` over the shared fixture database. `close()` is a
   * no-op — it never closes the shared DB underneath a sibling port. */
  makePort: (options?: P2pStagingFixturePortOptions) => P2pStagingFixturePort
  /** Raw rows for `table` on `strandId`, read directly (bypassing any transport), for scanning
   * payload-marker / registration-code / identity-field leakage in plaintext. */
  rawRows: (table: string, strandId: string) => Promise<Array<Record<string, unknown>>>
  /** A fresh real secp256k1 requester signer, in the conformance `makeRealSigner` shape. */
  makeRequesterSigner: () => { publicHex: string, privateHex: string, sign: (digest: Uint8Array) => Promise<Signature> }
  /** `sha256(utf8(JSON.stringify([init.id, requesterKey, init.submittedAt])))` — a deterministic,
   * test-only `RequestDigestFn`. The staging tables' `SignatureValid` CHECK only requires a
   * genuine signature over WHATEVER `Digest` a row stores; this fixture never claims to reproduce
   * the production DG-1 tuple. */
  fixtureRequestDigest: (init: { id: string, submittedAt: string }, requesterKey: string) => Promise<Uint8Array>
  /** `sha256(utf8(JSON.stringify([answer.requestId, answer.nonce, requesterKey])))` — the
   * attestation-leg counterpart, same discipline. */
  fixtureAttestationDigest: (answer: { requestId: string, nonce: string }, requesterKey: string) => Promise<Uint8Array>
  /** A random string tests embed inside a sealed payload, then scan raw rows for — proving the
   * plaintext never reaches a raw column. */
  payloadMarker: string
}

function applyOverlay (row: Record<string, unknown>, overlay: Map<string, string> | undefined): Record<string, unknown> {
  if (overlay === undefined) return row
  const requestId = row.RequestId
  if (typeof requestId !== 'string') return row
  const replacement = overlay.get(requestId)
  if (replacement === undefined) return row
  const out: Record<string, unknown> = { ...row }
  if ('InitJson' in out) out.InitJson = replacement
  if ('AnswerJson' in out) out.AnswerJson = replacement
  return out
}

const INSERT_TABLE_PATTERN = /^\s*insert into\s+(\w+)/i

function makeFixturePort (
  db: TestAuthorityContext['ctx']['db'],
  options?: P2pStagingFixturePortOptions
): P2pStagingFixturePort {
  return {
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      const rows: T[] = []
      for await (const row of db.eval(sql, params as SqlParameters)) {
        rows.push(applyOverlay(row as Record<string, unknown>, options?.overlay) as T)
      }
      return rows
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
      if (options?.beforeInsert !== undefined) {
        const match = INSERT_TABLE_PATTERN.exec(sql)
        if (match?.[1] !== undefined) {
          await options.beforeInsert(match[1], params)
        }
      }
      await db.exec(sql, params as SqlParameters)
    },
    async close (): Promise<void> {}
  }
}

export async function createP2pStagingFixture (): Promise<P2pStagingFixture> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const db = auth.ctx.db

  const officerA = generateEncryptionKeyPair()
  const officerB = generateEncryptionKeyPair()
  const outsider = generateEncryptionKeyPair()

  const recipientA: P2pStagingFixtureRecipient = { userId: net.user.id, publicKey: officerA.publicKey, secretKey: officerA.secretKey }
  const recipientB: P2pStagingFixtureRecipient = { userId: 'officer-b', publicKey: officerB.publicKey, secretKey: officerB.secretKey }
  const recipients: readonly [P2pStagingFixtureRecipient, P2pStagingFixtureRecipient] = [recipientA, recipientB]

  const publicRecipients: EnvelopeRecipient[] = recipients.map((r) => ({ userId: r.userId, publicKey: r.publicKey }))

  const sealer: StagingSealer = {
    authorityId: auth.authority.id,
    async seal (plaintext: string, binding: EnvelopeBinding): Promise<string> {
      const sealed = sealToRecipients(utf8ToBytes(plaintext), publicRecipients, binding)
      return serializeEnvelope(sealed)
    }
  }

  function makeOpenerFor (recipient: { userId: string, secretKey: Uint8Array }): StagingOpener {
    return {
      async open (sealed: string, binding: EnvelopeBinding): Promise<StagingOpenResult> {
        const result = openEnvelope(sealed, { userId: recipient.userId, secretKey: recipient.secretKey }, binding)
        if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }
        return { ok: true, plaintext: bytesToUtf8(result.plaintext) }
      }
    }
  }

  const opener = makeOpenerFor(recipientA)
  const outsiderOpener = makeOpenerFor({ userId: 'outsider', secretKey: outsider.secretKey })

  const decisionSigner: StagingDecisionSigner = {
    authorityId: auth.authority.id,
    sign: makeTestSignCallback(net.user)
  }

  function makePort (options?: P2pStagingFixturePortOptions): P2pStagingFixturePort {
    return makeFixturePort(db, options)
  }

  async function rawRows (table: string, strandId: string): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = []
    for await (const row of db.eval(`select * from ${table} where StrandId = :strandId`, { strandId })) {
      rows.push(row as Record<string, unknown>)
    }
    return rows
  }

  function makeRequesterSigner (): { publicHex: string, privateHex: string, sign: (digest: Uint8Array) => Promise<Signature> } {
    const { privateHex, publicHex } = randomTestKeyPair()
    const privBytes = hexToBytes(privateHex)
    const sign = async (digest: Uint8Array): Promise<Signature> => {
      const sig = secp256k1.sign(digest, privBytes) // v2 defaults, two-argument form — no options object.
      return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
    }
    return { publicHex, privateHex, sign }
  }

  async function fixtureRequestDigest (init: { id: string, submittedAt: string }, requesterKey: string): Promise<Uint8Array> {
    return sha256(utf8ToBytes(JSON.stringify([init.id, requesterKey, init.submittedAt])))
  }

  async function fixtureAttestationDigest (answer: { requestId: string, nonce: string }, requesterKey: string): Promise<Uint8Array> {
    return sha256(utf8ToBytes(JSON.stringify([answer.requestId, answer.nonce, requesterKey])))
  }

  const payloadMarker = `p2p-staging-fixture-marker-${crypto.randomUUID()}`

  return {
    net,
    auth,
    db,
    recipients,
    sealer,
    opener,
    outsiderOpener,
    decisionSigner,
    makePort,
    rawRows,
    makeRequesterSigner,
    fixtureRequestDigest,
    fixtureAttestationDigest,
    payloadMarker
  }
}
