/**
 * rethrow-preserves-code.spec.ts — the engine boundary must not strip a device-signing error's `code`.
 *
 * The device signer throws an Error carrying `code` (e.g. KEY_INVALIDATED_REASSOCIATE). The app
 * routes the officer to Replace Signing Key by that code, never by message text. Every `rethrow`
 * used to rebuild the Error from `err.message` only, so the code vanished at the engine boundary
 * and the officer was stuck on a generic "try again" loop.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MisuseError, QuereusError, StatusCode } from '@quereus/quereus'
import { rethrow } from '../src/signing/ceremony-helpers.js'
import { createTestNetwork, addTestAuthority, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'

function caught (fn: () => never): Error & { code?: unknown } {
  try {
    fn()
  } catch (e) {
    return e as Error & { code?: unknown }
  }
  throw new Error('expected a throw')
}

function coded (message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('rethrow preserves code', () => {
  it('shared rethrow keeps code and the engine-labelled message prefix', () => {
    const e = caught(() => rethrow(coded('boom', 'KEY_INVALIDATED_REASSOCIATE'), 'XEngine', 'doIt'))
    expect(e.code).to.equal('KEY_INVALIDATED_REASSOCIATE')
    expect(e.message).to.equal('XEngine.doIt: boom')
  })

  it('shared rethrow of an Error without code adds no code property', () => {
    const e = caught(() => rethrow(new Error('boom'), 'XEngine', 'doIt'))
    expect(Object.prototype.hasOwnProperty.call(e, 'code')).to.equal(false)
    expect(e.message).to.equal('XEngine.doIt: boom')
  })

  it('shared rethrow ignores a non-string code', () => {
    const e = caught(() => rethrow(Object.assign(new Error('boom'), { code: 42 }), 'XEngine', 'doIt'))
    expect(Object.prototype.hasOwnProperty.call(e, 'code')).to.equal(false)
  })

  it('Quereus and Misuse errors keep their existing shape', () => {
    const q = caught(() => rethrow(new QuereusError('bad', StatusCode.ERROR), 'XEngine', 'doIt'))
    expect(q.message).to.equal(`Quereus error (code ${StatusCode.ERROR}): bad`)
    // MisuseError extends QuereusError, so the Quereus branch wins — pinned as it is today.
    const m = caught(() => rethrow(new MisuseError('nope'), 'XEngine', 'doIt'))
    expect(m.message).to.equal(`Quereus error (code ${StatusCode.MISUSE}): nope`)
    expect(caught(() => rethrow('str', 'XEngine', 'doIt')).message).to.equal('XEngine.doIt: unknown error: str')
  })

  it('RegistrationEngine.rejectRegistrationRequest hands the caller the signer error code', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const requester = randomTestKeyPair()
    const engine = new RegistrationEngine(auth.ctx)
    const payload: RegisterInit = {
      registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] },
    }
    const init: RegistrationRequestInit = { id: crypto.randomUUID(), authorityId: auth.authority.id, payload, submittedAt: toIsoZDatetime(Date.now()) }
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex, hexToBytes } = await import('@noble/curves/utils.js')
    const priv = hexToBytes(requester.privateHex)
    const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, async (d: Uint8Array): Promise<Signature> => ({
      signature: bytesToHex(secp256k1.sign(d, priv)), signerKey: requester.publicHex, signerUserId: '',
    }))

    let thrown: (Error & { code?: unknown }) | undefined
    try {
      await engine.rejectRegistrationRequest(
        requestId,
        { checklist: ['id'], rejectionReason: 'Photo ID did not match the roll entry' },
        async () => { throw coded('Key permanently invalidated', 'KEY_INVALIDATED_REASSOCIATE') }
      )
    } catch (e) {
      thrown = e as Error & { code?: unknown }
    }
    expect(thrown, 'rejectRegistrationRequest should throw').to.not.equal(undefined)
    expect(thrown!.code).to.equal('KEY_INVALIDATED_REASSOCIATE')
    expect(thrown!.message).to.match(/^RegistrationEngine\.rejectRegistrationRequest: /)
  })

  it('every private rethrow in vote-engine src delegates to the shared helper or preserves code', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    const offenders: string[] = []
    let seen = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const re = /private rethrow ?\(/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        seen++
        // body = up to the next blank-line-separated member; 1500 chars is ample for a rethrow.
        const body = src.slice(m.index, m.index + 1500).split(/\n  (?:private|async|public|protected|\/\*\*)|\n\t(?:private|async|public|protected|\/\*\*)/)[0]
        if (!/rethrowHelper|Object\.assign/.test(body)) offenders.push(f)
      }
    }
    expect(seen, 'found the private rethrow copies').to.be.greaterThan(10)
    expect(offenders, `private rethrow copies that strip code: ${offenders.join(', ')}`).to.deep.equal([])
  })
})
