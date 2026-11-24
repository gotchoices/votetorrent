// The approval token: the user-presence stand-in for the vt CLI. A 256-bit random value written 0600
// once, and read afresh per approval-class action from a file, an env var or stdin. Nothing here
// caches a token across calls, logs one, or puts one (or a path) into an error message: every
// ApprovalTokenError reads `approval token refused (<code>, <source kind>)` and nothing more.

import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { PrivateFileError, createPrivateFileOnce, ensurePrivateDir, readPrivateFile } from '../vault/private-file.js'

/** Token length in bytes: 256 bits of entropy. */
export const APPROVAL_TOKEN_BYTES = 32
/** The env var the vt client reads by default. Reference the constant; never re-type its value elsewhere. */
export const APPROVAL_TOKEN_ENV = 'VT_APPROVAL_TOKEN'

/** Longest decoded token accepted (a 512-bit value); longer text is malformed, not a bigger token. */
const MAX_TOKEN_BYTES = 64
/** Longest token text accepted from any source, in characters (file bytes). */
const MAX_TOKEN_TEXT_CHARS = 1024

export type ApprovalTokenErrorCode =
  | 'token-absent'
  | 'token-mode'
  | 'token-owner'
  | 'token-not-file'
  | 'token-short'
  | 'token-format'
  | 'token-tty'
  | 'token-exists'

export type TokenSourceKind = 'file' | 'env' | 'stdin' | 'static' | 'none'

export class ApprovalTokenError extends Error {
  readonly code: ApprovalTokenErrorCode
  readonly source: TokenSourceKind

  constructor(code: ApprovalTokenErrorCode, source: TokenSourceKind) {
    super(`approval token refused (${code}, ${source})`)
    this.name = 'ApprovalTokenError'
    this.code = code
    this.source = source
  }
}

export type TokenSource = { file: string } | { env: string } | { stdin: true, stream?: Readable }

export interface ReadApprovalTokenOptions {
  /** The uid a token FILE must belong to; defaults to the current process uid. */
  readonly expectedUid?: number
}

/** Called once per approval-class operation; the caller zero-fills what it receives. */
export interface ApprovalContext {
  token(): Promise<Uint8Array>
}

export interface StaticApprovalContext extends ApprovalContext {
  /** Zero-fills the held copy; afterwards `token()` rejects `token-absent`. */
  dispose(): void
}

/** 32 fresh random bytes as a plain Uint8Array (not a pooled Buffer slice). */
export function generateApprovalToken(): Uint8Array {
  const raw = randomBytes(APPROVAL_TOKEN_BYTES)
  const out = Uint8Array.from(raw)
  raw.fill(0)
  return out
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Writes `token` (or a fresh one) as padding-free base64url plus one newline, 0600, create-once in a
 * 0700 parent. An existing file throws `token-exists` and is left untouched. Returns nothing: the text
 * is never handed back.
 */
export function writeApprovalTokenFile(path: string, token?: Uint8Array): void {
  if (token !== undefined) {
    if (!(token instanceof Uint8Array)) throw new ApprovalTokenError('token-format', 'file')
    if (token.length < APPROVAL_TOKEN_BYTES) throw new ApprovalTokenError('token-short', 'file')
    if (token.length > MAX_TOKEN_BYTES) throw new ApprovalTokenError('token-format', 'file')
  }
  ensurePrivateDir(dirname(path))
  const bytes = token ?? generateApprovalToken()
  const text = `${encodeBase64Url(bytes)}\n`
  if (!createPrivateFileOnce(path, text)) throw new ApprovalTokenError('token-exists', 'file')
}

const HEX_RE = /^[0-9a-fA-F]+$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** Decodes trimmed hex or padding-free base64url token text into a fresh Uint8Array of 32..64 bytes. */
function decodeTokenText(raw: string, kind: TokenSourceKind): Uint8Array {
  const text = raw.trim()
  if (text.length === 0) throw new ApprovalTokenError('token-absent', kind)
  if (text.length > MAX_TOKEN_TEXT_CHARS) throw new ApprovalTokenError('token-format', kind)
  let decoded: Buffer
  if (text.length % 2 === 0 && HEX_RE.test(text)) {
    decoded = Buffer.from(text, 'hex')
  } else if (BASE64URL_RE.test(text) && text.length % 4 !== 1) {
    decoded = Buffer.from(text, 'base64url')
  } else {
    throw new ApprovalTokenError('token-format', kind)
  }
  try {
    if (decoded.length < APPROVAL_TOKEN_BYTES) throw new ApprovalTokenError('token-short', kind)
    if (decoded.length > MAX_TOKEN_BYTES) throw new ApprovalTokenError('token-format', kind)
    return Uint8Array.from(decoded)
  } finally {
    decoded.fill(0)
  }
}

function mapPrivateFileError(e: unknown): ApprovalTokenError | undefined {
  const err = e as { name?: unknown, code?: unknown } | undefined
  if (err?.name !== 'PrivateFileError') return undefined
  switch (err.code as PrivateFileError['code']) {
    case 'mode':
      return new ApprovalTokenError('token-mode', 'file')
    case 'owner':
      return new ApprovalTokenError('token-owner', 'file')
    case 'not-file':
      return new ApprovalTokenError('token-not-file', 'file')
    case 'too-large':
      return new ApprovalTokenError('token-format', 'file')
    default:
      return undefined
  }
}

function readTokenFile(path: string, expectedUid: number | undefined): Uint8Array {
  let data: Buffer | null
  try {
    data = readPrivateFile(path, { maxBytes: MAX_TOKEN_TEXT_CHARS, expectedUid })
  } catch (e) {
    const mapped = mapPrivateFileError(e)
    if (mapped !== undefined) throw mapped
    throw e
  }
  if (data === null) throw new ApprovalTokenError('token-absent', 'file')
  try {
    return decodeTokenText(data.toString('utf8'), 'file')
  } finally {
    data.fill(0)
  }
}

function readTokenEnv(name: string): Uint8Array {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new ApprovalTokenError('token-absent', 'env')
  return decodeTokenText(value, 'env')
}

async function readTokenStdin(stream: Readable): Promise<Uint8Array> {
  if ((stream as Readable & { isTTY?: boolean }).isTTY === true) throw new ApprovalTokenError('token-tty', 'stdin')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array)
    total += buf.length
    chunks.push(buf)
    if (total > MAX_TOKEN_TEXT_CHARS) {
      for (const c of chunks) c.fill(0)
      stream.destroy()
      throw new ApprovalTokenError('token-format', 'stdin')
    }
  }
  if (total === 0) throw new ApprovalTokenError('token-absent', 'stdin')
  const data = Buffer.concat(chunks, total)
  for (const c of chunks) c.fill(0)
  try {
    return decodeTokenText(data.toString('utf8'), 'stdin')
  } finally {
    data.fill(0)
  }
}

/** Reads and decodes a token from one source, afresh every call. Rejects with a coded ApprovalTokenError. */
export async function readApprovalToken(src: TokenSource, opts?: ReadApprovalTokenOptions): Promise<Uint8Array> {
  if ('file' in src) return readTokenFile(src.file, opts?.expectedUid)
  if ('env' in src) return readTokenEnv(src.env)
  return readTokenStdin(src.stream ?? process.stdin)
}

/** A context whose `token()` re-reads the source on EVERY call: nothing is cached across verbs. */
export function createApprovalContext(src: TokenSource, opts?: ReadApprovalTokenOptions): ApprovalContext {
  return {
    token: () => readApprovalToken(src, opts)
  }
}

/**
 * For the daemon, where the token arrives in one ctl request body: copies `bytes` at construction
 * (32..64 bytes, else `token-short` / `token-format`), hands out a fresh copy per `token()` call, and
 * `dispose()` zero-fills the held copy.
 */
export function createStaticApprovalContext(bytes: Uint8Array): StaticApprovalContext {
  if (!(bytes instanceof Uint8Array)) throw new ApprovalTokenError('token-format', 'static')
  if (bytes.length < APPROVAL_TOKEN_BYTES) throw new ApprovalTokenError('token-short', 'static')
  if (bytes.length > MAX_TOKEN_BYTES) throw new ApprovalTokenError('token-format', 'static')
  const held = Uint8Array.from(bytes)
  let disposed = false
  return {
    async token() {
      if (disposed) throw new ApprovalTokenError('token-absent', 'static')
      return Uint8Array.from(held)
    },
    dispose() {
      disposed = true
      held.fill(0)
    }
  }
}

/** The unattended daemon's context: `token()` always rejects `token-absent`. */
export const NO_APPROVAL: ApprovalContext = Object.freeze({
  async token(): Promise<Uint8Array> {
    throw new ApprovalTokenError('token-absent', 'none')
  }
})
