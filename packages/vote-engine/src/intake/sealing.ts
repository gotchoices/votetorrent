// src/intake/sealing.ts — Phase 62 Plan 14 (D-03, D-04)
//
// The requester-side sealer and the officer-side opener, both structural
// ports 62-15 injects into the P2P transports. Neither this file nor its
// consumers ever persist, cache or log the opened plaintext (see
// types.ts's header for the full T-62-01-10 note).

import { bytesToUtf8 } from '@noble/ciphers/utils.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import {
  EnvelopeSealError,
  KeyVaultError,
  officerEncryptionKeyGenerationAlias,
  openEnvelope,
  sealToRecipients,
  serializeEnvelope
} from '../crypto/index.js'
import type { EnvelopeBinding, IKeyVault } from '../crypto/index.js'
import { listHeldOfficerKeyGenerations } from '../crypto/vault.js'
import { resolveIntakeRecipients } from './recipients.js'
import { IntakeError } from './types.js'
import type { IntakeOpener, IntakeOpenResult, IntakeSealer } from './types.js'
import type { IntakeQueryPort } from './query-port.js'

function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function vaultErrorDetail (err: unknown): string {
  return err instanceof KeyVaultError
    ? `createIntakeOpener.open: vault error (${err.code})`
    : 'createIntakeOpener.open: vault error'
}

function isValidBinding (binding: unknown): binding is EnvelopeBinding {
  if (binding === null || typeof binding !== 'object') return false
  const b = binding as Record<string, unknown>
  return isNonEmptyString(b.requestId) && isNonEmptyString(b.digest)
}

/**
 * D-03/D-04: resolves recipients on EVERY call (so an officer who registers
 * between two seals is a recipient of the NEXT one), then wraps the
 * plaintext for every one of them through 62-04's `sealToRecipients`. Zero
 * recipients is `IntakeError('no-recipients')` — there is no code path that
 * returns, stores or transmits the plaintext in that case.
 */
export function createIntakeSealer (options: { readonly port: IntakeQueryPort, readonly authorityId: string }): IntakeSealer {
  const { port, authorityId } = options
  return {
    authorityId,
    async seal (plaintext: string, binding: EnvelopeBinding): Promise<string> {
      if (!isNonEmptyString(plaintext)) {
        throw new IntakeError('invalid-argument', 'createIntakeSealer.seal: plaintext must be a non-empty string')
      }
      if (!isValidBinding(binding)) {
        throw new IntakeError('invalid-argument', 'createIntakeSealer.seal: binding must carry non-empty requestId and digest')
      }

      const recipientSet = await resolveIntakeRecipients(port, authorityId)
      if (recipientSet.recipients.length === 0) {
        throw new IntakeError(
          'no-recipients',
          `createIntakeSealer.seal: authority ${authorityId} has no intake recipients (${recipientSet.officersWithoutKey.length} current officer(s) without a usable key)`
        )
      }

      try {
        const envelope = sealToRecipients(utf8ToBytes(plaintext), recipientSet.recipients, binding)
        return serializeEnvelope(envelope)
      } catch (err) {
        if (err instanceof EnvelopeSealError) {
          if (err.code === 'no-recipients' || err.code === 'too-many-recipients') {
            throw new IntakeError(err.code, `createIntakeSealer.seal: ${err.code}`)
          }
          throw new IntakeError('seal-failed', `createIntakeSealer.seal: ${err.code}`)
        }
        throw new IntakeError('seal-failed', 'createIntakeSealer.seal: unexpected sealing failure')
      }
    }
  }
}

/**
 * D-03: the officer-side opener. Reads the officer's secret from the
 * injected `IKeyVault` and opens through 62-04's `openEnvelope`. NEVER
 * throws; the opened plaintext is returned to the caller in memory only —
 * this module never writes, caches or logs it (T-62-01-10 is referenced,
 * not widened: see types.ts's header).
 */
export function createIntakeOpener (options: { readonly vault: IKeyVault, readonly userId: string }): IntakeOpener {
  const { vault, userId } = options
  return {
    userId,
    async open (sealed: string, binding: EnvelopeBinding): Promise<IntakeOpenResult> {
      try {
        if (typeof sealed !== 'string' || sealed.length === 0) {
          return { ok: false, reason: 'invalid-argument', detail: 'createIntakeOpener.open: sealed must be a non-empty string' }
        }
        if (!isValidBinding(binding)) {
          return { ok: false, reason: 'invalid-argument', detail: 'createIntakeOpener.open: binding must carry non-empty requestId and digest' }
        }

        let generations: number[]
        try {
          generations = await listHeldOfficerKeyGenerations(vault, userId)
        } catch (err) {
          if (err instanceof KeyVaultError && err.code === 'invalid-alias') {
            return { ok: false, reason: 'invalid-argument', detail: 'createIntakeOpener.open: invalid userId' }
          }
          return { ok: false, reason: 'vault-error', detail: vaultErrorDetail(err) }
        }
        if (generations.length === 0) {
          return { ok: false, reason: 'no-local-key', detail: 'createIntakeOpener.open: no local key for this alias' }
        }

        // O-01/D-51: newest to oldest, so an envelope sealed before a key renewal still opens. The
        // NEWEST generation's failure is what a total miss reports.
        let newestFailure: IntakeOpenResult | undefined
        for (let i = generations.length - 1; i >= 0; i--) {
          let secretKey: Uint8Array | null
          try {
            secretKey = await vault.getSecret(officerEncryptionKeyGenerationAlias(userId, generations[i]!))
          } catch (err) {
            const failure: IntakeOpenResult = { ok: false, reason: 'vault-error', detail: vaultErrorDetail(err) }
            newestFailure ??= failure
            continue
          }
          if (secretKey === null) {
            newestFailure ??= { ok: false, reason: 'no-local-key', detail: 'createIntakeOpener.open: no local key for this alias' }
            continue
          }
          try {
            const result = openEnvelope(sealed, { userId, secretKey }, binding)
            if (result.ok) {
              const plaintext = bytesToUtf8(result.plaintext)
              // Best-effort zeroization only — not a security claim (bigint/JIT
              // copies may still survive outside these arrays).
              result.plaintext.fill(0)
              return { ok: true, plaintext }
            }
            newestFailure ??= result
          } finally {
            secretKey.fill(0)
          }
        }
        return newestFailure ?? { ok: false, reason: 'no-local-key', detail: 'createIntakeOpener.open: no local key for this alias' }
      } catch {
        return { ok: false, reason: 'authentication-failed', detail: 'createIntakeOpener.open: unexpected failure' }
      }
    }
  }
}
