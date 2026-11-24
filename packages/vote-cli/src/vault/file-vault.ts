// FileKeyVault: the engine IKeyVault over 0600 files, with the two-key split. A requireUserAuth:true
// alias is sealed under HKDF(approval token); a requireUserAuth:false alias under HKDF(at-rest key),
// so unattended intake reads work with no token present. AES-256-GCM with a fresh 12-byte nonce per
// record and AAD = prefix|alias|flag; records are created once and never overwritten (alias-exists),
// so a nonce is never reused under one key. authPromptCount moves exactly as InMemoryTestKeyVault's.
// KeyVaultError messages carry the operation, the alias and a reason word: never bytes, paths or tokens.

import { KeyVaultError, assertKeyVaultAlias } from '@votetorrent/vote-engine/rn'
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { NO_APPROVAL, type ApprovalContext } from '../approval/token.js'
import { DEVICE_KEY_FILES, HKDF_INFO, fileVaultErrorFrom, type DeviceKeys } from './device-keys.js'
import { createPrivateFileOnce, ensurePrivateDir, readPrivateFile } from './private-file.js'

export const FILE_VAULT_AAD_PREFIX = 'votetorrent/file-vault/v1'
export const MAX_FILE_VAULT_SECRET_BYTES = 4096

const RECORDS_DIR = 'records'
const RECORD_SUFFIX = '.rec'
const MAX_RECORD_BYTES = 16384
const NONCE_BYTES = 12
const TAG_BYTES = 16
const CIPHER = 'aes-256-gcm'

export interface FileKeyVaultOptions {
  readonly keys: DeviceKeys
  /** Defaults to NO_APPROVAL (every auth-required access rejects auth-denied). */
  readonly approval?: ApprovalContext
  /** Called once per getSecret of a present auth-required alias, before the token is read. */
  readonly onAuthPrompt?: (alias: string) => void
}

/** Stored record, fixed member order. nonce, tag and ct are base64. */
interface StoredRecord {
  v: 1
  alias: string
  requireUserAuth: boolean
  nonce: string
  tag: string
  ct: string
}

interface PromptCounter {
  count: number
}

function buildAad(alias: string, requireUserAuth: boolean): Buffer {
  return Buffer.from(`${FILE_VAULT_AAD_PREFIX}|${alias}|${requireUserAuth ? '1' : '0'}`, 'utf8')
}

function recordFileName(alias: string): string {
  return `${createHash('sha256').update(alias, 'utf8').digest('hex')}${RECORD_SUFFIX}`
}

function errnoCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

function isApprovalTokenError(e: unknown): e is { name: string, code: string } {
  const err = e as { name?: unknown, code?: unknown } | undefined
  return err?.name === 'ApprovalTokenError' && typeof err.code === 'string'
}

function parseRecord(raw: Buffer, alias: string): StoredRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new KeyVaultError('unavailable', `file-vault: getSecret record for alias '${alias}' is not valid JSON`)
  }
  const r = parsed as Partial<StoredRecord> | null
  if (
    r === null ||
    typeof r !== 'object' ||
    r.v !== 1 ||
    r.alias !== alias ||
    typeof r.requireUserAuth !== 'boolean' ||
    typeof r.nonce !== 'string' ||
    typeof r.tag !== 'string' ||
    typeof r.ct !== 'string'
  ) {
    throw new KeyVaultError('unavailable', `file-vault: getSecret record for alias '${alias}' has an unrecognized shape`)
  }
  return r as StoredRecord
}

export class FileKeyVault implements IKeyVault {
  private readonly keys: DeviceKeys
  private readonly approval: ApprovalContext
  private readonly onAuthPrompt: ((alias: string) => void) | undefined
  private readonly recordsDir: string
  private readonly counter: PromptCounter

  constructor(opts: FileKeyVaultOptions) {
    this.keys = opts.keys
    this.approval = opts.approval ?? NO_APPROVAL
    this.onAuthPrompt = opts.onAuthPrompt
    this.recordsDir = join(opts.keys.dir, RECORDS_DIR)
    const shared = (opts as { counter?: PromptCounter }).counter
    this.counter = shared ?? { count: 0 }
    try {
      ensurePrivateDir(this.recordsDir)
    } catch (e) {
      throw fileVaultErrorFrom(e, this.recordsDir, 'home')
    }
  }

  /** Read-only: one increment per getSecret of a present alias whose stored policy requires auth. Shared by every view. */
  get authPromptCount(): number {
    return this.counter.count
  }

  /** A view over the same keys, records and prompt counter, with a different approval context (one per approval-class verb). */
  withApproval(approval: ApprovalContext): FileKeyVault {
    const opts: FileKeyVaultOptions & { counter: PromptCounter } = {
      keys: this.keys,
      approval,
      onAuthPrompt: this.onAuthPrompt,
      counter: this.counter
    }
    return new FileKeyVault(opts)
  }

  private recordPath(alias: string): string {
    return join(this.recordsDir, recordFileName(alias))
  }

  private tokenCheckPath(): string {
    return join(this.keys.dir, DEVICE_KEY_FILES.tokenCheck)
  }

  /** True when any record on disk is sealed under the token key (used only to decide if token.check may still be bound). */
  private anyAuthRecordExists(): boolean {
    let names: string[]
    try {
      names = readdirSync(this.recordsDir)
    } catch {
      return false
    }
    for (const name of names) {
      if (!name.endsWith(RECORD_SUFFIX)) continue
      try {
        const parsed = JSON.parse(readFileSync(join(this.recordsDir, name), 'utf8')) as { requireUserAuth?: unknown } | null
        if (parsed !== null && typeof parsed === 'object' && parsed.requireUserAuth === true) return true
      } catch {
        // an unreadable record is not evidence either way; the token check stays unbound only for an empty vault
        return true
      }
    }
    return false
  }

  /** Reads the token once, verifies it against token.check (binding it on the first auth-required put), and derives the KEK. */
  private async tokenKek(alias: string, op: 'putSecret' | 'getSecret'): Promise<Buffer> {
    let token: Uint8Array
    try {
      token = await this.approval.token()
    } catch (e) {
      if (isApprovalTokenError(e)) {
        throw new KeyVaultError('auth-denied', `file-vault: ${op} approval refused for alias '${alias}' (${e.code})`)
      }
      throw e
    }
    let check: Buffer | undefined
    try {
      check = this.keys.deriveTokenKey(token, HKDF_INFO.tokenCheck)
      const checkPath = this.tokenCheckPath()
      let stored: Buffer | null
      try {
        stored = readPrivateFile(checkPath, { maxBytes: 64 })
      } catch {
        throw new KeyVaultError('unavailable', `file-vault: ${op} token check unreadable for alias '${alias}'`)
      }
      if (stored === null) {
        if (op === 'getSecret' || this.anyAuthRecordExists()) {
          throw new KeyVaultError('unavailable', `file-vault: ${op} token check missing for alias '${alias}'`)
        }
        if (!createPrivateFileOnce(checkPath, check)) {
          stored = readPrivateFile(checkPath, { maxBytes: 64 })
          if (stored === null) {
            throw new KeyVaultError('unavailable', `file-vault: ${op} token check missing for alias '${alias}'`)
          }
        }
      }
      if (stored !== null) {
        try {
          if (stored.length !== check.length || !timingSafeEqual(stored, check)) {
            throw new KeyVaultError('auth-denied', `file-vault: ${op} approval token mismatch for alias '${alias}'`)
          }
        } finally {
          stored.fill(0)
        }
      }
      return this.keys.deriveTokenKey(token, HKDF_INFO.userAuthKek)
    } finally {
      check?.fill(0)
      token.fill(0)
    }
  }

  async putSecret(alias: string, secret: Uint8Array, policy: KeyVaultPolicy): Promise<void> {
    assertKeyVaultAlias(alias)
    if (!(secret instanceof Uint8Array) || secret.length === 0 || secret.length > MAX_FILE_VAULT_SECRET_BYTES) {
      throw new KeyVaultError('invalid-secret', `file-vault: putSecret secret for alias '${alias}' must be 1..${MAX_FILE_VAULT_SECRET_BYTES} bytes`)
    }
    const requireUserAuth: unknown = (policy as { requireUserAuth?: unknown } | null)?.requireUserAuth
    if (typeof requireUserAuth !== 'boolean') {
      throw new KeyVaultError('invalid-secret', `file-vault: putSecret policy for alias '${alias}' has no boolean requireUserAuth`)
    }
    const input = Buffer.from(secret)
    let kek: Buffer | undefined
    try {
      const path = this.recordPath(alias)
      if (existsSync(path)) {
        throw new KeyVaultError('alias-exists', `file-vault: putSecret alias '${alias}' already holds a secret`)
      }
      kek = requireUserAuth ? await this.tokenKek(alias, 'putSecret') : this.keys.deriveAtRestKey(HKDF_INFO.atRestKek)
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv(CIPHER, kek, nonce, { authTagLength: TAG_BYTES })
      cipher.setAAD(buildAad(alias, requireUserAuth))
      const ct = Buffer.concat([cipher.update(input), cipher.final()])
      const tag = cipher.getAuthTag()
      const record: StoredRecord = {
        v: 1,
        alias,
        requireUserAuth,
        nonce: nonce.toString('base64'),
        tag: tag.toString('base64'),
        ct: ct.toString('base64')
      }
      if (!createPrivateFileOnce(path, `${JSON.stringify(record)}\n`)) {
        throw new KeyVaultError('alias-exists', `file-vault: putSecret alias '${alias}' already holds a secret`)
      }
    } finally {
      kek?.fill(0)
      input.fill(0)
    }
  }

  async getSecret(alias: string): Promise<Uint8Array | null> {
    assertKeyVaultAlias(alias)
    let raw: Buffer | null
    try {
      raw = readPrivateFile(this.recordPath(alias), { maxBytes: MAX_RECORD_BYTES })
    } catch (e) {
      if ((e as { name?: unknown } | undefined)?.name === 'PrivateFileError') {
        throw new KeyVaultError('unavailable', `file-vault: getSecret record for alias '${alias}' refused (${String((e as { code: string }).code)})`)
      }
      throw e
    }
    if (raw === null) return null
    const record = parseRecord(raw, alias)
    const nonce = Buffer.from(record.nonce, 'base64')
    const tag = Buffer.from(record.tag, 'base64')
    const ct = Buffer.from(record.ct, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new KeyVaultError('unavailable', `file-vault: getSecret record for alias '${alias}' has a malformed nonce or tag`)
    }
    let kek: Buffer | undefined
    let plaintext: Buffer | undefined
    try {
      if (record.requireUserAuth) {
        this.counter.count++
        this.onAuthPrompt?.(alias)
        kek = await this.tokenKek(alias, 'getSecret')
      } else {
        kek = this.keys.deriveAtRestKey(HKDF_INFO.atRestKek)
      }
      const decipher = createDecipheriv(CIPHER, kek, nonce, { authTagLength: TAG_BYTES })
      decipher.setAAD(buildAad(alias, record.requireUserAuth))
      decipher.setAuthTag(tag)
      try {
        plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
      } catch {
        throw new KeyVaultError('unavailable', `file-vault: getSecret record for alias '${alias}' failed authentication`)
      }
      return Uint8Array.from(plaintext)
    } finally {
      plaintext?.fill(0)
      kek?.fill(0)
    }
  }

  async hasSecret(alias: string): Promise<boolean> {
    assertKeyVaultAlias(alias)
    return existsSync(this.recordPath(alias))
  }

  async deleteSecret(alias: string): Promise<boolean> {
    assertKeyVaultAlias(alias)
    try {
      unlinkSync(this.recordPath(alias))
      return true
    } catch (e) {
      if (errnoCode(e) === 'ENOENT') return false
      throw e
    }
  }
}
