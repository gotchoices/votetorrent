import { MisuseError, QuereusError } from '@quereus/quereus'
import { FeatureNotAvailableError, UserHistoryEvent } from '@votetorrent/vote-core'
import { digestToBytes, fromCanonicalDatetime, nowCanonicalDatetime, parseJsonOr, toCanonicalDatetime } from '../utils.js'
import type { EngineContext } from '../types.js'
import type {
  CreateUserHistory,
  DeviceAdvertisement,
  ImageRef,
  IUserAddKeyBuilder,
  IUserCreateBuilder,
  IUserEngine,
  IUserReviseBuilder,
  IUserRevokeKeyBuilder,
  ReviseUserHistory,
  Scope,
  Signature,
  Timestamp,
  User,
  UserHistory,
  UserKey,
  UserKeyType
} from '@votetorrent/vote-core'
import {
  UserAddKeyBuilder,
  UserCreateBuilder,
  UserReviseBuilder,
  UserRevokeKeyBuilder
} from './builders/index.js'

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
   * Dispatches on CALLBACK PRESENCE (not key count):
   * - No `sign` callback → unchanged behavior (existing first-key/no-callback
   *   path). Binds `context.UserKey = existing active pubkey`, `Signature = null`,
   *   `IsSignatureValid = true`. The existing test stays green.
   * - `sign` callback provided → signed subsequent-key path (UKEY-03 / D-14).
   *   The engine computes a SQL `Digest(userId, newPubKey, keyType, expirationCanon)`,
   *   converts to bytes via the shared `digestToBytes`, calls the callback with
   *   those bytes, then binds `context.UserKey = existing active pubkey` (NOT the
   *   new key — RESEARCH §Pitfall 5), `context.Signature = real signature`, and
   *   `IsSignatureValid = true` so `UserKey.InsertValid`'s subsequent branch passes.
   *
   * The device private key NEVER enters this engine (D-01/D-04): `addKey` receives
   * a sign callback, not `privKeyHex`. The new key cannot authorize its own insertion.
   */
  async addKey (key: UserKey, sign?: (digest: Uint8Array) => Promise<Signature>): Promise<void> {
    this.requireCtx('addKey')
    const tid = nextTid++
    // EXISTING active pubkey — bound to context.UserKey in BOTH paths.
    // Per RESEARCH §Pitfall 5: this MUST be the EXISTING key, never key.key.
    const signerKey = this.user.activeKeys?.[0]?.key ?? null

    let boundSignature: string | null = null
    let evtSignature: string | null = null

    if (sign !== undefined) {
      // Signed subsequent-key path (UKEY-03 / D-14).
      // Guard: an existing active key must exist and must differ from the new key.
      if (signerKey == null) {
        throw new Error(
          'UserEngine.addKey: no existing active key to authorize a signed subsequent-key add'
        )
      }
      if (signerKey === key.key) {
        throw new Error(
          'UserEngine.addKey: the existing active key cannot sign its own re-insertion (T-21-07-01)'
        )
      }

      // Compute the digest via SQL — bytes are IDENTICAL to what InsertValid would recompute.
      // Convention (LOCKED by 21-02): Digest(userId, newPubKey, keyType, expirationCanon).
      const expirationCanon = toCanonicalDatetime(key.expiration)
      const digestRow = await this.ctx!.db
        .prepare('select Digest(:userId, :newPubKey, :keyType, :expiration) as d')
        .get({
          userId: this.user.id,
          newPubKey: key.key,
          keyType: key.type,
          expiration: expirationCanon
        })
      if (!digestRow || digestRow.d == null) {
        throw new Error(
          'UserEngine.addKey: Digest() returned null — crypto plugin not registered?'
        )
      }

      const digestBytes: Uint8Array = digestToBytes(digestRow.d)
      const signature = await sign(digestBytes)
      boundSignature = signature.signature
      evtSignature = signature.signature
    }

    try {
      await this.ctx!.db.exec(
				`insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration);

				insert into UserEvent (UserId, Sequence, Event, Timestamp, Signature, Payload)
				with context Tid = ${tid}, now = :now
				values (
					:userId,
					coalesce((select max(Sequence) from UserEvent where UserId = :userId), -1) + 1,
					'AK',
					:now,
					:evtSignature,
					:payload
				)`,
        {
          userId: this.user.id,
          keyType: key.type,
          keyValue: key.key,
          expiration: toCanonicalDatetime(key.expiration),
          // context.UserKey is ALWAYS the EXISTING active pubkey (never key.key).
          // When sign is absent: signerKey may be null (first-key path).
          // When sign is present: signerKey is the existing authorized signer (guard above).
          userKey: signerKey,
          // Without sign callback: null (no-callback unchanged path, first-key short-circuit).
          // With sign callback: real secp256k1 hex signature from the existing active key.
          signature: boundSignature,
          now: nowCanonicalDatetime(),
          // D-14/D-15/D-16: append-only AddUserKeyHistory event in the same batch (same Tid).
          // Payload carries the UserKey with raw epoch-ms expiration (Pitfall 5).
          evtSignature,
          payload: JSON.stringify({
            userKey: {
              key: key.key,
              type: key.type,
              expiration: key.expiration
            }
          })
        }
      )
    } catch (err) {
      this.rethrow(err, 'addKey')
    }
  }

  async connectDevice (): Promise<DeviceAdvertisement> {
    // ENG-07 phase-gate: connectDevice requires P2P fabric (UKEY-04, Phase 22).
    throw new FeatureNotAvailableError('connectDevice — requires a paired device (P2P not available)')
  }

  /**
   * USER-02 — insert a User row and the initial UserKey row using the
   * per-INSERT context envelope from 03-05/03-06. Both INSERTs run in a
   * single `db.exec` batch so the deferred-constraint queue resolves
   * cross-table CHECKs (User.UserKeyValid → UserKey, UserKey.UserIdValid
   * → User) at end-of-batch rather than at each insert moment.
   */
  async create (
    userInit: CreateUserHistory,
    options?: { inviteSlotCid?: string; inviteSignature?: string }
  ): Promise<void> {
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
				with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
				values (:userId, :userName, :userImageRef);

				insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration);

				insert into UserEvent (UserId, Sequence, Event, Timestamp, Signature, Payload)
				with context Tid = ${tid}, now = :now
				values (
					:userId,
					coalesce((select max(Sequence) from UserEvent where UserId = :userId), -1) + 1,
					'C',
					:now,
					:evtSignature,
					:payload
				);
				`,
        {
          userId: this.user.id,
          userName: userInit.name,
          userImageRef: imageRefJson,
          keyType: userInit.userKey.type,
          keyValue: userInit.userKey.key,
          expiration: toCanonicalDatetime(userInit.userKey.expiration),
          inviteSlotCid: options?.inviteSlotCid ?? null,
          inviteSignature: options?.inviteSignature ?? null,
          now: nowCanonicalDatetime(),
          // D-15: Signature written null this phase; Phase 21 fills real
          // signature content via the signing pipeline (no migration).
          evtSignature: null,
          // D-16: single JSON Payload round-trips the UserInit shape
          // (CreateUserHistory = UserHistory & UserInit). expiration is the
          // raw epoch-ms number (Pitfall 5 — do not canonical-stringify it).
          payload: JSON.stringify({
            name: userInit.name,
            imageRef: userInit.imageRef,
            userKey: {
              key: userInit.userKey.key,
              type: userInit.userKey.type,
              expiration: userInit.userKey.expiration
            }
          })
        }
      )
    } catch (err) {
      this.rethrow(err, 'create')
    }
  }

  /**
   * ENG-02 (D-17/D-18) — read the append-only UserEvent log for `userId`,
   * ordered by the per-user `Sequence` key (ASC when `forward`, DESC
   * otherwise), mapping each row back to its discriminated `UserHistory`
   * subtype. Users created before the UserEvent table existed have no rows,
   * so this yields nothing — honest empty history, no synthetic backfill
   * (D-18).
   *
   * T-19-05 mitigation: `userId` is a bound `:param` (never interpolated);
   * the ORDER BY direction is a whitelisted `'ASC'`/`'DESC'` literal branched
   * in TS (Quereus rejects `ORDER BY :param` — Pitfall 2). T-19-06: the
   * SELECT filters `WHERE UserId = :userId`, no cross-user read path.
   */
  async * getHistory (
    userId: string,
    forward: boolean
  ): AsyncIterable<UserHistory> {
    this.requireCtx('getHistory')
    const order = forward ? 'ASC' : 'DESC'
    try {
      for await (const row of this.ctx!.db.eval(
        `SELECT Event, Timestamp, Signature, Payload FROM UserEvent
          WHERE UserId = :userId ORDER BY Sequence ${order}`,
        { userId }
      )) {
        const base = {
          timestamp: fromCanonicalDatetime(row.Timestamp as string),
          // D-15/Pitfall 4: Signature is a REQUIRED field on UserHistory;
          // the column is written null this phase, read as '' until Phase 21.
          signature: (row.Signature as Signature | null) ?? ''
        }
        const payload = parseJsonOr<any>(row.Payload, {}, 'UserEvent.Payload')
        switch (row.Event) {
          case 'C':
            yield { event: UserHistoryEvent.create, ...base, ...payload } as UserHistory
            break
          case 'R':
            yield { event: UserHistoryEvent.revise, ...base, info: payload.info ?? payload } as UserHistory
            break
          case 'AK':
            yield { event: UserHistoryEvent.addKey, ...base, userKey: payload.userKey } as UserHistory
            break
          case 'RK':
            yield { event: UserHistoryEvent.revokeKey, ...base, key: payload.key } as UserHistory
            break
        }
      }
    } catch (err) {
      this.rethrow(err, 'getHistory')
    }
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
        { id: this.user.id, date: nowCanonicalDatetime() }
      )) {
        activeKeys.push({
          key: k.PubKey as string,
          type: k.Type as UserKeyType,
          expiration: fromCanonicalDatetime(k.Expiration as string)
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

  /**
   * ENG-03 — Returns true iff an Officer row exists for `userId` whose
   * Scopes JSON array includes `scope`, under the currently effective Admin
   * (current AdminEffectiveAt), in ANY authority of the network.
   *
   * T-18-01 mitigation: userId and scope are bound ONLY via the params object
   * `{ userId, scope }` — never string-interpolated into the SQL statement.
   *
   * NOTE: The Scope TS type includes 'rnp' but the DB Scope view does not
   * list it (existing schema inconsistency, not introduced here). The query
   * is correct as-is; an Officer with 'rnp' in their Scopes JSON would have
   * failed the ScopesValid CHECK at insert time — no special handling needed.
   *
   * T-18-02 mitigation: Scope match uses exact equality (json_each value = :scope,
   * not LIKE), and the join is restricted to CurrentAdmin — prevents false-positive
   * privilege grants.
   *
   * WR-02 — deny-by-default contract: the CurrentAdmin join requires a current
   * Admin row (`EffectiveAt <= now`, max per authority) whose `EffectiveAt`
   * equals the Officer's `AdminEffectiveAt`. If an authority has NO effective
   * Admin row, or the Officer's `AdminEffectiveAt` is future-dated (admin not yet
   * effective), no CurrentAdmin row joins and this method returns `false`. This
   * fail-closed behavior is intentional and safe for privilege grants, but it is
   * indistinguishable from "user lacks the scope." Pinned by the WR-02 tests in
   * user.spec.ts (future-dated admin and no-effective-admin both yield `false`).
   */
  async isPrivileged (scope: Scope, userId: string): Promise<boolean> {
    this.requireCtx('isPrivileged')
    try {
      const row = await this.ctx!.db
        .prepare(
          `SELECT 1 AS found
             FROM Officer O
             JOIN CurrentAdmin CA ON CA.AuthorityId = O.AuthorityId
                                 AND CA.EffectiveAt = O.AdminEffectiveAt
            WHERE O.UserId = :userId
              AND EXISTS (
                SELECT 1 FROM json_each(O.Scopes) WHERE value = :scope
              )
            LIMIT 1`
        )
        .get({ userId, scope })
      return row != null
    } catch (err) {
      this.rethrow(err, 'isPrivileged')
    }
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
				where Id = :userId;

				insert into UserEvent (UserId, Sequence, Event, Timestamp, Signature, Payload)
				with context Tid = ${tid}, now = :now
				values (
					:userId,
					coalesce((select max(Sequence) from UserEvent where UserId = :userId), -1) + 1,
					'R',
					:now,
					:evtSignature,
					:payload
				)`,
        {
          name: userRevise.info.name,
          imageRef: imageRefJson,
          userId: this.user.id,
          // signerKey/signature are unused by the current schema's update
          // CHECKs (User has no SignatureValid on update). Bound here for
          // forward compatibility with Phase 6 / TEST-01 signing tightening.
          signerKey,
          signature,
          now: nowCanonicalDatetime(),
          // D-14/D-15/D-16: append-only ReviseUserHistory event in the same
          // batch (same Tid). Payload carries UserInfo under `info`.
          // UKEY-01: commit the real signature hex from ReviseUserHistory.signature
          // to UserEvent.Signature (schema comment votetorrent.qsql:554 anticipated this).
          evtSignature: userRevise.signature?.signature ?? null,
          payload: JSON.stringify({
            info: {
              name: userRevise.info.name,
              imageRef: userRevise.info.imageRef
            }
          })
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
  async revokeKey (keyToRevoke: string, signature: Signature): Promise<void> {
    this.requireCtx('revokeKey')
    const tid = nextTid++
    // context.UserKey = the user's currently-active signing key (must exist in UserKey
    // table and be non-expired for DeleteValid to pass). This is the stored active key,
    // not signature.signerKey — the context gate checks DB membership of this key.
    const signerKey = this.user.activeKeys?.[0]?.key ?? null
    try {
      await this.ctx!.db.exec(
				`delete from UserKey
				with context UserKey = :userKey, Signature = :signature, Tid = ${tid}, now = :now, IsSignatureValid = true
				where UserId = :userId and PubKey = :pubKey;

				insert into UserEvent (UserId, Sequence, Event, Timestamp, Signature, Payload)
				with context Tid = ${tid}, now = :now
				values (
					:userId,
					coalesce((select max(Sequence) from UserEvent where UserId = :userId), -1) + 1,
					'RK',
					:now,
					:evtSignature,
					:payload
				)`,
        {
          userId: this.user.id,
          pubKey: keyToRevoke,
          userKey: signerKey,
          // UKEY-02: bind the real device Signature (replaces null) so context.Signature
          // carries a non-null value for UserKey.SignatureValid.
          signature: signature.signature,
          now: nowCanonicalDatetime(),
          // D-14/D-15/D-16: append-only RevokeUserKeyHistory event in the
          // same batch (same Tid). Payload carries the revoked pubkey hex.
          // UKEY-02: commit the real Signature to UserEvent.Signature as well.
          evtSignature: signature.signature,
          payload: JSON.stringify({ key: keyToRevoke })
        }
      )
    } catch (err) {
      this.rethrow(err, 'revokeKey')
    }
  }

  // ---------- builder factories ----------

  buildCreate (): IUserCreateBuilder {
    return new UserCreateBuilder(this)
  }

  buildAddKey (): IUserAddKeyBuilder {
    return new UserAddKeyBuilder(this)
  }

  buildRevise (): IUserReviseBuilder {
    return new UserReviseBuilder(this)
  }

  buildRevokeKey (): IUserRevokeKeyBuilder {
    return new UserRevokeKeyBuilder(this)
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
