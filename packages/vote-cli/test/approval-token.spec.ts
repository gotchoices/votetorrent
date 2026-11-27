// The approval token: generate, write 0600 create-once, and read from a file, an env var or stdin,
// with every refusal code exercised. Tokens are generated in-test; no key-length literal lives here,
// and the env var under test has an in-test generated name (the real constant is referenced by name).

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  APPROVAL_TOKEN_BYTES,
  APPROVAL_TOKEN_ENV,
  NO_APPROVAL,
  createApprovalContext,
  createStaticApprovalContext,
  generateApprovalToken,
  readApprovalToken,
  writeApprovalTokenFile,
  type ApprovalTokenError
} from '../src/approval/token.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown, stack?: unknown }

const errors: unknown[] = []
const tokens: Uint8Array[] = []

function remember(err: unknown): Coded {
  errors.push(err)
  return err as Coded
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    return remember(err)
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    return remember(err)
  }
  throw new Error('expected a throw')
}

function expectTokenError(err: Coded, code: ApprovalTokenError['code']): void {
  expect(err.name).to.equal('ApprovalTokenError')
  expect(err.code).to.equal(code)
}

function fresh(): Uint8Array {
  const t = generateApprovalToken()
  tokens.push(t)
  return t
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

describe('approval token', () => {
  let home: string
  let n = 0
  const envNames: string[] = []

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'vt-13-'))
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  afterEach(() => {
    for (const name of envNames.splice(0)) delete process.env[name]
  })

  function freshPath(): string {
    n++
    return join(home, `t${n}`, 'token')
  }

  it('generateApprovalToken returns 32 bytes and two calls differ', () => {
    const a = fresh()
    const b = fresh()
    expect(APPROVAL_TOKEN_BYTES).to.equal(32)
    expect(a.length).to.equal(32)
    expect(b.length).to.equal(32)
    expect(a).to.be.instanceOf(Uint8Array)
    expect(equalBytes(a, b)).to.equal(false)
  })

  it('write then read round-trips; the file is 0600 and its created parent 0700', async () => {
    const path = freshPath()
    const t = fresh()
    writeApprovalTokenFile(path, t)
    const got = await readApprovalToken({ file: path })
    expect(equalBytes(got, t)).to.equal(true)
    expect(statSync(path).mode & 0o777).to.equal(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).to.equal(0o700)
  })

  it('a second write on the same path throws token-exists and leaves the file unchanged', () => {
    const path = freshPath()
    writeApprovalTokenFile(path, fresh())
    const before = readFileSync(path)
    const err = thrown(() => writeApprovalTokenFile(path, fresh()))
    expectTokenError(err, 'token-exists')
    expect(readFileSync(path).equals(before)).to.equal(true)
  })

  it('modes 0640, 0604 and 0620 each throw token-mode', async () => {
    for (const mode of [0o640, 0o604, 0o620]) {
      const path = freshPath()
      writeApprovalTokenFile(path, fresh())
      chmodSync(path, mode)
      const err = await rejection(readApprovalToken({ file: path }))
      expectTokenError(err, 'token-mode')
    }
  })

  it('mode 0400 is accepted (positive control)', async () => {
    const path = freshPath()
    const t = fresh()
    writeApprovalTokenFile(path, t)
    chmodSync(path, 0o400)
    const got = await readApprovalToken({ file: path })
    expect(equalBytes(got, t)).to.equal(true)
  })

  it('a symlink to a valid 0600 token throws token-not-file', async () => {
    const path = freshPath()
    writeApprovalTokenFile(path, fresh())
    const link = join(path, '..', 'link')
    symlinkSync(path, link)
    const err = await rejection(readApprovalToken({ file: link }))
    expectTokenError(err, 'token-not-file')
  })

  it('a directory path throws token-not-file', async () => {
    const dir = join(home, 'a-directory')
    mkdirSync(dir, { mode: 0o700 })
    const err = await rejection(readApprovalToken({ file: dir }))
    expectTokenError(err, 'token-not-file')
  })

  it('a missing path throws token-absent', async () => {
    const err = await rejection(readApprovalToken({ file: join(home, 'nope', 'token') }))
    expectTokenError(err, 'token-absent')
  })

  it('expectedUid set to another uid throws token-owner', async () => {
    const path = freshPath()
    writeApprovalTokenFile(path, fresh())
    const uid = process.getuid?.() ?? 0
    const err = await rejection(readApprovalToken({ file: path }, { expectedUid: uid + 1 }))
    expectTokenError(err, 'token-owner')
  })

  it('a 16-byte token as base64url and as hex each throws token-short', async () => {
    const short = randomBytes(16)
    tokens.push(Uint8Array.from(short))
    for (const text of [short.toString('base64url'), short.toString('hex')]) {
      const path = freshPath()
      mkdirSync(join(path, '..'), { mode: 0o700 })
      writeFileSync(path, `${text}\n`, { mode: 0o600 })
      const err = await rejection(readApprovalToken({ file: path }))
      expectTokenError(err, 'token-short')
    }
  })

  it('malformed text, over 1024 characters, and a 65-byte value each throw token-format', async () => {
    const long = randomBytes(65)
    tokens.push(Uint8Array.from(long))
    const texts = ['not a token!', 'a'.repeat(1100), long.toString('hex')]
    for (const text of texts) {
      const path = freshPath()
      mkdirSync(join(path, '..'), { mode: 0o700 })
      writeFileSync(path, `${text}\n`, { mode: 0o600 })
      const err = await rejection(readApprovalToken({ file: path }))
      expectTokenError(err, 'token-format')
    }
  })

  it('a 64-character hex token is accepted', async () => {
    const t = fresh()
    const path = freshPath()
    mkdirSync(join(path, '..'), { mode: 0o700 })
    writeFileSync(path, `${Buffer.from(t).toString('hex')}\n`, { mode: 0o600 })
    const got = await readApprovalToken({ file: path })
    expect(equalBytes(got, t)).to.equal(true)
  })

  it('env source round-trips; unset and empty each throw token-absent', async () => {
    const name = `VT13_${randomBytes(4).toString('hex').toUpperCase()}`
    envNames.push(name)
    expect(name).to.not.equal(APPROVAL_TOKEN_ENV)
    expect(typeof APPROVAL_TOKEN_ENV).to.equal('string')
    const t = fresh()
    process.env[name] = Buffer.from(t).toString('base64url')
    const got = await readApprovalToken({ env: name })
    expect(equalBytes(got, t)).to.equal(true)
    delete process.env[name]
    expectTokenError(await rejection(readApprovalToken({ env: name })), 'token-absent')
    process.env[name] = ''
    expectTokenError(await rejection(readApprovalToken({ env: name })), 'token-absent')
  })

  it('stdin source round-trips; a TTY throws token-tty; an empty stream throws token-absent', async () => {
    const t = fresh()
    const ok = new PassThrough()
    ok.end(`${Buffer.from(t).toString('base64url')}\n`)
    const got = await readApprovalToken({ stdin: true, stream: ok })
    expect(equalBytes(got, t)).to.equal(true)

    const tty = Object.assign(new PassThrough(), { isTTY: true })
    tty.end(`${Buffer.from(t).toString('base64url')}\n`)
    expectTokenError(await rejection(readApprovalToken({ stdin: true, stream: tty })), 'token-tty')

    const empty = new PassThrough()
    empty.end()
    expectTokenError(await rejection(readApprovalToken({ stdin: true, stream: empty })), 'token-absent')
  })

  it('createApprovalContext re-reads the file on every call', async () => {
    const path = freshPath()
    const t1 = fresh()
    const t2 = fresh()
    writeApprovalTokenFile(path, t1)
    const ctx = createApprovalContext({ file: path })
    const a = await ctx.token()
    expect(equalBytes(a, t1)).to.equal(true)
    unlinkSync(path)
    writeApprovalTokenFile(path, t2)
    const b = await ctx.token()
    expect(equalBytes(b, t2)).to.equal(true)
    expect(a).to.not.equal(b)
  })

  it('createStaticApprovalContext returns copies, rejects after dispose, and refuses 31 bytes', async () => {
    const t = fresh()
    const ctx = createStaticApprovalContext(t)
    const a = await ctx.token()
    a[0] = a[0]! ^ 0xff
    const b = await ctx.token()
    expect(equalBytes(b, t)).to.equal(true)
    expect(a).to.not.equal(b)
    ctx.dispose()
    expectTokenError(await rejection(ctx.token()), 'token-absent')
    const short = randomBytes(31)
    tokens.push(Uint8Array.from(short))
    expectTokenError(thrown(() => createStaticApprovalContext(Uint8Array.from(short))), 'token-short')
  })

  it('NO_APPROVAL.token() rejects token-absent', async () => {
    expectTokenError(await rejection(NO_APPROVAL.token()), 'token-absent')
    expect(Object.isFrozen(NO_APPROVAL)).to.equal(true)
  })

  it('no collected error text carries a token or the temp path', () => {
    expect(errors.length).to.be.at.least(20)
    expect(tokens.length).to.be.greaterThan(10)
    const texts: string[] = []
    for (const err of errors) {
      const e = err as Coded
      texts.push(String(e.message ?? ''))
      texts.push(String(err))
      texts.push(String(e.stack ?? '').split('\n')[0] ?? '')
    }
    const all = texts.join('\n')
    assertNoLeak(all, tokens)
    expect(all).to.not.include(home)
  })
})
