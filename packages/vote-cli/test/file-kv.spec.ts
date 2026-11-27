// The plain 0600 KvStorage file store and the at-rest-sealed KeyVaultStorage, plus openDeviceVault's
// layout. Fresh mkdtemp homes per case; every value is generated in-test.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDeviceKeys } from '../src/vault/device-keys.js'
import { DEFAULT_KEY_VAULT_STORAGE_FILE, DEFAULT_VAULT_DIR, openDeviceVault } from '../src/vault/device-vault.js'
import { FileKvError, openFileKv, openSealedFileKv } from '../src/vault/file-kv.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown }

const homes: string[] = []
const IDENTITY_KEY = 'vt.keyholder-identities.v1'

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'vt-13-'))
  homes.push(home)
  return home
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    return err as Coded
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    return err as Coded
  }
  throw new Error('expected a throw')
}

function expectKvError(err: Coded, code: FileKvError['code']): void {
  expect(err.name).to.equal('FileKvError')
  expect(err.code).to.equal(code)
}

function value(): string {
  return randomBytes(24).toString('base64url')
}

function findTmp(dir: string): string[] {
  const hits: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes('.tmp-')) hits.push(entry.name)
    if (entry.isDirectory()) hits.push(...findTmp(join(dir, entry.name)))
  }
  return hits
}

function flipCt(path: string): void {
  const file = JSON.parse(readFileSync(path, 'utf8')) as { ct: string }
  const ct = Buffer.from(file.ct, 'base64')
  ct[0] = ct[0]! ^ 0x01
  file.ct = ct.toString('base64')
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 })
}

describe('file kv', () => {
  after(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true })
  })

  it('plain round trip for set, get and remove; an absent key returns null', async () => {
    const kv = openFileKv({ path: join(newHome(), 'kv', 'store.json') })
    const v = value()
    expect(await kv.getItem('k')).to.equal(null)
    await kv.setItem('k', v)
    expect(await kv.getItem('k')).to.equal(v)
    expect(kv.keys()).to.deep.equal(['k'])
    await kv.removeItem('k')
    expect(await kv.getItem('k')).to.equal(null)
    await kv.removeItem('k')
    kv.close()
  })

  it('a non-string value rejects kv-value', async () => {
    const kv = openFileKv({ path: join(newHome(), 'store.json') })
    expectKvError(await rejection(kv.setItem('k', 1 as unknown as string)), 'kv-value')
    expectKvError(await rejection(kv.setItem('k', { a: 1 } as unknown as string)), 'kv-value')
    expect(await kv.getItem('k')).to.equal(null)
    kv.close()
  })

  it('the file is 0600, its parent 0700, and its content plain JSON holding the value', async () => {
    const path = join(newHome(), 'kv', 'store.json')
    const kv = openFileKv({ path })
    const v = value()
    await kv.setItem('k', v)
    expect(statSync(path).mode & 0o777).to.equal(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).to.equal(0o700)
    expect(JSON.parse(readFileSync(path, 'utf8'))).to.deep.equal({ k: v })
    kv.close()
  })

  it('close then reopen reads the values', async () => {
    const path = join(newHome(), 'store.json')
    const kv = openFileKv({ path })
    const v1 = value()
    const v2 = value()
    await kv.setItem('a', v1)
    await kv.setItem('b', v2)
    kv.close()
    const again = openFileKv({ path })
    expect(await again.getItem('a')).to.equal(v1)
    expect(await again.getItem('b')).to.equal(v2)
    expect(again.keys().sort()).to.deep.equal(['a', 'b'])
    again.close()
  })

  it('a second open of an open path throws kv-path-open; an open after close succeeds', () => {
    const home = newHome()
    const path = join(home, 'store.json')
    const kv = openFileKv({ path })
    expectKvError(thrown(() => openFileKv({ path })), 'kv-path-open')
    expectKvError(thrown(() => openFileKv({ path: join(home, '.', 'store.json') })), 'kv-path-open')
    kv.close()
    const again = openFileKv({ path })
    again.close()
  })

  it('after close, getItem rejects kv-closed', async () => {
    const kv = openFileKv({ path: join(newHome(), 'store.json') })
    kv.close()
    kv.close()
    expectKvError(await rejection(kv.getItem('k')), 'kv-closed')
    expectKvError(await rejection(kv.setItem('k', 'v')), 'kv-closed')
    expectKvError(await rejection(kv.removeItem('k')), 'kv-closed')
    expectKvError(thrown(() => kv.keys()), 'kv-closed')
  })

  it('corrupt JSON throws kv-corrupt and leaves the file bytes unchanged', () => {
    const path = join(newHome(), 'store.json')
    for (const text of ['{not json', '[1,2]', '{"k": 1}', 'null']) {
      writeFileSync(path, text, { mode: 0o600 })
      const before = readFileSync(path)
      expectKvError(thrown(() => openFileKv({ path })), 'kv-corrupt')
      expect(readFileSync(path).equals(before)).to.equal(true)
    }
    const ok = openFileKv({ path: join(newHome(), 'absent.json') })
    ok.close()
  })

  it('a file chmodded to 0644 throws kv-mode', async () => {
    const path = join(newHome(), 'store.json')
    const kv = openFileKv({ path })
    await kv.setItem('k', value())
    kv.close()
    chmodSync(path, 0o644)
    expectKvError(thrown(() => openFileKv({ path })), 'kv-mode')
  })

  it('after 20 sets no .tmp- file remains', async () => {
    const home = newHome()
    const kv = openFileKv({ path: join(home, 'store.json') })
    for (let i = 0; i < 20; i++) await kv.setItem(`k${i}`, value())
    expect(kv.keys().length).to.equal(20)
    expect(findTmp(home)).to.deep.equal([])
    kv.close()
  })

  it('sealed: the file bytes hold neither the key name nor the value', async () => {
    const home = newHome()
    const keys = openDeviceKeys(join(home, 'vault'))
    const path = join(home, 'vault', 'ids.sealed.json')
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    const raw = randomBytes(24)
    await store.setItem(IDENTITY_KEY, raw.toString('base64url'))
    const text = readFileSync(path, 'utf8')
    assertNoLeak(text, [raw])
    expect(text).to.not.include(IDENTITY_KEY)
    expect(text).to.not.include('keyholder')
    expect(statSync(path).mode & 0o777).to.equal(0o600)
    store.close()
    keys.dispose()
  })

  it('sealed: close and reopen with new DeviceKeys on the same dir reads the identity back', async () => {
    const home = newHome()
    const vaultDir = join(home, 'vault')
    const path = join(vaultDir, 'ids.sealed.json')
    const keys = openDeviceKeys(vaultDir)
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    const v = value()
    await store.setItem(IDENTITY_KEY, v)
    store.close()
    keys.dispose()
    const keys2 = openDeviceKeys(vaultDir)
    const again = openSealedFileKv({ path, keys: keys2, label: 'ids' })
    expect(await again.getItem(IDENTITY_KEY)).to.equal(v)
    again.close()
    keys2.dispose()
  })

  it('sealed: a one-byte flip in ct throws kv-corrupt at open', async () => {
    const home = newHome()
    const vaultDir = join(home, 'vault')
    const path = join(vaultDir, 'ids.sealed.json')
    const keys = openDeviceKeys(vaultDir)
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    await store.setItem(IDENTITY_KEY, value())
    store.close()
    flipCt(path)
    expectKvError(thrown(() => openSealedFileKv({ path, keys, label: 'ids' })), 'kv-corrupt')
    keys.dispose()
  })

  it('sealed: reopening with another label throws kv-corrupt', async () => {
    const home = newHome()
    const vaultDir = join(home, 'vault')
    const path = join(vaultDir, 'ids.sealed.json')
    const keys = openDeviceKeys(vaultDir)
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    await store.setItem(IDENTITY_KEY, value())
    store.close()
    expectKvError(thrown(() => openSealedFileKv({ path, keys, label: 'other' })), 'kv-corrupt')
    keys.dispose()
  })

  it('sealed: opening the file with keys from a different home throws kv-corrupt', async () => {
    const home = newHome()
    const vaultDir = join(home, 'vault')
    const path = join(vaultDir, 'ids.sealed.json')
    const keys = openDeviceKeys(vaultDir)
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    await store.setItem(IDENTITY_KEY, value())
    store.close()
    keys.dispose()
    const foreign = openDeviceKeys(join(newHome(), 'vault'))
    expectKvError(thrown(() => openSealedFileKv({ path, keys: foreign, label: 'ids' })), 'kv-corrupt')
    foreign.dispose()
  })

  it('sealed: two consecutive writes leave different nonce values', async () => {
    const home = newHome()
    const vaultDir = join(home, 'vault')
    const path = join(vaultDir, 'ids.sealed.json')
    const keys = openDeviceKeys(vaultDir)
    const store = openSealedFileKv({ path, keys, label: 'ids' })
    const nonceOf = (): string => (JSON.parse(readFileSync(path, 'utf8')) as { nonce: string }).nonce
    const n0 = nonceOf()
    await store.setItem('a', value())
    const n1 = nonceOf()
    await store.setItem('a', value())
    const n2 = nonceOf()
    expect(n0).to.not.equal(n1)
    expect(n1).to.not.equal(n2)
    store.close()
    keys.dispose()
  })

  it('an invalid label throws kv-value', () => {
    const home = newHome()
    const keys = openDeviceKeys(join(home, 'vault'))
    const path = join(home, 'vault', 'x.sealed.json')
    expectKvError(thrown(() => openSealedFileKv({ path, keys, label: 'Has Space' })), 'kv-value')
    expectKvError(thrown(() => openSealedFileKv({ path, keys, label: '' })), 'kv-value')
    keys.dispose()
  })

  it('openDeviceVault lays out vault/ at 0700 with the sealed store at 0600, and close makes the storage reject kv-closed', async () => {
    const home = join(newHome(), 'device')
    const dv = openDeviceVault({ home })
    const vaultDir = join(home, DEFAULT_VAULT_DIR)
    expect(statSync(home).mode & 0o777).to.equal(0o700)
    expect(statSync(vaultDir).mode & 0o777).to.equal(0o700)
    expect(statSync(join(vaultDir, DEFAULT_KEY_VAULT_STORAGE_FILE)).mode & 0o777).to.equal(0o600)
    expect(statSync(join(vaultDir, 'records')).mode & 0o777).to.equal(0o700)
    const v = value()
    await dv.storage.setItem(IDENTITY_KEY, v)
    expect(await dv.vault.hasSecret('vt.officer-enc.u1')).to.equal(false)
    dv.close()
    dv.close()
    expectKvError(await rejection(dv.storage.getItem(IDENTITY_KEY)), 'kv-closed')
    const again = openDeviceVault({ home })
    expect(await again.storage.getItem(IDENTITY_KEY)).to.equal(v)
    again.close()
  })
})
