// Client-side approval token transport for `vt <role> <verb>`: the `--token-file <path>`,
// `--token-env` and `--token-stdin` flags (CONTEXT "Approval without biometrics or attestation": the
// token is presented PER CALL by file path, env var or stdin). Replaces the rig's single process-held
// signer and the retired JSON-RPC vote-cli's device key: the client never signs and never keeps a token.
//
//  - `--token-file` is resolved to an absolute path and NOT read here: the daemon reads it on every
//    token() call with its own mode/owner check (67-13 readApprovalToken).
//  - `--token-env` / `--token-stdin` are read through 67-13's decoder (trim, hex or base64url, 32..64
//    bytes) and sent once in the authenticated loopback body as base64url `approvalToken`; the decoded
//    bytes are zero-filled here and the flag key is removed. The env value is taken from the env object
//    the caller passes (never process.env directly), fed to the shared decoder as a stream, so the
//    decode rules are the same as every other source without mutating process.env.
//
// Accepted residual: the base64url string itself cannot be zeroed (threat T-67-26-04).

import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { APPROVAL_TOKEN_ENV, readApprovalToken } from '../approval/token.js'

export const APPROVAL_FLAG_KEYS = ['tokenFile', 'tokenEnv', 'tokenStdin'] as const

export type ApprovalTransportCode =
  | 'token-ambiguous'
  | 'token-flag-shape'
  | 'token-absent'
  | 'token-mode'
  | 'token-owner'
  | 'token-not-file'
  | 'token-short'
  | 'token-format'
  | 'token-tty'
  | 'token-exists'

export interface ApprovalTransportIo {
  env: NodeJS.ProcessEnv
  stdin: Readable
  cwd: string
}

export type AttachApprovalTokenResult = { ok: true, args: Record<string, unknown> } | { ok: false, code: ApprovalTransportCode }

function tokenErrorCode(e: unknown): ApprovalTransportCode | undefined {
  const err = e as { name?: unknown, code?: unknown } | undefined
  if (err?.name !== 'ApprovalTokenError' || typeof err.code !== 'string') return undefined
  return err.code as ApprovalTransportCode
}

/**
 * Turn the approval flags into what the daemon takes: `tokenFile` (absolute) or `approvalToken`
 * (base64url). No source: the args pass through unchanged and the verb decides whether it needs a
 * token. Never mutates `args`; returns a copy.
 */
export async function attachApprovalToken(args: Record<string, unknown>, io: ApprovalTransportIo): Promise<AttachApprovalTokenResult> {
  const present = APPROVAL_FLAG_KEYS.filter((k) => Object.hasOwn(args, k))
  if (present.length > 1) return { ok: false, code: 'token-ambiguous' }
  const out: Record<string, unknown> = { ...args }
  if (present.length === 0) return { ok: true, args: out }
  const key = present[0]!
  const value = args[key]
  if (key === 'tokenFile') {
    if (typeof value !== 'string') return { ok: false, code: 'token-flag-shape' }
    out.tokenFile = resolve(io.cwd, value)
    return { ok: true, args: out }
  }
  if (value !== true) return { ok: false, code: 'token-flag-shape' }
  let bytes: Uint8Array
  try {
    if (key === 'tokenEnv') {
      const text = io.env[APPROVAL_TOKEN_ENV]
      if (text === undefined || text.length === 0) return { ok: false, code: 'token-absent' }
      bytes = await readApprovalToken({ stdin: true, stream: Readable.from([text]) })
    } else {
      bytes = await readApprovalToken({ stdin: true, stream: io.stdin })
    }
  } catch (e) {
    const code = tokenErrorCode(e)
    if (code !== undefined) return { ok: false, code }
    throw e
  }
  out.approvalToken = Buffer.from(bytes).toString('base64url')
  bytes.fill(0)
  delete out[key]
  return { ok: true, args: out }
}
