import { MisuseError, QuereusError } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import type {
  IInvitationEngine,
  InviteStatus,
  SentOfficerInvite,
  SentAuthorityInvite,
  SentKeyholderInvite,
} from '@votetorrent/vote-core'

/**
 * Real InvitationEngine — Phase 15 (D-08 / SWAP-04).
 *
 * Reads InviteSlot and InviteResult rows from the shared EngineContext
 * database. The write-side (`respondToInvite`) is BLOCKED — it requires the
 * full secp256k1 invite-signing pipeline (D-08) and will be implemented in a
 * future phase.
 *
 * title/scopes storage gap (Q4 option 3): InviteSlot stores only `Name`.
 * `OfficerInit.title` and `.scopes` are required fields on the TypeScript type
 * but are not stored in InviteSlot. We return empty defaults ('', []) until a
 * future schema extension stores them in InviteSlot.
 * See .planning/phases/15-real-engine-di-swap/15-RESEARCH.md Q4 option 3.
 */
export class InvitationEngine implements IInvitationEngine {
  constructor (private readonly ctx: EngineContext) {}

  /**
   * Return all pending officer InviteSlot rows (Type = 'of') that have no
   * matching InviteResult row.
   */
  async getPendingOfficerInvites (): Promise<Array<InviteStatus<SentOfficerInvite>>> {
    const out: Array<InviteStatus<SentOfficerInvite>> = []
    try {
      for await (const row of this.ctx.db.eval(
        `SELECT Cid, Name FROM InviteSlot
         WHERE Type = 'of'
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)`,
        {}
      )) {
        out.push({
          // InviteSlot stores only Name; title/scopes deferred — see 15-RESEARCH.md Q4 option 3
          invite: { name: row.Name as string, type: 'of' as const, title: '', scopes: [] },
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPendingOfficerInvites')
    }
  }

  /**
   * Return all pending authority InviteSlot rows (Type = 'au') that have no
   * matching InviteResult row.
   */
  async getPendingAuthorityInvites (): Promise<Array<InviteStatus<SentAuthorityInvite>>> {
    const out: Array<InviteStatus<SentAuthorityInvite>> = []
    try {
      for await (const row of this.ctx.db.eval(
        `SELECT Cid, Name FROM InviteSlot
         WHERE Type = 'au'
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)`,
        {}
      )) {
        out.push({
          invite: { name: row.Name as string, type: 'au' as const },
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPendingAuthorityInvites')
    }
  }

  /**
   * Return the officer InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null (i.e. a
   * corresponding InviteResult row exists).
   */
  async getOfficerInvite (id: string): Promise<InviteStatus<SentOfficerInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'of'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        // InviteSlot stores only Name; title/scopes deferred — see 15-RESEARCH.md Q4 option 3
        invite: { name: row.Name, type: 'of' as const, title: '', scopes: [] },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getOfficerInvite')
    }
  }

  /**
   * Return the authority InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null.
   */
  async getAuthorityInvite (id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'au'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        invite: { name: row.Name, type: 'au' as const },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getAuthorityInvite')
    }
  }

  /**
   * Return the keyholder InviteSlot with the given Cid, joined with any
   * InviteResult row. Returns `undefined` when no matching row exists.
   *
   * `result` is populated only when `IsAccepted` is non-null (i.e. a
   * corresponding InviteResult row exists).
   *
   * SentKeyholderInvite is `{ name }` only — keyholder invites have no
   * type/title/scopes officer fields. The Type='k' filter scopes the read to
   * keyholder slots so officer ('of') / authority ('au') slots are excluded.
   */
  async getKeyholderInvite (id: string): Promise<InviteStatus<SentKeyholderInvite> | undefined> {
    try {
      const row = await this.ctx.db
        .prepare(
          `SELECT IS_.Cid, IS_.Name, IR.IsAccepted, IR.InviteSignature, IR.InvokedId
           FROM InviteSlot IS_
           LEFT JOIN InviteResult IR ON IR.SlotCid = IS_.Cid
           WHERE IS_.Cid = :id AND IS_.Type = 'k'`
        )
        .get({ id }) as {
          Cid: string
          Name: string
          IsAccepted: boolean | null
          InviteSignature: string | null
          InvokedId: string | null
        } | undefined

      if (!row) return undefined

      return {
        invite: { name: row.Name },
        result: row.IsAccepted !== null
          ? {
            // WR-02: Quereus/SQLite returns boolean columns as 0/1 on the
            // on-device path. Normalize to a real boolean (the field is typed
            // boolean) so strict comparisons (=== true) downstream are correct.
            isAccepted: row.IsAccepted === true || (row.IsAccepted as unknown) === 1,
            invitationSignature: row.InviteSignature ?? '',
            invokedId: row.InvokedId ?? undefined,
          }
          : undefined,
      }
    } catch (err) {
      this.rethrow(err, 'getKeyholderInvite')
    }
  }

  /**
   * BLOCKED: respondToInvite requires the full secp256k1 invite-signing
   * pipeline (InviteSignature over H(SlotCid, Digest, IsAccepted)) and an
   * InviteResult INSERT that passes the `IsSigningValid` + `IsSignatureValid`
   * context checks. The write path is deferred to a future phase (D-08).
   *
   * @throws {Error} Always — this method is not yet implemented.
   */
  async respondToInvite (_invitationId: string, _accept: boolean): Promise<void> {
    throw new Error('respondToInvite: full signing pipeline not yet implemented')
  }

  // ---------- helpers ----------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`InvitationEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`InvitationEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
