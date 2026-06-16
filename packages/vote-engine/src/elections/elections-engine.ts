import { MisuseError, QuereusError } from '@quereus/quereus'
import { ElectionEngine } from '../election/election-engine.js'
import { digestToBytes, fromCanonicalDatetime, nowCanonicalDatetime, parseJsonOr, toCanonicalDatetime } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  ElectionCoreInit,
  ElectionEvent,
  ElectionInit,
  ElectionRevisionInit,
  ElectionSummary,
  ElectionType,
  IElectionEngine,
  IElectionsAdjustElectionBuilder,
  IElectionsCreateElectionBuilder,
  IElectionsEngine,
  Proposal,
  Signature
} from '@votetorrent/vote-core'
import { ElectionsCreateElectionBuilder } from './builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from './builders/elections-adjust-election-builder.js'
import { SigningEngine } from '../signing/signing-engine.js'

// Phase 05 ELEC-01/02 — monotonic Tid counter for ElectionsEngine batches.
// WR-16 (17-REVIEW): DBs now persist across process restarts (Phase 17 proof
// harness), so a counter restarting at 1 would re-issue Tids already consumed
// by a previous process — defeating Tid's replay-protection role ("an update
// can't be repeated with the same credentials"). Tids are NOT queryable from
// the store (they live only inside persisted signature digests), so seeding
// from the store is impossible; instead the counter is seeded from the
// epoch-ms clock at module load. Increments stay sequential within a process,
// preserving the createElection T / T+1 revision-tid contract and
// peekNextElectionTid().
//
// WR-25 (17-REVIEW): this seed is a HEURISTIC, not a guarantee. Two unguarded
// failure modes can silently re-issue consumed Tids:
//   1. Allocation bursts faster than 1/ms — each nextTid++ advances the
//      counter 1 ms ahead of the wall clock, so a burst of N allocations lets
//      the counter outrun the clock by N ms; a process restart within that
//      window reseeds BELOW already-issued Tids.
//   2. Device clock rollback (manual change, NTP correction — common on
//      emulators) reseeds the counter below previously issued Tids.
// Nothing detects either condition today. PERSIST-01 must replace this with
// store-reconciled allocation seeded from a persisted high-water mark:
// nextTid = max(Date.now(), storedHighWater + 1), updated on allocation.
let nextTid = Date.now()

/** For test use only — returns the Tid that the next createElection() call will use. */
export function peekNextElectionTid (): number { return nextTid }

// digestToBytes promoted to packages/vote-engine/src/utils.ts (WR-01 single source of truth).
// Imported above from '../utils.js'.

/**
 * ElectionsEngine — Phase 05 (ELEC-01, ELEC-02) implementation.
 *
 * The engine is constructed with the shared {@link EngineContext}. Methods
 * that perform only in-memory work do not require `ctx`; methods that hit
 * the DB throw a recognisable error if `ctx` is missing.
 *
 * Schema kept as-written per the project's "assume upstream Quereus bugs
 * are fixed" directive. INSERT paths trip
 * [quereus#23](https://github.com/gotchoices/quereus/issues/23) (CantDelete
 * fires on INSERT) and are marked `it.skip` with a link in
 * `elections.spec.ts`.
 */
export class ElectionsEngine implements IElectionsEngine {
  constructor (private readonly ctx?: EngineContext) {}

  /**
   * ELEC-05 (narrative) / `adjustElection` (interface) — INSERT a
   * ProposedElection row. The schema's ProposedElection.UserValid CHECK
   * gates on an Officer with scope 'mel', a non-expired UserKey matching
   * `context.UserKey`, and a SignatureValid call over the row digest.
   */
  async adjustElection (election: ElectionInit): Promise<void> {
    this.requireCtx('adjustElection')
    const tid = nextTid++
    const e = election.election
    // IN-24 (17-REVIEW): the revision row belongs to THIS proposal — a
    // mismatched revision.electionId would key the revision elsewhere
    // (possibly a valid foreign Election), leaving this ProposedElection
    // with no revision row and getProposedElections with nothing to project.
    if (election.revision.electionId !== e.id) {
      throw new Error(
				`ElectionsEngine.adjustElection: revision.electionId (${election.revision.electionId}) does not match election.id (${e.id})`
      )
    }
    const signerKey = this.ctx!.user?.activeKeys?.[0]?.key ?? null
    try {
      // WR-24 (17-REVIEW): the ProposedElection + ProposedElectionRevision
      // inserts must be atomic — a second-insert failure would otherwise
      // strand a core row with no revision row, the exact partial state
      // getProposedElections has to guard against. BEGIN/COMMIT/ROLLBACK
      // mirrors the AUTH-08 envelope in SigningEngine.sign.
      await this.ctx!.db.exec('BEGIN')
      try {
      await this.ctx!.db.exec(
				`insert into ProposedElection (
					Id,
					AuthorityId,
					Title,
					Date,
					RevisionDeadline,
					BallotDeadline,
					Type
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = true
				values (
					:id,
					:authorityId,
					:title,
					:date,
					:revisionDeadline,
					:ballotDeadline,
					:type
				)`,
        {
          id: e.id,
          authorityId: e.authorityId,
          title: e.title,
          // ProposedElection has no DateValid CHECK — raw epoch ms is fine
          // here (quereus 3.1.2 datetime columns accept raw numbers).
          date: e.date,
          revisionDeadline: e.revisionDeadline,
          ballotDeadline: e.ballotDeadline,
          type: e.type,
          userId: this.ctx!.user?.id ?? null,
          userKey: signerKey,
          // No application-level signature is carried on ElectionInit; the
          // caller pre-signs via the signing engine and binds the signature
          // through the AdminSigning/AdminSignature pipeline. Phase 6 /
          // TEST-01 will tighten this contract to require a Signature here.
          signature: null,
          now: nowCanonicalDatetime()
        }
      )

      // WR-18 (17-REVIEW): persist the proposal's required revision payload
      // alongside the core row — previously `election.revision` was silently
      // dropped at write time, forcing getProposedElections() to fabricate it.
      // Serialization mirrors ElectionEngine.proposeRevision exactly; the
      // schema's ElectionIdValid accepts an ElectionId that references the
      // ProposedElection row inserted above.
      const revTid = nextTid++
      const r = election.revision
      await this.ctx!.db.exec(
				`insert into ProposedElectionRevision (
					ElectionId,
					Revision,
					RevisionTimestamp,
					Tags,
					Instructions,
					Timeline,
					KeyholderThreshold
				)
				with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = ${revTid}, now = :now, IsUserValid = true
				values (
					:electionId,
					:revision,
					:revisionTimestamp,
					:tags,
					:instructions,
					:timeline,
					:keyholderThreshold
				)`,
        {
          electionId: r.electionId,
          revision: r.revision,
          revisionTimestamp: r.revisionTimestamp,
          tags: JSON.stringify(r.tags),
          instructions: r.instructions,
          timeline: JSON.stringify(r.timeline),
          keyholderThreshold: r.keyholderThreshold,
          userId: this.ctx!.user?.id ?? null,
          userKey: signerKey,
          signature: null,
          now: nowCanonicalDatetime()
        }
      )
      await this.ctx!.db.exec('COMMIT')
      } catch (innerErr) {
        // WR-24: roll back the ProposedElection row if the revision insert
        // (or the COMMIT itself) failed, so no partial proposal persists.
        await this.ctx!.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'adjustElection')
    }
  }

  /**
   * ELEC-02 — INSERT a new Election row. The schema's `InsertValid` CHECK
   * gates on an AdminSignature row whose digest covers
   * (Tid, Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type).
   * Callers are expected to have already run the AdminSigning/AdminSignature
   * pipeline (e.g. via SigningEngine.startSigningSession) to produce a
   * matching AdminSignature row prior to this call.
   *
   * The schema's `InsertOnly check on update, delete (false)` is exactly
   * the constraint pattern that quereus#23 breaks today on INSERT.
   */
  /**
   * Byte-alignment contract for the revision insert (T-16-21 mitigation):
   * The Election row uses tid = nextTid++ (call it T).
   * The ElectionRevision row uses revTid = nextTid++ = T + 1.
   * seedElectionRevisionSigning MUST be called with tid = peekNextElectionTid() + 1
   * AFTER seedElectionSigning (which peeks at T) but BEFORE createElection (which
   * consumes T then T+1). This guarantees the seam's signed revTid equals the INSERT's
   * context.Tid. The caller controls revisionTimestamp — pass the SAME past epoch ms
   * to both the seam and election.revision.revisionTimestamp so both
   * toCanonicalDatetime() calls produce identical byte strings.
   */
  async createElection (election: ElectionInit, options?: { signingNonce?: string; revisionSigningNonce?: string }): Promise<void> {
    this.requireCtx('createElection')
    const tid = nextTid++
    const e = election.election
    try {
      await this.ctx!.db.exec(
				`insert into Election (
					Id,
					AuthorityId,
					Title,
					Date,
					RevisionDeadline,
					BallotDeadline,
					Type
				)
				with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
				values (
					:id,
					:authorityId,
					:title,
					:date,
					:revisionDeadline,
					:ballotDeadline,
					:type
				)`,
        {
          id: e.id,
          authorityId: e.authorityId,
          title: e.title,
          date: toCanonicalDatetime(e.date),
          revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
          ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
          type: e.type,
          signingNonce: options?.signingNonce ?? null,
          now: nowCanonicalDatetime()
        }
      )
    } catch (err) {
      this.rethrow(err, 'createElection')
    }

    // Insert the initial ElectionRevision (Revision = 0) if revision data and nonce are provided.
    // Skipped if either is absent (back-compat for callers that intentionally omit the revision).
    if (election.revision && options?.revisionSigningNonce) {
      const revTid = nextTid++
      const r = election.revision
      // Serialize tags/timeline with JSON.stringify — byte-identical to seedElectionRevisionSigning binds.
      const tags = JSON.stringify(r.tags)
      const timeline = JSON.stringify(r.timeline)
      // Use the CALLER-SUPPLIED revisionTimestamp (must be a past epoch ms — < context.now AND
      // < Election.RevisionDeadline). Do NOT generate a fresh Date.now() here; that would diverge
      // from the timestamp the seam already signed, reproducing the 16-06 digest-mismatch class.
      const revTimestamp = toCanonicalDatetime(r.revisionTimestamp)
      try {
        await this.ctx!.db.exec(
          `insert into ElectionRevision (ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold)
          with context SigningNonce = :signingNonce, Tid = ${revTid}, now = :now
          values (:electionId, 0, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold)`,
          {
            signingNonce: options.revisionSigningNonce,
            electionId: e.id,
            revTimestamp,
            tags,
            instructions: r.instructions,
            timeline,
            keyholderThreshold: r.keyholderThreshold,
            now: nowCanonicalDatetime(),
          }
        )
      } catch (err) {
        this.rethrow(err, 'createElection')
      }
    }
  }

  /**
   * ELEC-01 (history half) — return past elections from the Election
   * table joined with Authority for the authority name.
   */
  async getElectionHistory (): Promise<ElectionSummary[]> {
    if (!this.ctx) return []
    const out: ElectionSummary[] = []
    const now = nowCanonicalDatetime()
    try {
      for await (const row of this.ctx.db.eval(
				`select E.Id, E.Title, A.Name as AuthorityName, E.Date, E.Type
					from Election E join Authority A on A.Id = E.AuthorityId
					where E.Date < :now`,
        { now }
      )) {
        out.push({
          id: row.Id as string,
          title: row.Title as string,
          authorityName: row.AuthorityName as string,
          date: fromCanonicalDatetime(row.Date as string),
          type: row.Type as ElectionType
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionHistory')
    }
  }

  /**
   * ELEC-01 (current half) — return upcoming elections from the Election
   * table joined with Authority for the authority name. The IEngine
   * surface splits past/future into two methods; this engine matches.
   */
  async getElections (): Promise<ElectionSummary[]> {
    if (!this.ctx) return []
    const out: ElectionSummary[] = []
    const now = nowCanonicalDatetime()
    try {
      for await (const row of this.ctx.db.eval(
				`select E.Id, E.Title, A.Name as AuthorityName, E.Date, E.Type
					from Election E join Authority A on A.Id = E.AuthorityId
					where E.Date >= :now`,
        { now }
      )) {
        out.push({
          id: row.Id as string,
          title: row.Title as string,
          authorityName: row.AuthorityName as string,
          date: fromCanonicalDatetime(row.Date as string),
          type: row.Type as ElectionType
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElections')
    }
  }

  async getProposedElections (): Promise<Array<Proposal<ElectionInit>>> {
    if (!this.ctx) return []
    const out: Array<Proposal<ElectionInit>> = []
    try {
      // Materialize the core rows BEFORE issuing the per-row revision lookups
      // so the eval cursor is not interleaved with other statements on the
      // same db handle.
      const coreRows: Array<{
        id: string
        authorityId: string
        title: string
        date: number
        revisionDeadline: number
        ballotDeadline: number
        type: ElectionType
      }> = []
      for await (const row of this.ctx.db.eval(
				`select Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type
					from ProposedElection`,
        {}
      )) {
        coreRows.push({
          id: row.Id as string,
          authorityId: row.AuthorityId as string,
          title: row.Title as string,
          date: fromCanonicalDatetime(row.Date as string),
          revisionDeadline: fromCanonicalDatetime(row.RevisionDeadline as string),
          ballotDeadline: fromCanonicalDatetime(row.BallotDeadline as string),
          type: row.Type as ElectionType
        })
      }

      for (const core of coreRows) {
        // WR-18 (17-REVIEW): project the revision from the persisted
        // ProposedElectionRevision row (written by adjustElection alongside
        // the core row) instead of a type-defeating `undefined as unknown`
        // cast that crashed consumers at `proposal.proposed.revision.*`.
        const revRow = await this.ctx.db
          .prepare(
						`select Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold
							from ProposedElectionRevision where ElectionId = :id`
          )
          .get({ id: core.id })
        // IN-26 (17-REVIEW): rows without a persisted revision (written before
        // WR-18, when adjustElection dropped the revision payload — WR-24's
        // transaction now makes fresh partial writes impossible) previously
        // surfaced a type-lying `undefined as unknown as ElectionRevisionInit`
        // that crashed consumers at `proposal.proposed.revision.*`. Skip such
        // legacy rows with a warning instead — dev-phase stores are reset via
        // `pm clear`.
        if (!revRow) {
          console.warn(
						`ElectionsEngine.getProposedElections: skipping proposal ${core.id} — no persisted ProposedElectionRevision row (legacy/partial write)`
          )
          continue
        }
        const revision: ElectionRevisionInit = {
          electionId: core.id,
          revision: revRow.Revision as number,
          revisionTimestamp: fromCanonicalDatetime(revRow.RevisionTimestamp as string | number),
          tags: parseJsonOr<string[]>(revRow.Tags, [], 'ProposedElectionRevision.Tags'),
          instructions: revRow.Instructions as string,
          // ProposedElectionRevision persists no keyholder invites; []
          // mirrors ElectionEngine.getRevisions' projection of this field.
          keyholders: [],
          timeline: parseJsonOr<Record<ElectionEvent, number>>(
            revRow.Timeline,
            {} as Record<ElectionEvent, number>,
            'ProposedElectionRevision.Timeline'
          ),
          keyholderThreshold: revRow.KeyholderThreshold as number
        }

        out.push({
          proposed: {
            election: core,
            revision
          },
          // WR-18: Proposal.timestamp is optional and no proposal time is
          // persisted — omit it rather than fabricating the read time, which
          // changed on every call.
          signers: []
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getProposedElections')
    }
  }

  async openElection (electionId: string): Promise<IElectionEngine> {
    this.requireCtx('openElection')
    const row = await this.ctx!.db
      .prepare('select Id, AuthorityId from Election where Id = :id')
      .get({ id: electionId })
    if (!row) {
      throw new Error(`Election ${electionId} not found`)
    }
    return new ElectionEngine(
      {
        id: row.Id as string,
        authorityId: row.AuthorityId as string
      },
      this.ctx!
    )
  }

  // ---------- election-signing seam (D-01 / Phase 16 Plan 03) ----------

  /**
   * Seed the AdminSigning → OfficerSignature → AdminSignature prerequisite that
   * `Election.InsertValid` requires before `createElection()` can succeed.
   *
   * Owns the FULL crypto pipeline — the screen passes only election fields and
   * the device private key hex; the screen never computes tid, Digest, or signs:
   *
   * 1. Resolve `CurrentAdmin.EffectiveAt` for the authority.
   * 2. Peek the next Tid (the same value `createElection` will use — peek, not consume).
   * 3. Compute the election Digest via `select Digest(...)` over the DB so the bytes
   *    are IDENTICAL to what `Election.InsertValid` re-computes at insert time.
   * 4. Produce a REAL secp256k1 signature over those digest bytes using the device
   *    private key (inside the engine — screen never signs, D-01).
   * 5. Insert `AdminSigning` with scope='mel' and the election Digest.
   * 6. Call `SigningEngine.sign()` → OfficerSignature → (threshold=1) → AdminSignature.
   * 7. Return the nonce so the screen can pass it to `createElection(payload, { signingNonce })`.
   *
   * The `IsSignatureValid = true` context flag is the seedElectionSigning pattern
   * (same as test/fixtures/test-context.ts); it is acceptable because the stored
   * `Signature` value IS a genuine secp256k1 signature over the correct Digest —
   * `OfficerSignature.SignatureValid` will verify the real crypto (D-01).
   *
   * @param electionFields - The core election fields (id, authorityId, title, date,
   *   revisionDeadline, ballotDeadline, type) — must match exactly what the builder
   *   payload will carry so the Digests align.
   * @param sign - App-layer signing callback: receives the canonical digest bytes
   *   (computed via SQL Digest()) and returns a Signature `{ signerUserId, signerKey,
   *   signature }`. The private key stays app-side (D-01); the callback MUST use
   *   @noble/curves v2 defaults (prehash:true — WR-10). signerUserId/signerKey arrive
   *   inside the returned Signature (D-04).
   * @returns The signing nonce to pass to `createElection(payload, { signingNonce })`.
   */
  async seedElectionSigning (
    electionFields: Pick<ElectionCoreInit, 'id' | 'authorityId' | 'title' | 'date' | 'revisionDeadline' | 'ballotDeadline' | 'type'>,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<string> {
    this.requireCtx('seedElectionSigning')
    const ctx = this.ctx!
    const { id, authorityId, title, date, revisionDeadline, ballotDeadline, type } = electionFields

    // 1. Resolve CurrentAdmin.EffectiveAt for the authority
    const adminRow = await ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId })
    if (!adminRow) {
      throw new Error(`seedElectionSigning: CurrentAdmin not found for authorityId=${authorityId}`)
    }
    const adminEffectiveAt = adminRow.EffectiveAt as string | number

    // 2. Peek the Tid that createElection() will use (peek — do NOT increment)
    const tid = peekNextElectionTid()

    // Convert date fields to the canonical datetime string form the schema expects,
    // matching exactly what createElection passes to the Election INSERT.
    const dateCanon = toCanonicalDatetime(date)
    const revDeadlineCanon = toCanonicalDatetime(revisionDeadline)
    const ballotDeadlineCanon = toCanonicalDatetime(ballotDeadline)

    // 3. Compute the election Digest via SQL so the bytes are IDENTICAL to what
    //    Election.InsertValid will recompute: Digest(context.Tid, new.Id, new.AuthorityId,
    //    new.Title, new.Date, new.RevisionDeadline, new.BallotDeadline, new.Type).
    //    Pass tid as an INTEGER (JS number) to match context.Tid:int in Election.InsertValid
    //    and createElection's integer SQL literal `Tid = ${tid}`. Digest('1', …) ≠ Digest(1, …),
    //    so binding String(tid) would produce a mismatch and InsertValid would always fail.
    const digestRow = await ctx.db
      .prepare(
        'select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d'
      )
      .get({
        tid: tid,
        id,
        authorityId,
        title,
        date: dateCanon,
        revisionDeadline: revDeadlineCanon,
        ballotDeadline: ballotDeadlineCanon,
        type,
      })
    if (!digestRow || digestRow.d == null) {
      throw new Error('seedElectionSigning: Digest() returned null — crypto plugin not registered?')
    }

    // 4. Hand the canonical digest bytes to the app-layer sign callback (D-01/D-03/D-04).
    //    The callback closes over the device private key app-side and returns a Signature
    //    { signerUserId, signerKey, signature }. The engine never sees privKeyHex.
    //    CR-01: After the node-crypto.js polyfill fix, Digest() returns a base64url string
    //    on both Node and device. digestToBytes guards Uint8Array (legacy device path
    //    before the polyfill fix), 43-char base64url, and 64-char hex by shape (WR-01).
    //    WR-10 (17-REVIEW): the callback MUST use @noble/curves v2 defaults (prehash:true).
    const digestBytes: Uint8Array = digestToBytes(digestRow.d)
    const signature = await sign(digestBytes)

    // 5. Generate nonce and insert AdminSigning with the election-specific Digest.
    //    `IsSignatureValid = true` mirrors the seedElectionSigning test-fixture pattern;
    //    OfficerSignature.SignatureValid will still verify the genuine secp256k1 signature.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonce: string = (globalThis as any).crypto.randomUUID()
    const now = nowCanonicalDatetime()

    await ctx.db.exec(
      `insert into AdminSigning (
        Nonce,
        AuthorityId,
        AdminEffectiveAt,
        Scope,
        Digest,
        UserId,
        SignerKey,
        Signature
      )
      with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
      values (
        :nonce,
        :authorityId,
        :adminEffectiveAt,
        'mel',
        Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type),
        :userId,
        :signerKey,
        :signature
      )`,
      {
        nonce,
        authorityId,
        adminEffectiveAt,
        tid: tid,
        id,
        title,
        date: dateCanon,
        revisionDeadline: revDeadlineCanon,
        ballotDeadline: ballotDeadlineCanon,
        type,
        userId: signature.signerUserId,
        signerKey: signature.signerKey,
        signature: signature.signature,
        now,
      }
    )

    // 6. Drive OfficerSignature + AdminSignature via SigningEngine (threshold=1 → AdminSignature).
    await new SigningEngine(ctx).sign(nonce, signature)

    // 7. Return the nonce for the screen to pass to createElection(payload, { signingNonce }).
    return nonce
  }

  // ---------- revision-signing seam (D-01 / Phase 16 Plan 07) ----------

  /**
   * Seed a SECOND AdminSigning row (scope='mel') whose Digest covers the
   * `ElectionRevision` row that `createElection` will insert (Revision = 0).
   *
   * This is a COMPANION to `seedElectionSigning` — the Election-row signing
   * path is UNCHANGED. The revision Digest field order mirrors the schema's
   * `ElectionRevision.MutationValid` CHECK:
   *   Digest(context.Tid, new.ElectionId, new.Revision, new.RevisionTimestamp,
   *          new.Tags, new.Instructions, new.Timeline, new.KeyholderThreshold)
   *
   * Byte-alignment contract (T-16-21 mitigation):
   *   - `tid`          binds as INTEGER (JS number) — same 16-06 fix as seedElectionSigning.
   *   - `revision`     binds as INTEGER literal 0 (RevisionStart constraint).
   *   - `revTimestamp` binds as `toCanonicalDatetime(revision.revisionTimestamp)` — the
   *     CALLER supplies a PAST timestamp (< context.now AND < Election.RevisionDeadline).
   *     Do NOT generate a fresh Date.now() here; it must equal what createElection binds.
   *   - `tags`         binds as `JSON.stringify(revision.tags)` — byte-identical to
   *     what the ElectionRevision INSERT binds in Task 2.
   *   - `timeline`     binds as `JSON.stringify(revision.timeline)` — same byte-identity.
   *
   * The `revTid` used here is `peekNextElectionTid() + 1` because `createElection`
   * consumes `nextTid++` for the Election row first, then `nextTid++` for the revision.
   * Callers MUST call seedElectionSigning (which peeks at `peekNextElectionTid()`) BEFORE
   * calling this method so the +1 offset is stable.
   *
   * @returns A DISTINCT nonce (different from the election-row nonce) for the caller
   *   to pass to `createElection(payload, { signingNonce, revisionSigningNonce })`.
   */
  async seedElectionRevisionSigning (
    electionId: string,
    authorityId: string,
    revision: {
      revision: number
      revisionTimestamp: number
      tags: string[]
      instructions: string
      timeline: Record<string, number>
      keyholderThreshold: number
    },
    tid: number,
    sign: (digest: Uint8Array) => Promise<Signature>
  ): Promise<string> {
    this.requireCtx('seedElectionRevisionSigning')
    const ctx = this.ctx!

    // 1. Resolve CurrentAdmin.EffectiveAt for the authority (same as seedElectionSigning).
    const adminRow = await ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId })
    if (!adminRow) {
      throw new Error(`seedElectionRevisionSigning: CurrentAdmin not found for authorityId=${authorityId}`)
    }
    const adminEffectiveAt = adminRow.EffectiveAt as string | number

    // 2. Serialize tags/timeline with JSON.stringify — byte-identical to createElection binds.
    const tags = JSON.stringify(revision.tags)
    const timeline = JSON.stringify(revision.timeline)
    const revTimestamp = toCanonicalDatetime(revision.revisionTimestamp)

    // 3. Compute the revision Digest via SQL — IDENTICAL to MutationValid recompute.
    //    Bind `tid` as INTEGER (JS number, NOT String) — the 16-06 root-cause class fix.
    //    Bind `revision` as integer 0 (RevisionStart constraint literal).
    const digestRow = await ctx.db
      .prepare(
        'select Digest(:tid, :electionId, :revision, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold) as d'
      )
      .get({
        tid: tid,
        electionId,
        revision: 0,
        revTimestamp,
        tags,
        instructions: revision.instructions,
        timeline,
        keyholderThreshold: revision.keyholderThreshold,
      })
    if (!digestRow || digestRow.d == null) {
      throw new Error('seedElectionRevisionSigning: Digest() returned null — crypto plugin not registered?')
    }

    // 4. Hand the canonical digest bytes to the app-layer sign callback (D-01/D-03/D-04).
    //    CR-01/WR-01: same shape-discriminating decoder as seedElectionSigning.
    const digestBytes: Uint8Array = digestToBytes(digestRow.d)
    const signature = await sign(digestBytes)

    // 5. Generate a FRESH nonce (DISTINCT from the election-row nonce).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nonce: string = (globalThis as any).crypto.randomUUID()
    const now = nowCanonicalDatetime()

    await ctx.db.exec(
      `insert into AdminSigning (
        Nonce,
        AuthorityId,
        AdminEffectiveAt,
        Scope,
        Digest,
        UserId,
        SignerKey,
        Signature
      )
      with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
      values (
        :nonce,
        :authorityId,
        :adminEffectiveAt,
        'mel',
        Digest(:tid, :electionId, :revision, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold),
        :userId,
        :signerKey,
        :signature
      )`,
      {
        nonce,
        authorityId,
        adminEffectiveAt,
        tid: tid,
        electionId,
        revision: 0,
        revTimestamp,
        tags,
        instructions: revision.instructions,
        timeline,
        keyholderThreshold: revision.keyholderThreshold,
        userId: signature.signerUserId,
        signerKey: signature.signerKey,
        signature: signature.signature,
        now,
      }
    )

    // 6. Drive OfficerSignature + AdminSignature via SigningEngine (threshold=1 → AdminSignature).
    await new SigningEngine(ctx).sign(nonce, signature)

    // 7. Return the nonce for the caller to pass as revisionSigningNonce.
    return nonce
  }

  /**
   * DEBUG-ONLY seed: inserts ≥1 pending signature Task (AdminSignatureTaskExtension)
   * and ≥1 pending release-key Task (ReleaseKeyTaskExtension) for `userId`, using
   * real Authority, Admin, and Election data already present in the DB.
   *
   * This method is NOT on IElectionsEngine — it is a concrete-class-only debug helper.
   * Screens access it via `(engine as any).debugSeedPendingTasks(userId)` behind a
   * __DEV__ guard; it must NEVER ship in a release path.
   *
   * Idempotency: if pending tasks already exist for `userId` of the target type,
   * skip that seed (do not duplicate).
   *
   * Seeding strategy follows the established test-fixture pattern from signing.spec.ts:
   *   - For signature task: ProposedAdmin + AdminSigning + BEGIN Task + AdminSignatureTaskExtension COMMIT
   *     (explicit transaction so deferred ExtensionExists / TaskIdValid see sibling rows at COMMIT).
   *   - For release-key task: BEGIN Task + ReleaseKeyTaskExtension COMMIT (same pattern).
   *
   * @returns An object describing what was seeded (taskId or null if skipped).
   */
  async debugSeedPendingTasks (userId: string): Promise<{ signatureTaskId: string | null; releaseKeyTaskId: string | null }> {
    this.requireCtx('debugSeedPendingTasks')
    const ctx = this.ctx!

    // ----- Guard: skip signature seed if a pending 'admin' signature task already exists for this user -----
    const existingSignatureTask = await ctx.db
      .prepare(`select Id from Task where UserId = :userId and Type = 'signature' and SignatureType = 'admin' and IsCompleted = 0 limit 1`)
      .get({ userId })

    let signatureTaskId: string | null = null

    if (!existingSignatureTask) {
      // 1. Find the first Authority and its CurrentAdmin.EffectiveAt.
      const authorityRow = await ctx.db
        .prepare('select AuthorityId, EffectiveAt from CurrentAdmin limit 1')
        .get({})
      if (!authorityRow) {
        throw new Error('debugSeedPendingTasks: No CurrentAdmin found — create a network + authority first')
      }
      const authorityId = authorityRow.AuthorityId as string
      const adminEffectiveAt = authorityRow.EffectiveAt as string

      // 2. Seed ProposedAdmin so AdminSignatureTaskExtension.AdminEffectiveAtValid and
      //    MutationValid's Digest formula can resolve. Use a fresh tid for the Digest.
      const tid = Date.now()
      const thresholdPolicies = '[]'
      const now = nowCanonicalDatetime()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nonce: string = (globalThis as any).crypto.randomUUID()
      signatureTaskId = (globalThis as any).crypto.randomUUID()

      // ProposedAdmin may already exist for this EffectiveAt — insert or ignore.
      // We need a dummy signer key for the context fields that have IsUserValid checks.
      // Since context.IsSignatureValid = true bypasses the real signature CHECK, we can
      // use a placeholder hex key (32 zeros = 64 hex chars, valid secp256k1 scalar format).
      const placeholderKey = '0'.repeat(66)
      const placeholderSig = '0'.repeat(128)
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context IsUserValid = true, Tid = :tid, now = :now,
                        UserId = :userId, UserKey = :signerKey, Signature = :signature
           values (:authorityId, :adminEffectiveAt, :thresholdPolicies)`,
          { authorityId, adminEffectiveAt, thresholdPolicies, tid, now, userId, signerKey: placeholderKey, signature: placeholderSig }
        )
      } catch {
        // ProposedAdmin may already exist for this (AuthorityId, EffectiveAt) PK — treat as idempotent.
      }

      // 3. Insert AdminSigning with the 4-arg Digest matching AdminSignatureTaskExtension.MutationValid.
      //    Do NOT call sign() so AdminSignature stays absent — MutationValid's "not exists AdminSignature
      //    for uncompleted task" gate would block the extension insert if the signing was already complete.
      await ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad',
                 Digest(:tid, :authorityId, :adminEffectiveAt, :thresholdPolicies),
                 :userId, :signerKey, :signature)`,
        { nonce, authorityId, adminEffectiveAt, thresholdPolicies, tid, now, userId, signerKey: placeholderKey, signature: placeholderSig }
      )

      // 4. Insert Task + AdminSignatureTaskExtension in one explicit transaction so the
      //    deferred ExtensionExists (Task) and TaskIdValid (extension) checks see each other at COMMIT.
      await ctx.db.exec('BEGIN')
      try {
        await ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
          { id: signatureTaskId, userId, nonce, tid }
        )
        await ctx.db.exec(
          `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
           with context Tid = :tid
           values (:taskId, :authorityId, :adminEffectiveAt)`,
          { taskId: signatureTaskId, authorityId, adminEffectiveAt, tid }
        )
        await ctx.db.exec('COMMIT')
      } catch (err) {
        await ctx.db.exec('ROLLBACK')
        throw err
      }
    }

    // ----- Guard: skip release-key seed if a pending release-key task already exists for this user -----
    const existingReleaseKeyTask = await ctx.db
      .prepare(`select Id from Task where UserId = :userId and Type = 'release-key' and IsCompleted = 0 limit 1`)
      .get({ userId })

    let releaseKeyTaskId: string | null = null

    if (!existingReleaseKeyTask) {
      // 5. Find an Election that has an ElectionRevision row (revision 0) so
      //    ReleaseKeyTaskExtension.ElectionRevisionValid can be satisfied.
      //    Prefer elections with a future RevisionDeadline for UAT-8 countdown.
      const electionRow = await ctx.db
        .prepare(
          `select E.Id, ER.Revision
             from Election E join ElectionRevision ER on ER.ElectionId = E.Id and ER.Revision = 0
             order by E.RevisionDeadline desc
             limit 1`
        )
        .get({})
      if (!electionRow) {
        throw new Error(
          'debugSeedPendingTasks: No Election with ElectionRevision found — ' +
          'create an election via the Elections flow first (the creation pipeline inserts revision 0)'
        )
      }
      const electionId = electionRow.Id as string
      const electionRevision = electionRow.Revision as number  // always 0

      const rkTid = Date.now()
      releaseKeyTaskId = (globalThis as any).crypto.randomUUID() // eslint-disable-line @typescript-eslint/no-explicit-any

      // 6. Insert Task + ReleaseKeyTaskExtension in one explicit transaction.
      await ctx.db.exec('BEGIN')
      try {
        await ctx.db.exec(
          `insert into Task (Id, UserId, Type, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'release-key', 0)`,
          { id: releaseKeyTaskId, userId, tid: rkTid }
        )
        await ctx.db.exec(
          `insert into ReleaseKeyTaskExtension (TaskId, ElectionId, ElectionRevision)
           with context Tid = :tid
           values (:taskId, :electionId, :electionRevision)`,
          { taskId: releaseKeyTaskId, electionId, electionRevision, tid: rkTid }
        )
        await ctx.db.exec('COMMIT')
      } catch (err) {
        await ctx.db.exec('ROLLBACK')
        throw err
      }
    }

    return { signatureTaskId, releaseKeyTaskId }
  }

  // ---------- builder factories ----------

  buildCreateElection (): IElectionsCreateElectionBuilder {
    return new ElectionsCreateElectionBuilder(this)
  }

  buildAdjustElection (): IElectionsAdjustElectionBuilder {
    return new ElectionsAdjustElectionBuilder(this)
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`ElectionsEngine.${method}: no EngineContext bound — construct with (ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`ElectionsEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`ElectionsEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
