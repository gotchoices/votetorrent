// call-approval.spec.ts: the per-call approval token plumbing. Verb side (`withCallApproval`): the
// token reaches a verb from a `tokenFile` (re-read on every token() call) or an `approvalToken`
// (a per-call static context, disposed in a finally). Client side (`attachApprovalToken`): the
// `--token-file` / `--token-env` / `--token-stdin` flags. Tokens are generated here and never printed;
// every error message is checked against the token bytes with assertNoLeak.

import { expect } from 'chai'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { APPROVAL_TOKEN_ENV, generateApprovalToken, writeApprovalTokenFile, type ApprovalContext } from '../src/approval/token.js'
import { CALL_APPROVAL_ARG_KEYS, hasCallApproval, withCallApproval } from '../src/approval/call-approval.js'
import { APPROVAL_FLAG_KEYS, attachApprovalToken } from '../src/ctl/approval-transport.js'
import { assertNoLeak } from './support/vault-leak-check.js'

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/
const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

interface Coded {
  name?: string
  code?: string
  message?: string
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (e) {
    return e as Coded
  }
  throw new Error('expected a rejection')
}

describe('call approval', () => {
  let home: string
  let token1: Uint8Array
  let token2: Uint8Array
  const secrets = (): Uint8Array[] => [token1, token2]

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'vt-26-approval-'))
    chmodSync(home, 0o700)
    token1 = generateApprovalToken()
    token2 = generateApprovalToken()
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses token-absent with no source, and the callback never runs', async () => {
    expect(CALL_APPROVAL_ARG_KEYS).to.deep.equal(['tokenFile', 'approvalToken'])
    expect(hasCallApproval({})).to.equal(false)
    expect(hasCallApproval({ tokenFile: '/x' })).to.equal(true)
    let ran = false
    const err = await rejection(withCallApproval({ network: 'x' }, async () => {
      ran = true
    }))
    expect(err.name).to.equal('ApprovalRefusal')
    expect(err.code).to.equal('token-absent')
    expect(err.message).to.equal('approval refused (token-absent)')
    expect(ran).to.equal(false)
  })

  it('refuses token-ambiguous when both sources are present', async () => {
    let ran = false
    const err = await rejection(withCallApproval({ tokenFile: join(home, 'a.token'), approvalToken: encode(token1) }, async () => {
      ran = true
    }))
    expect(err.code).to.equal('token-ambiguous')
    expect(ran).to.equal(false)
    assertNoLeak(String(err.message), secrets())
  })

  it('refuses token-file-not-absolute for a relative tokenFile', async () => {
    const err = await rejection(withCallApproval({ tokenFile: 'secrets/a.token' }, async () => undefined))
    expect(err.code).to.equal('token-file-not-absolute')
    const err2 = await rejection(withCallApproval({ tokenFile: 7 }, async () => undefined))
    expect(err2.code).to.equal('token-file-not-absolute')
  })

  it('refuses token-refused for a malformed approvalToken', async () => {
    for (const bad of ['short', 'not base64url!', encode(token1).slice(0, 20), 'x'.repeat(100), 42]) {
      const err = await rejection(withCallApproval({ approvalToken: bad }, async () => undefined))
      expect(err.code, String(bad).length.toString()).to.equal('token-refused')
      assertNoLeak(String(err.message), secrets())
    }
  })

  it('a valid approvalToken reaches the callback as bytes, is deleted from args, and is disposed after return', async () => {
    const args: Record<string, unknown> = { network: 'h', approvalToken: encode(token1) }
    let seen: ApprovalContext | undefined
    const out = await withCallApproval(args, async (approval) => {
      seen = approval
      const bytes = await approval.token()
      expect(same(bytes, token1)).to.equal(true)
      expect(Object.hasOwn(args, 'approvalToken')).to.equal(false)
      return 'done'
    })
    expect(out).to.equal('done')
    const err = await rejection(seen!.token())
    expect(err.code).to.equal('token-absent')
  })

  it('disposes the static context even when the callback throws', async () => {
    let seen: ApprovalContext | undefined
    const err = await rejection(withCallApproval({ approvalToken: encode(token1) }, async (approval) => {
      seen = approval
      throw new Error('verb failed')
    }))
    expect(err.message).to.equal('verb failed')
    const after = await rejection(seen!.token())
    expect(after.code).to.equal('token-absent')
  })

  it('a tokenFile is re-read on every token() call', async () => {
    const file = join(home, 'reread.token')
    writeApprovalTokenFile(file, token1)
    await withCallApproval({ tokenFile: file }, async (approval) => {
      expect(same(await approval.token(), token1)).to.equal(true)
      rmSync(file)
      writeApprovalTokenFile(file, token2)
      expect(same(await approval.token(), token2)).to.equal(true)
    })
  })

  it('transport: --token-file becomes an absolute path and the file is not opened', async () => {
    expect(APPROVAL_FLAG_KEYS).to.deep.equal(['tokenFile', 'tokenEnv', 'tokenStdin'])
    const r = await attachApprovalToken({ tokenFile: 'secrets/does-not-exist.token', network: 'h' }, { env: {}, stdin: Readable.from([]), cwd: home })
    expect(r.ok).to.equal(true)
    if (r.ok) {
      expect(r.args.tokenFile).to.equal(join(home, 'secrets/does-not-exist.token'))
      expect(r.args.network).to.equal('h')
      expect(Object.hasOwn(r.args, 'approvalToken')).to.equal(false)
    }
    const none = await attachApprovalToken({ network: 'h' }, { env: {}, stdin: Readable.from([]), cwd: home })
    expect(none).to.deep.equal({ ok: true, args: { network: 'h' } })
  })

  it('transport: --token-env and a non-TTY stdin each become a 43-char base64url approvalToken and the flag keys are gone', async () => {
    const env: NodeJS.ProcessEnv = { [APPROVAL_TOKEN_ENV]: encode(token1) }
    const viaEnv = await attachApprovalToken({ tokenEnv: true, network: 'h' }, { env, stdin: Readable.from([]), cwd: home })
    expect(viaEnv.ok).to.equal(true)
    if (viaEnv.ok) {
      expect(String(viaEnv.args.approvalToken)).to.match(B64URL_43)
      expect(same(Buffer.from(String(viaEnv.args.approvalToken), 'base64url'), token1)).to.equal(true)
      expect(Object.hasOwn(viaEnv.args, 'tokenEnv')).to.equal(false)
      expect(Object.keys(viaEnv.args).sort()).to.deep.equal(['approvalToken', 'network'])
    }
    const viaStdin = await attachApprovalToken({ tokenStdin: true }, { env: {}, stdin: Readable.from([encode(token2) + '\n']), cwd: home })
    expect(viaStdin.ok).to.equal(true)
    if (viaStdin.ok) {
      expect(String(viaStdin.args.approvalToken)).to.match(B64URL_43)
      expect(same(Buffer.from(String(viaStdin.args.approvalToken), 'base64url'), token2)).to.equal(true)
      expect(Object.keys(viaStdin.args)).to.deep.equal(['approvalToken'])
    }
    const unset = await attachApprovalToken({ tokenEnv: true }, { env: {}, stdin: Readable.from([]), cwd: home })
    expect(unset).to.deep.equal({ ok: false, code: 'token-absent' })
  })

  it('transport: two sources are token-ambiguous, a TTY stdin is token-tty, a valued flag is token-flag-shape', async () => {
    const env: NodeJS.ProcessEnv = { [APPROVAL_TOKEN_ENV]: encode(token1) }
    const two = await attachApprovalToken({ tokenFile: '/abs/a.token', tokenEnv: true }, { env, stdin: Readable.from([]), cwd: home })
    expect(two).to.deep.equal({ ok: false, code: 'token-ambiguous' })
    const tty = Readable.from([]) as Readable & { isTTY?: boolean }
    tty.isTTY = true
    const viaTty = await attachApprovalToken({ tokenStdin: true }, { env: {}, stdin: tty, cwd: home })
    expect(viaTty).to.deep.equal({ ok: false, code: 'token-tty' })
    for (const shape of [{ tokenFile: true }, { tokenEnv: 'x' }, { tokenStdin: 'yes' }, { tokenEnv: false }]) {
      const r = await attachApprovalToken(shape, { env, stdin: Readable.from([]), cwd: home })
      expect(r, JSON.stringify(Object.keys(shape))).to.deep.equal({ ok: false, code: 'token-flag-shape' })
    }
  })
})
