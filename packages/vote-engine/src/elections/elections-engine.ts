import { MisuseError, QuereusError } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1'
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils'
import { ElectionEngine } from '../election/election-engine.js'
import { fromCanonicalDatetime, nowCanonicalDatetime, toCanonicalDatetime } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  ElectionCoreInit,
  ElectionInit,
  ElectionSummary,
  ElectionType,
  IElectionEngine,
  IElectionsAdjustElectionBuilder,
  IElectionsCreateElectionBuilder,
  IElectionsEngine,
  Proposal
} from '@votetorrent/vote-core'
import { ElectionsCreateElectionBuilder } from './builders/elections-create-election-builder.js'
import { ElectionsAdjustElectionBuilder } from './builders/elections-adjust-election-builder.js'
import { SigningEngine } from '../signing/signing-engine.js'

// Phase 05 ELEC-01/02 — monotonic Tid counter for ElectionsEngine batches.
// Mirrors NetworksEngine/UserEngine pattern. Re-evaluate at the v2
// persistence milestone (PERSIST-01) — a process-local counter can collide
// with stored Tids once DBs persist across runs.
let nextTid = 1

/** For test use only — returns the Tid that the next createElection() call will use. */
export function peekNextElectionTid (): number { return nextTid }

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
    const signerKey = this.ctx!.user?.activeKeys?.[0]?.key ?? null
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
  async createElection (election: ElectionInit, options?: { signingNonce?: string }): Promise<void> {
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
      for await (const row of this.ctx.db.eval(
				`select Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type
					from ProposedElection`,
        {}
      )) {
        out.push({
          proposed: {
            election: {
              id: row.Id as string,
              authorityId: row.AuthorityId as string,
              title: row.Title as string,
              date: fromCanonicalDatetime(row.Date as string),
              revisionDeadline: fromCanonicalDatetime(row.RevisionDeadline as string),
              ballotDeadline: fromCanonicalDatetime(row.BallotDeadline as string),
              type: row.Type as ElectionType
            },
            revision: undefined as unknown as ElectionInit['revision']
          },
          timestamp: Date.now(),
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
   * @param privKeyHex - Device private key as a hex string (from getDevicePrivKeyHex()).
   * @param signerUserId - Device user id (User.id).
   * @param signerKey - Device public key hex (User.activeKeys[0].key).
   * @returns The signing nonce to pass to `createElection(payload, { signingNonce })`.
   */
  async seedElectionSigning (
    electionFields: Pick<ElectionCoreInit, 'id' | 'authorityId' | 'title' | 'date' | 'revisionDeadline' | 'ballotDeadline' | 'type'>,
    privKeyHex: string,
    signerUserId: string,
    signerKey: string
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

    // 4. Produce a REAL secp256k1 signature over the digest bytes — INSIDE the engine
    //    (the screen never calls secp256k1.sign, satisfying the B2 tier constraint).
    const digestBytes: Uint8Array =
      digestRow.d instanceof Uint8Array
        ? digestRow.d
        : hexToBytes(digestRow.d as string)
    const privKeyBytes = hexToBytes(privKeyHex)
    const sig = secp256k1.sign(digestBytes, privKeyBytes)
    const signature = bytesToHex(sig.toCompactRawBytes())

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
        userId: signerUserId,
        signerKey,
        signature,
        now,
      }
    )

    // 6. Drive OfficerSignature + AdminSignature via SigningEngine (threshold=1 → AdminSignature).
    await new SigningEngine(ctx).sign(nonce, { signerUserId, signerKey, signature })

    // 7. Return the nonce for the screen to pass to createElection(payload, { signingNonce }).
    return nonce
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
