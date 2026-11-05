import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import type { EngineContext } from '../types.js'
import { digestToBytes, fromCanonicalDatetime, inviteResultSignedBytes, nowCanonicalDatetime, toCanonicalDatetime, verifyAdHocInviteSignature } from '../utils.js'
import { allocateTid } from '../database/tid-allocator.js'
import { readInviteChain } from './read-invite-chain.js'
import { withInviteWriteSerial } from './invite-write-serial.js'
import type {
  IInvitationEngine,
  InviteSlotResolution,
  InviteStatus,
  SentOfficerInvite,
  SentAuthorityInvite,
  SentKeyholderInvite,
  KeyholderAcceptProvisioning,
  KeyholderSlotSeat,
  InviteType,
} from '@votetorrent/vote-core'

/** An Error carrying a stable string `code` the app routes on (rethrow keeps it across the engine boundary). */
function coded (message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Real InvitationEngine — Phase 15 (D-08 / SWAP-04).
 *
 * Reads InviteSlot and InviteResult rows from the shared EngineContext
 * database. The write-side (`respondToInvite`) writes the local
 * InviteResult under the secp256k1 invite-signing pipeline (D-08).
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
   * Resolve an invitee's share to its InviteSlot chain and report its state. A resend inserts a second
   * InviteSlot with the same InviteKey and Type, so the share maps to a CHAIN of rows; the newest row
   * (the head) is the one to accept and the head decides liveness (a cancelled or expired head closes
   * the share, with no fall-back to an older row). A non-head cancellation strictly later than the
   * head's resend time also closes it (backstop for markers not written by
   * AuthorityEngine.cancelInvite). See `InviteSlotResolution` for the precedence rules and CR-01 /
   * CR-02 in 62-REVIEW.md for the reasoning.
   */
  async resolveInviteSlot (inviteKey: string, type: InviteType): Promise<InviteSlotResolution> {
    try {
      return await readInviteChain(this.ctx.db, inviteKey, type, nowCanonicalDatetime())
    } catch (err) {
      this.rethrow(err, 'resolveInviteSlot')
    }
  }

  /**
   * Resolve the InviteSlot Cid for an invitee's share by (InviteKey, Type): the chain head's Cid only
   * when the share is live, otherwise undefined (fail closed).
   */
  async resolveInviteSlotCid (inviteKey: string, type: InviteType): Promise<string | undefined> {
    const resolution = await this.resolveInviteSlot(inviteKey, type)
    return resolution.status === 'live' ? resolution.cid : undefined
  }

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
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)
           AND Expiration > :now`,
        { now: nowCanonicalDatetime() }
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
           AND NOT EXISTS (SELECT 1 FROM InviteResult IR WHERE IR.SlotCid = Cid)
           AND Expiration > :now`,
        { now: nowCanonicalDatetime() }
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
   * Accept or decline an invitation, writing a real local InviteResult row.
   *
   * INV-04 (accept): writes InviteResult with IsAccepted=true, non-null Digest,
   * and a real ephemeral-key InviteSignature over H(SlotCid, Digest, true).
   *
   * INV-05 / D-09 (signed decline): writes InviteResult with IsAccepted=false,
   * Digest=null, and a REAL ephemeral-key InviteSignature over H(SlotCid, null, false).
   * A decline is a cryptographically authenticated "no" — not a bare flag.
   *
   * InviteSignature byte form (A1 LOCKED — do not deviate):
   *   signedBytes = TextEncoder.encode([slotCid, digestToken, String(accept)].join('|'))
   *   sig = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))
   *   — noble v2 defaults (prehash:true); NEVER { prehash: false }
   *   where digestToken = digest for accept, 'null' for decline
   *
   * CR-01 / CR-02 (62-REVIEW.md): the slot must be the LIVE HEAD of its invitation's resend
   * chain; a cancelled, expired, superseded or already-answered slot is refused before any
   * signing prompt and before any write.
   *
   * The device user's private key MUST NOT enter this method (T-21-04-05).
   * Only the ephemeral one-time invite key (from D-06 paste) is permitted, and it is REQUIRED
   * (gap7/WR-05): without a well-formed key the call throws code `invite-key-required` before any
   * read; a key that does not verify against the slot's InviteKey throws `invite-signature-invalid`
   * before the keyholder binding signature and before any write. Refusals of a slot that is not the
   * live head carry codes: invite-already-answered, invite-no-longer-valid, invite-superseded,
   * invite-unverifiable.
   *
   * Phase-22 cross-device P2P transport: disabled boundary (D-08). The
   * cross-device "send over network" hop is deferred to the P2P transport
   * phase. Only the local InviteResult write is real in this phase.
   *
   * 62-02 (D-21, D-26): a Type 'k' (keyholder) ACCEPT is now ATOMIC and requires `keyholder`
   * provisioning. `InviteResult`, the fresh `User` (D-21: never the officer's identity), its
   * `UserKey` (the provisioned signing key), the `Keyholder` row and the signed
   * `KeyholderDkgBinding` row (D-26) are all written inside ONE `BEGIN`/`COMMIT` — a failed accept
   * leaves no orphan row behind (the 62-09 crossnote's non-atomicity is fixed). `keyholder.sign` is
   * called BEFORE the transaction opens (never hold a transaction open across a signing prompt);
   * the returned `signerKey` is verified against `keyholder.signingKey.key` before anything is
   * written. gap6/WR-09: a 'k' ACCEPT whose inviting officer (AdminSigning.UserId for the slot's
   * SigningNonce) is ctx.user is refused with code `self-invite`, before the binding signature and
   * again inside the transaction (user decision 8b: no override). Residuals - a colluding officer
   * with a second device, and co-signing officers (only the initiator is checked) - are recorded in
   * 62-SECURITY.md. Decline and every non-'k' accept are UNCHANGED (single InviteResult write, no
   * transaction). INTERIM STATE: the Authority keyholder-accept screen does not yet pass
   * provisioning (62-26 wires it), so a real keyholder accept in the app fails closed with the
   * message thrown below — by design, not a bug.
   */
  async respondToInvite (
    invitationId: string,
    accept: boolean,
    invitePrivate: string,
    digest?: string,
    invokedId?: string,
    keyholder?: KeyholderAcceptProvisioning,
  ): Promise<void> {
    // invitationId is the InviteSlot Cid in the thin IInvitationEngine surface
    // (as used by the accept/decline screens per D-06 paste flow).
    const slotCid = invitationId

    // gap7/WR-05: an invitation is answered only by whoever holds its one-time key. Refused before
    // any read, signing prompt or write; there is no keyless path.
    if (typeof invitePrivate !== 'string' || !/^[0-9a-fA-F]{64}$/.test(invitePrivate)) {
      throw coded('An invitation key is required to answer an invitation', 'invite-key-required')
    }

    try {
      // Step 1: Resolve the slot to confirm it exists (fail fast with a clear error).
      // InviteKey is also read here (999.1 R-03) — it is the verifying key for the
      // engine-side InviteResult.InviteSignature check below. Type/Name/ElectionId/
      // InviteSignature (of the InviteSlot itself) are read for the keyholder
      // accept-time User+Keyholder minting below (second-keyholder-invite-unique fix).
      const slotRow = await this.ctx.db
        .prepare('SELECT Cid, InviteKey, Type, Name, ElectionId, InviteSignature, SigningNonce FROM InviteSlot WHERE Cid = :slotCid')
        .get({ slotCid }) as {
          Cid: string
          InviteKey: string
          Type: string
          Name: string
          ElectionId: string | null
          InviteSignature: string | null
          SigningNonce: string
        } | undefined
      if (!slotRow) {
        throw new Error(`InviteSlot not found for Cid: ${slotCid}`)
      }

      // CR-01 / CR-02 (62-REVIEW.md): the slot must be the LIVE HEAD of its invitation's resend
      // chain. Checked here, before the keyholder provisioning is validated or signed and before
      // any write, with the same rule resolveInviteSlot uses.
      await this.assertSlotIsLiveHead(slotRow)

      // gap6/WR-09 (user decision 8b: no override): the officer who sent a keyholder invitation
      // cannot take its seat on their own device. Refused before the binding signature.
      if (accept && slotRow.Type === 'k') await this.assertNotSelfInvite(slotRow.SigningNonce)

      // second-keyholder-invite-unique fix: an accepted keyholder ('k') invite mints a
      // NEW User (there is no existing identity for a name-only invitee pre-acceptance)
      // — reserve its id up front, mirroring NetworkEngine.respondToInvite's authority-
      // invite id reservation, so the same id can be persisted into
      // InviteResult.InvokedId AND used for the User/Keyholder INSERTs below.
      const isKeyholderAccept = accept && slotRow.Type === 'k'
      const mintedUserId = isKeyholderAccept ? (invokedId ?? crypto.randomUUID()) : undefined

      // Step 2: Determine Digest column value.
      // Accept (INV-04): Digest must be non-null (DigestValid schema constraint).
      //   Use the caller-supplied digest if provided; otherwise fall back to a
      //   content-addressed placeholder (the slotCid suffices for test / offline paths).
      // Decline (INV-05): Digest must be null (DigestValid: not IsAccepted => Digest is null).
      const digestValue = accept
        ? (digest ?? slotCid)  // non-null for accept; caller-supplied or placeholder
        : null                  // must be null for decline — schema DigestValid enforces this

      // Step 3: Determine the digest TOKEN for the signed payload.
      // The signed token for decline is the LITERAL string 'null' (not empty string, not undefined)
      // so that the pipe-join arity stays stable — matching the A1 LOCKED encoding from
      // plan 21-02's <a1_resolution> and the decline test fixture.
      const digestToken = digestValue ?? 'null'

      // Step 4: Produce the ephemeral-key InviteSignature (A1 LOCKED encoding) with the invite
      // key from the pasted share (D-06). SECURITY: the device user's private key MUST NOT be
      // passed here (T-21-04-05).
      const invitePrivBytes = hexToBytes(invitePrivate)

      // A1 LOCKED ENCODING (verbatim from plan 21-02 <a1_resolution>):
      //   signedBytes = TextEncoder.encode([slotCid, digestToken, String(accept)].join('|'))
      //   sig = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))
      //   noble v2 defaults: prehash:true means actual signed domain = sha256(sha256(signedBytes))
      //   NEVER pass { prehash: false } — WR-10
      const signedBytes = inviteResultSignedBytes({ slotCid, digestToken, accept })
      const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivBytes))

      // 999.1 R-03 / gap7/WR-05: verify engine-side against the exact A1 LOCKED byte domain above
      // (NOT SQL Digest() — Pitfall 2), using the slot's own InviteKey. A key that is not the
      // slot's is refused here, before the keyholder binding signature and before any write.
      if (!verifyAdHocInviteSignature(signedBytes, inviteSignature, slotRow.InviteKey)) {
        throw coded('The invitation key does not match this invitation', 'invite-signature-invalid')
      }
      const isSignatureValid = true

      // 62-02 (D-21, D-26): a Type 'k' accept needs provisioning validated and its binding
      // digest signed BEFORE anything is written — never hold a transaction open across a
      // signing prompt, and never write a partial accept for a provisioning that turns out to
      // be malformed or falsely attributed.
      let keyholderWrite: {
        electionId: string
        revision: number
        boundAt: string
        bindingSignature: string
        userId: string
      } | undefined

      if (isKeyholderAccept) {
        if (!keyholder || !mintedUserId) {
          throw new Error(
            'Accepting a keyholder invitation needs a keyholder signing key and a key-generation receiving key, and none was provided'
          )
        }
        const keyholderUserId = mintedUserId
        if (
          typeof keyholder.dkgPublicKey !== 'string' ||
          keyholder.dkgPublicKey.length !== 66 ||
          !/^(02|03)[0-9a-f]{64}$/.test(keyholder.dkgPublicKey)
        ) {
          throw new Error('respondToInvite: keyholder.dkgPublicKey must be a 66-char lowercase hex compressed secp256k1 point (02/03 prefix)')
        }
        if (keyholder.signingKey.type !== 'M' && keyholder.signingKey.type !== 'P') {
          throw new Error(`respondToInvite: keyholder.signingKey.type must be 'M' or 'P' (got ${String(keyholder.signingKey.type)})`)
        }
        if (!slotRow.ElectionId) {
          throw new Error(`respondToInvite: keyholder InviteSlot ${slotCid} has no ElectionId`)
        }
        const revRow = await this.ctx.db
          .prepare('SELECT Revision FROM ElectionRevision WHERE ElectionId = :electionId')
          .get({ electionId: slotRow.ElectionId }) as { Revision: number } | undefined
        if (!revRow) {
          throw new Error(`respondToInvite: no ElectionRevision found for election ${slotRow.ElectionId}`)
        }

        const boundAt = new Date().toISOString()
        const bindingDigestRow = await this.ctx.db
          .prepare(
            "select Digest('KeyholderDkgBinding', :electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt) as d"
          )
          .get({
            electionId: slotRow.ElectionId,
            revision: revRow.Revision,
            userId: keyholderUserId,
            inviteSlotCid: slotCid,
            dkgPublicKey: keyholder.dkgPublicKey,
            boundAt,
          })
        if (!bindingDigestRow || bindingDigestRow.d == null) {
          throw new Error('respondToInvite: Digest() returned null for KeyholderDkgBinding — crypto plugin not registered?')
        }
        const bindingSig = await keyholder.sign(digestToBytes(bindingDigestRow.d as string))
        if (bindingSig.signerKey !== keyholder.signingKey.key) {
          throw new Error('respondToInvite: keyholder.sign() returned a signerKey that does not match keyholder.signingKey.key')
        }
        keyholderWrite = {
          electionId: slotRow.ElectionId,
          revision: revRow.Revision,
          boundAt,
          bindingSignature: bindingSig.signature,
          userId: keyholderUserId,
        }
      }

      // Step 5: write InviteResult (mirrors network-engine.ts:1046-1060, non-authority branch).
      // The AdminSigning row was already committed by saveInviteWithSigning on the send side —
      // this is the receive-side local write only. A keyholder accept wraps this in the SAME
      // transaction as the User/UserKey/Keyholder/KeyholderDkgBinding inserts below (D-26
      // lockstep); every other accept/decline keeps the pre-62-02 single-statement shape.
      const inviteResultSql = `insert into InviteResult (
          SlotCid,
          IsAccepted,
          Digest,
          InviteSignature,
          InvokedId
        )
        with context IsSigningValid = true, IsSignatureValid = :isSignatureValid
        values (
          :slotCid,
          :isAccepted,
          :digest,
          :inviteSignature,
          :invokedId
        )`
      const inviteResultParams = {
        slotCid,
        isAccepted: accept,
        digest: digestValue,
        inviteSignature,
        invokedId: mintedUserId ?? invokedId ?? null,
        isSignatureValid,
      }

      if (!keyholderWrite) {
        // gap7/IN-04: liveness is re-checked and the InviteResult inserted inside ONE transaction,
        // serialized per database, so a result (or cancellation) landing between the earlier read and
        // this write is refused instead of double-written.
        await withInviteWriteSerial(this.ctx.db, async () => {
          await this.ctx.db.exec('BEGIN')
          try {
            await this.assertSlotIsLiveHead(slotRow)
            await this.ctx.db.exec(inviteResultSql, inviteResultParams)
            await this.ctx.db.exec('COMMIT')
          } catch (innerErr) {
            try {
              await this.ctx.db.exec('ROLLBACK')
            } catch {
              // already rolled back by the failed statement — ignore, the original error is what matters.
            }
            throw innerErr
          }
        })

        // Phase-22 boundary (D-08): cross-device P2P network send is deferred.
        // The local InviteResult write above is the only real action this phase.
        // Transport-level authenticity for the cross-device exchange will be
        // implemented in the P2P transport phase.
        return
      }

      // D-21/D-26 atomic keyholder accept: InviteResult + User + UserKey + Keyholder +
      // KeyholderDkgBinding, all in ONE BEGIN/COMMIT, so a failed accept (e.g. an invokedId
      // collision on User) leaves ZERO rows behind — fixing the 62-09 crossnote's documented
      // non-atomicity (a failed mint used to orphan the InviteResult write).
      // Per-keyholder namespace: each keyholder's device writes ONLY its own TidHighWater row. A shared
      // 'user' row is a primary key two replicas upsert from stale views, so the second keyholder's
      // accept could be refused (same shape as KeyReleaseEngine.seedReleaseKeyTasks' keys-tasks row).
      const tid = await allocateTid(this.ctx.db, `user:${keyholderWrite.userId}`)
      await withInviteWriteSerial(this.ctx.db, async () => {
        await this.ctx.db.exec('BEGIN')
        try {
          // A cancellation can land while the signing prompt was open: re-check first thing inside
          // the transaction (the catch below rolls back). Residual: InviteResult rows replicated from
          // another device are not re-validated against cancellation (P2P concern, tier-2 engine
          // control, not schema).
          await this.assertSlotIsLiveHead(slotRow)
          // The identity can change while the signing prompt is open: check again inside the transaction.
          await this.assertNotSelfInvite(slotRow.SigningNonce)
          await this.ctx.db.exec(inviteResultSql, inviteResultParams)

            await this.ctx.db.exec(
              `insert into User (
                Id,
                Name,
                ImageRef
              )
              with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :userInviteSignature, Tid = ${tid}
              values (:userId, :userName, null)`,
              {
                inviteSlotCid: slotCid,
                userInviteSignature: slotRow.InviteSignature,
                userId: keyholderWrite.userId,
                userName: slotRow.Name,
              }
            )

            // D-21: a fresh identity's ONLY key is the caller-provisioned keyholder signing key —
            // the bootstrap UserKey context form (never the officer's key, never SignatureValid-
            // checked beyond the bootstrap branch), mirroring NetworksEngine.create's founding key.
            await this.ctx.db.exec(
              `insert into UserKey (
                UserId,
                Type,
                PubKey,
                Expiration
              )
              with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
              values (:userId, :keyType, :keyValue, :expiration)`,
              {
                userId: keyholderWrite.userId,
                keyType: keyholder!.signingKey.type,
                keyValue: keyholder!.signingKey.key,
                expiration: toCanonicalDatetime(keyholder!.signingKey.expiration),
                now: nowCanonicalDatetime(),
              }
            )

            await this.ctx.db.exec(
              `insert into Keyholder (
                ElectionId,
                ElectionRevision,
                UserId
              )
              with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
              values (:electionId, :revision, :userId)`,
              { electionId: keyholderWrite.electionId, revision: keyholderWrite.revision, userId: keyholderWrite.userId }
            )

            await this.ctx.db.exec(
              `insert into KeyholderDkgBinding (
                ElectionId,
                ElectionRevision,
                UserId,
                InviteSlotCid,
                DkgPublicKey,
                BoundAt,
                SignerKey,
                Signature
              )
              values (:electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt, :signerKey, :signature)`,
              {
                electionId: keyholderWrite.electionId,
                revision: keyholderWrite.revision,
                userId: keyholderWrite.userId,
                inviteSlotCid: slotCid,
                dkgPublicKey: keyholder!.dkgPublicKey,
                boundAt: keyholderWrite.boundAt,
                signerKey: keyholder!.signingKey.key,
                signature: keyholderWrite.bindingSignature,
              }
            )

          await this.ctx.db.exec('COMMIT')
        } catch (innerErr) {
          try {
            await this.ctx.db.exec('ROLLBACK')
          } catch {
            // already rolled back by the failed statement — ignore, the original error is what matters.
          }
          throw innerErr
        }
      })

    } catch (err) {
      this.rethrow(err, 'respondToInvite')
    }
  }

  /**
   * Seat facts for a keyholder ('k') slot, so the app can refuse before any biometric prompt:
   * the election the seat belongs to and whether the caller's officer sent it (selfInvite).
   * undefined for any other slot type, a slot without an election, or an unknown cid. The engine's
   * respondToInvite remains the authority.
   */
  async getKeyholderSlotSeat (slotCid: string): Promise<KeyholderSlotSeat | undefined> {
    try {
      const row = await this.ctx.db
        .prepare('SELECT Type, ElectionId, SigningNonce FROM InviteSlot WHERE Cid = :slotCid')
        .get({ slotCid }) as { Type: string, ElectionId: string | null, SigningNonce: string } | undefined
      if (!row || row.Type !== 'k' || !row.ElectionId) return undefined
      const invitedBy = await this.invitedBy(row.SigningNonce)
      const me = this.ctx.user?.id
      return { electionId: row.ElectionId, selfInvite: me !== undefined && invitedBy !== undefined && me === invitedBy }
    } catch (err) {
      this.rethrow(err, 'getKeyholderSlotSeat')
    }
  }

  // ---------- helpers ----------

  /** The officer who started the signing session behind a slot (AdminSigning.UserId), if known. */
  private async invitedBy (signingNonce: string): Promise<string | undefined> {
    const row = await this.ctx.db
      .prepare('SELECT UserId FROM AdminSigning WHERE Nonce = :nonce')
      .get({ nonce: signingNonce }) as { UserId: string } | undefined
    return row?.UserId
  }

  /** gap6/WR-09: throws code `self-invite` when ctx.user is the officer who sent the slot. */
  private async assertNotSelfInvite (signingNonce: string): Promise<void> {
    const me = this.ctx.user?.id
    if (me === undefined) return
    if (me === await this.invitedBy(signingNonce)) {
      throw coded('The officer who sent a keyholder invitation cannot accept it', 'self-invite')
    }
  }

  /** Throws a fixed, identifier-free message unless `slot` is the live head of its invitation's chain. */
  private async assertSlotIsLiveHead (slot: { Cid: string, InviteKey: string, Type: string, SigningNonce: string }): Promise<void> {
    const chain = await readInviteChain(this.ctx.db, slot.InviteKey, slot.Type, nowCanonicalDatetime(), slot.SigningNonce)
    if (chain.status === 'live' && chain.cid === slot.Cid) return
    switch (chain.status) {
      case 'answered':
        throw coded('This invitation has already been answered', 'invite-already-answered')
      case 'no-longer-valid':
        throw coded('This invitation was withdrawn or has expired', 'invite-no-longer-valid')
      case 'live':
        throw coded('This invitation was replaced by a newer copy', 'invite-superseded')
      default:
        throw coded('This invitation cannot be verified on this device', 'invite-unverifiable')
    }
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'InvitationEngine', method)
  }
}
