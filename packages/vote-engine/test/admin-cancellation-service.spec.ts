/**
 * admin-cancellation-service.spec.ts — the cancel service (src/authority/admin-cancellation.ts, 66.1-06, D-05).
 *
 * What this proves:
 *   - One current officer who holds 'rad' cancels a pending administration change with exactly ONE call to the
 *     sign callback (one biometric prompt), for a change already promoted into Admin and for one that exists only
 *     as a ProposedAdmin row, on a secp256k1 key and on a P-256 key.
 *   - Cancelling a change that is already cancelled resolves with zero sign calls and writes nothing.
 *   - A caller who is not a current 'rad' holder, an unknown target, a target already in effect and a malformed
 *     time are refused with a coded error BEFORE the prompt (zero sign calls, zero rows).
 *   - A signature from the wrong user or from a key that is not the cancelling user's is refused after the prompt
 *     and writes nothing; a schema refusal (wrong digest, or the change took effect during the prompt) maps to
 *     the coded 'refused' error; a second device that wins the race is treated as success.
 *   - No coded error carries SQL, Quereus text or a constraint name, and the service source stays browser-safe.
 *
 * The rig mirrors 66.1-04's schema spec: a founding administration two hours in the past, generation G1 one hour
 * in the past, one engine proposal TP ten minutes ahead (promoted into Admin), and raw ProposedAdmin seeds for
 * every other target. The `it`s share one rig and run in file order.
 */

import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from '@quereus/quereus'
import { ADMIN_CHANGE_ERROR_CODES } from '@votetorrent/vote-core'
import type { AdminInit, Proposal, Scope, Signature, User, UserKeyType } from '@votetorrent/vote-core'
import {
  ADMIN_CANCEL_DIGEST_TAG,
  adminCancelDigest,
  insertAdminCancellation
} from '../src/authority/admin-cancellation.js'
import { bytesToBase64url, fromCanonicalDatetime, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  type TestAuthorityContext
} from './fixtures/test-context.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const FULL_SCOPES: Scope[] = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] as Scope[]

const SERVICE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'authority', 'admin-cancellation.ts')

const FIXED_MESSAGES = [
  'There is no pending administration change at that time',
  'Only a current officer who can revise the administration can cancel this change',
  'The administration change could not be cancelled'
]

type SignFn = (digest: Uint8Array) => Promise<Signature>
type OfficerSel = AdminInit['officers'][number]

interface Rig {
  auth: TestAuthorityContext
  db: Database
  authorityId: string
  base: number
  founder: User
  founderSign: SignFn
  radP: User
  radPSign: SignFn
  nonRad: User
  outsider: User
  founding: string
  g1: string
  tp: string
  ta: string
  tb: string
  tc: string
  tr: string
}

/** Insert a user with a first key (copy of the dashboard spec's `insertFixtureUser`). */
async function insertFixtureUser (auth: TestAuthorityContext, user: User): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
  const key = user.activeKeys[0]!
  await auth.ctx.db.exec(
    `insert into UserKey (UserId, Type, PubKey, Expiration)
     with context UserKey = null, Signature = null, Tid = ${tid + 1}, now = :now, IsSignatureValid = true
     values (:userId, :keyType, :pubKey, :expiration)`,
    {
      userId: user.id,
      keyType: key.type,
      pubKey: key.key,
      expiration: toCanonicalDatetime(key.expiration),
      now: nowCanonicalDatetime()
    }
  )
}

/** Wraps a sign callback and counts how many times it is called. */
function countingSigner (inner: SignFn): SignFn & { calls: number } {
  const fn = (async (digest: Uint8Array) => {
    fn.calls++
    return inner(digest)
  }) as SignFn & { calls: number }
  fn.calls = 0
  return fn
}

/** A P-256 sign callback for `user`, signing the digest with `privBytes`. */
function p256SignCallback (user: User, privBytes: Uint8Array): SignFn {
  return async (digest) => ({
    signature: signDigestP256(bytesToBase64url(digest), privBytes),
    signerKey: user.activeKeys[0]!.key,
    signerUserId: user.id
  })
}

function existing (authorityId: string, userId: string, title: string, scopes: Scope[]): OfficerSel {
  return { existing: { userId, authorityId, title, scopes } } as OfficerSel
}

/** Engine proposal signed by the founder; asserts it was promoted. Returns the canonical EffectiveAt. */
async function propose (
  auth: TestAuthorityContext,
  founder: User,
  effectiveAtMs: number,
  officers: OfficerSel[]
): Promise<string> {
  const proposal: Proposal<AdminInit> = {
    proposed: { officers, effectiveAt: effectiveAtMs, thresholdPolicies: [{ policy: 'rad', threshold: 1 }] },
    signers: [founder.id]
  }
  await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(founder))
  const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
  expect(outcome?.status).to.equal('promoted')
  return toCanonicalDatetime(effectiveAtMs)
}

/** A raw, unpromoted target: one ProposedAdmin row, same columns and context as the engine's insert. */
async function seedProposedTarget (rig: Pick<Rig, 'db' | 'authorityId' | 'founder'>, effectiveAtMs: number): Promise<string> {
  const effectiveAt = toCanonicalDatetime(effectiveAtMs)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await rig.db.exec(
    `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
     with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
     values (:authorityId, :effectiveAt, :thresholdPolicies)`,
    {
      authorityId: rig.authorityId,
      effectiveAt,
      thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 1 }]),
      signerUserId: rig.founder.id,
      signerKey: rig.founder.activeKeys[0]!.key,
      signature: 'raw-test-seed',
      now: nowCanonicalDatetime(),
      isUserValid: true
    }
  )
  return effectiveAt
}

async function currentAdmin (rig: Pick<Rig, 'db' | 'authorityId'>): Promise<unknown> {
  const row = await rig.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: rig.authorityId })
  return row?.EffectiveAt
}

async function adminRowExists (rig: Pick<Rig, 'db' | 'authorityId'>, effectiveAt: string): Promise<boolean> {
  const row = await rig.db
    .prepare('select 1 as hit from Admin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId: rig.authorityId, effectiveAt })
  return row != null
}

async function rowsFor (rig: Rig, effectiveAt: string): Promise<Array<{ UserId: string, AdminEffectiveAt: string }>> {
  const out: Array<{ UserId: string, AdminEffectiveAt: string }> = []
  for await (const row of rig.db.eval(
    'select UserId, AdminEffectiveAt from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt',
    { authorityId: rig.authorityId, effectiveAt }
  )) {
    out.push({ UserId: row.UserId as string, AdminEffectiveAt: row.AdminEffectiveAt as string })
  }
  return out
}

async function totalRows (rig: Rig): Promise<number> {
  const row = await rig.db.prepare('select count(*) as n from AdminCancellation').get({})
  return Number(row?.n)
}

const LEAK_RE = /\b(select|insert|where|Quereus|CancelSignatureValid|TargetPending|CancellerIsRadOfficer)\b/i

/** Asserts the rejection carries `code`, a fixed message, and nothing that leaks SQL or a constraint name (V9). */
async function expectCode (p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try { await p } catch (err) { caught = err }
  expect(caught, `expected a rejection with code ${code}`).to.be.instanceOf(Error)
  const e = caught as Error & { code?: string }
  expect(e.code, `message was: ${e.message}`).to.equal(code)
  expect(FIXED_MESSAGES).to.include(e.message)
  expect(e.message).to.not.match(LEAK_RE)
}

async function makeRig (): Promise<Rig> {
  const base = Date.now()
  const net = await createTestNetwork({
    network: {
      admin: {
        officers: [{ init: { name: 'Admin A', title: 'Chair', scopes: FULL_SCOPES } }],
        effectiveAt: base - 2 * HOUR,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
      }
    }
  })
  const auth = await addTestAuthority(net)
  const db = auth.ctx.db
  const authorityId = auth.authority.id
  const founder = net.user

  const pKey = makeP256TestKey()
  const radP: User = { ...makeDistinctTestUser(), name: 'Service Rad P-256 Officer' }
  radP.activeKeys = [{ key: pKey.pubHex, type: 'P' as UserKeyType, expiration: base + DAY }]
  await insertFixtureUser(auth, radP)
  const nonRad: User = { ...makeDistinctTestUser(), name: 'Service Non-rad Officer' }
  await insertFixtureUser(auth, nonRad)
  const outsider: User = { ...makeDistinctTestUser(), name: 'Service Outsider' }
  await insertFixtureUser(auth, outsider)

  const foundingRow = await db
    .prepare('select min(EffectiveAt) as e from Admin where AuthorityId = :authorityId')
    .get({ authorityId })

  const roster = [
    existing(authorityId, founder.id, 'Chair', FULL_SCOPES),
    existing(authorityId, radP.id, 'Rad Officer', ['rad'] as Scope[]),
    existing(authorityId, nonRad.id, 'Clerk', ['mel'] as Scope[])
  ]
  // The file's only two engine proposals; only TP is in the future.
  const g1 = await propose(auth, founder, base - HOUR, roster)
  expect(await currentAdmin({ db, authorityId })).to.equal(g1)
  const tp = await propose(auth, founder, base + 10 * MIN, roster)
  expect(await adminRowExists({ db, authorityId }, tp)).to.equal(true)

  const partial = { db, authorityId, founder }
  const ta = await seedProposedTarget(partial, base + 2 * HOUR)
  const tb = await seedProposedTarget(partial, base + 3 * HOUR)
  const tc = await seedProposedTarget(partial, base + 4 * HOUR)
  const tr = await seedProposedTarget(partial, base + 6 * HOUR)

  return {
    auth,
    db,
    authorityId,
    base,
    founder,
    founderSign: makeTestSignCallback(founder),
    radP,
    radPSign: p256SignCallback(radP, pKey.privBytes),
    nonRad,
    outsider,
    founding: foundingRow!.e as string,
    g1,
    tp,
    ta,
    tb,
    tc,
    tr
  }
}

// ---------------------------------------------------------------------------
// Source-purity scanners (V10). Every hunted token is built from fragments.
// ---------------------------------------------------------------------------

function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const NODE_SPECIFIER_RE = new RegExp(`['"\`]${['no', 'de'].join('')}:`)
const BUFFER_RE = new RegExp(`\\b${['B', 'uffer'].join('')}\\b`)
const CONSOLE_TOKEN = ['con', 'sole.'].join('')
const RESERVED_BIND_RE = new RegExp(`:(${['li' + 'mit', 'de' + 'sc', 'gr' + 'oup', 'or' + 'der', 'ty' + 'pe', 'k' + 'ey', 'o' + 'r'].join('|')})\\b`)
const TXN_RE = new RegExp(`\\b(${['BE' + 'GIN', 'COM' + 'MIT', 'ROLL' + 'BACK'].join('|')})\\b`, 'i')
const SIGN_CALL_RE = new RegExp(`\\b${'si' + 'gn'}\\(`, 'g')
const INSERT_TOKEN = ['insert into', 'AdminCancellation'].join(' ')

function purityHits (stripped: string): string[] {
  const hits: string[] = []
  if (NODE_SPECIFIER_RE.test(stripped)) hits.push('node-specifier')
  if (BUFFER_RE.test(stripped)) hits.push('buffer')
  if (stripped.includes(CONSOLE_TOKEN)) hits.push('console')
  if (RESERVED_BIND_RE.test(stripped)) hits.push('reserved-bind')
  if (TXN_RE.test(stripped)) hits.push('transaction')
  return hits
}

function signCallSites (stripped: string): number {
  return (stripped.match(SIGN_CALL_RE) ?? []).length
}

function insertSites (stripped: string): number {
  return stripped.split(INSERT_TOKEN).length - 1
}

describe('admin cancellation service (66.1-06, D-05)', function () {
  this.timeout(300_000)

  let rig: Rig
  let rowsBefore: number

  before(async function () {
    this.timeout(240_000)
    rig = await makeRig()
  })

  beforeEach(async () => {
    if (rig != null) rowsBefore = await totalRows(rig)
  })

  it('exports the digest tag and computes the digest the schema checks', async () => {
    expect(ADMIN_CANCEL_DIGEST_TAG).to.equal('vt-admin-cancel')
    const a = await adminCancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt: rig.tb, userId: rig.founder.id })
    const b = await adminCancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt: rig.tc, userId: rig.founder.id })
    expect(a).to.be.instanceOf(Uint8Array)
    expect(a.length).to.equal(32)
    expect(bytesToBase64url(a)).to.not.equal(bytesToBase64url(b))
    expect(await totalRows(rig)).to.equal(0)
  })

  it('V1 the founder cancels the promoted change TP with one secp256k1 prompt', async () => {
    const signer = countingSigner(rig.founderSign)
    await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tp, userId: rig.founder.id, sign: signer })
    expect(signer.calls).to.equal(1)
    const rows = await rowsFor(rig, rig.tp)
    expect(rows).to.have.length(1)
    expect(rows[0]!.UserId).to.equal(rig.founder.id)
    expect(rows[0]!.AdminEffectiveAt).to.equal(rig.tp)
    expect(await totalRows(rig)).to.equal(rowsBefore + 1)
  })

  it('V2 cancelling TP again resolves with zero prompts and writes nothing', async () => {
    const signer = countingSigner(rig.founderSign)
    await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tp, userId: rig.founder.id, sign: signer })
    expect(signer.calls).to.equal(0)
    expect(await rowsFor(rig, rig.tp)).to.have.length(1)
    expect(await totalRows(rig)).to.equal(rowsBefore)
  })

  it('V2 a different rad holder cancelling TP also resolves with zero prompts (ISO-with-Z input normalised)', async () => {
    const signer = countingSigner(rig.radPSign)
    const isoZ = new Date(fromCanonicalDatetime(rig.tp)).toISOString()
    await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: isoZ, userId: rig.radP.id, sign: signer })
    expect(signer.calls).to.equal(0)
    const rows = await rowsFor(rig, rig.tp)
    expect(rows).to.have.length(1)
    expect(rows[0]!.UserId).to.equal(rig.founder.id)
    expect(await totalRows(rig)).to.equal(rowsBefore)
  })

  it('V3 radP cancels the unpromoted change TA with one P-256 prompt', async () => {
    expect(await adminRowExists(rig, rig.ta)).to.equal(false)
    const signer = countingSigner(rig.radPSign)
    await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.ta, userId: rig.radP.id, sign: signer })
    expect(signer.calls).to.equal(1)
    const rows = await rowsFor(rig, rig.ta)
    expect(rows).to.have.length(1)
    expect(rows[0]!.UserId).to.equal(rig.radP.id)
    expect(await totalRows(rig)).to.equal(rowsBefore + 1)
  })

  describe('V4 refusals before the prompt (zero sign calls, zero rows)', () => {
    const notAuthorized = ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized
    const notPending = ADMIN_CHANGE_ERROR_CODES.cancelNotPending

    async function refusedBeforePrompt (args: { effectiveAt: string, userId: string, authorityId?: string }, code: string): Promise<void> {
      const signer = countingSigner(rig.founderSign)
      await expectCode(
        insertAdminCancellation(rig.auth.ctx, {
          authorityId: args.authorityId ?? rig.authorityId,
          effectiveAt: args.effectiveAt,
          userId: args.userId,
          sign: signer
        }),
        code
      )
      expect(signer.calls).to.equal(0)
      expect(await totalRows(rig)).to.equal(rowsBefore)
    }

    it('a current officer holding only mel is not authorized', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.tb, userId: rig.nonRad.id }, notAuthorized)
    })

    it('a user with a live key who is not an officer is not authorized', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.tb, userId: rig.outsider.id }, notAuthorized)
    })

    it('an empty user id is not authorized', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.tb, userId: '' }, notAuthorized)
    })

    it('an unknown target (no Admin or ProposedAdmin row) is not pending', async () => {
      await refusedBeforePrompt({ effectiveAt: toCanonicalDatetime(rig.base + 5 * HOUR), userId: rig.founder.id }, notPending)
    })

    it('G1, already in effect, is not pending', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.g1, userId: rig.founder.id }, notPending)
    })

    it('the founding generation is not pending', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.founding, userId: rig.founder.id }, notPending)
    })

    it('a malformed time is not pending', async () => {
      await refusedBeforePrompt({ effectiveAt: 'not a time', userId: rig.founder.id }, notPending)
    })

    it('an empty authority id is not pending', async () => {
      await refusedBeforePrompt({ effectiveAt: rig.tb, userId: rig.founder.id, authorityId: '' }, notPending)
    })
  })

  describe('V5 signer mismatch after the prompt (one sign call, zero rows)', () => {
    it('a callback that returns radP\'s identity while cancelling as the founder is not authorized', async () => {
      const signer = countingSigner(rig.radPSign)
      await expectCode(
        insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tb, userId: rig.founder.id, sign: signer }),
        ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized
      )
      expect(signer.calls).to.equal(1)
      expect(await rowsFor(rig, rig.tb)).to.have.length(0)
      expect(await totalRows(rig)).to.equal(rowsBefore)
    })

    it('a callback that names the founder but signs with radP\'s key is not authorized', async () => {
      const signer = countingSigner(async (d) => ({ ...(await rig.radPSign(d)), signerUserId: rig.founder.id }))
      await expectCode(
        insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tb, userId: rig.founder.id, sign: signer }),
        ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized
      )
      expect(signer.calls).to.equal(1)
      expect(await rowsFor(rig, rig.tb)).to.have.length(0)
      expect(await totalRows(rig)).to.equal(rowsBefore)
    })
  })

  it('V6 a signature over another target\'s digest is refused by the schema and maps to admin-cancel-refused', async () => {
    const otherDigest = await adminCancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt: rig.tc, userId: rig.founder.id })
    const signer = countingSigner(async () => rig.founderSign(otherDigest))
    await expectCode(
      insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tb, userId: rig.founder.id, sign: signer }),
      ADMIN_CHANGE_ERROR_CODES.cancelRefused
    )
    expect(signer.calls).to.equal(1)
    expect(await rowsFor(rig, rig.tb)).to.have.length(0)
    expect(await totalRows(rig)).to.equal(rowsBefore)
  })

  it('V7 a change that takes effect during the prompt is refused at insert (admin-cancel-refused)', async function () {
    this.timeout(30_000)
    const soon = await seedProposedTarget(rig, Date.now() + 3_000)
    const signer = countingSigner(async (d) => {
      while (Date.now() < fromCanonicalDatetime(soon) + 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return rig.founderSign(d)
    })
    await expectCode(
      insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: soon, userId: rig.founder.id, sign: signer }),
      ADMIN_CHANGE_ERROR_CODES.cancelRefused
    )
    expect(signer.calls).to.equal(1)
    expect(await rowsFor(rig, soon)).to.have.length(0)
    expect(await totalRows(rig)).to.equal(rowsBefore)
  })

  it('V8 a second device that cancels the same change during the prompt makes this call resolve', async () => {
    const radPSigner = countingSigner(rig.radPSign)
    const founderSigner = countingSigner(async (d) => {
      await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tr, userId: rig.radP.id, sign: radPSigner })
      return rig.founderSign(d)
    })
    await insertAdminCancellation(rig.auth.ctx, { authorityId: rig.authorityId, effectiveAt: rig.tr, userId: rig.founder.id, sign: founderSigner })
    expect(founderSigner.calls).to.equal(1)
    expect(radPSigner.calls).to.equal(1)
    const rows = await rowsFor(rig, rig.tr)
    expect(rows).to.have.length(1)
    expect(rows[0]!.UserId).to.equal(rig.radP.id)
    expect(await totalRows(rig)).to.equal(rowsBefore + 1)
  })

  it('V9 the three fixed messages carry no SQL, Quereus text or constraint name', () => {
    expect(FIXED_MESSAGES).to.have.length(3)
    for (const m of FIXED_MESSAGES) expect(m).to.not.match(LEAK_RE)
    // Positive control: the leak pattern does see a constraint name and SQL.
    expect(`refused by ${['Target', 'Pending'].join('')}`).to.match(LEAK_RE)
    expect(['sel', 'ect 1'].join('')).to.match(LEAK_RE)
  })

  describe('V10 source purity of the service file (comments stripped)', () => {
    let stripped: string

    before(() => {
      stripped = stripComments(readFileSync(SERVICE_FILE, 'utf8'))
    })

    it('has no node specifier, byte buffer, console, reserved bind name or transaction statement', () => {
      expect(purityHits(stripped)).to.deep.equal([])
    })

    it('has exactly one sign call site and exactly one insert into the cancellation table', () => {
      expect(signCallSites(stripped)).to.equal(1)
      expect(insertSites(stripped)).to.equal(1)
    })

    it('exports exactly the three C3 names', () => {
      const exported = [...stripped.matchAll(/^export (?:const|async function|function|class|type|interface) (\w+)/gm)].map((m) => m[1])
      expect(exported).to.deep.equal(['ADMIN_CANCEL_DIGEST_TAG', 'adminCancelDigest', 'insertAdminCancellation'])
    })

    it('positive controls: each scanner sees a planted violation', () => {
      expect(purityHits(`import x from '${['no', 'de'].join('')}:fs'`)).to.include('node-specifier')
      expect(purityHits(`const b = ${['B', 'uffer'].join('')}.from('x')`)).to.include('buffer')
      expect(purityHits(`${CONSOLE_TOKEN}log('x')`)).to.include('console')
      expect(purityHits(`db.prepare('select 1 limit :${'li' + 'mit'}')`)).to.include('reserved-bind')
      expect(purityHits(`db.prepare('select 1 order by x :${'de' + 'sc'}')`)).to.include('reserved-bind')
      expect(purityHits(`db.exec('${'BE' + 'GIN'}')`)).to.include('transaction')
      expect(purityHits(`db.exec('${'roll' + 'back'}')`)).to.include('transaction')
      expect(signCallSites(`await args.${'si' + 'gn'}(d); await other.${'si' + 'gn'}(e)`)).to.equal(2)
      expect(insertSites(`'${INSERT_TOKEN} (A) values (1)'; '${INSERT_TOKEN} (B) values (2)'`)).to.equal(2)
    })

    it('positive control: violations only inside comments do not count', () => {
      const commentOnly = [
        `// import x from '${['no', 'de'].join('')}:fs'`,
        `/* const b = ${['B', 'uffer'].join('')}.from('x') */`,
        `// ${CONSOLE_TOKEN}log('x')`,
        `// :${'li' + 'mit'} ${'BE' + 'GIN'}`,
        `// args.${'si' + 'gn'}(d)`,
        `/* ${INSERT_TOKEN} (A) values (1) */`
      ].join('\n')
      const s = stripComments(commentOnly)
      expect(purityHits(s)).to.deep.equal([])
      expect(signCallSites(s)).to.equal(0)
      expect(insertSites(s)).to.equal(0)
      // and the same text unstripped does hit, so the comment test is not vacuous
      expect(purityHits(commentOnly).length).to.be.greaterThan(3)
    })
  })
})
