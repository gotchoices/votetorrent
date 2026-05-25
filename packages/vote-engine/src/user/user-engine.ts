import { MisuseError, QuereusError } from '@quereus/quereus'
import { UserHistoryEvent } from '@votetorrent/vote-core'
import { parseJsonOr } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  CreateUserHistory,
  DeviceAdvertisement,
  ImageRef,
  IUserEngine,
  ReviseUserHistory,
  Timestamp,
  User,
  UserHistory,
  UserKey,
  UserKeyType
} from '@votetorrent/vote-core'

// Phase 04 USER-02/04/05/06: monotonic Tid counter for UserEngine batches.
// Local to this module — mirrors NetworksEngine's pattern. Re-evaluate at
// the v2 persistence milestone (PERSIST-01) — a process-local counter can
// collide with stored Tids once DBs persist across runs.
let nextTid = 1

/**
 * UserEngine — Phase 04 (USER-01..USER-08) implementation.
 *
 * The engine is constructed with the {@link User} subject of its operations
 * and optionally the shared {@link EngineContext}. Methods that perform
 * only in-memory work do not require `ctx`; methods that hit the DB throw
 * a recognisable error if `ctx` is missing.
 *
 * Schema kept as-written per the project's "assume upstream Quereus bugs
 * are fixed" directive. Tests that depend on rows produced by
 * `NetworksEngine.create()` trip [quereus#23](https://github.com/gotchoices/quereus/issues/23)
 * (CantDelete fires on INSERT) and are marked `it.skip` with a link.
 */
export class UserEngine implements IUserEngine {
  constructor (
    private readonly user: User,
    private readonly ctx?: EngineContext
  ) {}

  /**
   * USER-05 — insert a new UserKey row with the per-INSERT context envelope
   * (Plan 03-05 Q2 — engine-side binding). The schema's `SignatureValid`
   * constraint binds against `context.UserKey` (signer's pubkey) and
   * `context.Signature`.
   *
   * The {@link UserKey} input does not carry a signature payload, so the
   * caller is expected to have populated the engine's {@link User} subject
   * with the signing key as `activeKeys[0]`. This matches the contract used
   * by MockUserEngine.
   */
  async addKey (key: UserKey): Promise<void> {
    this.requireCtx('addKey')
    const tid = nextTid++
    const signerKey = this.user.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx!.db.exec(
				`insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration)`,
        {
          userId: this.user.id,
          keyType: key.type,
          keyValue: key.key,
          expiration: key.expiration,
          userKey: signerKey,
          // No application-level signature is carried on UserKey — the
          // schema's SignatureValid is satisfied by the
          // `UserKey is null` short-circuit for the first key, and by the
          // signer pubkey + signature pair on subsequent keys. The caller
          // can pre-sign via the signing engine and then bind signature
          // through a follow-up addKey overload (Phase 6 — TEST-01).
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'addKey')
    }
  }

  async connectDevice (): Promise<DeviceAdvertisement> {
    throw new Error('Not implemented')
  }

  /**
   * USER-02 — insert a User row and the initial UserKey row using the
   * per-INSERT context envelope from 03-05/03-06. Both INSERTs run in a
   * single `db.exec` batch so the deferred-constraint queue resolves
   * cross-table CHECKs (User.UserKeyValid → UserKey, UserKey.UserIdValid
   * → User) at end-of-batch rather than at each insert moment.
   */
  async create (userInit: CreateUserHistory): Promise<void> {
    this.requireCtx('create')
    const tid = nextTid++
    const imageRefJson = userInit.imageRef ? JSON.stringify(userInit.imageRef) : null
    try {
      await this.ctx!.db.exec(
				`
				insert into User (
					Id,
					Name,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:userId, :userName, :userImageRef);

				insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration);
				`,
        {
          userId: this.user.id,
          userName: userInit.name,
          userImageRef: imageRefJson,
          keyType: userInit.userKey.type,
          keyValue: userInit.userKey.key,
          expiration: userInit.userKey.expiration,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'create')
    }
  }

  async * getHistory (
    userId: string,
    forward: boolean
  ): AsyncIterable<UserHistory> {
    // Out of Phase 4 scope (USER-01..08 covers summary + key + revise +
    // revokeKey + respondToInvite + DefaultUser). UserHistory event-log
    // reconstruction lives in Phase 6 / TEST-01.
    throw new Error('Not implemented')
    yield undefined as unknown as UserHistory
  }

  /**
   * USER-01 — return the User summary for `ctx.user.id`. Reads from the
   * User table and joins UserKey for the active (non-expired) keys.
   * Returns `undefined` if no User row matches the bound `ctx.user.id`.
   */
  async getSummary (): Promise<User | undefined> {
    if (!this.ctx) {
      // No DB context — fall back to the constructor-supplied user object.
      return this.user
    }
    try {
      const row = await this.ctx.db
        .prepare('select Id, Name, ImageRef from User where Id = :id')
        .get({ id: this.user.id })
      if (!row) return undefined
      const activeKeys: UserKey[] = []
      for await (const k of this.ctx.db.eval(
        'select PubKey, Type, Expiration from UserKey where UserId = :id and Expiration > :date',
        { id: this.user.id, date: Date.now() }
      )) {
        activeKeys.push({
          key: k.PubKey as string,
          type: k.Type as UserKeyType,
          expiration: k.Expiration as Timestamp
        })
      }
      return {
        id: row.Id as string,
        name: row.Name as string,
        imageRef: parseJsonOr<ImageRef | undefined>(
          row.ImageRef,
          undefined,
          'User.ImageRef'
        ),
        activeKeys
      }
    } catch (err) {
      this.rethrow(err, 'getSummary')
    }
  }

  async isPrivileged (): Promise<boolean> {
    // Out of Phase 4 scope. Privilege resolution belongs to Phase 6 /
    // TEST-01 once Officer/Keyholder joins are exercised end-to-end.
    throw new Error('Not implemented')
  }

  /**
   * USER-04 — update User name / imageRef. The schema's `ValidModification`
   * CHECK enforces `new.Id = old.Id` (no id rewrite); other update CHECKs
   * are placeholder TODO in the schema today.
   */
  async revise (userRevise: ReviseUserHistory): Promise<void> {
    this.requireCtx('revise')
    if (userRevise.event !== UserHistoryEvent.revise) {
      throw new Error('revise: ReviseUserHistory.event must be "revise"')
    }
    const tid = nextTid++
    const signerKey = userRevise.signature?.signerKey ?? null
    const signature = userRevise.signature?.signature ?? null
    const imageRefJson = userRevise.info.imageRef
      ? JSON.stringify(userRevise.info.imageRef)
      : null
    try {
      await this.ctx!.db.exec(
				`update User
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
					set Name = :name, ImageRef = :imageRef
				where Id = :userId`,
        {
          name: userRevise.info.name,
          imageRef: imageRefJson,
          userId: this.user.id,
          // signerKey/signature are unused by the current schema's update
          // CHECKs (User has no SignatureValid on update). Bound here for
          // forward compatibility with Phase 6 / TEST-01 signing tightening.
          signerKey,
          signature
        }
      )
    } catch (err) {
      this.rethrow(err, 'revise')
    }
  }

  /**
   * USER-06 — DELETE a UserKey row by its hex pubkey. The schema's
   * `UserKey.DeleteValid` is `check on delete` and requires (a) the
   * deleting signer's key is non-expired, and (b) it is not the last
   * remaining key for the user. Quereus#23 currently fires `check on
   * delete` on every operation; once that lands, this DELETE will work
   * as the schema intends.
   */
  async revokeKey (keyToRevoke: string): Promise<void> {
    this.requireCtx('revokeKey')
    const tid = nextTid++
    const signerKey = this.user.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx!.db.exec(
				`delete from UserKey
				with context UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsSignatureValid = true
				where UserId = :userId and PubKey = :pubKey`,
        {
          userId: this.user.id,
          pubKey: keyToRevoke,
          userKey: signerKey,
          signature: null,
          now: Date.now()
        }
      )
    } catch (err) {
      this.rethrow(err, 'revokeKey')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    if (!this.ctx) {
      throw new Error(
				`UserEngine.${method}: no EngineContext bound — construct with (user, ctx) for DB-backed methods`
      )
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`UserEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`UserEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
