// Private-file primitives shared by the approval token and the file vault: 0700 dirs, 0600 files
// written by temp + rename (replace) or temp + link (create once), and a reader that opens with
// O_NOFOLLOW and checks mode, owner and size on the SAME fd it then reads from. Errors carry a code
// and the file's basename only, never the absolute path (which would carry $HOME) and never content.

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { basename } from 'node:path'

export type PrivateFileErrorCode = 'dir-mode' | 'mode' | 'owner' | 'not-file' | 'too-large' | 'exists'

export class PrivateFileError extends Error {
  readonly code: PrivateFileErrorCode

  constructor(code: PrivateFileErrorCode, path: string) {
    super(`private file refused (${code}, ${basename(path)})`)
    this.name = 'PrivateFileError'
    this.code = code
  }
}

function currentUid(): number | undefined {
  return process.getuid?.()
}

function errnoCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Creates `dir` 0700 (recursively) and refuses a symlink, a non-directory, any 0o077 bit or another owner. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PrivateFileError('not-file', dir)
  if ((st.mode & 0o077) !== 0) throw new PrivateFileError('dir-mode', dir)
  const uid = currentUid()
  if (uid !== undefined && st.uid !== uid) throw new PrivateFileError('owner', dir)
}

function tempPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
}

/** Writes `data` to a fresh 0600 temp file (wx), fsyncs it and returns its path. The caller removes it. */
function writeTemp(tmp: string, data: Uint8Array | string): void {
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(tmp, 0o600)
}

/** Replace-in-place: temp file (0600, wx, fsync) then rename over `path`. The temp file never survives a throw. */
export function writePrivateFileAtomic(path: string, data: Uint8Array | string): void {
  const tmp = tempPathFor(path)
  try {
    writeTemp(tmp, data)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Create-never-overwrite: temp file then `link(temp, path)`. Returns false when `path` already exists
 * (the existing file is untouched). Atomic, so a crash never leaves a half-written file under `path`.
 */
export function createPrivateFileOnce(path: string, data: Uint8Array | string): boolean {
  const tmp = tempPathFor(path)
  try {
    writeTemp(tmp, data)
    try {
      linkSync(tmp, path)
    } catch (e) {
      if (errnoCode(e) === 'EEXIST') return false
      throw e
    }
    return true
  } finally {
    rmSync(tmp, { force: true })
  }
}

export interface ReadPrivateFileOptions {
  /** Refuse (too-large) a file whose size is over this many bytes. */
  readonly maxBytes: number
  /** The uid the file must belong to; defaults to the current process uid. */
  readonly expectedUid?: number
}

/**
 * Opens `path` with O_NOFOLLOW, then on that one fd: regular file, no 0o077 bit, expected owner, size
 * within `maxBytes`, then read. Returns null when the file does not exist.
 */
export function readPrivateFile(path: string, opts: ReadPrivateFileOptions): Buffer | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = errnoCode(e)
    if (code === 'ENOENT') return null
    if (code === 'ELOOP' || code === 'EMLINK') throw new PrivateFileError('not-file', path)
    throw e
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new PrivateFileError('not-file', path)
    if ((st.mode & 0o077) !== 0) throw new PrivateFileError('mode', path)
    const uid = opts.expectedUid ?? currentUid()
    if (uid !== undefined && st.uid !== uid) throw new PrivateFileError('owner', path)
    if (st.size > opts.maxBytes) throw new PrivateFileError('too-large', path)
    const data = readFileSync(fd)
    if (data.length > opts.maxBytes) throw new PrivateFileError('too-large', path)
    return data
  } finally {
    closeSync(fd)
  }
}
