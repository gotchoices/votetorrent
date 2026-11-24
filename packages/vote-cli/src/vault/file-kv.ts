// Two string key-value stores over one 0600 file each, write-through on every set and remove (so a
// kill right after `await setItem` loses nothing). `openFileKv` is the plain JSON store the daemon
// hands to the AsyncStorage slots; `openSealedFileKv` is the same map sealed with AES-256-GCM under
// the per-device at-rest key, for the keyholder identity store (public material that must survive a
// restart without the approval token). A module-local set of open paths refuses two writers on one
// file inside one process; the rig's process-global cache is gone.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, basename, resolve } from 'node:path'
import type { KeyVaultStorage, KvStorage } from '@votetorrent/workflows/platform'
import { HKDF_INFO, type DeviceKeys } from './device-keys.js'
import { ensurePrivateDir, readPrivateFile, writePrivateFileAtomic } from './private-file.js'

export type FileKvErrorCode = 'kv-corrupt' | 'kv-mode' | 'kv-path-open' | 'kv-closed' | 'kv-value'

export class FileKvError extends Error {
  readonly code: FileKvErrorCode

  constructor(code: FileKvErrorCode, path: string) {
    super(`file kv refused (${code}, ${basename(path)})`)
    this.name = 'FileKvError'
    this.code = code
  }
}

const MAX_KV_FILE_BYTES = 8 * 1024 * 1024
const SEALED_AAD_PREFIX = 'votetorrent/file-kv/v1|sealed|'
const LABEL_RE = /^[a-z0-9-]{1,64}$/
const NONCE_BYTES = 12
const TAG_BYTES = 16
const CIPHER = 'aes-256-gcm'

/** Absolute paths with a live store in this process (Pitfall 9: two writers on one file silently diverge). */
const openPaths = new Set<string>()

type StringMap = Record<string, string>

function isStringMap(value: unknown): value is StringMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  for (const v of Object.values(value as Record<string, unknown>)) if (typeof v !== 'string') return false
  return true
}

function parseStringMap(text: string, path: string): StringMap {
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new FileKvError('kv-corrupt', path)
  }
  if (!isStringMap(parsed)) throw new FileKvError('kv-corrupt', path)
  return { ...parsed }
}

function readStoreFile(abs: string): Buffer | null {
  try {
    ensurePrivateDir(dirname(abs))
    return readPrivateFile(abs, { maxBytes: MAX_KV_FILE_BYTES })
  } catch (e) {
    const err = e as { name?: unknown, code?: unknown } | undefined
    if (err?.name === 'PrivateFileError') {
      if (err.code === 'mode' || err.code === 'dir-mode' || err.code === 'owner') throw new FileKvError('kv-mode', abs)
      throw new FileKvError('kv-corrupt', abs)
    }
    throw e
  }
}

function claimPath(abs: string): void {
  if (openPaths.has(abs)) throw new FileKvError('kv-path-open', abs)
  openPaths.add(abs)
}

/** A string store over one private file. Implements both KvStorage and KeyVaultStorage (the same shape). */
export class FileKvStorage implements KvStorage, KeyVaultStorage {
  readonly path: string
  private data: StringMap
  private readonly flush: (data: StringMap) => void
  private closed = false

  /** Use `openFileKv` or `openSealedFileKv`. */
  constructor(path: string, data: StringMap, flush: (data: StringMap) => void) {
    this.path = path
    this.data = data
    this.flush = flush
  }

  private assertOpen(): void {
    if (this.closed) throw new FileKvError('kv-closed', this.path)
  }

  async getItem(key: string): Promise<string | null> {
    this.assertOpen()
    return Object.hasOwn(this.data, key) ? this.data[key]! : null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.assertOpen()
    if (typeof key !== 'string') throw new FileKvError('kv-value', this.path)
    if (typeof value !== 'string') throw new FileKvError('kv-value', this.path)
    this.data[key] = value
    this.flush(this.data)
  }

  async removeItem(key: string): Promise<void> {
    this.assertOpen()
    if (!Object.hasOwn(this.data, key)) return
    delete this.data[key]
    this.flush(this.data)
  }

  keys(): string[] {
    this.assertOpen()
    return Object.keys(this.data)
  }

  /** Releases the path for a later open in this process; every later call rejects kv-closed. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    openPaths.delete(this.path)
  }
}

/** The plain 0600 JSON store (the AsyncStorage slots). Absent or blank starts empty; corrupt content is refused and left untouched. */
export function openFileKv(opts: { path: string }): FileKvStorage {
  const abs = resolve(opts.path)
  if (openPaths.has(abs)) throw new FileKvError('kv-path-open', abs)
  const raw = readStoreFile(abs)
  const data = raw === null ? {} : parseStringMap(raw.toString('utf8'), abs)
  claimPath(abs)
  return new FileKvStorage(abs, data, (d) => { writePrivateFileAtomic(abs, JSON.stringify(d)) })
}

interface SealedFile {
  v: 1
  nonce: string
  tag: string
  ct: string
}

function sealMap(keys: DeviceKeys, label: string, data: StringMap): string {
  const kek = keys.deriveAtRestKey(HKDF_INFO.sealedKvKek)
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
  try {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(CIPHER, kek, nonce, { authTagLength: TAG_BYTES })
    cipher.setAAD(Buffer.from(`${SEALED_AAD_PREFIX}${label}`, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const file: SealedFile = {
      v: 1,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64')
    }
    return `${JSON.stringify(file)}\n`
  } finally {
    kek.fill(0)
    plaintext.fill(0)
  }
}

function openMap(keys: DeviceKeys, label: string, raw: Buffer, abs: string): StringMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new FileKvError('kv-corrupt', abs)
  }
  const f = parsed as Partial<SealedFile> | null
  if (f === null || typeof f !== 'object' || f.v !== 1 || typeof f.nonce !== 'string' || typeof f.tag !== 'string' || typeof f.ct !== 'string') {
    throw new FileKvError('kv-corrupt', abs)
  }
  const nonce = Buffer.from(f.nonce, 'base64')
  const tag = Buffer.from(f.tag, 'base64')
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new FileKvError('kv-corrupt', abs)
  const kek = keys.deriveAtRestKey(HKDF_INFO.sealedKvKek)
  let plaintext: Buffer | undefined
  try {
    const decipher = createDecipheriv(CIPHER, kek, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(`${SEALED_AAD_PREFIX}${label}`, 'utf8'))
    decipher.setAuthTag(tag)
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(f.ct, 'base64')), decipher.final()])
    } catch {
      throw new FileKvError('kv-corrupt', abs)
    }
    return parseStringMap(plaintext.toString('utf8'), abs)
  } finally {
    kek.fill(0)
    plaintext?.fill(0)
  }
}

/**
 * The at-rest-sealed store: `{ v, nonce, tag, ct }` with AES-256-GCM under HKDF(at-rest key, sealedKvKek)
 * and AAD bound to `label`. A GCM failure, another label, keys from another home or a bad shape is
 * `kv-corrupt`. The decrypted map stays in memory for the life of the store (public identity material).
 */
export function openSealedFileKv(opts: { path: string, keys: DeviceKeys, label: string }): FileKvStorage {
  const abs = resolve(opts.path)
  if (typeof opts.label !== 'string' || !LABEL_RE.test(opts.label)) throw new FileKvError('kv-value', abs)
  if (openPaths.has(abs)) throw new FileKvError('kv-path-open', abs)
  const { keys, label } = opts
  const raw = readStoreFile(abs)
  const data = raw === null ? {} : openMap(keys, label, raw, abs)
  const flush = (d: StringMap): void => { writePrivateFileAtomic(abs, sealMap(keys, label, d)) }
  if (raw === null) flush(data)
  claimPath(abs)
  return new FileKvStorage(abs, data, flush)
}
