// The token-gated software signer: acceptance under the schema's own SQL verifiers and every refusal
// path. Each case gets a fresh device home and in-test tokens; no key, token or digest literal appears
// here. Error codes are read structurally (name + code), never with instanceof.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { verifySigP256 } from '@votetorrent/vote-engine/rn'
import type { IKeyVault, KeyVaultPolicy } from '@votetorrent/vote-engine/rn'
import {
  NO_APPROVAL,
  createApprovalContext,
  generateApprovalToken,
  writeApprovalTokenFile,
  type ApprovalContext
} from '../src/approval/token.js'
import {
  TOKEN_SIGNING_PUBLIC_KEY_POLICY,
  createTokenSigner,
  deleteTokenSigningKey,
  provisionTokenSigningKey,
  readTokenSigningPublicKey,
  tokenSigningPublicKeyAlias,
  type ApprovalScopedVault,
  type TokenSignerCurve
} from '../src/approval/signer.js'
import { openDeviceVault, type DeviceVault } from '../src/vault/device-vault.js'
import type { FileKeyVault } from '../src/vault/file-vault.js'
import { digestText, schemaSignatureValid } from './support/schema-signature.js'
import { assertNoLeak } from './support/vault-leak-check.js'

type Coded = { name?: unknown, code?: unknown, message?: unknown, cause?: unknown }

interface CountingContext extends ApprovalContext {
  readonly calls: number
}

/** Records every `token()` call before delegating. */
function counting(inner: ApprovalContext): CountingContext {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    token() {
      calls++
      return inner.token()
    }
  }
}

type SpyVault = ApprovalScopedVault & { readonly recorded: Uint8Array[] }
type CountedVault = IKeyVault & { readonly authPromptCount: number }

/** Wraps the real vault so every array `getSecret` returns (on any view) is recorded for the zero-fill check. */
function spyVault(real: FileKeyVault): SpyVault {
  const recorded: Uint8Array[] = []
  const wrap = (v: FileKeyVault): CountedVault => ({
    get authPromptCount() {
      return v.authPromptCount
    },
    putSecret: (alias: string, secret: Uint8Array, policy: KeyVaultPolicy) => v.putSecret(alias, secret, policy),
    hasSecret: (alias: string) => v.hasSecret(alias),
    deleteSecret: (alias: string) => v.deleteSecret(alias),
    async getSecret(alias: string) {
      const out = await v.getSecret(alias)
      if (out !== null) recorded.push(out)
      return out
    }
  })
  const root = wrap(real)
  const spy: SpyVault = {
    recorded,
    get authPromptCount() {
      return root.authPromptCount
    },
    putSecret: root.putSecret,
    hasSecret: root.hasSecret,
    deleteSecret: root.deleteSecret,
    getSecret: root.getSecret,
    withApproval: (approval: ApprovalContext) => wrap(real.withApproval(approval))
  }
  return spy
}

async function rejection(p: Promise<unknown>): Promise<Coded> {
  try {
    await p
  } catch (err) {
    caught.push(err)
    return err as Coded
  }
  throw new Error('expected a rejection')
}

function thrown(fn: () => unknown): Coded {
  try {
    fn()
  } catch (err) {
    caught.push(err)
    return err as Coded
  }
  throw new Error('expected a throw')
}

function expectSignerError(err: Coded, code: string): void {
  expect(err.name).to.equal('TokenSignerError')
  expect(err.code).to.equal(code)
}

function digest(): Uint8Array {
  const d = Uint8Array.from(randomBytes(32))
  sensitive.push(d)
  return d
}

const ALIAS = 'vt.officer.signing'
const USER = 'officer-user-1'
const COMPRESSED_RE = /^(02|03)[0-9a-f]{64}$/

const caught: unknown[] = []
const sensitive: Uint8Array[] = []
const collected: Array<{ curve: TokenSignerCurve, sig: string, d: Uint8Array, key: string }> = []

let home: string
let dv: DeviceVault
let goodToken: Uint8Array
let wrongToken: Uint8Array
let goodPath: string
let wrongPath: string
let good: CountingContext
let wrong: CountingContext

describe('token signer', function () {
  this.timeout(30_000)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vt-20-'))
    goodToken = generateApprovalToken()
    wrongToken = generateApprovalToken()
    sensitive.push(goodToken, wrongToken)
    goodPath = join(home, 'secrets', 'approval.token')
    wrongPath = join(home, 'secrets', 'wrong.token')
    writeApprovalTokenFile(goodPath, goodToken)
    writeApprovalTokenFile(wrongPath, wrongToken)
    good = counting(createApprovalContext({ file: goodPath }))
    wrong = counting(createApprovalContext({ file: wrongPath }))
    dv = openDeviceVault({ home })
  })

  afterEach(() => {
    dv.close()
    rmSync(home, { recursive: true, force: true })
  })

  async function provision(curve: TokenSignerCurve, alias = ALIAS): Promise<string> {
    const { publicKey } = await provisionTokenSigningKey({ vault: dv.vault, token: good, curve, alias })
    return publicKey
  }

  it('1 provisions a secp256k1 key as 66-char compressed hex and reads the public half with no token call', async () => {
    const publicKey = await provision('secp256k1')
    expect(publicKey).to.match(COMPRESSED_RE)
    const before = good.calls
    expect(await readTokenSigningPublicKey({ vault: dv.vault, alias: ALIAS })).to.equal(publicKey)
    expect(good.calls).to.equal(before)
    expect(tokenSigningPublicKeyAlias(ALIAS)).to.equal(`${ALIAS}.pub`)
  })

  it('2 signs 8 digests with secp256k1 and each verifies under SQL SignatureValid with the provisioned key', async () => {
    const key = await provision('secp256k1')
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    for (let i = 0; i < 8; i++) {
      const d = digest()
      const out = await sign(d)
      expect(out.signerKey).to.equal(key)
      expect(out.signerUserId).to.equal(USER)
      expect(out.signature).to.match(/^[0-9a-f]{128}$/)
      expect(await schemaSignatureValid('secp256k1', d, out.signature, key)).to.equal(true)
      collected.push({ curve: 'secp256k1', sig: out.signature, d, key })
    }
  })

  it('3 signs 8 digests with p256 and each verifies under SQL SignatureValidP256 and verifySigP256', async () => {
    const key = await provision('p256')
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'p256', alias: ALIAS, signerUserId: '' })
    for (let i = 0; i < 8; i++) {
      const d = digest()
      const out = await sign(d)
      expect(out.signerKey).to.equal(key)
      expect(out.signerUserId).to.equal('')
      expect(await schemaSignatureValid('p256', d, out.signature, key)).to.equal(true)
      expect(verifySigP256(digestText(d), out.signature, key)).to.equal(true)
      collected.push({ curve: 'p256', sig: out.signature, d, key })
    }
  })

  it('4 prehash control: a prehash:false P-256 signature over the digest is refused by SignatureValidP256, prehash:true is accepted', async () => {
    const k = p256.utils.randomSecretKey()
    sensitive.push(k)
    const key = bytesToHex(p256.getPublicKey(k, true))
    const d = digest()
    const raw = bytesToHex(p256.sign(d, k, { prehash: false, lowS: true }))
    const hashed = bytesToHex(p256.sign(d, k, { prehash: true, lowS: true }))
    expect(await schemaSignatureValid('p256', d, raw, key)).to.equal(false)
    expect(await schemaSignatureValid('p256', d, hashed, key)).to.equal(true)
    k.fill(0)
  })

  it('5 all 16 token signatures are low-S, and a high-S variant of a p256 one is refused by SignatureValidP256', async () => {
    expect(collected.length).to.equal(16)
    for (const c of collected) {
      const curve = c.curve === 'p256' ? p256 : secp256k1
      expect(curve.Signature.fromBytes(hexToBytes(c.sig), 'compact').hasHighS()).to.equal(false)
    }
    const sample = collected.find((c) => c.curve === 'p256')
    expect(sample).to.not.equal(undefined)
    if (sample === undefined) return
    const parsed = p256.Signature.fromBytes(hexToBytes(sample.sig), 'compact')
    const n = p256.Point.CURVE().n
    const high = new p256.Signature(parsed.r, n - parsed.s)
    expect(high.hasHighS()).to.equal(true)
    const highHex = bytesToHex(high.toBytes('compact'))
    // the variant is a valid ECDSA signature when low-S is not enforced, so only the low-S rule refuses it
    expect(p256.verify(hexToBytes(highHex), sample.d, hexToBytes(sample.key), { lowS: false, prehash: true })).to.equal(true)
    expect(await schemaSignatureValid('p256', sample.d, highHex, sample.key)).to.equal(false)
  })

  it('6 NO_APPROVAL rejects token-refused with cause auth-denied and no signature', async () => {
    await provision('secp256k1')
    const sign = createTokenSigner({ vault: dv.vault, token: NO_APPROVAL, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    const err = await rejection(sign(digest()))
    expectSignerError(err, 'token-refused')
    expect((err.cause as Coded | undefined)?.code).to.equal('auth-denied')
  })

  it('7 the wrong token rejects token-refused', async () => {
    await provision('secp256k1')
    const sign = createTokenSigner({ vault: dv.vault, token: wrong, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    expectSignerError(await rejection(sign(digest())), 'token-refused')
    expect(wrong.calls).to.equal(1)
  })

  it('8 an absent token file rejects token-refused', async () => {
    await provision('p256')
    const absent = createApprovalContext({ file: join(home, 'secrets', 'missing.token') })
    const sign = createTokenSigner({ vault: dv.vault, token: absent, curve: 'p256', alias: ALIAS, signerUserId: '' })
    expectSignerError(await rejection(sign(digest())), 'token-refused')
  })

  it('9 a group-readable (0640) token file rejects token-refused', async () => {
    await provision('p256')
    chmodSync(goodPath, 0o640)
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'p256', alias: ALIAS, signerUserId: '' })
    expectSignerError(await rejection(sign(digest())), 'token-refused')
  })

  it('10 zero-fills every unwrapped key array after a success and after a key-mismatch refusal', async () => {
    const spy = spyVault(dv.vault)
    const key = await provisionTokenSigningKey({ vault: spy, token: good, curve: 'secp256k1', alias: ALIAS })
    const ok = createTokenSigner({ vault: spy, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    const out = await ok(digest())
    expect(out.signerKey).to.equal(key.publicKey)
    const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const bad = createTokenSigner({ vault: spy, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER, signerKey: other })
    expectSignerError(await rejection(bad(digest())), 'key-mismatch')
    // the public-half read and the two private unwraps
    expect(spy.recorded.length).to.equal(3)
    for (const arr of spy.recorded) expect(arr.every((b) => b === 0)).to.equal(true)
  })

  it('11 an explicit wrong signerKey rejects key-mismatch', async () => {
    await provision('p256')
    const other = bytesToHex(p256.getPublicKey(p256.utils.randomSecretKey(), true))
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'p256', alias: ALIAS, signerUserId: '', signerKey: other })
    expectSignerError(await rejection(sign(digest())), 'key-mismatch')
  })

  it('12 an unprovisioned alias rejects key-absent, without and with an explicit signerKey', async () => {
    const plain = createTokenSigner({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    expectSignerError(await rejection(plain(digest())), 'key-absent')
    const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const explicit = createTokenSigner({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER, signerKey: other })
    expectSignerError(await rejection(explicit(digest())), 'key-absent')
    expect(good.calls).to.equal(0)
  })

  it('13 a signing record stored without token gating rejects key-policy even with no token', async () => {
    const k = secp256k1.utils.randomSecretKey()
    sensitive.push(k)
    const pub = bytesToHex(secp256k1.getPublicKey(k, true))
    await dv.vault.putSecret(ALIAS, k, { requireUserAuth: false })
    await dv.vault.putSecret(tokenSigningPublicKeyAlias(ALIAS), Buffer.from(pub, 'utf8'), TOKEN_SIGNING_PUBLIC_KEY_POLICY)
    const before = dv.vault.authPromptCount
    const sign = createTokenSigner({ vault: dv.vault, token: NO_APPROVAL, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    expectSignerError(await rejection(sign(digest())), 'key-policy')
    expect(dv.vault.authPromptCount).to.equal(before)
    k.fill(0)
  })

  it('14 a second provision on the same alias rejects key-exists with no token call and the first key unchanged', async () => {
    const first = await provision('secp256k1')
    const callsAfterFirst = good.calls
    expectSignerError(await rejection(provisionTokenSigningKey({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS })), 'key-exists')
    expect(good.calls).to.equal(callsAfterFirst)
    expect(await readTokenSigningPublicKey({ vault: dv.vault, alias: ALIAS })).to.equal(first)
    expect(await deleteTokenSigningKey({ vault: dv.vault, alias: ALIAS })).to.equal(true)
    expect(await deleteTokenSigningKey({ vault: dv.vault, alias: ALIAS })).to.equal(false)
  })

  it('15 an empty or non-array digest rejects invalid-digest before any token or vault read', async () => {
    await provision('secp256k1')
    const callsBefore = good.calls
    const promptsBefore = dv.vault.authPromptCount
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    expectSignerError(await rejection(sign(new Uint8Array(0))), 'invalid-digest')
    expectSignerError(await rejection(sign('not bytes' as unknown as Uint8Array)), 'invalid-digest')
    expect(good.calls).to.equal(callsBefore)
    expect(dv.vault.authPromptCount).to.equal(promptsBefore)
  })

  it('16 three signatures raise authPromptCount by exactly 3 and read the token exactly 3 times', async () => {
    await provision('p256')
    const callsBefore = good.calls
    const promptsBefore = dv.vault.authPromptCount
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'p256', alias: ALIAS, signerUserId: '' })
    for (let i = 0; i < 3; i++) await sign(digest())
    expect(good.calls - callsBefore).to.equal(3)
    expect(dv.vault.authPromptCount - promptsBefore).to.equal(3)
  })

  it('17 a key provisioned in one open signs after close and re-open of the same home', async () => {
    const key = await provision('secp256k1')
    dv.close()
    dv = openDeviceVault({ home })
    const sign = createTokenSigner({ vault: dv.vault, token: good, curve: 'secp256k1', alias: ALIAS, signerUserId: USER })
    const d = digest()
    const out = await sign(d)
    expect(out.signerKey).to.equal(key)
    expect(await schemaSignatureValid('secp256k1', d, out.signature, key)).to.equal(true)
  })

  it('18 construction refuses a bad curve, a bad alias, an over-long alias and a bad signerKey', () => {
    const base = { vault: dv.vault, token: good, alias: ALIAS, signerUserId: USER }
    expectSignerError(thrown(() => createTokenSigner({ ...base, curve: 'ed25519' as unknown as TokenSignerCurve })), 'invalid-curve')
    expectSignerError(thrown(() => createTokenSigner({ ...base, curve: 'secp256k1', alias: 'bad alias' })), 'invalid-alias')
    expectSignerError(thrown(() => createTokenSigner({ ...base, curve: 'secp256k1', alias: 'a'.repeat(125) })), 'invalid-alias')
    expectSignerError(thrown(() => createTokenSigner({ ...base, curve: 'secp256k1', signerKey: 'zz' })), 'invalid-signer')
    expectSignerError(thrown(() => tokenSigningPublicKeyAlias('a'.repeat(125))), 'invalid-alias')
    expect(tokenSigningPublicKeyAlias('a'.repeat(124)).length).to.equal(128)
  })

  it('19 no caught error leaks a token or a digest, and every message has the fixed shape', () => {
    expect(caught.length).to.be.greaterThan(10)
    for (const err of caught) {
      const e = err as Coded
      const text = `${String(e.name)} ${String(e.message)} ${JSON.stringify(err)}`
      assertNoLeak(text, sensitive)
      if (e.name === 'TokenSignerError') {
        expect(String(e.message)).to.match(/^token signer refused \([a-z-]+, (sign|provision|read|hold)\)$/)
      }
    }
  })

  it('20 the vote-cli FileKeyVault satisfies ApprovalScopedVault at compile time', () => {
    const v: ApprovalScopedVault = dv.vault
    expect(v).to.equal(dv.vault)
    expect(typeof v.withApproval(good).authPromptCount).to.equal('number')
  })
})
