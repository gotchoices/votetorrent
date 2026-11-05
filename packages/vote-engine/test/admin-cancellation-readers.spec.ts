/**
 * admin-cancellation-readers.spec.ts — a cancelled administration change is never current anywhere (66.1-06, D-13).
 *
 * The file proves D-13 in two halves.
 *
 * First half, a structural drift scan (C5). Every place that picks "the administration in effect now" uses the same
 * selector: the latest Admin generation at or before now. Each copy must also skip a generation that was cancelled,
 * and that skip must sit on the same line as the time comparison. The scan covers `votetorrent.qsql` (with whole
 * `--` comment lines removed) and every `.ts` file under `packages/vote-engine/src` (with comments removed). It
 * deliberately does not cover `test/`: the 66.1-01 probe spec keeps the old text on purpose (planning note R-02).
 * `src/database/schema-sql.ts` is skipped because it is the one-line generated copy of the qsql whose byte identity
 * another spec pins; this file compares its count of the exclusion with the qsql's instead. The scanner's tokens are
 * built from fragments so this file never contains the selector it hunts, and positive controls prove the scanner
 * can see a missing exclusion, an unaliased selector, an exclusion on the wrong line and a commented-out copy.
 *
 * Second half, a real-wait proof on a real clock. An administration change dated 5 s ahead (the injected test
 * delay, D-02: the value is passed in, nothing is switched) adds officer X with 'vrg'. It is cancelled through the
 * real cancel service. After a real wait past its time it must not be current for any of the six readers: the
 * CurrentAdmin view, listCurrentScopeHolders, isCurrentPairingOfficer, the RegistrationDecision and
 * AssociationDecision DeciderIsOfficerWithScope CHECKs, and the ElectionTally PublisherIsOfficer CHECK. The same
 * roster in a change that is NOT cancelled must become current for all six. Finally, a schema copy with the
 * exclusion removed lets the same cancelled change become current and its officer's decision through, which shows
 * that the exclusion is what refuses.
 */

import { expect } from 'chai'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adminChangeEffectiveAt } from '@votetorrent/vote-core'
import type { AdminInit, Proposal, Scope, User } from '@votetorrent/vote-core'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { setSchemaSql } from '../src/database/initialize.js'
import { insertAdminCancellation } from '../src/authority/admin-cancellation.js'
import { listCurrentScopeHolders } from '../src/signing/threshold.js'
import { isCurrentPairingOfficer } from '../src/pairing/pairing-statement.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { buildTallyTree, type TallyTree } from '../src/blocks/tally-tree.js'
import { TallyPublicationEngine, type TallyPublisher } from '../src/tally/tally-publication.js'
import type { EngineContext } from '../src/types.js'
import { fromCanonicalDatetime, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  signTestDigest,
  type TestAuthorityContext
} from './fixtures/test-context.js'
import { runDkgToQuiescence, seedDkgElection } from './fixtures/dkg-keyholders.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, '..', 'src')
const QSQL_FILE = join(HERE, '..', '..', 'vote-core', 'schema', 'votetorrent.qsql')

// ---------------------------------------------------------------------------
// Scanner constants, built from fragments.
// ---------------------------------------------------------------------------

const SEL_HEAD = ['ma', 'x('].join('')
/** The aliased selector every site must use. */
const SELECTOR_ALIASED = [SEL_HEAD, 'A.', 'EffectiveAt)'].join('')
/** The selector with any alias or none. A fresh global regex per call (lastIndex is stateful). */
const selectorRe = (): RegExp => new RegExp(['ma', 'x\\(\\s*(?:\\w+\\.)?', 'Effective', 'At\\s*\\)'].join(''), 'g')
const COMPARISON = 'A.EffectiveAt <='
const EXCLUSION =
  'and not exists (select 1 from AdminCancellation C where C.AuthorityId = A.AuthorityId and C.AdminEffectiveAt = A.EffectiveAt)'
/**
 * 66.1-04 SUMMARY, `### Branch taken`: "SELF_REFERENCE | present | A2 = PASS". CancellerIsRadOfficer carries the
 * exclusion, so no site is allow-listed.
 */
const SELF_REFERENCE_SHIPPED = true

type Reason = 'ok' | 'unaliased' | 'no-comparison' | 'no-exclusion'
interface Site { name: string, reason: Reason }

/** Drop whole lines whose first non-space characters are `--` (the rule 66.1-04's acceptance greps use). */
function stripSql (text: string): string {
  return text.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
}

/** Remove block and line comments (the intake-source-gates idiom). */
function stripTs (text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function countOf (text: string, needle: string): number {
  return text.split(needle).length - 1
}

function scanSites (stripped: string, kind: 'sql' | 'ts'): Site[] {
  const nameRe = kind === 'sql' ? /\b(?:constraint|view)\s+(\w+)/g : /\bfunction\s+(\w+)/g
  const sites: Site[] = []
  for (const m of stripped.matchAll(selectorRe())) {
    const at = m.index ?? 0
    const before = stripped.slice(0, at)
    const names = [...before.matchAll(nameRe)]
    const name = names.length > 0 ? names[names.length - 1]![1]! : '(none)'
    let reason: Reason
    if (m[0] !== SELECTOR_ALIASED) {
      reason = 'unaliased'
    } else {
      const after = at + m[0].length
      const window = stripped.slice(after, after + 400)
      const cmp = window.indexOf(COMPARISON)
      if (cmp < 0) {
        reason = 'no-comparison'
      } else {
        const lineStart = after + cmp
        const lineEnd = stripped.indexOf('\n', lineStart)
        const rest = stripped.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        reason = rest.includes(EXCLUSION) ? 'ok' : 'no-exclusion'
      }
    }
    sites.push({ name, reason })
  }
  return sites
}

function engineSourceFiles (): string[] {
  return (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => f.endsWith('.ts') && f !== 'database/schema-sql.ts')
    .sort()
}

describe('cancellation exclusion drift scan (C5)', () => {
  describe('real files', () => {
    it('votetorrent.qsql has exactly the five current-generation sites, each carrying the exclusion', () => {
      const stripped = stripSql(readFileSync(QSQL_FILE, 'utf8'))
      const sites = scanSites(stripped, 'sql')
      expect(sites.map((s) => s.name).sort(), 'a new current-generation reader must carry the cancellation exclusion, then update this pin')
        .to.deep.equal(['CancellerIsRadOfficer', 'CurrentAdmin', 'DeciderIsOfficerWithScope', 'DeciderIsOfficerWithScope', 'PublisherIsOfficer'])
      if (SELF_REFERENCE_SHIPPED) {
        expect(sites.filter((s) => s.reason !== 'ok')).to.deep.equal([])
        expect(countOf(stripped, EXCLUSION)).to.equal(5)
      } else {
        // 66.1-01 A2 = FAIL branch (planning note R-22): the one allow-listed site.
        expect(sites.filter((s) => s.reason !== 'ok')).to.deep.equal([{ name: 'CancellerIsRadOfficer', reason: 'no-exclusion' }])
        expect(countOf(stripped, EXCLUSION)).to.equal(4)
      }
    })

    it('the engine source has exactly one current-generation site, isCurrentPairingOfficer, carrying the exclusion', () => {
      const found: Array<Site & { file: string }> = []
      for (const rel of engineSourceFiles()) {
        const stripped = stripTs(readFileSync(join(SRC_DIR, rel), 'utf8'))
        for (const s of scanSites(stripped, 'ts')) found.push({ ...s, file: rel })
      }
      expect(found, 'a new current-generation reader must carry the cancellation exclusion, then update this pin')
        .to.deep.equal([{ name: 'isCurrentPairingOfficer', reason: 'ok', file: 'pairing/pairing-statement.ts' }])
    })

    it('the generated schema copy holds the exclusion as many times as the qsql file', () => {
      const raw = readFileSync(QSQL_FILE, 'utf8')
      expect(countOf(VOTETORRENT_SCHEMA_SQL, EXCLUSION)).to.equal(countOf(raw, EXCLUSION))
      expect(countOf(raw, EXCLUSION)).to.equal(SELF_REFERENCE_SHIPPED ? 5 : 4)
    })
  })

  describe('positive controls', () => {
    const checkWith = (tail: string): string => [
      '\ttable T (',
      '\t\tconstraint SomeOfficerCheck check on insert (',
      '\t\t\texists (select 1 from Officer O where O.AdminEffectiveAt = (',
      `\t\t\t\tselect ${SELECTOR_ALIASED} from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= context.now${tail}`,
      '\t\t\t))',
      '\t\t)',
      '\t)'
    ].join('\n')

    it('a CHECK whose comparison line lacks the exclusion is one no-exclusion site named after its constraint', () => {
      expect(scanSites(stripSql(checkWith('')), 'sql')).to.deep.equal([{ name: 'SomeOfficerCheck', reason: 'no-exclusion' }])
    })

    it('the same CHECK with the exclusion is ok', () => {
      expect(scanSites(stripSql(checkWith(` ${EXCLUSION}`)), 'sql')).to.deep.equal([{ name: 'SomeOfficerCheck', reason: 'ok' }])
    })

    it('a view whose exclusion sits on the line after the comparison is no-exclusion (same-line rule)', () => {
      const view = [
        '\tview SomeView as',
        `\t\tselect A.AuthorityId, ${SELECTOR_ALIASED} as EffectiveAt`,
        '\t\t\tfrom Admin A',
        "\t\t\twhere A.EffectiveAt <= datetime('now')",
        `\t\t\t\t${EXCLUSION}`,
        '\t\t\tgroup by A.AuthorityId;'
      ].join('\n')
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'SomeView', reason: 'no-exclusion' }])
    })

    it('an unaliased selector is reported as unaliased', () => {
      const view = [
        '\tview OldView as',
        `\t\tselect AuthorityId, ${SEL_HEAD}EffectiveAt) as EffectiveAt from Admin where EffectiveAt <= datetime('now') group by AuthorityId;`
      ].join('\n')
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'OldView', reason: 'unaliased' }])
    })

    it('a selector with no time comparison after it is reported as no-comparison', () => {
      const view = `\tview LatestEver as\n\t\tselect ${SELECTOR_ALIASED} as E from Admin A;`
      expect(scanSites(stripSql(view), 'sql')).to.deep.equal([{ name: 'LatestEver', reason: 'no-comparison' }])
    })

    it('a violating CHECK only on -- comment lines yields zero sites', () => {
      const commented = checkWith('').split('\n').map((l) => `\t-- ${l.trim()}`).join('\n')
      expect(scanSites(commented, 'sql').length, 'unstripped text is seen (control is not vacuous)').to.be.greaterThan(0)
      expect(scanSites(stripSql(commented), 'sql')).to.deep.equal([])
    })

    const tsWith = (tail: string): string => [
      'export async function someOfficerTest (db: Database): Promise<boolean> {',
      `  const row = await db.prepare('select 1 as x from Officer O where O.AdminEffectiveAt = (select ${SELECTOR_ALIASED} from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= :nowAt${tail})').get({})`,
      '  return row != null',
      '}'
    ].join('\n')

    it('a TypeScript prepare string without the exclusion is one no-exclusion site named after its function', () => {
      expect(scanSites(stripTs(tsWith('')), 'ts')).to.deep.equal([{ name: 'someOfficerTest', reason: 'no-exclusion' }])
      expect(scanSites(stripTs(tsWith(` ${EXCLUSION}`)), 'ts')).to.deep.equal([{ name: 'someOfficerTest', reason: 'ok' }])
    })

    it('the same TypeScript inside a line comment or a block comment yields zero sites', () => {
      const lineCommented = tsWith('').split('\n').map((l) => `// ${l}`).join('\n')
      const blockCommented = `/*\n${tsWith('')}\n*/`
      expect(scanSites(lineCommented, 'ts').length, 'unstripped text is seen (control is not vacuous)').to.equal(1)
      expect(scanSites(stripTs(lineCommented), 'ts')).to.deep.equal([])
      expect(scanSites(stripTs(blockCommented), 'ts')).to.deep.equal([])
    })

    it('the REAL qsql text with every exclusion removed reports five non-ok sites', () => {
      const stripped = stripSql(readFileSync(QSQL_FILE, 'utf8'))
      const mutated = stripped.split(EXCLUSION).join('')
      expect(mutated).to.not.equal(stripped)
      const sites = scanSites(mutated, 'sql')
      expect(sites).to.have.length(5)
      expect(sites.every((s) => s.reason === 'no-exclusion')).to.equal(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Real-wait reader proof: shared helpers (private to this file).
// ---------------------------------------------------------------------------

/** D-02: the test injects a 5 s delay in place of the shipped hour. */
const INJECTED_DELAY_MS = 5_000
const FULL_SCOPES: Scope[] = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] as Scope[]

type OfficerSel = AdminInit['officers'][number]

function effectiveIn5s (): string {
  return adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
}

/** Sleep until a full 1.5 s after `canonical`. A wait-until, so a loaded host is slower, never flaky. */
async function waitPast (canonical: string): Promise<void> {
  const until = fromCanonicalDatetime(canonical) + 1_500
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(10, until - Date.now()))))
  }
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

/** A signer wrapper over a registered test User's own key (copy of staging-schema's `officerSignerFor`). */
function officerSignerFor (user: User): { sign: (digestBase64url: string) => { signature: string, signerKey: string } } {
  return {
    sign: (d: string) => {
      const sig = signTestDigest(user, d)
      return { signature: sig.signature, signerKey: sig.signerKey }
    }
  }
}

let cursorSeq = 0
/** 16-digit zero-padded decimal cursor, per the P2P transport convention. */
function nextCursor (): string {
  cursorSeq += 1
  return String(cursorSeq).padStart(16, '0')
}

/** Sign and insert an 'a' RegistrationDecision for a fresh strand and request (staging-schema's helpers, merged). */
async function registrationDecisionAs (ctx: EngineContext, authorityId: string, decider: User): Promise<{ strandId: string, requestId: string }> {
  const strandId = `strand-${crypto.randomUUID()}`
  const requestId = crypto.randomUUID()
  const decidedAt = toIsoZDatetime(Date.now())
  const row = await ctx.db
    .prepare("select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d")
    .get({ strandId, requestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt })
  if (!row || row.d == null) throw new Error('registrationDecisionAs: Digest() returned null')
  const sig = officerSignerFor(decider).sign(row.d as string)
  await ctx.db.exec(
    `insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature)
     with context now = :now
     values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)`,
    {
      strandId,
      cursor: nextCursor(),
      requestId,
      authorityId,
      status: 'a',
      reason: null,
      closesRequestId: null,
      decidedAt,
      deciderKey: sig.signerKey,
      deciderSignature: sig.signature,
      now: nowCanonicalDatetime()
    }
  )
  return { strandId, requestId }
}

/** Sign and insert a 'c' AssociationDecision with a ChallengeNonce (staging-schema's accepted case). */
async function associationDecisionAs (ctx: EngineContext, authorityId: string, decider: User): Promise<{ strandId: string, requestId: string }> {
  const strandId = `strand-${crypto.randomUUID()}`
  const requestId = crypto.randomUUID()
  const challengeNonce = crypto.randomUUID()
  const decidedAt = toIsoZDatetime(Date.now())
  const row = await ctx.db
    .prepare("select Digest('AssociationDecision', :strandId, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt) as d")
    .get({ strandId, requestId, authorityId, status: 'c', challengeNonce, reason: null, revokesDeviceKey: null, matchMethod: null, decidedAt })
  if (!row || row.d == null) throw new Error('associationDecisionAs: Digest() returned null')
  const sig = officerSignerFor(decider).sign(row.d as string)
  await ctx.db.exec(
    `insert into AssociationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature)
     with context now = :now
     values (:strandId, :cursor, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt, :deciderKey, :deciderSignature)`,
    {
      strandId,
      cursor: nextCursor(),
      requestId,
      authorityId,
      status: 'c',
      challengeNonce,
      reason: null,
      revokesDeviceKey: null,
      matchMethod: null,
      decidedAt,
      deciderKey: sig.signerKey,
      deciderSignature: sig.signature,
      now: nowCanonicalDatetime()
    }
  )
  return { strandId, requestId }
}

async function decisionRows (ctx: EngineContext, table: 'RegistrationDecision' | 'AssociationDecision', ids: { strandId: string, requestId: string }): Promise<number> {
  const row = await ctx.db
    .prepare(`select count(*) as c from ${table} where StrandId = :strandId and RequestId = :requestId`)
    .get(ids)
  return Number(row?.c)
}

/** Runs `write` and returns the error text, or fails if it did not throw. */
async function refusalText (write: () => Promise<unknown>): Promise<string> {
  let caught: unknown
  try { await write() } catch (err) { caught = err }
  expect(caught, 'expected the write to be refused').to.be.instanceOf(Error)
  return (caught as Error).message
}

async function currentAdminAt (ctx: EngineContext, authorityId: string): Promise<unknown> {
  const row = await ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  return row?.EffectiveAt
}

function rosterOf (authorityId: string, founder: User, x: User): OfficerSel[] {
  return [
    { existing: { userId: founder.id, authorityId, title: 'Chair', scopes: FULL_SCOPES } } as OfficerSel,
    { existing: { userId: x.id, authorityId, title: 'Registrar', scopes: ['vrg'] as Scope[] } } as OfficerSel
  ]
}

/** The founder proposes `officers` at `effectiveAt`; asserts the change was promoted into Admin. */
async function proposeRoster (auth: TestAuthorityContext, officers: OfficerSel[], effectiveAt: string): Promise<void> {
  const founder = auth.user
  const proposal: Proposal<AdminInit> = {
    proposed: { officers, effectiveAt, thresholdPolicies: [{ policy: 'rad', threshold: 1 }] },
    signers: [founder.id]
  }
  await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(founder))
  const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
  expect(outcome?.status).to.equal('promoted')
  const row = await auth.ctx.db
    .prepare('select 1 as hit from Admin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId: auth.authority.id, effectiveAt })
  expect(row, 'an Admin row at the proposed time').to.not.equal(undefined)
}

/** The founder cancels the change at `effectiveAt` through the real service, with exactly one prompt. */
async function cancelAsFounder (auth: TestAuthorityContext, effectiveAt: string): Promise<void> {
  if (Date.now() >= fromCanonicalDatetime(effectiveAt)) {
    expect.fail('host too slow: the 5 s window elapsed before the cancel')
  }
  const inner = makeTestSignCallback(auth.user)
  let calls = 0
  await insertAdminCancellation(auth.ctx, {
    authorityId: auth.authority.id,
    effectiveAt,
    userId: auth.user.id,
    sign: async (d) => { calls++; return inner(d) }
  })
  expect(calls).to.equal(1)
}

async function cancellationRows (ctx: EngineContext, authorityId: string, effectiveAt: string): Promise<number> {
  const row = await ctx.db
    .prepare('select count(*) as n from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
    .get({ authorityId, effectiveAt })
  return Number(row?.n)
}

/** The current generation WITHOUT the exclusion (non-vacuity control), built from fragments. */
const UNFILTERED_CURRENT_SQL =
  `select ${SELECTOR_ALIASED} as e from Admin A where A.AuthorityId = :authorityId and A.EffectiveAt <= :nowAt`
/** isCurrentPairingOfficer's statement WITHOUT the exclusion (TypeScript control), built from fragments. */
const UNFILTERED_PAIRING_SQL =
  'select 1 as x from Officer O where O.UserId = :pairUserId and O.AdminEffectiveAt = ' +
  `(select ${SELECTOR_ALIASED} from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= :nowAt)`

describe('a cancelled change is never current (D-13, real wait)', function () {
  this.timeout(300_000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let auth: TestAuthorityContext
  let ctx: EngineContext
  let authorityId: string
  let founding: unknown
  let x: User
  let xPublisher: TallyPublisher
  let tally: TallyTree
  let gCancel: string
  let gLive: string

  before(async function () {
    this.timeout(240_000)
    // The tally rig of tally-publication.spec.ts: a real 2-of-3 DKG election, keys released, empty tree built.
    elec = await seedDkgElection({ keyholders: ['rd-1', 'rd-2', 'rd-3'], threshold: 2 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    auth = elec.auth
    ctx = { db: auth.ctx.db }
    authorityId = auth.authority.id
    const timeline = await ctx.db.prepare('select Timeline from ElectionRevision where ElectionId = :id').get({ id: elec.electionId })
    const at = releasingKeysAt(JSON.parse(timeline!.Timeline as string) as Record<string, number>)!
    for (const p of elec.participants.slice(0, 2)) {
      await new KeyReleaseEngine(ctx, { vault: p.vault, now: () => at }).releaseKeyShare(elec.electionId, p.signer)
    }
    const key = await new KeyReleaseEngine(ctx).reconstructElectionKey(elec.electionId)
    const built = buildTallyTree({
      scope: { electionId: elec.electionId, electionRevision: elec.revision },
      rows: [], voterRows: [], ballots: [], registrants: [], associations: [],
      timeline: { votingStarts: 0 },
      release: { secretKey: key.secretKey, jointPublicKey: key.jointPublicKey }
    })
    key.secretKey.fill(0)
    if (!built.ok) throw new Error(`fixture: buildTallyTree refused: ${built.reason} ${built.detail}`)
    tally = built.tally

    x = { ...makeDistinctTestUser(), name: 'Readers Officer X' }
    await insertFixtureUser(auth, x)
    xPublisher = { userId: x.id, signingPublicKey: x.activeKeys[0]!.key, sign: makeTestSignCallback(x) }
    founding = await currentAdminAt(ctx, authorityId)
    expect(founding).to.be.a('string')
  })

  /** The tally engine with the DEFAULT real clock, so PublisherIsOfficer judges the generation at the real time. */
  const tallyEngine = (): TallyPublicationEngine => new TallyPublicationEngine(ctx)

  it('RD0 the change adding X is promoted and still in the future', async () => {
    gCancel = effectiveIn5s()
    await proposeRoster(auth, rosterOf(authorityId, auth.user, x), gCancel)
    expect(await currentAdminAt(ctx, authorityId)).to.equal(founding)
    expect(await isCurrentPairingOfficer(ctx.db, { userId: x.id, nowCanonical: nowCanonicalDatetime() })).to.equal(false)
  })

  it('RD1 the founder cancels it through the service with one prompt', async () => {
    await cancelAsFounder(auth, gCancel)
    expect(await cancellationRows(ctx, authorityId, gCancel)).to.equal(1)
  })

  describe('RD2 after a real wait past its time, every reader refuses the cancelled generation', () => {
    before(async function () {
      this.timeout(30_000)
      await waitPast(gCancel)
    })

    it('the CurrentAdmin view still reads the founding generation', async () => {
      expect(await currentAdminAt(ctx, authorityId)).to.equal(founding)
    })

    it('non-vacuity control: without the exclusion the cancelled generation WOULD be current', async () => {
      const row = await ctx.db.prepare(UNFILTERED_CURRENT_SQL).get({ authorityId, nowAt: nowCanonicalDatetime() })
      expect(row?.e).to.equal(gCancel)
    })

    it('listCurrentScopeHolders does not list X for vrg', async () => {
      expect(await listCurrentScopeHolders(ctx.db, authorityId, 'vrg' as Scope)).to.not.include(x.id)
    })

    it('isCurrentPairingOfficer is false for X, and the same statement without the exclusion returns X', async () => {
      const nowAt = nowCanonicalDatetime()
      expect(await isCurrentPairingOfficer(ctx.db, { userId: x.id, nowCanonical: nowAt })).to.equal(false)
      const control = await ctx.db.prepare(UNFILTERED_PAIRING_SQL).get({ pairUserId: x.id, nowAt })
      expect(control, 'the control statement returns a row for X').to.not.equal(undefined)
      expect(control).to.not.equal(null)
    })

    it('X\'s RegistrationDecision is refused by DeciderIsOfficerWithScope', async () => {
      const text = await refusalText(() => registrationDecisionAs(ctx, authorityId, x))
      expect(text).to.contain('DeciderIsOfficerWithScope')
    })

    it('X\'s AssociationDecision is refused by DeciderIsOfficerWithScope', async () => {
      const text = await refusalText(() => associationDecisionAs(ctx, authorityId, x))
      expect(text).to.contain('DeciderIsOfficerWithScope')
    })

    it('X\'s tally publish is not-officer, from PublisherIsOfficer, and nothing is published', async () => {
      const thrown: unknown[] = []
      const db = ctx.db
      const watched = new Proxy(db, {
        get (target, prop, receiver) {
          if (prop !== 'exec') return Reflect.get(target, prop, receiver)
          return async (...args: unknown[]) => {
            try {
              return await (target.exec as (...a: unknown[]) => Promise<unknown>).apply(target, args)
            } catch (err) {
              thrown.push(err)
              throw err
            }
          }
        }
      })
      const r = await new TallyPublicationEngine({ db: watched }).publishElectionTally(tally, xPublisher)
      expect(r.outcome).to.equal('not-officer')
      expect(thrown.map(String).join(' | ')).to.contain('PublisherIsOfficer')
      expect(await tallyEngine().readPublishedTally(elec.electionId, elec.revision)).to.equal(null)
    })
  })

  describe('RD3 control: the same roster in an uncancelled change becomes current for every reader', () => {
    before(async function () {
      this.timeout(60_000)
      gLive = effectiveIn5s()
      await proposeRoster(auth, rosterOf(authorityId, auth.user, x), gLive)
      expect(await cancellationRows(ctx, authorityId, gLive)).to.equal(0)
      await waitPast(gLive)
    })

    it('the CurrentAdmin view reads the uncancelled generation', async () => {
      expect(gLive > gCancel).to.equal(true)
      expect(await currentAdminAt(ctx, authorityId)).to.equal(gLive)
    })

    it('listCurrentScopeHolders lists X for vrg', async () => {
      expect(await listCurrentScopeHolders(ctx.db, authorityId, 'vrg' as Scope)).to.include(x.id)
    })

    it('isCurrentPairingOfficer is true for X', async () => {
      expect(await isCurrentPairingOfficer(ctx.db, { userId: x.id, nowCanonical: nowCanonicalDatetime() })).to.equal(true)
    })

    it('X\'s RegistrationDecision and AssociationDecision are accepted', async () => {
      const reg = await registrationDecisionAs(ctx, authorityId, x)
      expect(await decisionRows(ctx, 'RegistrationDecision', reg)).to.equal(1)
      const assoc = await associationDecisionAs(ctx, authorityId, x)
      expect(await decisionRows(ctx, 'AssociationDecision', assoc)).to.equal(1)
    })

    it('X publishes the tally (PublisherIsOfficer accepts)', async () => {
      const r = await tallyEngine().publishElectionTally(tally, xPublisher)
      expect(r.outcome).to.equal('published')
      const back = await tallyEngine().readPublishedTally(elec.electionId, elec.revision)
      expect(back).to.not.equal(null)
      expect(back!.publisherUserId).to.equal(x.id)
    })
  })
})

describe('the exclusion is load-bearing (schema mutation)', function () {
  this.timeout(120_000)

  it('with the exclusion removed from the schema, the same cancelled change becomes current and X\'s decision is accepted', async () => {
    const escaped = EXCLUSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\s+${escaped}`, 'g')
    const removed = (VOTETORRENT_SCHEMA_SQL.match(re) ?? []).length
    expect(removed).to.equal(SELF_REFERENCE_SHIPPED ? 5 : 4)
    const mutated = VOTETORRENT_SCHEMA_SQL.replace(re, '')
    expect(mutated).to.not.equal(VOTETORRENT_SCHEMA_SQL)
    expect(countOf(mutated, EXCLUSION)).to.equal(0)

    try {
      setSchemaSql(mutated)
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const mctx: EngineContext = { db: auth.ctx.db }
      const mAuthorityId = auth.authority.id
      const mx: User = { ...makeDistinctTestUser(), name: 'Mutation Officer X' }
      await insertFixtureUser(auth, mx)

      const gMut = effectiveIn5s()
      await proposeRoster(auth, rosterOf(mAuthorityId, auth.user, mx), gMut)
      // The founder is current in the founding generation, so the cancel is accepted even without the
      // self-reference in CancellerIsRadOfficer.
      await cancelAsFounder(auth, gMut)
      expect(await cancellationRows(mctx, mAuthorityId, gMut)).to.equal(1)
      await waitPast(gMut)

      expect(await currentAdminAt(mctx, mAuthorityId)).to.equal(gMut)
      const reg = await registrationDecisionAs(mctx, mAuthorityId, mx)
      expect(await decisionRows(mctx, 'RegistrationDecision', reg)).to.equal(1)
      // The AssociationDecision and ElectionTally copies are the same text, pinned by the drift scan above; they are
      // not re-run under mutation, to avoid a second DKG rig.
    } finally {
      setSchemaSql(undefined)
    }
  })
})
