import type {
  AuthorityPeer,
  IAuthorityConfigEngine,
  PollingDevice,
  Signature
} from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

// Phase 42-05 (D-01) — monotonic Tid counter for AuthorityConfigEngine
// mutations, mirroring ElectionsEngine/RegistrationEngine/AssociationEngine's
// counter seeded from the epoch-ms clock (WR-16/WR-25 rationale applies
// identically here — see elections-engine.ts for the full write-up).
let nextTid = Date.now()

/**
 * AuthorityConfigEngine — Phase 42-05 (D-01) implementation.
 *
 * AuthorityId-keyed direct-CRUD engine (no builder — per D-02, config
 * mutations are direct async methods) for two authority-config tables:
 *
 *  - `AuthorityPeer` (network-peer roster) — gated by the `'cap'`
 *    (Configure Authority Peers) AdminSigning scope.
 *  - `PollingDevice` (shared-tablet uniqueness-waiver whitelist, D-06) —
 *    gated by the `'vrg'` (Validate Registrations) AdminSigning scope,
 *    NOT `'cap'`.
 *
 * Every mutation runs the shared `seedSignedMutation` ceremony exactly once
 * per row, then performs the actual insert/delete
 * `with context SigningNonce = :nonce, Tid = ${tid}`. The schema's own
 * `InsertValid`/`DeleteValid` CHECK independently re-derives
 * `Digest(context.Tid, ...)` and compares against `AdminSigning.Digest` —
 * the app-computed digest is never trusted alone (T-42-05-01).
 */
export class AuthorityConfigEngine implements IAuthorityConfigEngine {
  constructor (private readonly ctx?: EngineContext) {}

  async addAuthorityPeer (
    authorityId: string,
    peerId: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    this.requireCtx('addAuthorityPeer')
    const ctx = this.ctx!
    const tid = nextTid++
    try {
      const nonce = await seedSignedMutation(
        ctx,
        authorityId,
        'cap',
        tid,
        'select Digest(:tid, :authorityId, :peerId) as d',
        { tid, authorityId, peerId },
        this.resolveSign(signatureOrCallback)
      )
      await ctx.db.exec(
        `insert into AuthorityPeer (AuthorityId, PeerId)
         with context SigningNonce = :nonce, Tid = ${tid}
         values (:authorityId, :peerId)`,
        { authorityId, peerId, nonce }
      )
    } catch (err) {
      this.rethrow(err, 'addAuthorityPeer')
    }
  }

  async removeAuthorityPeer (
    authorityId: string,
    peerId: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    this.requireCtx('removeAuthorityPeer')
    const ctx = this.ctx!
    const tid = nextTid++
    try {
      const nonce = await seedSignedMutation(
        ctx,
        authorityId,
        'cap',
        tid,
        `select Digest(:tid, :authorityId, :peerId, 'delete') as d`,
        { tid, authorityId, peerId },
        this.resolveSign(signatureOrCallback)
      )
      await ctx.db.exec(
        `delete from AuthorityPeer
         with context SigningNonce = :nonce, Tid = ${tid}
         where AuthorityId = :authorityId and PeerId = :peerId`,
        { authorityId, peerId, nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeAuthorityPeer')
    }
  }

  async getAuthorityPeers (authorityId: string): Promise<AuthorityPeer[]> {
    if (!this.ctx) return []
    const out: AuthorityPeer[] = []
    try {
      for await (const row of this.ctx.db.eval(
        'select AuthorityId, PeerId from AuthorityPeer where AuthorityId = :authorityId',
        { authorityId }
      )) {
        out.push({
          authorityId: row.AuthorityId as string,
          peerId: row.PeerId as string
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getAuthorityPeers')
    }
  }

  async addPollingDevice (
    authorityId: string,
    deviceHash: string,
    label: string | undefined,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    this.requireCtx('addPollingDevice')
    const ctx = this.ctx!
    const tid = nextTid++
    try {
      const nonce = await seedSignedMutation(
        ctx,
        authorityId,
        'vrg',
        tid,
        'select Digest(:tid, :authorityId, :deviceHash, :label) as d',
        { tid, authorityId, deviceHash, label: label ?? null },
        this.resolveSign(signatureOrCallback)
      )
      await ctx.db.exec(
        `insert into PollingDevice (AuthorityId, DeviceHash, Label)
         with context SigningNonce = :nonce, Tid = ${tid}
         values (:authorityId, :deviceHash, :label)`,
        { authorityId, deviceHash, label: label ?? null, nonce }
      )
    } catch (err) {
      this.rethrow(err, 'addPollingDevice')
    }
  }

  async removePollingDevice (
    authorityId: string,
    deviceHash: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    this.requireCtx('removePollingDevice')
    const ctx = this.ctx!
    const tid = nextTid++
    try {
      const nonce = await seedSignedMutation(
        ctx,
        authorityId,
        'vrg',
        tid,
        `select Digest(:tid, :authorityId, :deviceHash, 'delete') as d`,
        { tid, authorityId, deviceHash },
        this.resolveSign(signatureOrCallback)
      )
      await ctx.db.exec(
        `delete from PollingDevice
         with context SigningNonce = :nonce, Tid = ${tid}
         where AuthorityId = :authorityId and DeviceHash = :deviceHash`,
        { authorityId, deviceHash, nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removePollingDevice')
    }
  }

  async getPollingDevices (authorityId: string): Promise<PollingDevice[]> {
    if (!this.ctx) return []
    const out: PollingDevice[] = []
    try {
      for await (const row of this.ctx.db.eval(
        'select AuthorityId, DeviceHash, Label from PollingDevice where AuthorityId = :authorityId',
        { authorityId }
      )) {
        out.push({
          authorityId: row.AuthorityId as string,
          deviceHash: row.DeviceHash as string,
          label: (row.Label as string | null) ?? undefined
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPollingDevices')
    }
  }

  // ---------- helpers ----------

  /**
   * D-01/D-19: normalize the incoming `Signature | callback` param to a sign
   * callback for `seedSignedMutation` — the engine never holds a private key.
   * A caller-supplied completed `Signature` (test-fixture path) is wrapped in
   * a callback that just returns it; a callback param passes through as-is.
   */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return resolveSignHelper(signatureOrCallback)
  }

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'AuthorityConfigEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'AuthorityConfigEngine', method)
  }
}
