// Arguments, the seat-share file reader, the per-call approval and the refusal class of the keyholder
// verbs (`vt keyholder join|accept|dkg|release`). Replaces what the retired lean rig's keyholder driver took from
// its environment (the seat file path, the in-memory vault) and what main driver legAccept/legDkg/
// legRelease took from the process-wide `S_` state.
//
// Secrecy rules (CONTEXT "Secrecy"): the seat share is read by ABSOLUTE PATH from a 0600, owner-owned,
// regular, non-symlink file of at most 4096 bytes; it is never an argument value and never returned.
// An inline secret argument (`share`, `shareText`, `token`, `code`, `seat`, `invitePrivate`) is
// refused before any other check. A refusal message is fixed text plus, at most, an argument NAME
// and an unwrap count; never a value, a path, an id or engine text, and no engine `cause` is chained.
//
// Approval (CONTEXT "Approval without biometrics or attestation"): the token reaches a verb only per
// call. `tokenFile` (absolute path) gives a 67-13 context that re-reads the file on every token()
// call; a client-side `--token-env` / `--token-stdin` arrives as 67-26's `approvalToken` and goes
// through 67-26's `withCallApproval` (static context, zero-filled and disposed in a finally). With
// neither, the vault gets NO_APPROVAL, so the refusal is the vault's `auth-denied` at the FIRST
// token-gated operation, with no identity, DKG message or share release written. Nothing is cached
// across calls.

import { isAbsolute } from 'node:path'
import { hasCallApproval, withCallApproval } from '../../approval/call-approval.js'
import { NO_APPROVAL, createApprovalContext, type ApprovalContext } from '../../approval/token.js'
import { readPrivateFile } from '../../vault/private-file.js'

export type KeyholderVerb = 'join' | 'accept' | 'dkg' | 'release'

const CODE_RE = /^[a-z0-9-]{1,48}$/

/**
 * The one refusal class. Message: `keyholder <verb> refused (<code>)`, plus ` field=<argName>` for
 * `bad-args` with an allow-listed name, plus ` unwraps=<n>` once `measureUnwraps` attached the count
 * (a number, so a ctl caller can read the cost of a refusal from the error view). Never a value.
 */
export class KeyholderVerbError extends Error {
  readonly code: string
  readonly verb: KeyholderVerb
  readonly argName: string | undefined
  #unwraps: number | undefined

  constructor(verb: KeyholderVerb, code: string, opts: { argName?: string } = {}) {
    const argName = code === 'bad-args' && typeof opts.argName === 'string' && ARG_NAME_RE.test(opts.argName) ? opts.argName : undefined
    super(`keyholder ${verb} refused (${code})${argName !== undefined ? ` field=${argName}` : ''}`)
    this.name = 'KeyholderVerbError'
    this.verb = verb
    this.code = code
    this.argName = argName
  }

  /** The auth-prompt delta the refused call cost; set once by `measureUnwraps`, appended to the message. */
  get unwraps(): number | undefined {
    return this.#unwraps
  }

  set unwraps(n: number | undefined) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || this.#unwraps !== undefined) return
    this.#unwraps = n
    this.message = `${this.message} unwraps=${n}`
  }
}

/**
 * A structural read of `err.code` (never `instanceof`): a machine code matching `^[a-z0-9-]{1,48}$`
 * is kept; an InviteLookupTimeoutError (by name) is `lookup-timeout`; anything else is `unknown`.
 */
export function keyholderErrorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown'
  const e = err as { code?: unknown, name?: unknown }
  if (e.name === 'InviteLookupTimeoutError') return 'lookup-timeout'
  return typeof e.code === 'string' && CODE_RE.test(e.code) ? e.code : 'unknown'
}

// ---------------------------------------------------------------------------------------------
// Arguments

export type KeyholderArgKind = 'network' | 'election' | 'abs-path' | 'int' | 'text'

export interface KeyholderArgSpecEntry {
  kind: KeyholderArgKind
  required?: boolean
  /** `int` only. */
  min?: number
  max?: number
}

export type KeyholderArgSpec = Record<string, KeyholderArgSpecEntry>

export type ParsedKeyholderArgs<S extends KeyholderArgSpec> = {
  readonly [K in keyof S]: (S[K]['kind'] extends 'int' ? number : string) | undefined
}

/** Keys that would carry a secret inline; refused before any other check, whatever the verb. */
export const INLINE_SECRET_KEYS: readonly string[] = Object.freeze(['share', 'shareText', 'token', 'code', 'seat', 'invitePrivate'])

/** The colocation label the daemon strips; a direct caller may still pass it. Never copied out. */
const PEER_KEY = 'peer'
/** 67-26's per-call token value; read by `withCallApproval` from the request object, never copied. */
const TOKEN_VALUE_KEY = 'approvalToken'
const TOKEN_FILE_KEY = 'tokenFile'

const ARG_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/
const NETWORK_RE = /^[A-Za-z0-9_-]{8,128}$/
const ELECTION_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const DIGITS_RE = /^\d{1,12}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const MAX_PATH_CHARS = 4096
const MAX_TEXT_CHARS = 128

function badArgs(verb: KeyholderVerb, key: string): never {
  throw new KeyholderVerbError(verb, 'bad-args', { argName: key })
}

function parseInt10(verb: KeyholderVerb, key: string, v: unknown, e: KeyholderArgSpecEntry): number {
  let n: number
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) badArgs(verb, key)
    n = v
  } else if (typeof v === 'string' && DIGITS_RE.test(v)) {
    n = Number(v)
  } else {
    badArgs(verb, key)
  }
  if (e.min !== undefined && n < e.min) badArgs(verb, key)
  if (e.max !== undefined && n > e.max) badArgs(verb, key)
  return n
}

/**
 * Strict allow-listed parsing. Order: any inline-secret key -> `inline-secret-refused`; any other key
 * not in `spec` (except `peer`, and `approvalToken` on a spec that has `tokenFile`) -> `bad-args` with
 * the key named only when it is a plain identifier; then each spec entry is checked by kind:
 * `network` `^[A-Za-z0-9_-]{8,128}$`, `election` `^[A-Za-z0-9_.:-]{1,128}$`, `abs-path` (absolute,
 * at most 4096 chars, no NUL), `int` (a JS integer or a digit string, in range), `text` (1..128 chars,
 * no control chars). Returns a frozen typed object; `approvalToken` and `peer` are never copied.
 */
export function parseKeyholderArgs<S extends KeyholderArgSpec>(verb: KeyholderVerb, args: Record<string, unknown>, spec: S): ParsedKeyholderArgs<S> {
  const keys = Object.keys(args)
  for (const key of keys) if (INLINE_SECRET_KEYS.includes(key)) throw new KeyholderVerbError(verb, 'inline-secret-refused')
  const approvalClass = Object.hasOwn(spec, TOKEN_FILE_KEY)
  for (const key of keys) {
    if (key === PEER_KEY) continue
    if (key === TOKEN_VALUE_KEY && approvalClass) continue
    if (!Object.hasOwn(spec, key)) {
      if (ARG_NAME_RE.test(key)) badArgs(verb, key)
      throw new KeyholderVerbError(verb, 'bad-args')
    }
  }
  const out: Record<string, string | number | undefined> = {}
  for (const [key, entry] of Object.entries(spec)) {
    const v = Object.hasOwn(args, key) ? args[key] : undefined
    if (v === undefined) {
      if (entry.required === true) badArgs(verb, key)
      out[key] = undefined
      continue
    }
    switch (entry.kind) {
      case 'network':
        if (typeof v !== 'string' || !NETWORK_RE.test(v)) badArgs(verb, key)
        out[key] = v
        break
      case 'election':
        if (typeof v !== 'string' || !ELECTION_RE.test(v)) badArgs(verb, key)
        out[key] = v
        break
      case 'abs-path':
        if (typeof v !== 'string' || !isAbsolute(v) || v.length > MAX_PATH_CHARS || v.includes('\u0000')) badArgs(verb, key)
        out[key] = v
        break
      case 'text':
        if (typeof v !== 'string' || v.length === 0 || v.length > MAX_TEXT_CHARS || CONTROL_RE.test(v)) badArgs(verb, key)
        out[key] = v
        break
      case 'int':
        out[key] = parseInt10(verb, key, v, entry)
        break
      default: {
        const _exhaustive: never = entry.kind
        return _exhaustive
      }
    }
  }
  return Object.freeze(out) as ParsedKeyholderArgs<S>
}

// ---------------------------------------------------------------------------------------------
// The seat share file

export const MAX_SEAT_SHARE_BYTES = 4096

const SHARE_FILE_CODES: Readonly<Record<string, string>> = Object.freeze({
  mode: 'share-file-mode',
  owner: 'share-file-owner',
  'not-file': 'share-file-not-file',
  'too-large': 'share-file-size'
})

/**
 * Read the seat share text from `absPath` through 67-13's `readPrivateFile` (O_NOFOLLOW; mode, owner,
 * regular-file and size checked on the open fd). Refusals: `share-file-missing`, `share-file-mode`,
 * `share-file-owner`, `share-file-not-file`, `share-file-size`, `share-file-unreadable`, and
 * `share-file-empty` for a file that is blank after trimming. The buffer is zero-filled; no message
 * carries the path or the content.
 */
export function readSeatShareFile(verb: KeyholderVerb, absPath: string): string {
  if (typeof absPath !== 'string' || !isAbsolute(absPath)) badArgs(verb, 'shareFile')
  let buf: Buffer | null
  try {
    buf = readPrivateFile(absPath, { maxBytes: MAX_SEAT_SHARE_BYTES })
  } catch (e) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
    const mapped = typeof code === 'string' ? SHARE_FILE_CODES[code] : undefined
    throw new KeyholderVerbError(verb, mapped ?? 'share-file-unreadable')
  }
  if (buf === null) throw new KeyholderVerbError(verb, 'share-file-missing')
  const text = buf.toString('utf8').trim()
  buf.fill(0)
  if (text.length === 0) throw new KeyholderVerbError(verb, 'share-file-empty')
  return text
}

// ---------------------------------------------------------------------------------------------
// Approval, per call

export interface KeyholderApproval {
  approval: ApprovalContext
  source: 'none' | 'file'
}

/**
 * No `tokenFile` -> NO_APPROVAL (the vault refuses `auth-denied` at its first token-gated operation);
 * a non-absolute one -> `bad-args field=tokenFile`; an absolute one -> a context that re-reads the file
 * on EVERY token() call. The token is not read here and nothing is cached across calls.
 */
export function approvalFromArgs(verb: KeyholderVerb, tokenFile: unknown): KeyholderApproval {
  if (tokenFile === undefined || tokenFile === null) return { approval: NO_APPROVAL, source: 'none' }
  if (typeof tokenFile !== 'string' || !isAbsolute(tokenFile) || tokenFile.length > MAX_PATH_CHARS || tokenFile.includes('\u0000')) badArgs(verb, TOKEN_FILE_KEY)
  return { approval: createApprovalContext({ file: tokenFile }), source: 'file' }
}

/**
 * Run `fn` with this call's approval: an `approvalToken` (67-26's client transport for --token-env /
 * --token-stdin) goes through 67-26's `withCallApproval` (static context, disposed in a finally; both
 * keys -> its `token-ambiguous`); a `tokenFile` alone -> `approvalFromArgs`; neither -> NO_APPROVAL.
 */
export function withKeyholderApproval<T>(verb: KeyholderVerb, args: Record<string, unknown>, fn: (approval: ApprovalContext) => Promise<T>): Promise<T> {
  if (Object.hasOwn(args, TOKEN_VALUE_KEY) || !hasCallApproval(args)) {
    if (!hasCallApproval(args)) return fn(NO_APPROVAL)
    return withCallApproval(args, fn)
  }
  return fn(approvalFromArgs(verb, args[TOKEN_FILE_KEY]).approval)
}
