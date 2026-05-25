import { MisuseError, QuereusError } from '@quereus/quereus'
import { ElectionEngine } from '../election/election-engine.js'
import type { EngineContext } from '../types.js'
import type {
  ElectionInit,
  ElectionSummary,
  ElectionType,
  IElectionEngine,
  IElectionsEngine,
  Proposal
} from '@votetorrent/vote-core'

// Phase 05 ELEC-01/02 — monotonic Tid counter for ElectionsEngine batches.
// Mirrors NetworksEngine/UserEngine pattern. Re-evaluate at the v2
// persistence milestone (PERSIST-01) — a process-local counter can collide
// with stored Tids once DBs persist across runs.
let nextTid = 1

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
          now: Date.now()
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
  async createElection (election: ElectionInit): Promise<void> {
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
          date: e.date,
          revisionDeadline: e.revisionDeadline,
          ballotDeadline: e.ballotDeadline,
          type: e.type,
          // The signing nonce is expected to be supplied by the caller via
          // the surrounding signing session (Phase 6 / TEST-01 tightens the
          // surface to take the nonce explicitly). Today we forward null;
          // when the schema's InsertValid CHECK becomes enforceable post
          // #23, the call site supplies it via context binding overload.
          signingNonce: null,
          now: Date.now()
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
    const now = Date.now()
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
          date: row.Date as number,
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
    const now = Date.now()
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
          date: row.Date as number,
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
              date: row.Date as number,
              revisionDeadline: row.RevisionDeadline as number,
              ballotDeadline: row.BallotDeadline as number,
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
