// vote-record-seams.ts: the CLI's implementations of the Voter's platform seams for the vote record (phase 67
// plan 30): a VoteRecordWrapProvider that seals the record's data key with AES-256-GCM under the token-derived
// KEK (`keys.deriveTokenKey(token, CLI_VOTE_RECORD_WRAP_INFO)`, one `approval.token()` per wrap or unwrap), the
// four shared factories over the daemon's file kv and that provider, and a redacting VoteSendDebug sink.
// Replaces the lean rig's host voter record handling (the retired lean rig's host voter 907-1047) with
// the shared store, vault, receipt reader and sent store: no marker, guard, envelope or reveal logic is written
// here. Error codes use the native set: an absent or refused token is CANCELED, a wrong token on unwrap is
// UNWRAP_TAG_MISMATCH, anything else WRAP_FAILED / UNWRAP_FAILED. The token copy and the KEK are zero-filled.
// Messages carry the code only. No console (the sink's one stderr write excepted), no process.env, no instanceof.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { KvStorage, SecretWrapPrompt, VoteRecordWrapProvider, WrappedSecret } from '@votetorrent/workflows/platform'
import {
  createVoteReceiptReader,
  createVoteRecordStore,
  createVoteRecordVault,
  createVoteSentStore,
  voteRecordMatchesMarker,
  type VoteReceiptReader,
  type VoteRecordStore,
  type VoteRecordUnavailableReason,
  type VoteRecordVault,
  type VoteSendDebug,
  type VoteSentStoreWithNames
} from '@votetorrent/workflows/voter'
import type { ApprovalContext } from '../approval/token.js'

export const CLI_VOTE_RECORD_WRAP_KEY_ALIAS = 'vt.vote-record-wrap.v1'
export const CLI_VOTE_RECORD_WRAP_INFO = 'votetorrent/vote-cli/v1/kek/vote-record-wrap'

/** The vault's prompt guard needs non-empty copy; the CLI shows no prompt, the token stands in for it. */
export const CLI_VOTE_PROMPT: SecretWrapPrompt = Object.freeze({
  title: 'vt vote',
  subtitle: 'approval token in place of a biometric prompt',
  negativeButton: 'cancel'
})

export type VoteRecordWrapErrorCode = 'CANCELED' | 'INVALID_ARGUMENT' | 'UNWRAP_TAG_MISMATCH' | 'WRAP_FAILED' | 'UNWRAP_FAILED'

export class VoteRecordWrapError extends Error {
  readonly code: VoteRecordWrapErrorCode

  constructor (code: VoteRecordWrapErrorCode) {
    super(`vote record wrap refused (${code})`)
    this.name = 'VoteRecordWrapError'
    this.code = code
  }
}

/** The 67-13 device keys' token-derived KEK, the only member the provider reads. */
export interface TokenKeyDeriver {
  deriveTokenKey(token: Uint8Array, info: string): Buffer
}

export interface CliVoteRecordWrapProviderOptions {
  keys: TokenKeyDeriver
  approval: ApprovalContext
}

const IV_BYTES = 12
const TAG_BYTES = 16

function isWrapError (e: unknown): boolean {
  return (e as { name?: unknown } | null | undefined)?.name === 'VoteRecordWrapError'
}

/** A byte view (Uint8Array or Buffer), checked structurally. */
function isBytes (v: unknown): v is Uint8Array {
  return ArrayBuffer.isView(v) && (v as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1
}

export function createCliVoteRecordWrapProvider (options: CliVoteRecordWrapProviderOptions): VoteRecordWrapProvider {
  const { keys, approval } = options
  if (keys === null || typeof keys !== 'object' || typeof keys.deriveTokenKey !== 'function' || approval === null || typeof approval !== 'object' || typeof approval.token !== 'function') {
    throw new TypeError('vote record wrap provider options are required')
  }

  async function kekFor (): Promise<Buffer> {
    let token: Uint8Array
    try {
      token = await approval.token()
    } catch {
      throw new VoteRecordWrapError('CANCELED')
    }
    try {
      return keys.deriveTokenKey(token, CLI_VOTE_RECORD_WRAP_INFO)
    } finally {
      token.fill(0)
    }
  }

  return {
    async wrap (plaintext: Uint8Array, aad: Uint8Array): Promise<WrappedSecret> {
      if (!isBytes(plaintext) || plaintext.length === 0 || !isBytes(aad)) throw new VoteRecordWrapError('INVALID_ARGUMENT')
      const kek = await kekFor()
      try {
        const iv = randomBytes(IV_BYTES)
        const cipher = createCipheriv('aes-256-gcm', kek, iv)
        cipher.setAAD(aad)
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
        return {
          v: 1,
          alg: 'AES-256-GCM',
          keyAlias: CLI_VOTE_RECORD_WRAP_KEY_ALIAS,
          ivBase64: iv.toString('base64'),
          ciphertextBase64: ct.toString('base64'),
          securityLevel: 'software'
        }
      } catch (e) {
        if (isWrapError(e)) throw e
        throw new VoteRecordWrapError('WRAP_FAILED')
      } finally {
        kek.fill(0)
      }
    },
    async unwrap (wrapped: WrappedSecret, aad: Uint8Array): Promise<Uint8Array> {
      const w = wrapped as { v?: unknown, alg?: unknown, keyAlias?: unknown, ivBase64?: unknown, ciphertextBase64?: unknown } | null | undefined
      if (
        w === null || w === undefined || typeof w !== 'object' || w.v !== 1 || w.alg !== 'AES-256-GCM' || w.keyAlias !== CLI_VOTE_RECORD_WRAP_KEY_ALIAS ||
        typeof w.ivBase64 !== 'string' || typeof w.ciphertextBase64 !== 'string' || !isBytes(aad)
      ) {
        throw new VoteRecordWrapError('INVALID_ARGUMENT')
      }
      const iv = Buffer.from(w.ivBase64, 'base64')
      const ct = Buffer.from(w.ciphertextBase64, 'base64')
      if (iv.length !== IV_BYTES || ct.length <= TAG_BYTES) throw new VoteRecordWrapError('INVALID_ARGUMENT')
      const kek = await kekFor()
      try {
        const decipher = createDecipheriv('aes-256-gcm', kek, iv)
        decipher.setAAD(aad)
        decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
        let plain: Buffer
        try {
          plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()])
        } catch {
          throw new VoteRecordWrapError('UNWRAP_TAG_MISMATCH')
        }
        const out = Uint8Array.from(plain)
        plain.fill(0)
        return out
      } catch (e) {
        if (isWrapError(e)) throw e
        throw new VoteRecordWrapError('UNWRAP_FAILED')
      } finally {
        kek.fill(0)
      }
    }
  }
}

export interface CliVoteRecordPortsOptions {
  kv: KvStorage
  keys: TokenKeyDeriver
  approval: ApprovalContext
  debug: VoteSendDebug
}

export interface CliVoteRecordPorts {
  provider: VoteRecordWrapProvider
  store: VoteRecordStore
  vault: VoteRecordVault
  receipt: VoteReceiptReader
  sentStore: VoteSentStoreWithNames
}

/** The four shared factories over the daemon's kv and the CLI wrap provider; nothing of their logic lives here. */
export function createCliVoteRecordPorts (options: CliVoteRecordPortsOptions): CliVoteRecordPorts {
  const provider = createCliVoteRecordWrapProvider({ keys: options.keys, approval: options.approval })
  const store = createVoteRecordStore(options.kv)
  const vault = createVoteRecordVault({
    resolveWrapProvider: () => provider,
    readWrapErrorCode: (e) => (isWrapError(e) ? String((e as { code: unknown }).code) : null),
    wrapKeyAlias: CLI_VOTE_RECORD_WRAP_KEY_ALIAS
  })
  const receipt = createVoteReceiptReader({
    readVoteMarker: (id) => store.readVoteMarker(id),
    readSavedVote: (id, r) => store.readSavedVote(id, r),
    voteRecordMatchesMarker: (rec, m) => voteRecordMatchesMarker(rec, m),
    openVoteRecord: (id, env, o) => vault.openVoteRecord(id, env, o),
    unavailableReasonOf: (e) => {
      const err = e as { name?: unknown, reason?: unknown } | null | undefined
      return err?.name === 'VoteRecordUnavailableError' && typeof err.reason === 'string' ? (err.reason as VoteRecordUnavailableReason) : null
    }
  })
  const sentStore = createVoteSentStore(options.kv, options.debug)
  return { provider, store, vault, receipt, sentStore }
}

// ---------------------------------------------------------------------------------------------
// The redacting debug sink

const DROPPED_KEYS: ReadonlySet<string> = new Set(['message', 'stack', 'cause'])
const OPAQUE_RUN = /[0-9a-fA-F]{16,}|[A-Za-z0-9_-]{16,}/g
const LONG_STRING = 64
const PREFIX_CHARS = 8
const MAX_DEPTH = 3

function sanitiseString (s: string): string {
  if (s.length > LONG_STRING) return `len:${s.length}`
  return s.replace(OPAQUE_RUN, (run) => run.slice(0, PREFIX_CHARS))
}

function sanitiseValue (v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return sanitiseString(v)
  if (depth >= MAX_DEPTH) return '<dropped>'
  if (Array.isArray(v)) return v.map((x) => sanitiseValue(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(k) || x === undefined) continue
      out[k] = sanitiseValue(x, depth + 1)
    }
    return out
  }
  return '<dropped>'
}

/** The CLI's sink: one `VT-DEBUG <tag> <event> <json>` line per event, sanitised then redacted, on stderr. */
export function createRedactingVoteSendDebug (ctx: { redact(text: string): string }, write: (line: string) => void = (line) => { process.stderr.write(line) }): VoteSendDebug {
  return {
    vtDebug (tag, event, detail) {
      const json = JSON.stringify(sanitiseValue(detail ?? {}, 0))
      write(ctx.redact(`VT-DEBUG ${sanitiseString(String(tag))} ${sanitiseString(String(event))} ${json}`) + '\n')
    },
    idPrefix (id) {
      return typeof id === 'string' ? id.slice(0, PREFIX_CHARS) : typeof id
    }
  }
}
