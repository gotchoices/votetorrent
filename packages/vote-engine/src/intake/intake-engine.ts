// src/intake/intake-engine.ts — Phase 62 Plan 14 (D-03, D-04, D-29, D-32, D-46)
//
// Officer key registration and status, recipient listing, sealer/opener
// factories, and the intake policy read/write. Every catch block re-throws
// an `IntakeError` unchanged and routes anything else through the shared
// `rethrow` helper (ceremony-helpers.ts), matching every other
// registration-domain engine in this package.
//
// Task 1 lands officer key registration/status and recipient listing. Task 2
// adds the sealer/opener factories and the intake policy read/write.

import type { Scope } from '@votetorrent/vote-core'
import {
  ENCRYPTION_KEY_ALG,
  encryptionPublicKeyFromSecret,
  generateEncryptionKeyPair,
  MAX_OFFICER_KEY_GENERATIONS,
  officerEncryptionKeyGenerationAlias,
  OFFICER_ENCRYPTION_KEY_POLICY
} from '../crypto/index.js'
import { listHeldOfficerKeyGenerations } from '../crypto/vault.js'
import type { IKeyVault } from '../crypto/index.js'
import { digestToBytes } from '../utils.js'
import { requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { readAuthorityThreshold } from '../signing/threshold.js'
import { allocateTid } from '../database/tid-allocator.js'
import type { EngineContext } from '../types.js'
import { intakeQueryPortFromDb } from './query-port.js'
import { pickCurrentEncryptionKey, readUsableEncryptionKeys, resolveIntakeRecipients } from './recipients.js'
import { createIntakeOpener, createIntakeSealer } from './sealing.js'
import { isValidRestBridgeUrl, readIntakePolicyFrom } from './policy.js'
import { IntakeError, REASSOCIATION_MODES } from './types.js'
import type {
  AuthorityIntakePolicyInput,
  AuthorityIntakePolicyView,
  IntakeOpener,
  IntakeRecipientSet,
  IntakeSealer,
  IntakeSignCallback,
  OfficerEncryptionKeyRegistration,
  OfficerEncryptionKeyStatus,
  OfficerKeyRenewalOutcome
} from './types.js'

function describeThrown (err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

export class IntakeEngine {
  constructor (private readonly ctx?: EngineContext) {}

  // ---------- ceremony-helper delegators (WR-04 shared-copy convention) ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'IntakeEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'IntakeEngine', method)
  }

  private requireUserId (): string {
    const userId = this.ctx?.user?.id
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new IntakeError('invalid-argument', 'IntakeEngine: no ctx.user bound')
    }
    return userId
  }

  /** Authority-scoped current-officer check; `scope`, when given, additionally requires it in O.Scopes. */
  private async isCurrentOfficer (authorityId: string, userId: string, scope?: Scope): Promise<boolean> {
    const ctx = this.ctx!
    const scopeClause = scope !== undefined
      ? 'and exists (select 1 from json_each(O.Scopes) where value = :scopeCode)'
      : ''
    const row = await ctx.db
      .prepare(
        `select 1 as found
           from Officer O
           join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
          where O.AuthorityId = :authorityId and O.UserId = :userId ${scopeClause}
          limit 1`
      )
      .get({ authorityId, userId, scopeCode: scope ?? null })
    return row != null
  }

  // ---------- D-04 officer encryption-key registration ----------

  /**
   * D-04: an officer publishes their own secp256k1 encryption public key as
   * a self-signed `UserEncryptionKey` row. The vault write ALWAYS precedes
   * the row insert — a published key always has a held secret. Idempotent:
   * a second call for an already-published key reuses the vault secret and
   * reports `'already-registered'`.
   *
   * One key per officer per vault alias: a newer row from another device of
   * the SAME officer becomes current and this device's key stops receiving
   * NEW envelopes; deleting the vault alias to re-register loses access to
   * every envelope already wrapped to the old key (D-07 keeps them forever).
   */
  async registerOfficerEncryptionKey (
    authorityId: string,
    vault: IKeyVault,
    sign: IntakeSignCallback
  ): Promise<OfficerEncryptionKeyRegistration> {
    this.requireCtx('registerOfficerEncryptionKey')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-argument', 'registerOfficerEncryptionKey: authorityId must be a non-empty string')
    }

    // No vault access before this check (T-62-14 custody ordering).
    if (!(await this.isCurrentOfficer(authorityId, userId))) {
      throw new IntakeError(
        'not-a-current-officer',
        'registerOfficerEncryptionKey: caller is not a current officer of this authority'
      )
    }

    return this.registerOrRenew(authorityId, userId, vault, sign)
  }

  /**
   * O-01: the shared decision behind `registerOfficerEncryptionKey` and `renewStrandedOfficerEncryptionKey`.
   * The newest held vault generation is the local key. Not held at all: mint generation 0 (legacy alias).
   * Held but unpublished: publish it. Published and usable: `already-registered` (`superseded` when the
   * officer's other device published a newer usable key). STRANDED (see `isStranded`): mint generation n+1.
   * Older generations are never deleted or overwritten (D-51).
   */
  private async registerOrRenew (
    authorityId: string,
    userId: string,
    vault: IKeyVault,
    sign: IntakeSignCallback
  ): Promise<OfficerEncryptionKeyRegistration> {
    const ctx = this.ctx!
    const method = 'registerOfficerEncryptionKey'
    let publicKey: string
    let minted = false
    let held: number[]
    try {
      held = await listHeldOfficerKeyGenerations(vault, userId)
    } catch (err) {
      throw new IntakeError('vault-error', `${method}: ${describeThrown(err)}`)
    }

    if (held.length === 0) {
      publicKey = await this.mintGeneration(vault, userId, 0, method)
      minted = true
    } else {
      publicKey = await this.readGenerationPublicKey(vault, userId, held[held.length - 1]!, method)
    }

    const existingRow = await ctx.db
      .prepare('select RegisteredAt from UserEncryptionKey where UserId = :userId and PubKey = :pubKey')
      .get({ userId, pubKey: publicKey })

    if (existingRow && !minted) {
      const { usable, dropped } = await readUsableEncryptionKeys(intakeQueryPortFromDb(ctx.db), userId)
      if (this.isStranded(publicKey, dropped)) {
        if (held.length >= MAX_OFFICER_KEY_GENERATIONS) {
          throw new IntakeError('vault-error', `${method}: the vault already holds the maximum ${MAX_OFFICER_KEY_GENERATIONS} key generations`)
        }
        const renewedKey = await this.mintGeneration(vault, userId, held.length, method)
        const registeredAt = await this.publishKey(userId, renewedKey, sign, method)
        return { userId, authorityId, publicKey: renewedKey, registeredAt, status: 'renewed' }
      }
      const current = pickCurrentEncryptionKey(usable)
      const superseded = current !== undefined && current.publicKey !== publicKey
      return {
        userId,
        authorityId,
        publicKey,
        registeredAt: existingRow.RegisteredAt as string,
        status: 'already-registered',
        ...(superseded ? { superseded: true } : {})
      }
    }
    if (existingRow) {
      return {
        userId,
        authorityId,
        publicKey,
        registeredAt: existingRow.RegisteredAt as string,
        status: 'already-registered'
      }
    }

    const registeredAt = await this.publishKey(userId, publicKey, sign, method)
    return { userId, authorityId, publicKey, registeredAt, status: 'registered' }
  }

  /**
   * STRANDED is deliberately narrow: the newest local key's `(UserId, PubKey)` row was dropped by
   * `readUsableEncryptionKeys` with reason exactly `'signer-key-revoked'`. Every other drop reason
   * (`invalid-public-key`; `duplicate-public-key`, no longer produced - contested keys stay usable and
   * are reported in `contestedKeys`, never dropped) and every usable row is NOT stranded and never renews.
   */
  private isStranded (publicKey: string, dropped: ReadonlyArray<{ publicKey: string, reason: string }>): boolean {
    return dropped.some((d) => d.publicKey === publicKey && d.reason === 'signer-key-revoked')
  }

  /** Generates a key pair, stores the secret under `generation` BEFORE anything is published (D-04 custody order). */
  private async mintGeneration (vault: IKeyVault, userId: string, generation: number, method: string): Promise<string> {
    let alias: string
    try {
      alias = officerEncryptionKeyGenerationAlias(userId, generation)
    } catch (err) {
      throw new IntakeError('invalid-argument', `${method}: invalid vault alias (${describeThrown(err)})`)
    }
    const generated = generateEncryptionKeyPair()
    try {
      await vault.putSecret(alias, generated.secretKey, OFFICER_ENCRYPTION_KEY_POLICY)
      return generated.publicKey
    } catch (err) {
      throw new IntakeError('vault-error', `${method}: ${describeThrown(err)}`)
    } finally {
      generated.secretKey.fill(0)
    }
  }

  private async readGenerationPublicKey (vault: IKeyVault, userId: string, generation: number, method: string): Promise<string> {
    let secretCopy: Uint8Array | null = null
    try {
      const secret = await vault.getSecret(officerEncryptionKeyGenerationAlias(userId, generation))
      if (secret === null) {
        throw new IntakeError('vault-error', `${method}: vault reports the alias exists but returned no secret`)
      }
      secretCopy = secret
      return encryptionPublicKeyFromSecret(secret)
    } catch (err) {
      if (err instanceof IntakeError) throw err
      throw new IntakeError('vault-error', `${method}: ${describeThrown(err)}`)
    } finally {
      // Best-effort local-copy zeroization; the vault's own copy is never touched here.
      secretCopy?.fill(0)
    }
  }

  /** Signs and inserts the self-signed `UserEncryptionKey` row; returns its RegisteredAt. */
  private async publishKey (userId: string, publicKey: string, sign: IntakeSignCallback, method: string): Promise<string> {
    const ctx = this.ctx!
    const registeredAt = new Date().toISOString()
    try {
      const digestRow = await ctx.db
        .prepare("select Digest('UserEncryptionKey', :userId, :alg, :pubKey, :registeredAt) as d")
        .get({ userId, alg: ENCRYPTION_KEY_ALG, pubKey: publicKey, registeredAt })
      if (!digestRow || digestRow.d == null) {
        throw new Error(`${method}: Digest() returned null — crypto plugin not registered?`)
      }
      const digestBytes = digestToBytes(digestRow.d)
      const signature = await sign(digestBytes)
      await ctx.db.exec(
        `insert into UserEncryptionKey (UserId, Alg, PubKey, RegisteredAt, SignerKey, Signature)
         values (:userId, :alg, :pubKey, :registeredAt, :signerKey, :signature)`,
        {
          userId,
          alg: ENCRYPTION_KEY_ALG,
          pubKey: publicKey,
          registeredAt,
          signerKey: signature.signerKey,
          signature: signature.signature
        }
      )
    } catch (err) {
      if (err instanceof IntakeError) throw err
      this.rethrow(err, method)
    }
    return registeredAt
  }

  /**
   * O-01: renew the caller's intake key when (and only when) it is stranded, with no authority id.
   * `'not-an-officer'` touches nothing in the vault; `sign` is called only when renewing.
   */
  async renewStrandedOfficerEncryptionKey (vault: IKeyVault, sign: IntakeSignCallback): Promise<OfficerKeyRenewalOutcome> {
    this.requireCtx('renewStrandedOfficerEncryptionKey')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    const officerRow = await ctx.db
      .prepare(
        `select O.AuthorityId as authorityId
           from Officer O
           join CurrentAdmin CA on CA.AuthorityId = O.AuthorityId and CA.EffectiveAt = O.AdminEffectiveAt
          where O.UserId = :userId
          limit 1`
      )
      .get({ userId })
    if (officerRow == null) return 'not-an-officer'

    let held: number[]
    try {
      held = await listHeldOfficerKeyGenerations(vault, userId)
    } catch (err) {
      throw new IntakeError('vault-error', `renewStrandedOfficerEncryptionKey: ${describeThrown(err)}`)
    }
    if (held.length === 0) return 'no-local-key'

    const publicKey = await this.readGenerationPublicKey(vault, userId, held[held.length - 1]!, 'renewStrandedOfficerEncryptionKey')
    const { dropped } = await readUsableEncryptionKeys(intakeQueryPortFromDb(ctx.db), userId)
    if (!this.isStranded(publicKey, dropped)) return 'not-needed'
    if (held.length >= MAX_OFFICER_KEY_GENERATIONS) {
      throw new IntakeError('vault-error', `renewStrandedOfficerEncryptionKey: the vault already holds the maximum ${MAX_OFFICER_KEY_GENERATIONS} key generations`)
    }
    const renewedKey = await this.mintGeneration(vault, userId, held.length, 'renewStrandedOfficerEncryptionKey')
    await this.publishKey(userId, renewedKey, sign, 'renewStrandedOfficerEncryptionKey')
    return 'renewed'
  }

  /** Read-only snapshot of the caller's own officer encryption key for `authorityId`. */
  async getOfficerEncryptionKeyStatus (authorityId: string, vault: IKeyVault): Promise<OfficerEncryptionKeyStatus> {
    this.requireCtx('getOfficerEncryptionKeyStatus')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-argument', 'getOfficerEncryptionKeyStatus: authorityId must be a non-empty string')
    }

    let hasLocalKey = false
    let localPublicKey: string | null = null
    try {
      const held = await listHeldOfficerKeyGenerations(vault, userId)
      hasLocalKey = held.length > 0
      if (hasLocalKey) {
        localPublicKey = await this.readGenerationPublicKey(vault, userId, held[held.length - 1]!, 'getOfficerEncryptionKeyStatus')
      }
    } catch (err) {
      if (err instanceof IntakeError) throw err
      throw new IntakeError('vault-error', `getOfficerEncryptionKeyStatus: ${describeThrown(err)}`)
    }

    const port = intakeQueryPortFromDb(ctx.db)

    let published = false
    if (localPublicKey !== null) {
      const row = await ctx.db
        .prepare('select 1 as found from UserEncryptionKey where UserId = :userId and PubKey = :pubKey')
        .get({ userId, pubKey: localPublicKey })
      published = row != null
    }

    const { usable, dropped } = await readUsableEncryptionKeys(port, userId)
    const stranded = localPublicKey !== null && this.isStranded(localPublicKey, dropped)
    const current = pickCurrentEncryptionKey(usable)
    const isCurrent = localPublicKey !== null && current !== undefined && current.publicKey === localPublicKey
    const isIntakeRecipient = isCurrent && (await this.isCurrentOfficer(authorityId, userId))

    let isContested = false
    if (isCurrent && localPublicKey !== null) {
      const recipientSet = await resolveIntakeRecipients(port, authorityId)
      isContested = recipientSet.contestedKeys.some(
        (entry) => entry.publicKey === localPublicKey && entry.userIds.some((id) => id !== userId)
      )
    }

    return { userId, authorityId, hasLocalKey, localPublicKey, published, isCurrent, isIntakeRecipient, isContested, stranded }
  }

  /** `resolveIntakeRecipients` over this engine's own DB handle (D-04/D-32). */
  async listIntakeRecipients (authorityId: string): Promise<IntakeRecipientSet> {
    this.requireCtx('listIntakeRecipients')
    return resolveIntakeRecipients(intakeQueryPortFromDb(this.ctx!.db), authorityId)
  }

  // ---------- D-03/D-04 sealer/opener factories ----------

  createSealer (authorityId: string): IntakeSealer {
    this.requireCtx('createSealer')
    return createIntakeSealer({ port: intakeQueryPortFromDb(this.ctx!.db), authorityId })
  }

  createOpener (vault: IKeyVault): IntakeOpener {
    this.requireCtx('createOpener')
    return createIntakeOpener({ vault, userId: this.requireUserId() })
  }

  // ---------- D-29/D-46 intake policy ----------

  async readIntakePolicy (authorityId: string): Promise<AuthorityIntakePolicyView> {
    this.requireCtx('readIntakePolicy')
    return readIntakePolicyFrom(intakeQueryPortFromDb(this.ctx!.db), authorityId)
  }

  /**
   * D-29: an officer holding `'vrg'` sets the authority's REST bridge URL
   * and/or re-association mode as a new revision, under a `'vrg'`
   * AdminSigning ceremony — mirroring `RegistrationEngine.registerBridgeKey`
   * field for field. Every check below runs BEFORE the first write, so a
   * refusal never leaves an orphan ceremony session.
   */
  async setIntakePolicy (input: AuthorityIntakePolicyInput, sign: IntakeSignCallback): Promise<AuthorityIntakePolicyView> {
    this.requireCtx('setIntakePolicy')
    const ctx = this.ctx!
    const userId = this.requireUserId()
    const { authorityId } = input

    if (typeof authorityId !== 'string' || authorityId.length === 0) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: authorityId must be a non-empty string')
    }
    const hasUrl = Object.prototype.hasOwnProperty.call(input, 'restBridgeUrl')
    const hasMode = Object.prototype.hasOwnProperty.call(input, 'reassociationMode')
    if (!hasUrl && !hasMode) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: at least one of restBridgeUrl/reassociationMode must be given')
    }
    if (hasUrl && input.restBridgeUrl !== null && input.restBridgeUrl !== undefined && !isValidRestBridgeUrl(input.restBridgeUrl)) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: restBridgeUrl must be null or a valid https URL')
    }
    if (hasMode && !(REASSOCIATION_MODES as readonly string[]).includes(input.reassociationMode as string)) {
      throw new IntakeError('invalid-policy', 'setIntakePolicy: reassociationMode must be "manual" or "automatic"')
    }

    // Tier 2 pre-check (tier 1 is the schema's own ceremony CHECK).
    if (!(await this.isCurrentOfficer(authorityId, userId, 'vrg' as Scope))) {
      throw new IntakeError('not-authorized', "setIntakePolicy: caller does not hold 'vrg' at this authority")
    }

    // Like registerBridgeKey, this table has no co-sign Task path, and
    // adding one needs a schema change frozen after 62-03 (D-22). Refusing
    // before any write leaves no orphan ceremony.
    const threshold = await readAuthorityThreshold(ctx.db, authorityId, 'vrg' as Scope)
    if (threshold > 1) {
      throw new IntakeError(
        'threshold-requires-co-sign',
        "setIntakePolicy: the 'vrg' threshold at this authority is above 1 — co-sign is not yet supported for this table"
      )
    }

    const current = await readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      throw new IntakeError(
        'policy-revision-conflict',
        `setIntakePolicy: expectedRevision ${input.expectedRevision} does not match current revision ${current.revision}`
      )
    }

    const nextUrl = hasUrl ? (input.restBridgeUrl ?? null) : current.restBridgeUrl
    const nextMode = hasMode ? (input.reassociationMode ?? current.reassociationMode) : current.reassociationMode

    if (!current.isDefault && nextUrl === current.restBridgeUrl && nextMode === current.reassociationMode) {
      return current
    }

    const revision = current.revision + 1
    const setAt = new Date().toISOString()
    // The SAME durable allocator namespace registerBridgeKey uses.
    const tid = await allocateTid(ctx.db, 'registration-request')
    const digestExpr = "select Digest(:tid, 'AuthorityIntakePolicy', :rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt) as d"
    const digestParams = {
      tid,
      rowAuthorityId: authorityId,
      revision,
      restBridgeUrl: nextUrl,
      reassociationMode: nextMode,
      setAt
    }

    try {
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg' as Scope, tid, digestExpr, digestParams, sign)
      await ctx.db.exec(
        `insert into AuthorityIntakePolicy (AuthorityId, Revision, RestBridgeUrl, ReassociationMode, SetAt)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:rowAuthorityId, :revision, :restBridgeUrl, :reassociationMode, :setAt)`,
        {
          rowAuthorityId: authorityId,
          revision,
          restBridgeUrl: nextUrl,
          reassociationMode: nextMode,
          setAt,
          signingNonce: nonce
        }
      )
    } catch (err) {
      if (err instanceof IntakeError) throw err
      // A concurrent officer may have won the PK race (same idiom as
      // registerBridgeKey) — the unused ceremony session is harmless.
      const reread = await readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
      if (reread.revision >= revision) {
        throw new IntakeError('policy-revision-conflict', 'setIntakePolicy: a concurrent write won the revision race')
      }
      this.rethrow(err, 'setIntakePolicy')
    }

    return readIntakePolicyFrom(intakeQueryPortFromDb(ctx.db), authorityId)
  }
}
