/**
 * quereus-delete-check-semantics.spec.ts — 49-03.
 *
 * PERMANENT REGRESSION PROBE — do not delete or reduce to a throwaway. This file empirically
 * answers CONTEXT.md "Claude's Discretion" item 3 / RESEARCH Open Question 4 / Assumption A3
 * for D-20: does a bare (unqualified) `check` constraint fire on DELETE in the Quereus version
 * actually installed in this repo, and can a `check on delete` body call the real `SignatureValid`
 * UDF over a `Digest(old...)` expression? If a future Quereus bump silently changes either answer,
 * D-20's revoke-signature verification (a security control) could stop firing while every other
 * test still passes — this spec is what would catch that regression.
 *
 * VERDICT: (installed @quereus/quereus 4.11.0, see `installedQuereusVersion()` below)
 *   1. Does a bare `check` fire on DELETE?                                     NO
 *   2. Does `check on delete` fire on INSERT or UPDATE (quereus#23 shape)?     NO (stays fixed)
 *   3. Can `check on delete` call SignatureValid(Digest(old...), ...) cleanly? YES
 *   4. Selected D-20 shape:                                                    extend-DeleteValid
 *
 * Decision rule applied (per 49-03-PLAN.md Task 2): (1)=no and (3)=yes -> extend the existing
 * `UserKey.DeleteValid` (qsql:646-651) with an additional AND'd
 * `SignatureValid(Digest(old.UserId, old.PubKey), context.Signature, context.UserKey)` clause.
 * This is the RESEARCH.md Pitfall 5 "expected outcome" branch — no new separately-named
 * constraint is needed. Finding 1 (NO) also confirms UserKey.SignatureValid — the existing BARE
 * check at qsql:663-673 — is genuinely NOT evaluated on today's DELETE path, so CONTEXT.md's "the
 * delete path is unverified" premise stands exactly as stated; it is not accidentally already
 * covered by the bare constraint.
 *
 * quereus#23 cross-reference (finding 2): no reappearance observed — `check on delete` stays
 * correctly scoped to DELETE-only on 4.11.0, consistent with the project's spike-findings skill
 * (references/quereus-constraint-evaluation.md: "quereus#23 ... FIXED in 3.3.0") and this repo's
 * existing `test/quereus-repros/stage-6-check-on-delete.spec.ts` (which proves the same fix on a
 * single `check on delete (false)` constraint, without the SignatureValid/Digest UDF combination
 * this file adds).
 *
 * METHODOLOGY: a scratch schema (NOT votetorrent.qsql) declares one table, `Widget`, with four
 * separately-named constraints exercising every DML-qualifier shape:
 *   - `BareCheck`        — unqualified check referencing `new.` columns only.
 *   - `BareContextCheck` — unqualified check referencing ONLY `context.Marker` (no new./old. at
 *                          all) — this is the DECISIVE probe for "does a bare check fire on
 *                          DELETE", because BareCheck's `new.`-only body evaluates to SQL NULL
 *                          (not FALSE) when `new` doesn't exist on DELETE, and a NULL CHECK
 *                          result is treated as satisfied regardless of whether the constraint
 *                          was evaluated at all — so BareCheck's own DELETE behavior is
 *                          structurally unable to distinguish "fired-and-passed-vacuously" from
 *                          "never evaluated". BareContextCheck has no such blind spot: context
 *                          values are always bound explicitly regardless of DML type, so if it
 *                          fires on DELETE, binding Marker != 'ALLOW' will visibly reject the row.
 *   - `OnDeleteCheck`    — `check on delete`, combining an `old.`-column membership clause with
 *                          the exact D-20 target shape: `SignatureValid(Digest(old...), ...)`.
 *   - `OnInsertCheck`    — `check on insert`, the INSERT-side mirror of OnDeleteCheck (control).
 *
 * Every rejection assertion checks post-operation row state (`select count(*)` / `select Data`),
 * not just that an error was thrown — a "rejected but still mutated" outcome is itself a finding
 * this file is built to catch (per the threat model: a security control that silently no-ops).
 */

import { Database, ConstraintError } from '@quereus/quereus'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerDbPlugins } from '../src/database/initialize.js'
import { digestToBytes } from '../src/utils.js'
import { randomTestKeyPair } from './fixtures/keys.js'

// ---------------------------------------------------------------------------
// Installed Quereus version (version-attributes the VERDICT above)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function installedQuereusVersion (): string {
  const pkgPath = path.join(__dirname, '..', 'node_modules', '@quereus', 'quereus', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return pkg.version
}

// ---------------------------------------------------------------------------
// Scratch schema — NOT votetorrent.qsql. Four constraints over one table.
// ---------------------------------------------------------------------------

const SCRATCH_SCHEMA = `
declare schema main

{
	table Widget (
		Id text primary key,
		Data text,
		constraint BareCheck check (new.Data <> 'BARE_BLOCK'),
		constraint BareContextCheck check (context.Marker = 'ALLOW'),
		constraint OnDeleteCheck check on delete (
			old.Data <> 'DELETE_BLOCK'
				and SignatureValid(Digest(old.Id, old.Data), context.Signature, context.SignerKey)
		),
		constraint OnInsertCheck check on insert (new.Data <> 'INSERT_BLOCK')
	)
		with context ( Marker text null, Signature text null, SignerKey text null );
}

apply schema main;
`

/**
 * Fresh Database per test, registered with the REAL production UDF path
 * (`registerDbPlugins` — the same function `initialize.ts`'s `prepareDb` calls, per the plan's
 * key_links requirement), but WITHOUT loading votetorrent.qsql — only this file's scratch schema.
 */
async function createProbeDb (): Promise<Database> {
  const db = new Database()
  await registerDbPlugins(db)
  await db.exec(SCRATCH_SCHEMA)
  return db
}

interface WidgetContext {
  marker: string
  signature?: string | null
  signerKey?: string | null
}

async function insertWidget (db: Database, id: string, data: string, ctx: WidgetContext): Promise<void> {
  await db.exec(
    `insert into Widget (Id, Data)
     with context Marker = :marker, Signature = :signature, SignerKey = :signerKey
     values (:id, :data)`,
    { id, data, marker: ctx.marker, signature: ctx.signature ?? null, signerKey: ctx.signerKey ?? null }
  )
}

async function updateWidgetData (db: Database, id: string, newData: string, ctx: WidgetContext): Promise<void> {
  await db.exec(
    `update Widget
     with context Marker = :marker, Signature = :signature, SignerKey = :signerKey
     set Data = :newData
     where Id = :id`,
    { id, newData, marker: ctx.marker, signature: ctx.signature ?? null, signerKey: ctx.signerKey ?? null }
  )
}

async function deleteWidget (db: Database, id: string, ctx: WidgetContext): Promise<void> {
  await db.exec(
    `delete from Widget
     with context Marker = :marker, Signature = :signature, SignerKey = :signerKey
     where Id = :id`,
    { id, marker: ctx.marker, signature: ctx.signature ?? null, signerKey: ctx.signerKey ?? null }
  )
}

async function widgetCount (db: Database, id: string): Promise<number> {
  const row = await db.prepare('select count(*) as c from Widget where Id = :id').get({ id })
  return Number(row?.c ?? 0)
}

async function widgetData (db: Database, id: string): Promise<string | undefined> {
  const row = await db.prepare('select Data from Widget where Id = :id').get({ id })
  return row?.Data as string | undefined
}

/**
 * Compute a REAL secp256k1 signature over `Digest(id, data)` — the exact expression
 * `OnDeleteCheck`'s `SignatureValid(Digest(old.Id, old.Data), ...)` clause recomputes for a row
 * whose Id/Data equal the given values. Mirrors `test-context.ts`'s `signTestDigest` convention:
 * digest is base64url (`Digest()`'s own output), signature and signerKey are hex-encoded.
 */
async function realSignatureFor (db: Database, id: string, data: string): Promise<{ signature: string; signerKey: string }> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const digestRow = await db.prepare('select Digest(:id, :data) as d').get({ id, data })
  if (!digestRow || digestRow.d == null) throw new Error('realSignatureFor: Digest() returned null')
  const digestBytes = digestToBytes(digestRow.d as string)
  const sigBytes = secp256k1.sign(digestBytes, hexToBytes(privateHex))
  return { signature: bytesToHex(sigBytes), signerKey: publicHex }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('delete-check semantics (D-20 verdict, 49-03)', () => {
  it('records the installed @quereus/quereus version this VERDICT is attributed to', () => {
    const version = installedQuereusVersion()
    // eslint-disable-next-line no-console
    console.log(`[quereus-delete-check-semantics] installed @quereus/quereus version: ${version}`)
    expect(version, 'installed @quereus/quereus must be the 4.x line this VERDICT block was written against').to.match(/^4\./)
  })

  // -------------------------------------------------------------------------
  // INSERT — 4 cells: BareCheck, BareContextCheck, OnDeleteCheck, OnInsertCheck
  // -------------------------------------------------------------------------
  describe('INSERT', () => {
    it('BareCheck (bare, new.-referencing) FIRES on INSERT — rejects new.Data = BARE_BLOCK', async () => {
      const db = await createProbeDb()
      let caught: unknown
      try {
        await insertWidget(db, 'i-bare-reject', 'BARE_BLOCK', { marker: 'ALLOW' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'BareCheck must reject an INSERT with new.Data = BARE_BLOCK').to.be.instanceOf(ConstraintError)
      expect(await widgetCount(db, 'i-bare-reject'), 'a rejected INSERT must not leave a row behind').to.equal(0)

      await insertWidget(db, 'i-bare-accept', 'OK', { marker: 'ALLOW' })
      expect(await widgetCount(db, 'i-bare-accept'), 'a passing INSERT must succeed').to.equal(1)
    })

    it('BareContextCheck (bare, context-only) FIRES on INSERT — rejects context.Marker != ALLOW', async () => {
      const db = await createProbeDb()
      let caught: unknown
      try {
        await insertWidget(db, 'i-ctx-reject', 'OK', { marker: 'DENY' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'BareContextCheck must reject an INSERT with context.Marker != ALLOW').to.be.instanceOf(ConstraintError)
      expect(await widgetCount(db, 'i-ctx-reject')).to.equal(0)

      await insertWidget(db, 'i-ctx-accept', 'OK', { marker: 'ALLOW' })
      expect(await widgetCount(db, 'i-ctx-accept')).to.equal(1)
    })

    it('OnDeleteCheck (check on delete) does NOT fire on INSERT — quereus#23 shape stays fixed', async () => {
      const db = await createProbeDb()
      // Data = 'DELETE_BLOCK' would violate OnDeleteCheck's old.Data clause IF it fired on
      // INSERT (the quereus#23 regression shape: op-mask filtering broken, on-delete constraint
      // evaluated on every op) — but old. does not exist on INSERT, and a correctly op-masked
      // constraint is skipped entirely for this DML type.
      await insertWidget(db, 'i-ondelete-noop', 'DELETE_BLOCK', { marker: 'ALLOW' })
      expect(
        await widgetCount(db, 'i-ondelete-noop'),
        'OnDeleteCheck must not block an INSERT — quereus#23 (fixed in 3.3.0) staying fixed on 4.x'
      ).to.equal(1)
    })

    it('OnInsertCheck (check on insert) FIRES on INSERT — rejects new.Data = INSERT_BLOCK', async () => {
      const db = await createProbeDb()
      let caught: unknown
      try {
        await insertWidget(db, 'i-oninsert-reject', 'INSERT_BLOCK', { marker: 'ALLOW' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'OnInsertCheck must reject an INSERT with new.Data = INSERT_BLOCK').to.be.instanceOf(ConstraintError)
      expect(await widgetCount(db, 'i-oninsert-reject')).to.equal(0)
    })
  })

  // -------------------------------------------------------------------------
  // UPDATE — 3 cells: BareCheck, BareContextCheck, OnDeleteCheck
  // -------------------------------------------------------------------------
  describe('UPDATE', () => {
    it('BareCheck FIRES on UPDATE — rejects new.Data = BARE_BLOCK, leaves the old value intact', async () => {
      const db = await createProbeDb()
      await insertWidget(db, 'u-bare', 'OK', { marker: 'ALLOW' })

      let caught: unknown
      try {
        await updateWidgetData(db, 'u-bare', 'BARE_BLOCK', { marker: 'ALLOW' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'BareCheck must reject an UPDATE with new.Data = BARE_BLOCK').to.be.instanceOf(ConstraintError)
      expect(await widgetData(db, 'u-bare'), 'a rejected UPDATE must not mutate the row').to.equal('OK')

      await updateWidgetData(db, 'u-bare', 'OK2', { marker: 'ALLOW' })
      expect(await widgetData(db, 'u-bare')).to.equal('OK2')
    })

    it('BareContextCheck FIRES on UPDATE — rejects context.Marker != ALLOW', async () => {
      const db = await createProbeDb()
      await insertWidget(db, 'u-ctx', 'OK', { marker: 'ALLOW' })

      let caught: unknown
      try {
        await updateWidgetData(db, 'u-ctx', 'OK2', { marker: 'DENY' })
      } catch (err) {
        caught = err
      }
      expect(caught, 'BareContextCheck must reject an UPDATE with context.Marker != ALLOW').to.be.instanceOf(ConstraintError)
      expect(await widgetData(db, 'u-ctx')).to.equal('OK')

      await updateWidgetData(db, 'u-ctx', 'OK2', { marker: 'ALLOW' })
      expect(await widgetData(db, 'u-ctx')).to.equal('OK2')
    })

    it('OnDeleteCheck does NOT fire on UPDATE — old.Data = DELETE_BLOCK does not block updating that row', async () => {
      const db = await createProbeDb()
      // Seed with Data = 'DELETE_BLOCK' directly — proven safe by the INSERT case above
      // (OnDeleteCheck does not fire on INSERT) — so old.Data really is 'DELETE_BLOCK' going
      // into this UPDATE.
      await insertWidget(db, 'u-ondelete', 'DELETE_BLOCK', { marker: 'ALLOW' })
      await updateWidgetData(db, 'u-ondelete', 'DELETE_BLOCK_STILL', { marker: 'ALLOW' })
      expect(
        await widgetData(db, 'u-ondelete'),
        'OnDeleteCheck must not block an UPDATE even when old.Data would trip its own clause'
      ).to.equal('DELETE_BLOCK_STILL')
    })
  })

  // -------------------------------------------------------------------------
  // DELETE — 3 cells: BareCheck, BareContextCheck, OnDeleteCheck
  // -------------------------------------------------------------------------
  describe('DELETE', () => {
    it('BareCheck (new.-referencing) does not block DELETE (structurally underdetermined by design — see BareContextCheck below for the decisive answer)', async () => {
      const db = await createProbeDb()
      await insertWidget(db, 'd-bare', 'OK', { marker: 'ALLOW' })
      const sig = await realSignatureFor(db, 'd-bare', 'OK')
      await deleteWidget(db, 'd-bare', { marker: 'ALLOW', signature: sig.signature, signerKey: sig.signerKey })
      expect(
        await widgetCount(db, 'd-bare'),
        'a bare check referencing only new.-columns must not block DELETE (new.Data evaluates to SQL NULL, which a CHECK treats as satisfied, whether or not the constraint was actually evaluated)'
      ).to.equal(0)
    })

    it('BareContextCheck (bare, context-only) — DECISIVE: does NOT fire on DELETE (bare checks are insert/update-only)', async () => {
      const db = await createProbeDb()
      await insertWidget(db, 'd-ctx-reject', 'OK', { marker: 'ALLOW' })
      const sigReject = await realSignatureFor(db, 'd-ctx-reject', 'OK')
      // Marker = 'DENY': if a bare check fires on DELETE, BareContextCheck evaluates FALSE here
      // and must reject. OnDeleteCheck's own clauses (Data != DELETE_BLOCK, valid signature) are
      // satisfied so a rejection can ONLY be attributed to BareContextCheck.
      await deleteWidget(db, 'd-ctx-reject', { marker: 'DENY', signature: sigReject.signature, signerKey: sigReject.signerKey })
      expect(
        await widgetCount(db, 'd-ctx-reject'),
        'BareContextCheck (a bare check with no ON qualifier) must NOT fire on DELETE — context.Marker != ALLOW does not block the delete, confirming bare checks are insert/update-only in this Quereus version'
      ).to.equal(0)

      // Companion control: Marker = 'ALLOW' also succeeds (nothing here depends on Marker at all
      // once bare-check-on-delete is confirmed off).
      await insertWidget(db, 'd-ctx-accept', 'OK', { marker: 'ALLOW' })
      const sigAccept = await realSignatureFor(db, 'd-ctx-accept', 'OK')
      await deleteWidget(db, 'd-ctx-accept', { marker: 'ALLOW', signature: sigAccept.signature, signerKey: sigAccept.signerKey })
      expect(await widgetCount(db, 'd-ctx-accept')).to.equal(0)
    })

    it('OnDeleteCheck FIRES on DELETE (Data clause) — rejects old.Data = DELETE_BLOCK, leaves the row present', async () => {
      const db = await createProbeDb()
      // Data = 'DELETE_BLOCK' is only reachable at all because INSERT doesn't enforce OnDeleteCheck
      // (proven above) — this is the load-bearing setup for testing OnDeleteCheck's OWN clause.
      await insertWidget(db, 'd-ondelete-reject', 'DELETE_BLOCK', { marker: 'ALLOW' })
      const sig = await realSignatureFor(db, 'd-ondelete-reject', 'DELETE_BLOCK')

      let caught: unknown
      try {
        await deleteWidget(db, 'd-ondelete-reject', { marker: 'ALLOW', signature: sig.signature, signerKey: sig.signerKey })
      } catch (err) {
        caught = err
      }
      expect(caught, 'OnDeleteCheck must reject a DELETE where old.Data = DELETE_BLOCK').to.be.instanceOf(ConstraintError)
      expect(await widgetCount(db, 'd-ondelete-reject'), 'a rejected DELETE must leave the row present').to.equal(1)
    })

    // -----------------------------------------------------------------------
    // The exact D-20 shape: SignatureValid(Digest(old...), context.Signature, context.SignerKey)
    // inside `check on delete`.
    // -----------------------------------------------------------------------
    describe('OnDeleteCheck — SignatureValid(Digest(old...), ...) sub-clause (the exact D-20 shape)', () => {
      it('(a)+(b) evaluates without a Quereus error, and a CORRECT signature permits the DELETE', async () => {
        const db = await createProbeDb()
        await insertWidget(db, 'd-sig-valid', 'OK', { marker: 'ALLOW' })
        const sig = await realSignatureFor(db, 'd-sig-valid', 'OK')

        // No throw = (a). Row actually removed = (b).
        await deleteWidget(db, 'd-sig-valid', { marker: 'ALLOW', signature: sig.signature, signerKey: sig.signerKey })
        expect(
          await widgetCount(db, 'd-sig-valid'),
          'a genuinely correct SignatureValid(Digest(old...), ...) result must permit the DELETE'
        ).to.equal(0)
      })

      it('(c) an INCORRECT signature rejects the DELETE and leaves the row present', async () => {
        const db = await createProbeDb()
        await insertWidget(db, 'd-sig-invalid', 'OK', { marker: 'ALLOW' })
        // A syntactically well-formed but WRONG signature: sign the right digest with the WRONG
        // (unrelated) private key, so SignatureValid's key-recovery/verify step genuinely fails
        // rather than throwing on malformed hex.
        const wrongSig = await realSignatureFor(db, 'd-sig-invalid', 'SOME-OTHER-DATA-ENTIRELY')

        let caught: unknown
        try {
          await deleteWidget(db, 'd-sig-invalid', { marker: 'ALLOW', signature: wrongSig.signature, signerKey: wrongSig.signerKey })
        } catch (err) {
          caught = err
        }
        expect(caught, 'an incorrect signature must reject the DELETE').to.be.instanceOf(ConstraintError)
        expect(await widgetCount(db, 'd-sig-invalid'), 'a rejected DELETE must leave the row present').to.equal(1)
      })

      it('(c continued) a completely missing signature (null) rejects the DELETE cleanly (no crash) and leaves the row present', async () => {
        const db = await createProbeDb()
        await insertWidget(db, 'd-sig-null', 'OK', { marker: 'ALLOW' })

        let caught: unknown
        try {
          await deleteWidget(db, 'd-sig-null', { marker: 'ALLOW', signature: null, signerKey: null })
        } catch (err) {
          caught = err
        }
        expect(caught, 'a null signature must reject the DELETE, not crash the process').to.be.instanceOf(ConstraintError)
        expect(await widgetCount(db, 'd-sig-null')).to.equal(1)
      })
    })
  })
})
