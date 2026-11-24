// FileKeyVault against the IKeyVault contract (ported from vote-engine's key-vault.spec), plus token
// gating, tamper, AAD swap, policy downgrade, file modes and the no-leak rule. Every secret and token
// is generated in-test; each case gets a fresh mkdtemp home. KeyVaultError is asserted structurally
// (name + code), never by instanceof.

import { expect } from 'chai'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KEYHOLDER_DKG_RECEIVING_KEY_POLICY,
  KEYHOLDER_SHARE_POLICY,
  OFFICER_ENCRYPTION_KEY_POLICY,
  type KeyVaultError,
  type KeyVaultPolicy
} from '@votetorrent/vote-engine/rn'
import { NO_APPROVAL, createApprovalContext, generateApprovalToken, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { DEVICE_KEY_FILES, FileVaultError, openDeviceKeys } from '../src/vault/device-keys.js'
import { FileKeyVault, MAX_FILE_VAULT_SECRET_BYTES } from '../src/vault/file-vault.js'
import { assertNoLeak } from './support/vault-leak-check.js'

/** Stands for the Authority's KEYHOLDER_SIGNING_KEY_POLICY (not exported by the rn entry). */
const SIGNING_POLICY: KeyVaultPolicy = { requireUserAuth: true }
/** Stands for KEYHOLDER_SHARE_ATTEMPT_POLICY (not exported by the rn entry). */
const ATTEMPT_POLICY: KeyVaultPolicy = { requireUserAuth: false }

type Coded = { name?: unknown, code?: unknown, message?: unknown }

const errors: unknown[] = []
const sensitive: Uint8Array[] = []
const homes: string[] = []

function secret(n = 32): Uint8Array {
  const s = Uint8Array.from(randomBytes(n))
  sensitive.push(s)
  return s
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    errors.push(err)
    return err as Coded
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    errors.push(err)
    return err as Coded
  }
  throw new Error('expected a throw')
}

function expectVaultError(err: Coded, code: KeyVaultError['code']): void {
  expect(err.name).to.equal('KeyVaultError')
  expect(err.code).to.equal(code)
}

function expectFileVaultError(err: Coded, code: FileVaultError['code']): void {
  expect(err.name).to.equal('FileVaultError')
  expect(err.code).to.equal(code)
}

function same(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && Buffer.from(a).equals(Buffer.from(b))
}

interface Counting extends ApprovalContext {
  calls: number
  returned: Uint8Array[]
}

function counting(inner: ApprovalContext): Counting {
  const ctx: Counting = {
    calls: 0,
    returned: [],
    async token() {
      ctx.calls++
      const t = await inner.token()
      ctx.returned.push(t)
      return t
    }
  }
  return ctx
}

interface Rig {
  home: string
  keysDir: string
  keys: ReturnType<typeof openDeviceKeys>
  token: Uint8Array
  tokenPath: string
  approval: Counting
  prompts: string[]
  vault: FileKeyVault
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'vt-13-'))
  homes.push(home)
  return home
}

function writeToken(home: string, name: string): { token: Uint8Array, path: string } {
  const token = generateApprovalToken()
  sensitive.push(token)
  const path = join(home, 'tokens', name)
  writeApprovalTokenFile(path, token)
  return { token, path }
}

function rig(): Rig {
  const home = newHome()
  const keysDir = join(home, 'vault')
  const keys = openDeviceKeys(keysDir)
  const { token, path } = writeToken(home, 'approval')
  const approval = counting(createApprovalContext({ file: path }))
  const prompts: string[] = []
  const vault = new FileKeyVault({ keys, approval, onAuthPrompt: (alias) => { prompts.push(alias) } })
  return { home, keysDir, keys, token, tokenPath: path, approval, prompts, vault }
}

function recordPath(r: Rig, alias: string): string {
  return join(r.keysDir, 'records', `${createHash('sha256').update(alias, 'utf8').digest('hex')}.rec`)
}

function readRecord(r: Rig, alias: string): Record<string, unknown> {
  return JSON.parse(readFileSync(recordPath(r, alias), 'utf8')) as Record<string, unknown>
}

function writeRecordText(r: Rig, alias: string, text: string): void {
  writeFileSync(recordPath(r, alias), text, { mode: 0o600 })
}

function flipBase64Byte(value: string, index: number): string {
  const buf = Buffer.from(value, 'base64')
  buf[index] = buf[index]! ^ 0x01
  return buf.toString('base64')
}

function findTmp(dir: string): string[] {
  const hits: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name.includes('.tmp-')) hits.push(name.name)
    if (name.isDirectory()) hits.push(...findTmp(join(dir, name.name)))
  }
  return hits
}

const A = 'vt.officer-enc.u1'
const AUTH_A = 'vt.keyholder-dkg-recv.u1'

describe('file vault', () => {
  after(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true })
  })

  // ---- contract parity (ported from key-vault.spec.ts)

  it('put then get returns equal bytes', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    expect(same(await r.vault.getSecret(A), s)).to.equal(true)
  })

  it('mutating the input after put does not change the stored secret', async () => {
    const r = rig()
    const s = secret()
    const copy = Uint8Array.from(s)
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    s[0] = s[0]! ^ 0xff
    expect(same(await r.vault.getSecret(A), copy)).to.equal(true)
  })

  it('mutating a returned array does not change the next get, and two gets do not share a buffer', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    const got1 = await r.vault.getSecret(A)
    got1![0] = got1![0]! ^ 0xff
    const got2 = await r.vault.getSecret(A)
    expect(same(got2, s)).to.equal(true)
    expect(got1).to.not.equal(got2)
    expect(got1!.buffer).to.not.equal(got2!.buffer)
  })

  it('a second put rejects alias-exists', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    expectVaultError(await rejection(r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)), 'alias-exists')
  })

  it('delete then put succeeds', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    expect(await r.vault.deleteSecret(A)).to.equal(true)
    const s2 = secret()
    await r.vault.putSecret(A, s2, OFFICER_ENCRYPTION_KEY_POLICY)
    expect(same(await r.vault.getSecret(A), s2)).to.equal(true)
  })

  it('an absent alias returns null with 0 prompts and 0 token calls', async () => {
    const r = rig()
    expect(await r.vault.getSecret('vt.officer-enc.nobody')).to.equal(null)
    expect(r.vault.authPromptCount).to.equal(0)
    expect(r.approval.calls).to.equal(0)
  })

  it('delete returns true then false', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    expect(await r.vault.deleteSecret(A)).to.equal(true)
    expect(await r.vault.deleteSecret(A)).to.equal(false)
  })

  it('hasSecret on an auth alias and an absent alias leaves prompts and token calls at 0', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
    r.approval.calls = 0
    expect(await r.vault.hasSecret(AUTH_A)).to.equal(true)
    expect(await r.vault.hasSecret('vt.keyholder-dkg-recv.nobody')).to.equal(false)
    expect(r.vault.authPromptCount).to.equal(0)
    expect(r.approval.calls).to.equal(0)
  })

  it('with NO_APPROVAL an auth get rejects auth-denied and the count is 1', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
    const unattended = r.vault.withApproval(NO_APPROVAL)
    expectVaultError(await rejection(unattended.getSecret(AUTH_A)), 'auth-denied')
    expect(unattended.authPromptCount).to.equal(1)
    expect(r.vault.authPromptCount).to.equal(1)
  })

  it('with the right token the auth get succeeds and the count is 1', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(AUTH_A, s, KEYHOLDER_SHARE_POLICY)
    expect(same(await r.vault.getSecret(AUTH_A), s)).to.equal(true)
    expect(r.vault.authPromptCount).to.equal(1)
  })

  it('a requireUserAuth:false alias reads under NO_APPROVAL with 0 prompts and 0 token calls', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    const attempt = secret(4)
    await r.vault.putSecret('vt.keyholder-share-attempt.e1.1.u1', attempt, ATTEMPT_POLICY)
    const unattended = new FileKeyVault({ keys: r.keys, approval: NO_APPROVAL })
    expect(same(await unattended.getSecret(A), s)).to.equal(true)
    expect(same(await unattended.getSecret('vt.keyholder-share-attempt.e1.1.u1'), attempt)).to.equal(true)
    expect(unattended.authPromptCount).to.equal(0)
    expect(r.approval.calls).to.equal(0)
  })

  it('invalid aliases reject invalid-alias on all four methods', async () => {
    const r = rig()
    for (const alias of ['', 'a'.repeat(129), 'has/slash', 'has space']) {
      const ops = [
        () => r.vault.putSecret(alias, new Uint8Array([1]), OFFICER_ENCRYPTION_KEY_POLICY),
        () => r.vault.getSecret(alias),
        () => r.vault.hasSecret(alias),
        () => r.vault.deleteSecret(alias)
      ]
      for (const op of ops) expectVaultError(await rejection(op()), 'invalid-alias')
    }
  })

  it('a 128-character alias is accepted', async () => {
    const r = rig()
    const alias = 'vt.officer-enc.' + 'u'.repeat(113)
    expect(alias.length).to.equal(128)
    await r.vault.putSecret(alias, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    expect(await r.vault.hasSecret(alias)).to.equal(true)
  })

  it('an empty secret rejects invalid-secret', async () => {
    const r = rig()
    expectVaultError(await rejection(r.vault.putSecret(A, new Uint8Array(0), OFFICER_ENCRYPTION_KEY_POLICY)), 'invalid-secret')
  })

  it('a 4097-byte secret rejects invalid-secret', async () => {
    const r = rig()
    expect(MAX_FILE_VAULT_SECRET_BYTES).to.equal(4096)
    expectVaultError(await rejection(r.vault.putSecret(A, secret(4097), OFFICER_ENCRYPTION_KEY_POLICY)), 'invalid-secret')
    expect(existsSync(recordPath(r, A))).to.equal(false)
  })

  it('a policy of {} rejects invalid-secret', async () => {
    const r = rig()
    expectVaultError(await rejection(r.vault.putSecret(A, secret(), {} as KeyVaultPolicy)), 'invalid-secret')
  })

  // ---- token gating

  it('with a different token the auth get rejects auth-denied, the count is 1, and token.check is unchanged', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    const checkPath = join(r.keysDir, DEVICE_KEY_FILES.tokenCheck)
    const before = readFileSync(checkPath)
    const other = writeToken(r.home, 'other')
    const view = r.vault.withApproval(createApprovalContext({ file: other.path }))
    expectVaultError(await rejection(view.getSecret(AUTH_A)), 'auth-denied')
    expect(r.vault.authPromptCount).to.equal(1)
    expect(readFileSync(checkPath).equals(before)).to.equal(true)
  })

  it('with a different token an auth put rejects auth-denied and writes no record', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    const other = writeToken(r.home, 'other')
    const view = r.vault.withApproval(createApprovalContext({ file: other.path }))
    expectVaultError(await rejection(view.putSecret('vt.keyholder-signing.u2', secret(), SIGNING_POLICY)), 'auth-denied')
    expect(existsSync(recordPath(r, 'vt.keyholder-signing.u2'))).to.equal(false)
  })

  it('two auth gets make two token calls (never cached)', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    const putCalls = r.approval.calls
    await r.vault.getSecret(AUTH_A)
    await r.vault.getSecret(AUTH_A)
    expect(r.approval.calls - putCalls).to.equal(2)
    expect(putCalls).to.equal(1)
  })

  it('after a successful auth get every token array the context returned is all zeros', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    await r.vault.getSecret(AUTH_A)
    expect(r.approval.returned.length).to.equal(2)
    for (const arr of r.approval.returned) {
      expect(arr.length).to.equal(32)
      expect(arr.every((b) => b === 0)).to.equal(true)
    }
  })

  it('onAuthPrompt is called once per auth get with the alias', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    expect(r.prompts).to.deep.equal([])
    await r.vault.getSecret(AUTH_A)
    await r.vault.getSecret(A)
    expect(r.prompts).to.deep.equal([AUTH_A])
  })

  it('a withApproval view shares the counter with the base vault', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(AUTH_A, s, SIGNING_POLICY)
    const view = r.vault.withApproval(createApprovalContext({ file: r.tokenPath }))
    expect(same(await view.getSecret(AUTH_A), s)).to.equal(true)
    expect(view.authPromptCount).to.equal(1)
    expect(r.vault.authPromptCount).to.equal(1)
  })

  // ---- crypto and tamper

  it('the raw record file passes assertNoLeak against the secret', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    const raw = readFileSync(recordPath(r, A), 'utf8')
    assertNoLeak(raw, [s])
    expect(raw).to.include(`"alias":"${A}"`)
  })

  it('two records with the same secret differ in nonce and ciphertext, and a re-put gets a new nonce', async () => {
    const r = rig()
    const s = secret()
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    await r.vault.putSecret('vt.officer-enc.u2', s, OFFICER_ENCRYPTION_KEY_POLICY)
    const ra = readRecord(r, A)
    const rb = readRecord(r, 'vt.officer-enc.u2')
    expect(ra.nonce).to.not.equal(rb.nonce)
    expect(ra.ct).to.not.equal(rb.ct)
    await r.vault.deleteSecret(A)
    await r.vault.putSecret(A, s, OFFICER_ENCRYPTION_KEY_POLICY)
    expect(readRecord(r, A).nonce).to.not.equal(ra.nonce)
  })

  it('flipping one ciphertext byte makes the get reject unavailable', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    const rec = readRecord(r, A)
    rec.ct = flipBase64Byte(rec.ct as string, 0)
    writeRecordText(r, A, JSON.stringify(rec))
    expectVaultError(await rejection(r.vault.getSecret(A)), 'unavailable')
  })

  it('flipping one tag byte makes the get reject unavailable', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    const rec = readRecord(r, A)
    rec.tag = flipBase64Byte(rec.tag as string, 3)
    writeRecordText(r, A, JSON.stringify(rec))
    expectVaultError(await rejection(r.vault.getSecret(A)), 'unavailable')
  })

  it('AAD swap: a record moved to another alias rejects unavailable', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    await r.vault.putSecret('vt.officer-enc.u2', secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    const rec = readRecord(r, A)
    rec.alias = 'vt.officer-enc.u2'
    writeRecordText(r, 'vt.officer-enc.u2', JSON.stringify(rec))
    expectVaultError(await rejection(r.vault.getSecret('vt.officer-enc.u2')), 'unavailable')
  })

  it('policy downgrade: an auth record rewritten to requireUserAuth:false rejects unavailable under NO_APPROVAL', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    const rec = readRecord(r, AUTH_A)
    rec.requireUserAuth = false
    writeRecordText(r, AUTH_A, JSON.stringify(rec))
    const unattended = r.vault.withApproval(NO_APPROVAL)
    let got: Uint8Array | null | undefined
    const err = await rejection((async () => { got = await unattended.getSecret(AUTH_A) })())
    expectVaultError(err, 'unavailable')
    expect(got).to.equal(undefined)
  })

  it('unparsable JSON and v:2 each reject unavailable', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    const rec = readRecord(r, A)
    writeRecordText(r, A, '{not json')
    expectVaultError(await rejection(r.vault.getSecret(A)), 'unavailable')
    writeRecordText(r, A, JSON.stringify({ ...rec, v: 2 }))
    expectVaultError(await rejection(r.vault.getSecret(A)), 'unavailable')
  })

  // ---- files and modes

  it('home and records are 0700; salt, at-rest key, token.check and every record are 0600; keys are 32 bytes', async () => {
    const r = rig()
    await r.vault.putSecret(AUTH_A, secret(), SIGNING_POLICY)
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    const mode = (p: string): number => statSync(p).mode & 0o777
    expect(mode(r.keysDir)).to.equal(0o700)
    expect(mode(join(r.keysDir, 'records'))).to.equal(0o700)
    for (const f of [DEVICE_KEY_FILES.salt, DEVICE_KEY_FILES.atRest, DEVICE_KEY_FILES.tokenCheck]) {
      expect(mode(join(r.keysDir, f))).to.equal(0o600)
    }
    expect(statSync(join(r.keysDir, DEVICE_KEY_FILES.salt)).size).to.equal(32)
    expect(statSync(join(r.keysDir, DEVICE_KEY_FILES.atRest)).size).to.equal(32)
    const recs = readdirSync(join(r.keysDir, 'records')).filter((n) => n.endsWith('.rec'))
    expect(recs.length).to.equal(2)
    for (const n of recs) expect(mode(join(r.keysDir, 'records', n))).to.equal(0o600)
  })

  it('openDeviceKeys refuses a 0755 home, a 0644 key, a 31-byte key and a symlinked salt', () => {
    const h1 = join(newHome(), 'vault')
    mkdirSync(h1)
    chmodSync(h1, 0o755)
    expectFileVaultError(thrown(() => openDeviceKeys(h1)), 'home-mode')

    const h2 = join(newHome(), 'vault')
    openDeviceKeys(h2).dispose()
    chmodSync(join(h2, DEVICE_KEY_FILES.atRest), 0o644)
    expectFileVaultError(thrown(() => openDeviceKeys(h2)), 'key-mode')

    const h3 = join(newHome(), 'vault')
    openDeviceKeys(h3).dispose()
    writeFileSync(join(h3, DEVICE_KEY_FILES.atRest), randomBytes(31), { mode: 0o600 })
    expectFileVaultError(thrown(() => openDeviceKeys(h3)), 'key-length')

    const h4 = join(newHome(), 'vault')
    openDeviceKeys(h4).dispose()
    const saltPath = join(h4, DEVICE_KEY_FILES.salt)
    unlinkSync(saltPath)
    symlinkSync(join(h4, DEVICE_KEY_FILES.atRest), saltPath)
    expectFileVaultError(thrown(() => openDeviceKeys(h4)), 'key-not-file')
  })

  it('a record chmodded to 0644 makes the get reject unavailable', async () => {
    const r = rig()
    await r.vault.putSecret(A, secret(), OFFICER_ENCRYPTION_KEY_POLICY)
    chmodSync(recordPath(r, A), 0o644)
    expectVaultError(await rejection(r.vault.getSecret(A)), 'unavailable')
  })

  it('after 10 mixed puts and deletes no .tmp- entry remains anywhere in the home', async () => {
    const r = rig()
    for (let i = 0; i < 10; i++) {
      const alias = `vt.officer-enc.u${i % 4}`
      const policy = i % 3 === 0 ? SIGNING_POLICY : OFFICER_ENCRYPTION_KEY_POLICY
      if (await r.vault.hasSecret(alias)) {
        await r.vault.deleteSecret(alias)
      } else {
        await r.vault.putSecret(alias, secret(), policy)
      }
    }
    expect(findTmp(r.home)).to.deep.equal([])
  })

  it('in-process reopen: new DeviceKeys and a new FileKeyVault read the auth secret (with token) and the at-rest secret (without)', async () => {
    const r = rig()
    const sAuth = secret()
    const sRest = secret()
    await r.vault.putSecret(AUTH_A, sAuth, SIGNING_POLICY)
    await r.vault.putSecret(A, sRest, OFFICER_ENCRYPTION_KEY_POLICY)
    r.keys.dispose()
    const keys2 = openDeviceKeys(r.keysDir)
    const withToken = new FileKeyVault({ keys: keys2, approval: createApprovalContext({ file: r.tokenPath }) })
    expect(same(await withToken.getSecret(AUTH_A), sAuth)).to.equal(true)
    const without = new FileKeyVault({ keys: keys2 })
    expect(same(await without.getSecret(A), sRest)).to.equal(true)
    expectVaultError(await rejection(without.getSecret(AUTH_A)), 'auth-denied')
    keys2.dispose()
  })

  it('no collected error message carries a secret, a token or a temp path', () => {
    expect(errors.length).to.be.at.least(30)
    expect(sensitive.length).to.be.at.least(30)
    const texts: string[] = []
    for (const err of errors) {
      texts.push(String((err as Coded).message ?? ''))
      texts.push(String(err))
    }
    const all = texts.join('\n')
    assertNoLeak(all, sensitive)
    for (const home of homes) expect(all).to.not.include(home)
  })
})
