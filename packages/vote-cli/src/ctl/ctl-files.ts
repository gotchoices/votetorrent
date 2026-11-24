// The ctl dir and its two files: a 0700 dir, 0600 files written by temp file + rename, a 256-bit token,
// and readers that refuse a token file another local user could read or swap. Errors carry a code only,
// never a path, so they can be logged as they are.

import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { CTL_PORT_FILE, CTL_TOKEN_FILE } from './protocol.js'

export type CtlSetupErrorCode = 'dir-symlink' | 'not-a-dir'

export class CtlSetupError extends Error {
  readonly code: CtlSetupErrorCode

  constructor(code: CtlSetupErrorCode) {
    super(`ctl dir: ${code}`)
    this.name = 'CtlSetupError'
    this.code = code
  }
}

export type CtlTokenReadCode = 'no-token-file' | 'token-symlink' | 'token-mode' | 'token-owner' | 'token-shape'
export type CtlPortReadCode = 'no-port-file' | 'port-shape'

const TOKEN_RE = /^[0-9a-f]{64}$/
const PORT_RE = /^\d{1,5}\n?$/

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** Creates the dir 0700 (or tightens an existing one); a symlink or a non-directory at the path is refused. */
export function ensurePrivateDir(dir: string): void {
  const st = lstatOrUndefined(dir)
  if (st !== undefined) {
    if (st.isSymbolicLink()) throw new CtlSetupError('dir-symlink')
    if (!st.isDirectory()) throw new CtlSetupError('not-a-dir')
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  // mkdir never tightens an existing dir, so always chmod.
  chmodSync(dir, 0o700)
}

/** Writes `<path>.tmp-<pid>-<hex>` with wx (refusing a planted file or symlink) at 0600, then renames it over `path`. */
export function writePrivateFileAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** 64 lowercase hex characters = 256 random bits; redact() already masks any hex64 run. */
export function newCtlToken(): string {
  return randomBytes(32).toString('hex')
}

export function readCtlToken(dir: string): { ok: true, token: string } | { ok: false, code: CtlTokenReadCode } {
  const path = join(dir, CTL_TOKEN_FILE)
  const st = lstatOrUndefined(path)
  if (st === undefined) return { ok: false, code: 'no-token-file' }
  if (st.isSymbolicLink()) return { ok: false, code: 'token-symlink' }
  if ((st.mode & 0o077) !== 0) return { ok: false, code: 'token-mode' }
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) return { ok: false, code: 'token-owner' }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, code: 'no-token-file' }
  }
  const token = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!TOKEN_RE.test(token)) return { ok: false, code: 'token-shape' }
  return { ok: true, token }
}

export function readCtlPort(dir: string): { ok: true, port: number } | { ok: false, code: CtlPortReadCode } {
  let text: string
  try {
    text = readFileSync(join(dir, CTL_PORT_FILE), 'utf8')
  } catch {
    return { ok: false, code: 'no-port-file' }
  }
  if (!PORT_RE.test(text)) return { ok: false, code: 'port-shape' }
  const port = Number(text.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, code: 'port-shape' }
  return { ok: true, port }
}
