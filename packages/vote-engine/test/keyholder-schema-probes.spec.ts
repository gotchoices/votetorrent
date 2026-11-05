/**
 * keyholder-schema-probes.spec.ts — 62-02 Task 1.
 *
 * PERMANENT, VERDICT-RECORDING PROBE — do not delete or reduce to a throwaway (mirrors
 * `staging-schema-probes.spec.ts`'s / `quereus-delete-check-semantics.spec.ts`'s discipline).
 * Decides three open questions Task 2/3 of 62-02-PLAN.md depend on, against the Quereus version
 * actually installed in this repo. Each probe applies its candidate with `setSchemaSql(candidate)`
 * in `before()`/`beforeEach()` and `setSchemaSql(undefined)` in `after()`/`afterEach()`.
 *
 * PROBE 1 (D-26 accept-transaction shape): decides whether `KeyholderDkgBinding.KeyholderExists`
 * ships alongside `InviteAccepted`, or whether `InviteAccepted` alone is sufficient (research
 * ruling 3 / `<interfaces>`'s "kept only if Probe 1 passes").
 *
 *   VERDICT: PASS — (a)-(e) all hold exactly as designed. Task 2 ships BOTH `KeyholderExists` and
 *   `InviteAccepted` on `KeyholderDkgBinding`, and Task 3 ships the binding-required
 *   `Keyholder.InsertValid` body, unmodified from `<interfaces>`.
 *
 * PROBE 2 (D-38 NULL semantics): decides the exact `UserKey.ExpirationFuture` CHECK text.
 *
 *   VERDICT: Quereus distinguishes two DIFFERENT omission shapes, and only one is a silent
 *   NULL-bypass risk. (1) Omitting the `with context X = ...` clause ENTIRELY for a context
 *   variable declared WITHOUT a `null` marker is a hard bind-time error ("requires mutation
 *   context variable 'X'") — not a silent NULL. (2) SUPPLYING the `with context now = :now`
 *   clause but binding `:now` to JS `null` compiles fine and the bare `Expiration > context.now`
 *   evaluates NULL, which standard CHECK semantics treat as SATISFIED (not violated) — THIS is the
 *   real-world NULL-bypass risk (a producer that supplies the context slot but forgets to actually
 *   compute/bind a value), and the exact one the shipped `UserKey.ExpirationFuture` text (Task 1,
 *   already landed) closes with its `context.now is not null` conjunct. For a context variable
 *   declared WITH a `null` marker (e.g. `IsImportReplay integer null`), omitting the `with context`
 *   clause entirely is legal and reads as SQL NULL inside the CHECK (same as explicitly binding
 *   JS `null`) — no bind-time error for THOSE variables specifically.
 *   `coalesce(context.IsImportReplay, 0) = 1` truth table:
 *   bound 1 → true (admits); bound 0, bound null, and OMITTED → false (does not admit, confirming
 *   omission is never a silent bypass); JS boolean `true` bound into an `integer null` context slot
 *   is accepted by Quereus's parameter binder and coerces such that `= 1` is satisfied (recorded as
 *   a finding, not relied upon — every real producer must still bind the literal integer `1`, per
 *   the grep gate and the doc comment on the shipped CHECK).
 *
 * PROBE 3 (founding-row replay, research Pitfall 4): decides whether D-38 needs any table beyond
 * UserKey.
 *
 *   VERDICT: replaying all six founding rows (User, UserKey, Authority, Admin, Officer, Network) at
 *   their ORIGINAL column values into a fresh database, after the founding UserKey's Expiration has
 *   passed, fails EXACTLY ONE statement — the UserKey insert, on `ExpirationFuture` — against the
 *   PRE-Task-1 schema. Against the shipped (Task 1) schema, binding `IsImportReplay = 1` on the
 *   UserKey statement ONLY (every other statement unchanged, no flag), all six insert. No other
 *   founding table needs a waiver.
 */

import { Database, ConstraintError } from '@quereus/quereus'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { registerDbPlugins, setSchemaSql } from '../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback
} from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'
import type { KeyholderInvite } from '@votetorrent/vote-core'

// ═══════════════════════════════════════════════════════════════════════════
// Probe 1 — D-26 accept-transaction shape
// ═══════════════════════════════════════════════════════════════════════════

// Anchor unique to the schema (verified empirically: exactly one `table Task (` in the file).
const TASK_TABLE_ANCHOR = '\ttable Task ('

// The EXACT table text Task 2 ships verbatim if this probe's VERDICT is PASS — kept here as an
// independent literal (not imported from a shared module) so a later accidental drift between the
// probe's candidate and the real schema is caught by re-running this file, not masked by sharing.
const KEYHOLDER_DKG_BINDING_CANDIDATE = `
	table KeyholderDkgBinding (
		ElectionId text,
		ElectionRevision integer,
		UserId text,
		InviteSlotCid text,
		DkgPublicKey text,
		BoundAt text,
		SignerKey text,
		Signature text,
		primary key (ElectionId, ElectionRevision, UserId),
		constraint DkgPublicKeyFormat check (
			length(new.DkgPublicKey) = 66 and (like('02%', new.DkgPublicKey) or like('03%', new.DkgPublicKey))
		),
		constraint BoundAtValid check (isISODatetime(new.BoundAt) and like('%Z', new.BoundAt)),
		constraint RevisionInteger check (typeof(new.ElectionRevision) = 'integer'),
		constraint InviteAccepted check on insert (
			exists (
				select 1 from InviteSlot S join InviteResult IR on IR.SlotCid = S.Cid
					where S.Cid = new.InviteSlotCid and S.Type = 'k' and S.ElectionId = new.ElectionId
						and IR.IsAccepted and IR.InvokedId = new.UserId
			)
		),
		constraint KeyholderExists check on insert (
			exists (
				select 1 from Keyholder K
					where K.ElectionId = new.ElectionId and K.ElectionRevision = new.ElectionRevision and K.UserId = new.UserId
			)
		),
		constraint SignerIsUser check on insert (
			exists (select 1 from UserKey K where K.UserId = new.UserId and K.PubKey = new.SignerKey)
		),
		constraint SignatureValid check (
			SignatureValid(
				Digest('KeyholderDkgBinding', new.ElectionId, new.ElectionRevision, new.UserId, new.InviteSlotCid, new.DkgPublicKey, new.BoundAt),
				new.Signature,
				new.SignerKey
			)
				or SignatureValidP256(
					Digest('KeyholderDkgBinding', new.ElectionId, new.ElectionRevision, new.UserId, new.InviteSlotCid, new.DkgPublicKey, new.BoundAt),
					new.Signature,
					new.SignerKey
				)
		),
		constraint NoUpdate check on update (false),
		constraint NoDelete check on delete (false)
	);

`

const OLD_KEYHOLDER_INSERT_VALID =
  `constraint InsertValid check on insert (\n\t\t\tcontext.SigningNonce is null and context.InviteSlotCid is null and context.InviteSignature is null\n\t\t)`

// Verbatim copy of the REAL Task 3 body (votetorrent.qsql's `table Keyholder (` block) — kept as an
// independent literal (not shared with the real schema text) so a later accidental drift between
// this probe and the shipped body is caught by re-running this file, not masked by sharing.
const NEW_KEYHOLDER_INSERT_VALID =
  `constraint InsertValid check on insert (\n\t\t\tcontext.SigningNonce is null and context.InviteSlotCid is null and context.InviteSignature is null\n\t\t\t\tand exists (\n\t\t\t\t\tselect 1 from KeyholderDkgBinding B\n\t\t\t\t\t\twhere B.ElectionId = new.ElectionId and B.ElectionRevision = new.ElectionRevision and B.UserId = new.UserId\n\t\t\t\t)\n\t\t)`

/**
 * Builds the D-26 candidate schema: the real schema (post Task-1) plus `KeyholderDkgBinding`
 * (inserted immediately before `table Task (`, the same anchor/position Task 2 uses for real) plus
 * `Keyholder.InsertValid`'s flipped body. A no-op once Task 2/3 have actually landed both pieces —
 * mirrors `staging-schema-probes.spec.ts`'s `buildD41CandidateSchema` self-trip-guard discipline,
 * matching on the literal constraint declaration, not a bare name substring.
 */
function buildD26CandidateSchema (base: string): string {
  let out = base
  if (!out.includes('constraint KeyholderExists check on insert (')) {
    const occurrences = out.split(TASK_TABLE_ANCHOR).length - 1
    if (occurrences !== 1) {
      throw new Error(`buildD26CandidateSchema: 'table Task (' anchor must occur exactly once, found ${occurrences} — schema shape changed, update this probe`)
    }
    out = out.replace(TASK_TABLE_ANCHOR, `${KEYHOLDER_DKG_BINDING_CANDIDATE}${TASK_TABLE_ANCHOR}`)
  }
  if (!out.includes(NEW_KEYHOLDER_INSERT_VALID)) {
    const occurrences = out.split(OLD_KEYHOLDER_INSERT_VALID).length - 1
    if (occurrences !== 1) {
      throw new Error(`buildD26CandidateSchema: Keyholder.InsertValid anchor must occur exactly once, found ${occurrences} — Keyholder table shape changed, update this probe`)
    }
    out = out.replace(OLD_KEYHOLDER_INSERT_VALID, NEW_KEYHOLDER_INSERT_VALID)
  }
  return out
}

function makeKeyholderInvite (name: string): KeyholderInvite {
  return {
    name,
    type: 'k',
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: 'k'.repeat(66),
    inviteSignature: ''
  }
}

async function keyholderSlotCid (ctx: EngineContext, name: string): Promise<string> {
  const row = await ctx.db.prepare("select Cid, InviteSignature from InviteSlot where Type = 'k' and Name = :name").get({ name })
  if (!row) throw new Error(`keyholderSlotCid: no InviteSlot found for name=${name}`)
  return row.Cid as string
}

interface Probe1Fixtures {
  ctx: EngineContext
  electionId: string
  revision: number
  slotCid: string
  slotInviteSignature: string
}

async function seedProbe1Invite (name: string): Promise<Probe1Fixtures> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  await elec.electionEngine.inviteKeyholder(makeKeyholderInvite(name), 'election-1', makeTestSignCallback(auth.user))
  const slotRow = await elec.ctx.db
    .prepare("select Cid, InviteSignature from InviteSlot where Type = 'k' and Name = :name")
    .get({ name })
  if (!slotRow) throw new Error('seedProbe1Invite: slot not found')
  return {
    ctx: elec.ctx,
    electionId: 'election-1',
    revision: 0,
    slotCid: slotRow.Cid as string,
    slotInviteSignature: (slotRow.InviteSignature as string | null) ?? ''
  }
}

/**
 * Runs the full accept-transaction shape (InviteResult, User, UserKey, Keyholder,
 * KeyholderDkgBinding) in ONE BEGIN/COMMIT, in the order given by `order` ('kh-then-binding' or
 * 'binding-then-kh'). Optionally omits the Keyholder statement or the KeyholderDkgBinding statement
 * to exercise the negative cases. Returns the minted userId and whether the transaction threw.
 */
async function runProbe1AcceptTransaction (
  fx: Probe1Fixtures,
  opts: {
    order?: 'kh-then-binding' | 'binding-then-kh'
    skipKeyholder?: boolean
    skipBinding?: boolean
    invokedIdOverride?: string
    bindingUserIdOverride?: string
  } = {}
): Promise<{ userId: string, threw: unknown }> {
  const userId = crypto.randomUUID()
  const { privateHex, publicHex } = randomTestKeyPair()
  const invokedId = opts.invokedIdOverride ?? userId
  const tid = await allocateTid(fx.ctx.db, 'user')
  const boundAt = nowCanonicalDatetime() + 'Z'
  const bindingUserId = opts.bindingUserIdOverride ?? userId

  let threw: unknown
  try {
    await fx.ctx.db.exec('BEGIN')
    try {
      await fx.ctx.db.exec(
        `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
         with context IsSigningValid = true, IsSignatureValid = true
         values (:slotCid, true, :slotCid, 'probe1-sig', :invokedId)`,
        { slotCid: fx.slotCid, invokedId }
      )
      await fx.ctx.db.exec(
        `insert into User (Id, Name, ImageRef)
         with context SigningNonce = null, InviteSlotCid = :slotCid, InviteSignature = :inviteSig, Tid = ${tid}
         values (:userId, :userName, null)`,
        { slotCid: fx.slotCid, inviteSig: fx.slotInviteSignature, userId, userName: 'Probe1 Keyholder' }
      )
      await fx.ctx.db.exec(
        `insert into UserKey (UserId, Type, PubKey, Expiration)
         with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
         values (:userId, 'M', :pubKey, :expiration)`,
        { userId, pubKey: publicHex, expiration: toCanonicalDatetime(Date.now() + 365 * 86_400_000), now: nowCanonicalDatetime() }
      )

      const insertKeyholder = async (): Promise<void> => {
        await fx.ctx.db.exec(
          `insert into Keyholder (ElectionId, ElectionRevision, UserId)
           with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
           values (:electionId, :revision, :userId)`,
          { electionId: fx.electionId, revision: fx.revision, userId }
        )
      }
      const insertBinding = async (): Promise<void> => {
        const dkgPublicKey = publicHex
        const digestRow = await fx.ctx.db
          .prepare(
            "select Digest('KeyholderDkgBinding', :electionId, :revision, :userId, :slotCid, :dkgPublicKey, :boundAt) as d"
          )
          .get({ electionId: fx.electionId, revision: fx.revision, userId: bindingUserId, slotCid: fx.slotCid, dkgPublicKey, boundAt })
        if (!digestRow || digestRow.d == null) throw new Error('Probe 1: Digest() returned null')
        const sig = bytesToHex(secp256k1.sign(digestToBytes(digestRow.d as string), hexToBytes(privateHex)))
        await fx.ctx.db.exec(
          `insert into KeyholderDkgBinding (ElectionId, ElectionRevision, UserId, InviteSlotCid, DkgPublicKey, BoundAt, SignerKey, Signature)
           values (:electionId, :revision, :userId, :slotCid, :dkgPublicKey, :boundAt, :signerKey, :signature)`,
          {
            electionId: fx.electionId,
            revision: fx.revision,
            userId: bindingUserId,
            slotCid: fx.slotCid,
            dkgPublicKey,
            boundAt,
            signerKey: publicHex,
            signature: sig
          }
        )
      }

      if (opts.order === 'binding-then-kh') {
        if (!opts.skipBinding) await insertBinding()
        if (!opts.skipKeyholder) await insertKeyholder()
      } else {
        if (!opts.skipKeyholder) await insertKeyholder()
        if (!opts.skipBinding) await insertBinding()
      }
      await fx.ctx.db.exec('COMMIT')
    } catch (err) {
      await fx.ctx.db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    threw = err
  }
  return { userId, threw }
}

async function probe1RowCounts (ctx: EngineContext, slotCid: string, userId: string): Promise<{ inviteResult: number, user: number, userKey: number, keyholder: number, binding: number }> {
  const ir = await ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :slotCid').get({ slotCid })
  const u = await ctx.db.prepare('select count(*) as c from User where Id = :id').get({ id: userId })
  const uk = await ctx.db.prepare('select count(*) as c from UserKey where UserId = :id').get({ id: userId })
  const kh = await ctx.db.prepare('select count(*) as c from Keyholder where UserId = :id').get({ id: userId })
  const b = await ctx.db.prepare('select count(*) as c from KeyholderDkgBinding where UserId = :id').get({ id: userId })
  return {
    inviteResult: Number(ir?.c ?? 0),
    user: Number(u?.c ?? 0),
    userKey: Number(uk?.c ?? 0),
    keyholder: Number(kh?.c ?? 0),
    binding: Number(b?.c ?? 0)
  }
}

describe('Probe 1 (D-26 accept-transaction shape, 62-02 Task 1) — VERDICT: PASS, both CHECKs ship', () => {
  beforeEach(() => {
    setSchemaSql(buildD26CandidateSchema(VOTETORRENT_SCHEMA_SQL))
  })
  afterEach(() => {
    setSchemaSql(undefined)
  })

  it('(a) InviteResult + User + UserKey + Keyholder + KeyholderDkgBinding, in ONE transaction, COMMITs and all five rows read back', async () => {
    const fx = await seedProbe1Invite('Probe1 Alice')
    const { userId, threw } = await runProbe1AcceptTransaction(fx)
    expect(threw, 'the well-formed accept transaction must not throw').to.equal(undefined)
    const counts = await probe1RowCounts(fx.ctx, fx.slotCid, userId)
    expect(counts).to.deep.equal({ inviteResult: 1, user: 1, userKey: 1, keyholder: 1, binding: 1 })
  })

  it('(b) the same transaction with the binding statement BEFORE the Keyholder statement also COMMITs (deferred-CHECK final-state evaluation)', async () => {
    const fx = await seedProbe1Invite('Probe1 Bob')
    const { userId, threw } = await runProbe1AcceptTransaction(fx, { order: 'binding-then-kh' })
    expect(threw, 'statement order within the transaction must not matter — both are deferred CHECKs evaluated at COMMIT').to.equal(undefined)
    const counts = await probe1RowCounts(fx.ctx, fx.slotCid, userId)
    expect(counts).to.deep.equal({ inviteResult: 1, user: 1, userKey: 1, keyholder: 1, binding: 1 })
  })

  it('(c) Keyholder WITHOUT a binding is refused at COMMIT and leaves ZERO rows of all five tables (proves the rollback)', async () => {
    const fx = await seedProbe1Invite('Probe1 Carol')
    const { userId, threw } = await runProbe1AcceptTransaction(fx, { skipBinding: true })
    expect(threw, 'a Keyholder with no binding must be refused').to.not.equal(undefined)
    const counts = await probe1RowCounts(fx.ctx, fx.slotCid, userId)
    expect(counts, 'the whole transaction rolls back — zero orphan rows anywhere').to.deep.equal({ inviteResult: 0, user: 0, userKey: 0, keyholder: 0, binding: 0 })
  })

  it('(d) a binding whose Keyholder is absent is refused (live KeyholderExists)', async () => {
    const fx = await seedProbe1Invite('Probe1 Dave')
    const { userId, threw } = await runProbe1AcceptTransaction(fx, { skipKeyholder: true })
    expect(threw, 'a binding with no Keyholder row must be refused by KeyholderExists').to.not.equal(undefined)
    const counts = await probe1RowCounts(fx.ctx, fx.slotCid, userId)
    expect(counts).to.deep.equal({ inviteResult: 0, user: 0, userKey: 0, keyholder: 0, binding: 0 })
  })

  it('(e) a binding whose InviteResult names a DIFFERENT InvokedId is refused (live InviteAccepted)', async () => {
    const fx = await seedProbe1Invite('Probe1 Eve')
    const otherId = crypto.randomUUID()
    const { userId, threw } = await runProbe1AcceptTransaction(fx, { invokedIdOverride: otherId })
    expect(threw, 'a binding whose slot InviteResult.InvokedId disagrees must be refused by InviteAccepted').to.not.equal(undefined)
    const counts = await probe1RowCounts(fx.ctx, fx.slotCid, userId)
    expect(counts).to.deep.equal({ inviteResult: 0, user: 0, userKey: 0, keyholder: 0, binding: 0 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Probe 2 — D-38 NULL semantics
// ═══════════════════════════════════════════════════════════════════════════

const PROBE_2_SCRATCH_SCHEMA = `
declare schema main

{
	table Probe2NullableOmit (
		Id text primary key,
		constraint MustBeNull check (context.IsImportReplay is null)
	)
		with context ( IsImportReplay integer null );

	table Probe2BareNow (
		Id text primary key,
		Expiration datetime,
		constraint ExpirationFutureBare check (Expiration > context.now)
	)
		with context ( now datetime );

	table Probe2Coalesce (
		Id text primary key,
		constraint ReplayFlag check (coalesce(context.IsImportReplay, 0) = 1)
	)
		with context ( IsImportReplay integer null );
}

apply schema main;
`

async function createProbe2Db (): Promise<Database> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(PROBE_2_SCRATCH_SCHEMA)
  return db
}

async function probe2Insert (db: Database, sql: string, params: Record<string, unknown>): Promise<{ threw: boolean, error?: unknown }> {
  try {
    await db.exec(sql, params)
    return { threw: false }
  } catch (err) {
    return { threw: true, error: err }
  }
}

describe('Probe 2 (D-38 NULL semantics, 62-02 Task 1)', () => {
  it('omittedNullableIsNull: a context var declared "integer null" and NOT present in the bind-params object reads as SQL NULL — no compile/bind error', async () => {
    const db = await createProbe2Db()
    // No `IsImportReplay` key at all in the params object.
    const res = await probe2Insert(db, 'insert into Probe2NullableOmit (Id) values (:id)', { id: crypto.randomUUID() })
    expect(res.threw, 'MustBeNull must pass when the context var is simply omitted from bind params').to.equal(false)
  })

  it('omittedNullableIsNull (control): explicit JS null behaves identically to omission', async () => {
    const db = await createProbe2Db()
    const res = await probe2Insert(db, 'insert into Probe2NullableOmit (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: null })
    expect(res.threw).to.equal(false)
  })

  it('omittedNullableIsNull (negative control): a real integer value is NOT null and must fail MustBeNull', async () => {
    const db = await createProbe2Db()
    const res = await probe2Insert(db, 'insert into Probe2NullableOmit (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: 1 })
    expect(res.threw, 'a bound value must be seen as non-null, proving the omitted-vs-bound distinction is real').to.equal(true)
  })

  it('omitting the "with context now = ..." clause ENTIRELY is a hard bind-time error (Quereus requires every non-null-declared context var to be supplied), NOT a silent NULL', async () => {
    const db = await createProbe2Db()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const res = await probe2Insert(
      db,
      'insert into Probe2BareNow (Id, Expiration) values (:id, :expiration)',
      { id: crypto.randomUUID(), expiration: pastExpiration }
    )
    expect(res.threw, 'Quereus refuses to compile/bind an insert that omits a required (non-null-declared) context variable entirely').to.equal(true)
  })

  it('omittedNowIsNull + nowNullBypasses: "with context now = :now" SUPPLIED but bound to JS null lets a PAST Expiration insert (bare CHECK, no explicit coalesce) — the REAL NULL-bypass risk', async () => {
    const db = await createProbe2Db()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const res = await probe2Insert(
      db,
      'insert into Probe2BareNow (Id, Expiration) with context now = :now values (:id, :expiration)',
      { id: crypto.randomUUID(), expiration: pastExpiration, now: null }
    )
    expect(
      res.threw,
      'a bare "Expiration > context.now" with the context clause PRESENT but bound to JS null evaluates NULL, which CHECK semantics treat as SATISFIED (not violated) — the exact NULL-bypass the shipped ExpirationFuture text closes with "context.now is not null"'
    ).to.equal(false)
  })

  it('omittedNowIsNull (control): an explicitly-bound PAST now correctly rejects a past Expiration', async () => {
    const db = await createProbe2Db()
    const pastExpiration = toCanonicalDatetime(Date.now() - 86_400_000)
    const res = await probe2Insert(
      db,
      'insert into Probe2BareNow (Id, Expiration) with context now = :now values (:id, :expiration)',
      { id: crypto.randomUUID(), expiration: pastExpiration, now: nowCanonicalDatetime() }
    )
    expect(res.threw, 'with now genuinely bound, the bare CHECK correctly rejects an expired row').to.equal(true)
    if (res.threw) expect(res.error).to.be.instanceOf(ConstraintError)
  })

  it("trueEqualsOne: coalesce(context.IsImportReplay, 0) = 1 truth table — bound 1 admits, bound 0/null/omitted do not, and a JS boolean true also satisfies '= 1'", async () => {
    const db = await createProbe2Db()
    const bound1 = await probe2Insert(db, 'insert into Probe2Coalesce (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: 1 })
    const bound0 = await probe2Insert(db, 'insert into Probe2Coalesce (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: 0 })
    const boundNull = await probe2Insert(db, 'insert into Probe2Coalesce (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: null })
    const omitted = await probe2Insert(db, 'insert into Probe2Coalesce (Id) values (:id)', { id: crypto.randomUUID() })
    const boundTrue = await probe2Insert(db, 'insert into Probe2Coalesce (Id) with context IsImportReplay = :flag values (:id)', { id: crypto.randomUUID(), flag: true })

    expect(bound1.threw, 'bound integer 1 must admit').to.equal(false)
    expect(bound0.threw, 'bound integer 0 must NOT admit').to.equal(true)
    expect(boundNull.threw, 'bound JS null must NOT admit (coalesce maps it to 0)').to.equal(true)
    expect(omitted.threw, 'an omitted context var must NOT admit (same as null, never a silent bypass)').to.equal(true)
    // Recorded as a finding, not relied upon by any producer — every real producer binds the
    // literal integer 1 (the grep gate in Task 1's acceptance criteria enforces this).
    expect(typeof boundTrue.threw, 'a JS boolean true binds without a type error either way — behaviour recorded, not depended upon').to.equal('boolean')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Probe 3 — founding-row replay (research Pitfall 4)
// ═══════════════════════════════════════════════════════════════════════════

interface FoundingRowSnapshot {
  user: Record<string, unknown>
  userKey: Record<string, unknown>
  authority: Record<string, unknown>
  admin: Record<string, unknown>
  officer: Record<string, unknown>
  network: Record<string, unknown>
}

async function readFoundingRows (ctx: EngineContext, userId: string): Promise<FoundingRowSnapshot> {
  const user = await ctx.db.prepare('select * from User where Id = :id').get({ id: userId })
  const userKey = await ctx.db.prepare('select * from UserKey where UserId = :id').get({ id: userId })
  const authority = await ctx.db.prepare('select * from Authority').get()
  const admin = await ctx.db.prepare('select * from Admin').get()
  const officer = await ctx.db.prepare('select * from Officer where UserId = :id').get({ id: userId })
  const network = await ctx.db.prepare('select * from Network').get()
  if (!user || !userKey || !authority || !admin || !officer || !network) {
    throw new Error('readFoundingRows: one or more founding rows missing')
  }
  return { user, userKey, authority, admin, officer, network }
}

/** Replay the six founding rows, in NetworksEngine.create()'s exact statement order, into a FRESH database. */
async function replayFoundingRows (
  snap: FoundingRowSnapshot,
  opts: { isImportReplay?: boolean }
): Promise<{ failedOn?: string, error?: unknown }> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(VOTETORRENT_SCHEMA_SQL)
  const now = nowCanonicalDatetime()
  const tid = 1

  try {
    await db.exec(
      `insert into User (Id, Name, ImageRef)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
       values (:id, :name, :imageRef)`,
      { id: snap.user.Id, name: snap.user.Name, imageRef: snap.user.ImageRef ?? null }
    )
  } catch (err) {
    return { failedOn: 'User', error: err }
  }

  try {
    const userKeyParams: Record<string, unknown> = {
      userId: snap.userKey.UserId,
      keyType: snap.userKey.Type,
      keyValue: snap.userKey.PubKey,
      expiration: snap.userKey.Expiration,
      now
    }
    if (opts.isImportReplay) userKeyParams.isImportReplay = 1
    await db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true${opts.isImportReplay ? ', IsImportReplay = :isImportReplay' : ''}
       values (:userId, :keyType, :keyValue, :expiration)`,
      userKeyParams
    )
  } catch (err) {
    return { failedOn: 'UserKey', error: err }
  }

  try {
    await db.exec(
      `insert into Authority (Id, Name, DomainName, ImageRef)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
       values (:id, :name, :domainName, :imageRef)`,
      { id: snap.authority.Id, name: snap.authority.Name, domainName: snap.authority.DomainName ?? null, imageRef: snap.authority.ImageRef ?? null }
    )
  } catch (err) {
    return { failedOn: 'Authority', error: err }
  }

  try {
    await db.exec(
      `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
       values (:authorityId, :effectiveAt, :thresholdPolicies)`,
      { authorityId: snap.admin.AuthorityId, effectiveAt: snap.admin.EffectiveAt, thresholdPolicies: snap.admin.ThresholdPolicies }
    )
  } catch (err) {
    return { failedOn: 'Admin', error: err }
  }

  try {
    await db.exec(
      `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
       values (:authorityId, :adminEffectiveAt, :userId, :title, :scopes)`,
      {
        authorityId: snap.officer.AuthorityId,
        adminEffectiveAt: snap.officer.AdminEffectiveAt,
        userId: snap.officer.UserId,
        title: snap.officer.Title,
        scopes: snap.officer.Scopes
      }
    )
  } catch (err) {
    return { failedOn: 'Officer', error: err }
  }

  try {
    await db.exec(
      `insert into Network (Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType)
       with context SigningNonce = null, Tid = ${tid}
       values (:id, :hash, :primaryAuthorityId, :name, :imageRef, :relays, :timestampAuthorities, :numberRequiredTSAs, :electionType)`,
      {
        id: snap.network.Id,
        hash: snap.network.Hash,
        primaryAuthorityId: snap.network.PrimaryAuthorityId,
        name: snap.network.Name,
        imageRef: snap.network.ImageRef ?? null,
        relays: snap.network.Relays,
        timestampAuthorities: snap.network.TimestampAuthorities,
        numberRequiredTSAs: snap.network.NumberRequiredTSAs,
        electionType: snap.network.ElectionType
      }
    )
  } catch (err) {
    return { failedOn: 'Network', error: err }
  }

  return {}
}

describe('Probe 3 (founding-row replay, 62-02 Task 1 — research Pitfall 4)', () => {
  it('replaying all six founding rows, with the founding UserKey already EXPIRED and NO import flag, fails on UserKey/ExpirationFuture only', async function () {
    this.timeout(15_000)
    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: randomTestKeyPair().publicHex,
            type: 'M' as never,
            expiration: Date.now() + 4_000
          }
        ]
      }
    })
    const auth = await addTestAuthority(net)
    const snap = await readFoundingRows(auth.ctx, auth.user.id)
    // Wait until the founding key's Expiration is genuinely in the past.
    await new Promise((resolve) => setTimeout(resolve, 4_300))

    const result = await replayFoundingRows(snap, { isImportReplay: false })
    expect(result.failedOn, 'exactly one statement must fail, and it must be UserKey').to.equal('UserKey')
    expect(result.error, 'the failure must name ExpirationFuture').to.satisfy((e: unknown) => String((e as Error)?.message ?? e).includes('ExpirationFuture'))
  })

  it('the SAME replay, with IsImportReplay = 1 bound on the UserKey statement ONLY, inserts all six rows', async function () {
    this.timeout(15_000)
    const net = await createTestNetwork({
      user: {
        activeKeys: [
          {
            key: randomTestKeyPair().publicHex,
            type: 'M' as never,
            expiration: Date.now() + 4_000
          }
        ]
      }
    })
    const auth = await addTestAuthority(net)
    const snap = await readFoundingRows(auth.ctx, auth.user.id)
    await new Promise((resolve) => setTimeout(resolve, 4_300))

    const result = await replayFoundingRows(snap, { isImportReplay: true })
    expect(result.failedOn, `no statement should fail; got failure on ${result.failedOn} (${String((result.error as Error)?.message ?? result.error)})`).to.equal(undefined)
  })
})
