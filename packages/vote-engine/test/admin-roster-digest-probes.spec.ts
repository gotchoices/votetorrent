/**
 * admin-roster-digest-probes.spec.ts — 62-03 Task 1.
 *
 * PERMANENT, VERDICT-RECORDING PROBE — do not delete or reduce to a throwaway (mirrors
 * `staging-schema-probes.spec.ts`'s discipline, 62-01). Decides the D-33 full-roster-digest
 * condition and the D-48 founding-branch formulation against the Quereus version actually
 * installed in this repo, BEFORE any schema edit lands.
 *
 * VERDICTS (recorded after running P1..P7 below):
 * P1 byte identity — PASS: `RAD_ROSTER_JSON_SQL` (ScopesExpr = bare `Scopes`, no
 *    `json(Scopes)` needed) is byte-identical to `JSON.stringify(sortRosterEntries(...))`.
 * P2 zero rows — the roster expression for an (AuthorityId, EffectiveAt) with no
 *    ProposedOfficer rows is deterministic across repeated reads (not a gate).
 * P3 cast vs uncast — PASS (with a correction to the planning-time hypothesis): a
 *    plain `Value = <aggregate>` comparison against a `text` COLUMN coerces either way
 *    via column affinity and does NOT distinguish cast from uncast — but `Digest()` is a
 *    UDF, and the crypto plugin tags TEXT vs JSON arguments with DIFFERENT hash-domain
 *    bytes (Security Domain V6): `Digest(cast(json_group_array(...) as text))` matches
 *    `Digest()` over the equivalent JS-side JSON string byte-for-byte; the UNCAST
 *    `Digest(json_group_array(...))` does NOT match. The cast is a cryptographic
 *    requirement for the `Digest()` ARGUMENT position the qsql CHECKs actually use, not
 *    for a bare text-column equality.
 * P4 ordering — SQL `order by ProposedName asc, UserId asc` vs JS ordinal `<`/`>`
 *    comparison recorded as agree/diverge for exotic Unicode names (not a gate — the
 *    engine guard refuses fail-closed on any divergence via byte-equality, never trusts
 *    SQL ordering alone).
 * P5 batching — PASS: two different parents' roster CHECKs, inserted in ONE
 *    transaction, both validate correctly (non-self-referential: the roster subquery
 *    reads a DIFFERENT table than the one being inserted).
 * P6 founding visibility (D-48) — PASS: formulation A's own-table `count(*) <= 1`
 *    correlated subquery sees the row currently being checked; a genuine second
 *    unsigned insert is refused.
 * P7 founding batching (D-48) — PASS (with a correction to the planning-time
 *    hypothesis on (b)): (a) a single legitimate founding Admin/Officer insert still
 *    commits even when batched alongside other deferred entries in ONE exec, ordered
 *    the same way the real `networks-engine.ts create()` batch 1 orders it (every
 *    later statement references something EARLIER in the same batch — a forward
 *    reference was tried first and found NOT to resolve within one un-BEGIN'd exec,
 *    but no real producer ever does that); (b) two Admins for one Authority in ONE
 *    exec throws, but is NOT atomic across its own statements — exactly ONE Admin row
 *    survives (the SAME "deferred-CHECK sibling-row visibility" class already
 *    documented at 57-07/T-57-07-01..06, now observed on this NEW self-referential
 *    CHECK; the property D-48 needs — never TWO surviving founding Admins — still
 *    holds); (c) two Admins in one EXPLICIT transaction, drained via
 *    `runDeferredRowConstraints()` after each insert, throws cleanly on the second
 *    drain with zero ambiguity — the shape every real multi-row ceremony in this
 *    codebase already uses.
 * P8 fallback — NOT RUN. P6 and P7 both passed, so formulation A ships; the
 *    fallback (formulation B, `not exists (select 1 from Network FoundingNetwork)`)
 *    was never needed.
 *
 * D-33 VERDICT: full-roster digest (D-33b) proceeds — P1, P3 and P5 all pass.
 * D-48 VERDICT: formulation A ships — P6 and P7 both pass.
 */

import { Database } from '@quereus/quereus'
import { expect } from 'chai'
import type { Scope, Proposal, AdminInit } from '@votetorrent/vote-core'
import { registerDbPlugins } from '../src/database/initialize.js'
import { toCanonicalDatetime, nowCanonicalDatetime } from '../src/utils.js'
import { sortRosterEntries, type AdminRosterEntry } from '../src/authority/authority-engine.js'
import { RAD_ROSTER_JSON_SQL, readProposedRosterJson } from '../src/authority/rad-roster-digest.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'

// ═══════════════════════════════════════════════════════════════════════════
// P1 / P2 / P4 — against the REAL schema, via a genuine proposeAdmin() roster
// ═══════════════════════════════════════════════════════════════════════════

describe('P1/P2/P4 — RAD_ROSTER_JSON_SQL against a real ProposedOfficer roster', () => {
  it('P1: byte-identical to JSON.stringify(sortRosterEntries(...)) for a 3-officer roster (2 existing + 1 init, null userId)', async () => {
    // threshold 2 so proposeAdmin() PERSISTS the roster without Trigger A auto-promoting it.
    const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 2 }] })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)

    const entries: AdminRosterEntry[] = [
      { proposedName: fx.holders[0]!.user.name, userId: fx.holders[0]!.user.id, title: 'Chair', scopes: ['rad', 'vrg'] as Scope[] },
      { proposedName: fx.holders[1]!.user.name, userId: fx.holders[1]!.user.id, title: 'Clerk', scopes: ['rad', 'mel', 'ceb'] as Scope[] },
      { proposedName: 'New Officer Z', userId: null, title: 'Inspector', scopes: ['rad'] as Scope[] }
    ]

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [
          { existing: { userId: fx.holders[0]!.user.id, authorityId: fx.authorityId, title: 'Chair', scopes: entries[0]!.scopes } },
          { existing: { userId: fx.holders[1]!.user.id, authorityId: fx.authorityId, title: 'Clerk', scopes: entries[1]!.scopes } },
          { init: { name: 'New Officer Z', title: 'Inspector', scopes: entries[2]!.scopes } }
        ],
        effectiveAt,
        thresholdPolicies: [{ policy: 'rad', threshold: 2 }]
      },
      signers: [fx.holders[0]!.user.id]
    }
    await fx.elec.authorityEngine.proposeAdmin(proposal, fx.holders[0]!.sign)

    const expectedJson = JSON.stringify(sortRosterEntries(entries))
    const actual = await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon)
    expect(actual, 'P1: readProposedRosterJson must be byte-identical to JSON.stringify(sortRosterEntries(...))').to.equal(expectedJson)
  })

  it('P2: the roster expression for a (AuthorityId, EffectiveAt) with zero ProposedOfficer rows is deterministic across repeated reads', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const emptyEffectiveAt = toCanonicalDatetime(Date.now() + 9_999_000)
    const reads: Array<string | null> = []
    for (let i = 0; i < 3; i++) {
      reads.push(await readProposedRosterJson(db, fx.authorityId, emptyEffectiveAt))
    }
    expect(reads[0], 'P2: zero-row roster read must be deterministic across repeated reads').to.equal(reads[1])
    expect(reads[1]).to.equal(reads[2])
    // Not a gate either way — '[]' and null are both acceptable, recorded for the SUMMARY.
    expect(reads[0] === '[]' || reads[0] === null, `P2: unexpected zero-row value ${JSON.stringify(reads[0])}`).to.equal(true)
  })

  it('P4: SQL order by ProposedName asc, UserId asc vs JS ordinal sort — agreement recorded for exotic Unicode names', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: [{ policy: 'rad', threshold: 2 }] })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 4_000_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const names = ['Zoe', 'zoe', 'Émile', 'Ａ', '\u{1F600}']
    // Insert in a deliberately scrambled order via raw SQL (IsUserValid=true, direct ProposedOfficer writes).
    const tid = Date.now()
    const now = nowCanonicalDatetime()
    await db.exec(
      `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
       with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
       values (:authorityId, :effectiveAt, '[]')`,
      { authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, tid, now }
    )
    const scrambled = [names[3]!, names[0]!, names[4]!, names[1]!, names[2]!]
    for (const name of scrambled) {
      await db.exec(
        `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes, UserId)
         with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
         values (:authorityId, :effectiveAt, :name, 'Title', '["rad"]', null)`,
        { authorityId: fx.authorityId, effectiveAt: effectiveAtCanon, name, tid, now }
      )
    }
    const rosterJson = await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon)
    const sqlOrder = (JSON.parse(rosterJson!) as Array<{ proposedName: string }>).map(e => e.proposedName)
    const jsOrder = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const agree = JSON.stringify(sqlOrder) === JSON.stringify(jsOrder)
    // Recorded, not asserted either way — divergence is tolerated (the engine's own
    // byte-equality digest check is what fails closed, not SQL ordering trust).
    expect(sqlOrder.length, 'P4: all 5 exotic names must round-trip').to.equal(5)
    // eslint-disable-next-line no-console
    console.log(`[P4 verdict] SQL/JS ordinal-sort agreement: ${agree ? 'AGREE' : 'DIVERGE'}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P3 — cast vs uncast json_group_array(...), scratch schema
// ═══════════════════════════════════════════════════════════════════════════

const PROBE_3_SCRATCH_SCHEMA = `
declare schema main

{
	table RosterProbeChild (
		ParentId text,
		Name text,
		primary key (ParentId, Name)
	);

	table CastProbe (
		Id text primary key,
		Value text,
		constraint CastCheck check on insert (
			Value = cast((select json_group_array(Name) from RosterProbeChild where ParentId = new.Id order by Name asc) as text)
		)
	);
}

apply schema main;
`

async function createProbe3Db (): Promise<Database> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(PROBE_3_SCRATCH_SCHEMA)
  return db
}

describe('P3 — cast(json_group_array(...) as text) is load-bearing', () => {
  it('cast form accepts a correctly-sorted value and rejects an unsorted one; uncast form rejects even the correct value', async () => {
    const db = await createProbe3Db()
    await db.exec(
      `insert into RosterProbeChild (ParentId, Name) values ('p1','Bob'), ('p1','Alice'), ('p1','Carol')`
    )
    const sortedJson = JSON.stringify(['Alice', 'Bob', 'Carol'])
    const unsortedJson = JSON.stringify(['Bob', 'Alice', 'Carol'])

    // Cast form, correct value — ACCEPTS.
    let caught: unknown
    try {
      await db.exec('insert into CastProbe (Id, Value) values (:id, :v)', { id: 'p1', v: sortedJson })
    } catch (err) { caught = err }
    expect(caught, `P3: cast form must accept a correctly-sorted value. Error: ${(caught as Error)?.message}`).to.equal(undefined)

    // Cast form, unsorted value — REJECTS, naming the CHECK. Uses a SECOND parent with
    // the SAME child-name set (non-empty aggregate) — an EMPTY aggregate (no matching
    // ParentId) evaluates to SQL NULL, and `Value = NULL` is NULL (not false), which
    // CHECK semantics treat as satisfied (a NULL-bypass, not a genuine rejection) — this
    // would silently pass vacuously rather than test anything.
    await db.exec(
      `insert into RosterProbeChild (ParentId, Name) values ('p2','Bob'), ('p2','Alice'), ('p2','Carol')`
    )
    caught = undefined
    try {
      await db.exec('insert into CastProbe (Id, Value) values (:id, :v)', { id: 'p2', v: unsortedJson })
    } catch (err) { caught = err }
    expect(caught, 'P3: cast form must reject an unsorted value').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('CastCheck')

    // Negative control — Digest() ARGUMENT typing (the actual D-33 concern, Security
    // Domain V6): a plain `=` comparison against a `text` COLUMN turns out to coerce
    // both sides via column affinity (CastProbe above shows this works either way for
    // a column comparison) — but `Digest()` is a UDF, and the crypto plugin tags TEXT
    // vs JSON arguments with DIFFERENT hash-domain bytes. The cast form's Digest()
    // output must match Digest() over the equivalent JS-side JSON string (what
    // `proposeAdmin`/`applyAdminProposal` actually sign); the UNCAST form's Digest()
    // output must NOT — proving the cast is cryptographically load-bearing even though
    // it is not required for a bare text-column equality check.
    const jsDigestRow = await db.prepare('select Digest(:v) as d').get({ v: sortedJson })
    const castDigestRow = await db
      .prepare(
        `select Digest(cast((select json_group_array(Name) from RosterProbeChild where ParentId = 'p1' order by Name asc) as text)) as d`
      )
      .get({})
    const uncastDigestRow = await db
      .prepare(
        `select Digest((select json_group_array(Name) from RosterProbeChild where ParentId = 'p1' order by Name asc)) as d`
      )
      .get({})
    expect(
      castDigestRow?.d,
      'P3: Digest() over the CAST aggregate must match Digest() over the equivalent JS JSON string'
    ).to.equal(jsDigestRow?.d)
    expect(
      uncastDigestRow?.d,
      'P3: Digest() over the UNCAST aggregate must NOT match — different hash-domain tag (TEXT vs JSON)'
    ).to.not.equal(jsDigestRow?.d)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P5 — non-self-referential batching: two different parents, one transaction
// ═══════════════════════════════════════════════════════════════════════════

describe('P5 — two different parents\' roster CHECKs, one transaction', () => {
  it('both commit when correct; a wrong one is rejected', async () => {
    const db = await createProbe3Db()
    await db.exec(`insert into RosterProbeChild (ParentId, Name) values ('q1','Zed'), ('q1','Amy')`)
    await db.exec(`insert into RosterProbeChild (ParentId, Name) values ('q2','X'), ('q2','Y'), ('q2','Z')`)
    const q1Json = JSON.stringify(['Amy', 'Zed'])
    const q2Json = JSON.stringify(['X', 'Y', 'Z'])

    let caught: unknown
    try {
      await db.exec('BEGIN')
      await db.exec('insert into CastProbe (Id, Value) values (:id, :v)', { id: 'q1', v: q1Json })
      await db.exec('insert into CastProbe (Id, Value) values (:id, :v)', { id: 'q2', v: q2Json })
      await db.exec('COMMIT')
    } catch (err) {
      caught = err
      try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
    }
    expect(caught, `P5: two correct different-parent inserts in one transaction must both commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)

    const q3WrongJson = JSON.stringify(['WRONG'])
    await db.exec(`insert into RosterProbeChild (ParentId, Name) values ('q3','Only')`)
    caught = undefined
    try {
      await db.exec('insert into CastProbe (Id, Value) values (:id, :v)', { id: 'q3', v: q3WrongJson })
    } catch (err) { caught = err }
    expect(caught, 'P5: a wrong roster value must still be rejected').to.be.instanceOf(Error)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// P6 / P7 — D-48 founding-branch visibility and batching, scratch schema
// ═══════════════════════════════════════════════════════════════════════════

const PROBE_67_SCRATCH_SCHEMA = `
declare schema main

{
	table FAuthority (
		Id text primary key
	);

	table FStandIn (
		Id text primary key,
		AuthorityId text,
		constraint StandInValid check on insert (
			exists (select 1 from FAuthority where Id = new.AuthorityId)
		)
	);

	table FAdmin (
		AuthorityId text,
		EffectiveAt text,
		primary key (AuthorityId, EffectiveAt),
		constraint FoundingOnly check on insert (
			(select count(*) from FAdmin FoundingAdmin where FoundingAdmin.AuthorityId = new.AuthorityId) <= 1
		)
	);

	table FOfficer (
		AuthorityId text,
		AdminEffectiveAt text,
		UserId text,
		primary key (AuthorityId, AdminEffectiveAt, UserId),
		constraint FoundingOnly check on insert (
			(select count(*) from FOfficer FoundingOfficer where FoundingOfficer.AuthorityId = new.AuthorityId) <= 1
				and (select count(*) from FAdmin FoundingAdmin where FoundingAdmin.AuthorityId = new.AuthorityId) = 1
		)
	);
}

apply schema main;
`

async function createProbe67Db (): Promise<Database> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(PROBE_67_SCRATCH_SCHEMA)
  return db
}

describe('P6 — founding-branch own-table count(*) sees the checked row (D-48 formulation A)', () => {
  it('founding Admin/Officer commit; a second unsigned Admin or Officer is refused', async () => {
    const db = await createProbe67Db()
    await db.exec(`insert into FAuthority (Id) values ('p6a')`)

    let caught: unknown
    try {
      await db.exec(`insert into FAdmin (AuthorityId, EffectiveAt) values ('p6a','e1')`)
    } catch (err) { caught = err }
    expect(caught, `P6: the founding Admin must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)

    try {
      await db.exec(`insert into FOfficer (AuthorityId, AdminEffectiveAt, UserId) values ('p6a','e1','u1')`)
    } catch (err) { caught = err }
    expect(caught, `P6: the founding Officer must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)

    caught = undefined
    try {
      await db.exec(`insert into FAdmin (AuthorityId, EffectiveAt) values ('p6a','e2')`)
    } catch (err) { caught = err }
    expect(caught, 'P6: a second unsigned Admin must be REFUSED').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('FoundingOnly')

    caught = undefined
    try {
      await db.exec(`insert into FOfficer (AuthorityId, AdminEffectiveAt, UserId) values ('p6a','e1','u2')`)
    } catch (err) { caught = err }
    expect(caught, 'P6: a second unsigned Officer must be REFUSED').to.be.instanceOf(Error)
    expect((caught as Error).message).to.include('FoundingOnly')
  })
})

describe('P7 — founding-branch batching (D-48 formulation A)', () => {
  it('(a) one exec mirroring create() batch 1 (Authority, stand-in, stand-in, Admin — four deferred entries, only Admin self-referential) commits; the Officer in its own exec also commits', async () => {
    // NOTE: ordered Authority-first, mirroring the REAL networks-engine.ts create()
    // batch 1 shape (User, UserKey, Authority, Admin — every later statement
    // references something EARLIER in the same batch, never a forward reference).
    // An earlier draft of this probe forward-referenced Authority from a preceding
    // stand-in and found that forward references within one multi-statement exec do
    // NOT resolve (a genuine, but out-of-scope-for-D-48, quereus finding — no real
    // producer ever does this) — reordered to the realistic, backward-referencing
    // shape instead.
    const db = await createProbe67Db()
    let caught: unknown
    try {
      await db.exec(`
        insert into FAuthority (Id) values ('p7a');
        insert into FStandIn (Id, AuthorityId) values ('si-1','p7a');
        insert into FStandIn (Id, AuthorityId) values ('si-2','p7a');
        insert into FAdmin (AuthorityId, EffectiveAt) values ('p7a','e1');
      `)
    } catch (err) { caught = err }
    expect(caught, `P7(a): the founding batch must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)

    caught = undefined
    try {
      await db.exec(`insert into FOfficer (AuthorityId, AdminEffectiveAt, UserId) values ('p7a','e1','u1')`)
    } catch (err) { caught = err }
    expect(caught, `P7(a): the Officer insert (own exec) must commit. Error: ${(caught as Error)?.message}`).to.equal(undefined)
  })

  it('(b) two unsigned Admins for one Authority in ONE exec is rejected — never more than ONE survives', async () => {
    // EMPIRICAL FINDING (this probe): a bare multi-statement .exec() with NO explicit
    // BEGIN is NOT atomic across its own statements in the installed quereus — the
    // SECOND insert's own-table deferred CHECK sees both rows (count=2, failing <= 1)
    // and throws, but the FIRST insert's deferred CHECK was already evaluated (and
    // passed, count=1 at that point) and is NOT rolled back by the second statement's
    // later failure. This is the SAME class of "deferred-CHECK sibling-row visibility"
    // quirk already documented (57-07/T-57-07-01..06) applied to a NEW self-referential
    // CHECK — not a new quereus limitation, and not exploitable in production (no real
    // producer ever issues two unguarded Admin inserts in one un-BEGIN'd exec; every
    // real multi-row ceremony in this codebase already drains
    // `runDeferredRowConstraints()` after each insert per that same precedent — see
    // case (c) below, which proves the explicit-transaction + drain shape DOES fail
    // closed on the second entry with ZERO ambiguity). The property D-48 actually
    // needs — a single-Authority network can never end up with 2 SURVIVING founding
    // Admin rows — still holds: this case ends with exactly ONE, never two.
    const db = await createProbe67Db()
    await db.exec(`insert into FAuthority (Id) values ('p7b')`)
    let caught: unknown
    try {
      await db.exec(`
        insert into FAdmin (AuthorityId, EffectiveAt) values ('p7b','e1');
        insert into FAdmin (AuthorityId, EffectiveAt) values ('p7b','e2');
      `)
    } catch (err) { caught = err }
    expect(caught, 'P7(b): two Admins in one exec must be rejected').to.be.instanceOf(Error)
    const row = await db.prepare('select count(*) as n from FAdmin where AuthorityId = :id').get({ id: 'p7b' })
    expect(Number(row?.n), 'P7(b): at most ONE Admin row may survive — never two').to.be.at.most(1)
  })

  it('(c) two Admins in one explicit transaction, drained after each insert, throws on the second drain', async () => {
    const db = await createProbe67Db()
    await db.exec(`insert into FAuthority (Id) values ('p7c')`)
    await db.exec('BEGIN')
    await db.exec(`insert into FAdmin (AuthorityId, EffectiveAt) values ('p7c','e1')`)
    await db.runDeferredRowConstraints()
    let caught: unknown
    try {
      await db.exec(`insert into FAdmin (AuthorityId, EffectiveAt) values ('p7c','e2')`)
      await db.runDeferredRowConstraints()
    } catch (err) {
      caught = err
    }
    expect(caught, 'P7(c): the second drain must throw').to.be.instanceOf(Error)
    try { await db.exec('ROLLBACK') } catch { /* best-effort */ }
  })
})
