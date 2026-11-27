// Verb-side per-call approval (PATTERNS: the client reads the token and sends it in the request body,
// or forwards a file path; the verb builds an ApprovalContext for the ONE call and drops it). Replaces
// the rig's process-wide officer signer (the retired lean rig's main driver `S_.officerSign`) and
// the retired JSON-RPC vote-cli's device-held key: here nothing outlives the call.
//
// Two sources, exactly one per call:
//  - `tokenFile` (absolute path): a 67-13 `createApprovalContext({ file })`, so the daemon re-reads the
//    file on EVERY token() call; a mode, owner or symlink fault surfaces later as the signer's
//    `token-refused`.
//  - `approvalToken` (base64url text from the client's --token-env / --token-stdin): decoded once into
//    a `createStaticApprovalContext` copy; the decode buffer is zero-filled, the key is deleted from the
//    args object, and `dispose()` runs in a finally, even when the verb throws.
//
// Accepted residual (threat T-67-26-04): the JS string carrying an env/stdin token cannot be zeroed; it
// lives for one request in the daemon heap of a single-user dev host. `--token-file` avoids it.

import { isAbsolute } from 'node:path'
import { createApprovalContext, createStaticApprovalContext, type ApprovalContext, type StaticApprovalContext } from './token.js'

export const CALL_APPROVAL_ARG_KEYS = ['tokenFile', 'approvalToken'] as const

export type ApprovalRefusalCode = 'token-absent' | 'token-ambiguous' | 'token-file-not-absolute' | 'token-refused'

export class ApprovalRefusal extends Error {
  readonly code: ApprovalRefusalCode

  constructor(code: ApprovalRefusalCode) {
    super(`approval refused (${code})`)
    this.name = 'ApprovalRefusal'
    this.code = code
  }
}

/** A base64url token of 32..64 bytes: 43..86 characters, no padding. */
const APPROVAL_TOKEN_RE = /^[A-Za-z0-9_-]{43,86}$/

/** True when the args carry either per-call approval key. */
export function hasCallApproval(args: Record<string, unknown>): boolean {
  return CALL_APPROVAL_ARG_KEYS.some((k) => Object.hasOwn(args, k))
}

function staticContextFrom(text: unknown): StaticApprovalContext {
  if (typeof text !== 'string' || !APPROVAL_TOKEN_RE.test(text)) throw new ApprovalRefusal('token-refused')
  const bytes = Buffer.from(text, 'base64url')
  try {
    return createStaticApprovalContext(bytes)
  } catch {
    throw new ApprovalRefusal('token-refused')
  } finally {
    bytes.fill(0)
  }
}

/**
 * Build the call's ApprovalContext from `args`, run `fn` with it, and drop it. Refusals, in order:
 * neither key -> `token-absent`; both -> `token-ambiguous`; a `tokenFile` that is not an absolute path
 * string -> `token-file-not-absolute`; an `approvalToken` that is not well-formed base64url of 32..64
 * bytes -> `token-refused`. `args.approvalToken` is deleted before `fn` runs.
 */
export async function withCallApproval<T>(args: Record<string, unknown>, fn: (approval: ApprovalContext) => Promise<T>): Promise<T> {
  const hasFile = Object.hasOwn(args, 'tokenFile')
  const hasToken = Object.hasOwn(args, 'approvalToken')
  if (!hasFile && !hasToken) throw new ApprovalRefusal('token-absent')
  if (hasFile && hasToken) throw new ApprovalRefusal('token-ambiguous')
  let approval: ApprovalContext
  let disposable: StaticApprovalContext | undefined
  if (hasFile) {
    const file = args.tokenFile
    if (typeof file !== 'string' || !isAbsolute(file)) throw new ApprovalRefusal('token-file-not-absolute')
    approval = createApprovalContext({ file })
  } else {
    disposable = staticContextFrom(args.approvalToken)
    delete args.approvalToken
    approval = disposable
  }
  try {
    return await fn(approval)
  } finally {
    disposable?.dispose()
  }
}
