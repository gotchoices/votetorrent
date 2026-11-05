// src/crypto/vault.ts — the D-13 key-vault storage leg: the `IKeyVault` port
// and a software test implementation.
//
// `doc/encryption-formats.md` section 4 is the normative contract this
// module's JSDoc restates for 62-21's native adapter: copy semantics (every
// method copies in and copies out — a caller mutating an array it passed in
// or received back must never change what the vault actually holds), the
// 'alias-exists' refusal (a DKG share or an officer encryption key, the
// ONLY copy, can never be silently overwritten — the caller must
// `deleteSecret` first), `hasSecret` never prompting, `null` for an absent
// alias, and the meaning of each `KeyVaultErrorCode`.
//
// Adapters (62-21) store only hardware-wrapped bytes (62-08's
// `wrapSecret`/`unwrapSecret`) — never plaintext at rest. `'unavailable'` is
// reserved for an adapter whose native backend is missing; the software test
// vault below never returns it.
//
// Purity rules (see `encoding.ts`'s header for the full list): no
// `node:` import, no `../` import, no `console`, no `TextDecoder`, no
// reference to Node's byte-buffer type even in a comment.

export interface KeyVaultPolicy {
  readonly requireUserAuth: boolean
}

export type KeyVaultErrorCode = 'invalid-alias' | 'invalid-secret' | 'alias-exists' | 'auth-denied' | 'unavailable'

export class KeyVaultError extends Error {
  readonly code: KeyVaultErrorCode

  constructor (code: KeyVaultErrorCode, message: string) {
    super(message)
    this.name = 'KeyVaultError'
    this.code = code
  }
}

export interface IKeyVault {
  /**
   * Store `secret` under `alias`. Rejects `'alias-exists'` if the alias is
   * already present — the caller must `deleteSecret` first. It never
   * silently overwrites.
   */
  putSecret: (alias: string, secret: Uint8Array, policy: KeyVaultPolicy) => Promise<void>
  /**
   * Returns `null` when absent. May prompt when the stored policy requires
   * user auth, and rejects `'auth-denied'` on refusal. Returns a fresh copy
   * every call.
   */
  getSecret: (alias: string) => Promise<Uint8Array | null>
  /** Never prompts. */
  hasSecret: (alias: string) => Promise<boolean>
  /** Returns true if something was removed; idempotent. */
  deleteSecret: (alias: string) => Promise<boolean>
}

/** Every alias in this format: `vt.<kind>.<...>`, 1..128 chars. */
export const KEY_VAULT_ALIAS_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** Every `IKeyVault` method rejects `'invalid-alias'` for an alias failing this pattern. */
export function assertKeyVaultAlias (alias: string): void {
  if (typeof alias !== 'string' || !KEY_VAULT_ALIAS_PATTERN.test(alias)) {
    throw new KeyVaultError(
      'invalid-alias',
      `assertKeyVaultAlias: alias does not match KEY_VAULT_ALIAS_PATTERN (got ${
        typeof alias === 'string' ? JSON.stringify(alias) : typeof alias
      })`
    )
  }
}

export function officerEncryptionKeyAlias (userId: string): string {
  const alias = `vt.officer-enc.${userId}`
  assertKeyVaultAlias(alias)
  return alias
}

/** Upper bound on officer encryption-key vault generations (O-01): keeps every generation scan finite. */
export const MAX_OFFICER_KEY_GENERATIONS = 16

/**
 * O-01: the vault alias of an officer's encryption key at `generation`. Generation 0 is the legacy
 * alias (`officerEncryptionKeyAlias`) so a vault written before generations existed stays valid;
 * n >= 1 is `vt.officer-enc.<userId>.g<n>`. Older generations are never deleted (D-51).
 */
export function officerEncryptionKeyGenerationAlias (userId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0 || generation >= MAX_OFFICER_KEY_GENERATIONS) {
    throw new KeyVaultError(
      'invalid-alias',
      `officerEncryptionKeyGenerationAlias: generation must be an integer in [0, ${MAX_OFFICER_KEY_GENERATIONS - 1}]`
    )
  }
  if (generation === 0) return officerEncryptionKeyAlias(userId)
  const alias = `vt.officer-enc.${userId}.g${generation}`
  assertKeyVaultAlias(alias)
  return alias
}

/**
 * O-01: the generations this vault holds for `userId`, ascending and contiguous from 0 (the scan
 * stops at the first gap). Uses `hasSecret` only, so it never prompts.
 */
export async function listHeldOfficerKeyGenerations (vault: IKeyVault, userId: string): Promise<number[]> {
  const held: number[] = []
  for (let generation = 0; generation < MAX_OFFICER_KEY_GENERATIONS; generation++) {
    if (!(await vault.hasSecret(officerEncryptionKeyGenerationAlias(userId, generation)))) break
    held.push(generation)
  }
  return held
}

export function keyholderDkgReceivingKeyAlias (userId: string): string {
  const alias = `vt.keyholder-dkg-recv.${userId}`
  assertKeyVaultAlias(alias)
  return alias
}

export function keyholderDkgShareAlias (electionId: string, revision: number, userId: string): string {
  const alias = `vt.keyholder-share.${electionId}.${revision}.${userId}`
  assertKeyVaultAlias(alias)
  return alias
}

/**
 * Non-secret marker beside the share alias: the attempt number whose round 4 produced the share.
 * The share alias itself stays attempt-agnostic (every consumer reads it unchanged); only the DKG
 * vault sweep reads this marker, so it deletes a share ONLY when the producing attempt aborted.
 */
export function keyholderDkgShareAttemptAlias (electionId: string, revision: number, userId: string): string {
  const alias = `vt.keyholder-share-attempt.${electionId}.${revision}.${userId}`
  assertKeyVaultAlias(alias)
  return alias
}

/** Research A4: unattended intake — officer encryption keys are usable without user interaction. */
export const OFFICER_ENCRYPTION_KEY_POLICY: KeyVaultPolicy = { requireUserAuth: false }
export const KEYHOLDER_DKG_RECEIVING_KEY_POLICY: KeyVaultPolicy = { requireUserAuth: true }
export const KEYHOLDER_SHARE_POLICY: KeyVaultPolicy = { requireUserAuth: true }
/** Non-secret metadata (an attempt number already public on the strand); reading it never prompts, so the biometric budget is unchanged. */
export const KEYHOLDER_SHARE_ATTEMPT_POLICY: KeyVaultPolicy = { requireUserAuth: false }

interface VaultEntry {
  readonly bytes: Uint8Array
  readonly policy: KeyVaultPolicy
}

/**
 * **TEST ONLY — holds secrets in process memory in clear.** The deep-path,
 * never-barrel-exported software implementation of `IKeyVault` used by this
 * package's own tests. A real adapter (62-21) stores hardware-wrapped bytes;
 * this one does not wrap anything, which is exactly why it must never ship.
 */
export class InMemoryTestKeyVault implements IKeyVault {
  private readonly store = new Map<string, VaultEntry>()
  private readonly authorize: (alias: string) => boolean | Promise<boolean>
  private _authPromptCount = 0

  constructor (options?: { readonly authorize?: (alias: string) => boolean | Promise<boolean> }) {
    this.authorize = options?.authorize ?? (() => true)
  }

  /** Read-only. Incremented once per `getSecret` call whose stored policy requires user auth. */
  get authPromptCount (): number {
    return this._authPromptCount
  }

  async putSecret (alias: string, secret: Uint8Array, policy: KeyVaultPolicy): Promise<void> {
    assertKeyVaultAlias(alias)
    if (!(secret instanceof Uint8Array) || secret.length === 0) {
      throw new KeyVaultError('invalid-secret', 'putSecret: secret must be a non-empty Uint8Array')
    }
    if (this.store.has(alias)) {
      throw new KeyVaultError('alias-exists', `putSecret: alias '${alias}' already holds a secret`)
    }
    this.store.set(alias, { bytes: Uint8Array.from(secret), policy })
  }

  async getSecret (alias: string): Promise<Uint8Array | null> {
    assertKeyVaultAlias(alias)
    const entry = this.store.get(alias)
    if (entry === undefined) return null
    if (entry.policy.requireUserAuth) {
      this._authPromptCount++
      const authorized = await this.authorize(alias)
      if (!authorized) {
        throw new KeyVaultError('auth-denied', `getSecret: user denied access to alias '${alias}'`)
      }
    }
    return Uint8Array.from(entry.bytes)
  }

  async hasSecret (alias: string): Promise<boolean> {
    assertKeyVaultAlias(alias)
    return this.store.has(alias)
  }

  async deleteSecret (alias: string): Promise<boolean> {
    assertKeyVaultAlias(alias)
    return this.store.delete(alias)
  }
}
