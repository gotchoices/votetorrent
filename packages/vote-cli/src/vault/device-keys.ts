// Per-device key material for the file vault: a 32-byte salt and a 32-byte at-rest key, each a 0600
// create-once file in the 0700 vault home, plus the HKDF-SHA256 derivations every sealed file uses.
// Two keys by design: the at-rest key seals non-approval material (so unattended intake reads work
// with no token present) and the approval token, as HKDF input keying material, seals approval-class
// material. Nothing here logs, and every derived Buffer is the caller's to zero-fill.

import { hkdfSync, randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { PrivateFileError, createPrivateFileOnce, ensurePrivateDir, readPrivateFile } from './private-file.js'

export type FileVaultErrorCode = 'home-mode' | 'key-mode' | 'key-length' | 'key-not-file' | 'home-owner'

export class FileVaultError extends Error {
  readonly code: FileVaultErrorCode

  constructor(code: FileVaultErrorCode, path: string) {
    super(`file vault refused (${code}, ${basename(path)})`)
    this.name = 'FileVaultError'
    this.code = code
  }
}

/** File names inside the vault home. */
export const DEVICE_KEY_FILES = Object.freeze({
  salt: 'vault.salt',
  atRest: 'at-rest.key',
  tokenCheck: 'token.check'
})

/** HKDF info strings; each names one purpose, so no two derivations share a key. */
export const HKDF_INFO = Object.freeze({
  userAuthKek: 'votetorrent/file-vault/v1/kek/user-auth',
  atRestKek: 'votetorrent/file-vault/v1/kek/at-rest',
  tokenCheck: 'votetorrent/file-vault/v1/token-check',
  sealedKvKek: 'votetorrent/file-kv/v1/kek/at-rest'
})

const KEY_BYTES = 32
const DERIVED_BYTES = 32

/** Maps a PrivateFileError raised on the vault home or a key file to the vault's own codes; other errors pass through. */
export function fileVaultErrorFrom(e: unknown, path: string, what: 'home' | 'key'): unknown {
  const err = e as { name?: unknown, code?: unknown } | undefined
  if (err?.name !== 'PrivateFileError') return e
  switch (err.code as PrivateFileError['code']) {
    case 'dir-mode':
      return new FileVaultError('home-mode', path)
    case 'mode':
      return new FileVaultError(what === 'home' ? 'home-mode' : 'key-mode', path)
    case 'owner':
      return new FileVaultError('home-owner', path)
    case 'not-file':
      return new FileVaultError('key-not-file', path)
    case 'too-large':
      return new FileVaultError('key-length', path)
    default:
      return e
  }
}

function readKeyFile(path: string): Buffer | null {
  try {
    return readPrivateFile(path, { maxBytes: 64 })
  } catch (e) {
    throw fileVaultErrorFrom(e, path, 'key')
  }
}

/** Reads the 32-byte key file at `path`, creating it with fresh random bytes when absent (create-once; a lost race re-reads). */
function loadOrCreateKey(path: string): Buffer {
  let data = readKeyFile(path)
  if (data === null) {
    const fresh = randomBytes(KEY_BYTES)
    try {
      if (createPrivateFileOnce(path, fresh)) {
        data = Buffer.from(fresh)
      } else {
        data = readKeyFile(path)
      }
    } finally {
      fresh.fill(0)
    }
  }
  if (data === null || data.length !== KEY_BYTES) {
    data?.fill(0)
    throw new FileVaultError('key-length', path)
  }
  return data
}

export class DeviceKeys {
  readonly dir: string
  private readonly salt: Buffer
  private readonly atRest: Buffer
  private disposed = false

  /** Use `openDeviceKeys`. */
  constructor(dir: string, salt: Buffer, atRest: Buffer) {
    this.dir = dir
    this.salt = salt
    this.atRest = atRest
  }

  private assertLive(): void {
    if (this.disposed) throw new TypeError('device keys disposed')
  }

  /** HKDF-SHA256(at-rest key, salt, info) -> 32 bytes. The caller zero-fills the result. */
  deriveAtRestKey(info: string): Buffer {
    this.assertLive()
    return Buffer.from(hkdfSync('sha256', this.atRest, this.salt, info, DERIVED_BYTES))
  }

  /** HKDF-SHA256(token, salt, info) -> 32 bytes. The token already carries 256 bits of entropy, so no slow KDF is needed. */
  deriveTokenKey(token: Uint8Array, info: string): Buffer {
    this.assertLive()
    return Buffer.from(hkdfSync('sha256', token, this.salt, info, DERIVED_BYTES))
  }

  /** Zero-fills the salt and the at-rest key; every later derivation throws. */
  dispose(): void {
    this.disposed = true
    this.salt.fill(0)
    this.atRest.fill(0)
  }
}

/** Opens (creating when absent) the 0700 vault home with its salt and at-rest key. */
export function openDeviceKeys(dir: string): DeviceKeys {
  try {
    ensurePrivateDir(dir)
  } catch (e) {
    throw fileVaultErrorFrom(e, dir, 'home')
  }
  const salt = loadOrCreateKey(join(dir, DEVICE_KEY_FILES.salt))
  let atRest: Buffer
  try {
    atRest = loadOrCreateKey(join(dir, DEVICE_KEY_FILES.atRest))
  } catch (e) {
    salt.fill(0)
    throw e
  }
  return new DeviceKeys(dir, salt, atRest)
}
