/**
 * join-code-v2.spec.ts — phase 64 plan 04: the flattened `vtjoin2.` join code (D-01) and the
 * typed decode reasons (D-07), proven against inputs minted by cadre-core's REAL encoder.
 *
 *   JV-1..JV-9  codec behaviour
 *   JV-10       the committed real-encoder fixtures
 *   JV-11       source hygiene (no console, no byte-codec identifiers) with positive controls
 */
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCadreInvitation, encodeCadreInvitation } from '@serfab/cadre-core'
import {
  CADRE_INVITATION_PREFIX_EXPECTED,
  decodeNetworkJoinCode,
  encodeNetworkJoinCode,
  looksLikeJoinCode,
  NETWORK_JOIN_CODE_PREFIX,
  NETWORK_JOIN_CODE_PREFIX_V2,
  type NetworkJoinCode
} from '../src/networks/join-code.js'
import { foundingBundleFingerprint } from '../src/networks/founding-bundle.js'
import {
  buildJoinCodeFixtures,
  mintInvitation,
  randomCadreInvitation,
  randomJoinAnchor
} from './fixtures/join-code-fixtures.js'

import { JOIN_CODE_FIXTURES } from './fixtures/join-code-fixtures.generated.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function asciiEscape (json: string): string {
  return json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function b64u (text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const rawV2 = (obj: unknown): string => NETWORK_JOIN_CODE_PREFIX_V2 + b64u(asciiEscape(JSON.stringify(obj)))
const rawV2Json = (jsonText: string): string => NETWORK_JOIN_CODE_PREFIX_V2 + b64u(jsonText)
const rawV1 = (obj: unknown): string => NETWORK_JOIN_CODE_PREFIX + b64u(asciiEscape(JSON.stringify(obj)))

function windows16 (s: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 16 <= s.length; i++) out.push(s.slice(i, i + 16))
  return out
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function makeV2 (members = 1, name?: string) {
  const inv = randomCadreInvitation({ members })
  const anchor = randomJoinAnchor(name === undefined ? {} : { name })
  const mint = mintInvitation(inv)
  const code: NetworkJoinCode = { v: 2, invitation: mint, ...anchor }
  const body = {
    v: 2,
    invitation: inv as unknown as Record<string, unknown>,
    networkHash: anchor.networkHash,
    name: anchor.name,
    genesis: { ...anchor.genesis },
    digest: anchor.digest
  }
  return { inv, anchor, mint, code, body }
}

describe('64-04: vtjoin2. join code (JV)', () => {
  it('JV-1 a v2 code from a real cadre-core mint round-trips byte-identically', () => {
    const { inv, anchor, mint, code } = makeV2(2)
    const text = encodeNetworkJoinCode(code)
    expect(text).to.match(/^vtjoin2\.[A-Za-z0-9_-]+$/)
    const decoded = decodeNetworkJoinCode(text)
    if (!decoded.ok) throw new Error('JV-1: expected ok')
    expect(decoded.code.v).to.equal(2)
    expect(decoded.code.networkHash).to.equal(anchor.networkHash)
    expect(decoded.code.name).to.equal(anchor.name)
    expect(decoded.code.genesis).to.deep.equal(anchor.genesis)
    expect(decoded.code.digest).to.equal(anchor.digest)
    expect(decoded.fingerprint).to.equal(foundingBundleFingerprint(anchor.digest))
    expect(decoded.code.invitation === mint, 'invitation is byte-identical to the mint').to.equal(true)
    expect(decodeCadreInvitation(decoded.code.invitation)).to.deep.equal(inv)
  })

  it('JV-2 whitespace, tabs and CRLF anywhere still decode', () => {
    const text = encodeNetworkJoinCode(makeV2().code)
    const mangled = ` \t${text.slice(0, 30)}\r\n${text.slice(30, 200)}\n ${text.slice(200, 700)}\t\r\n${text.slice(700)}  \n`
    expect(decodeNetworkJoinCode(mangled).ok).to.equal(true)
  })

  it('JV-3 a non-ASCII name round-trips and the code text stays printable ASCII', () => {
    const { code } = makeV2(1, 'Élections — Zürich 選挙 🗳')
    const text = encodeNetworkJoinCode(code)
    expect(text).to.match(/^[\x21-\x7e]+$/)
    const decoded = decodeNetworkJoinCode(text)
    expect(decoded.ok && decoded.code.name).to.equal(code.name)
  })

  it('JV-4 each refusal case is malformed', () => {
    const { mint, body } = makeV2(1)
    const mut = (fn: (b: any) => void): string => { const b = clone(body) as any; fn(b); return rawV2(b) } // eslint-disable-line @typescript-eslint/no-explicit-any
    const json = JSON.stringify(body)
    const cases: Array<[string, string]> = [
      ['top-level extra key', mut((b) => { b.extra = 1 })],
      ['top-level missing digest', mut((b) => { delete b.digest })],
      ['__proto__ at top level', rawV2Json(json.replace(/^\{/, '{"__proto__":{},'))],
      ['__proto__ in invitation', rawV2Json(json.replace('"invitation":{', '"invitation":{"__proto__":{},'))],
      ['__proto__ in invite', rawV2Json(json.replace('"invite":{', '"invite":{"__proto__":{},'))],
      ['__proto__ in genesis', rawV2Json(json.replace('"genesis":{', '"genesis":{"__proto__":{},'))],
      ['constructor key in invitation', mut((b) => { b.invitation.constructor = 'x' })],
      ['invitation extra key', mut((b) => { b.invitation.extra = 1 })],
      ['invitation missing members', mut((b) => { delete b.invitation.members })],
      ['invite extra key', mut((b) => { b.invitation.invite.extra = 1 })],
      ['invite missing stampId', mut((b) => { delete b.invitation.invite.stampId })],
      ['genesis extra key', mut((b) => { b.genesis.x = 'y' })],
      ['genesis missing signerKey', mut((b) => { delete b.genesis.signerKey })],
      ['nested invitation.v = 2', mut((b) => { b.invitation.v = 2 })],
      ['invitation as a string (the v1 nesting)', mut((b) => { b.invitation = mint })],
      ['ownerKeys empty', mut((b) => { b.invitation.ownerKeys = [] })],
      ['ownerKeys of 17', mut((b) => { b.invitation.ownerKeys = Array.from({ length: 17 }, (_, i) => 'k' + i) })],
      ['members of 9', mut((b) => { b.invitation.members = Array.from({ length: 9 }, (_, i) => '/ip4/10.0.0.' + i + '/tcp/1') })],
      ['a non-string member', mut((b) => { b.invitation.members = [42] })],
      ['an empty partyId', mut((b) => { b.invitation.partyId = '' })],
      ['a 1025-char issuerSig', mut((b) => { b.invitation.invite.issuerSig = 'a'.repeat(1025) })],
      ['a 1025-char networkHash', mut((b) => { b.networkHash = 'a'.repeat(1025) })],
      ['name of 257 chars', mut((b) => { b.name = 'n'.repeat(257) })],
      ['totalUses 0', mut((b) => { b.invitation.invite.totalUses = 0 })],
      ['totalUses 1.5', mut((b) => { b.invitation.invite.totalUses = 1.5 })],
      ['totalUses as a string', mut((b) => { b.invitation.invite.totalUses = '1000' })],
      ['an unknown invite key in the grantsOwner slot', mut((b) => { b.invitation.invite.grantsowner = false })],
      ['peerId 42', mut((b) => { b.invitation.invite.peerId = 42 })],
      ['expiresAt empty', mut((b) => { b.invitation.invite.expiresAt = '' })],
      ['non-printable-ASCII partyId', mut((b) => { b.invitation.partyId = 'é' })],
      ['control char in invitePrivateKey', mut((b) => { b.invitation.invitePrivateKey = 'a\u0001b' })],
      ['top-level v 1 under the vtjoin2. prefix', mut((b) => { b.v = 1 })],
      ['an array body', rawV2([1, 2])],
      ['a non-JSON body', NETWORK_JOIN_CODE_PREFIX_V2 + b64u('not json at all')],
      ['a char outside the base64url alphabet', NETWORK_JOIN_CODE_PREFIX_V2 + 'abc$def'],
      ['a byte above 0x7f', NETWORK_JOIN_CODE_PREFIX_V2 + '_w'],
      ['digest too short to fingerprint', mut((b) => { b.digest = 'AAAA' })]
    ]
    for (const [label, input] of cases) {
      expect(decodeNetworkJoinCode(input), label).to.deep.equal({ ok: false, reason: 'malformed' })
    }
  })

  it('JV-4c a v2 code minted before cadre-core 1.18 (its invite row still carries grantsOwner) is invitation-older-version', () => {
    const { body } = makeV2(1)
    const legacy = clone(body) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    // The pre-1.18 mint order: grantsOwner sat between peerId and expiresAt.
    const { key, peerId, expiresAt, totalUses, stampId, issuerKey, issuerSig } = legacy.invitation.invite
    legacy.invitation.invite = { key, peerId, grantsOwner: false, expiresAt, totalUses, stampId, issuerKey, issuerSig }
    expect(decodeNetworkJoinCode(rawV2(legacy))).to.deep.equal({ ok: false, reason: 'invitation-older-version' })
    // Any value of the old field reads the same: the shape is what dates it.
    legacy.invitation.invite.grantsOwner = 'false'
    expect(decodeNetworkJoinCode(rawV2(legacy))).to.deep.equal({ ok: false, reason: 'invitation-older-version' })
  })

  it('JV-4b an empty name decodes (v1 rule kept, R1)', () => {
    const { body } = makeV2(1)
    const b = clone(body)
    b.name = ''
    expect(decodeNetworkJoinCode(rawV2(b)).ok).to.equal(true)
  })

  it('JV-5 caps are measured after whitespace removal', () => {
    expect(decodeNetworkJoinCode(NETWORK_JOIN_CODE_PREFIX_V2 + 'A'.repeat(4089))).to.deep.equal({ ok: false, reason: 'malformed' })
    const text = encodeNetworkJoinCode(makeV2(1).code)
    expect(text.length).to.be.lessThan(4096)
    const padded = text.slice(0, 100) + ' '.repeat(4200) + text.slice(100)
    expect(padded.length).to.be.greaterThan(4096)
    expect(decodeNetworkJoinCode(padded).ok).to.equal(true)
    expect(decodeNetworkJoinCode(NETWORK_JOIN_CODE_PREFIX + 'A'.repeat(16_377))).to.deep.equal({ ok: false, reason: 'malformed' })
  })

  it('JV-6 dispatch: not-join-code, unsupported-version, malformed', () => {
    const body = encodeNetworkJoinCode(makeV2(1).code).slice(NETWORK_JOIN_CODE_PREFIX_V2.length)
    for (const input of ['', '   ', 'hello', 'https://example.org/x', 'sereus-invite:1.abc', 'VTJOIN2.abc', 'xvtjoin2.abc', body]) {
      expect(decodeNetworkJoinCode(input), JSON.stringify(input.slice(0, 12))).to.deep.equal({ ok: false, reason: 'not-join-code' })
    }
    for (const input of ['vtjoin3.abc', 'vtjoin10.abc', 'vtjoin0.abc']) {
      expect(decodeNetworkJoinCode(input), input).to.deep.equal({ ok: false, reason: 'unsupported-version' })
    }
    for (const input of [42, null, {}]) {
      expect(decodeNetworkJoinCode(input)).to.deep.equal({ ok: false, reason: 'malformed' })
    }
  })

  it('JV-7 looksLikeJoinCode', () => {
    for (const t of [' vtjoin2.\nabc', 'vtjoin9.x', 'vtjoin1.x', 'vtjoin2.']) expect(looksLikeJoinCode(t), t).to.equal(true)
    for (const t of [42, null, undefined, {}, '', 'VTJOIN2.x', 'sereus-invite:1.x', 'hello']) expect(looksLikeJoinCode(t)).to.equal(false)
  })

  it('JV-8 v1 compatibility, the 1.14 no-prefix rule, and opaque fakes', () => {
    const { anchor, mint } = makeV2(1)
    const v1 = encodeNetworkJoinCode({ v: 1, invitation: mint, ...anchor })
    const decoded = decodeNetworkJoinCode(v1)
    if (!decoded.ok) throw new Error('JV-8: expected ok')
    expect(decoded.code.v).to.equal(1)
    expect(decoded.code.invitation === mint).to.equal(true)

    const v1Body = (invitation: string) => rawV1({
      v: 1, invitation, networkHash: anchor.networkHash, name: anchor.name, genesis: { ...anchor.genesis }, digest: anchor.digest
    })
    const older = b64u('{"v":1,"partyId":"votetorrent","invitePrivateKey":"x"}')
    expect(decodeNetworkJoinCode(v1Body(older))).to.deep.equal({ ok: false, reason: 'invitation-older-version' })
    for (const opaque of ['eyJ2IjoxfQ', 'encoded-invitation', b64u('{"v":2,"partyId":"x"}')]) {
      expect(decodeNetworkJoinCode(v1Body(opaque)).ok, opaque).to.equal(true)
    }
  })

  it('JV-9 the encoder throws closed messages', () => {
    const { code, mint } = makeV2(1)
    const bad: Array<[string, NetworkJoinCode]> = [
      ['v 3', { ...code, v: 3 as unknown as 2 }],
      ['v2 without the prefix', { ...code, invitation: mint.slice(CADRE_INVITATION_PREFIX_EXPECTED.length) }],
      ['prefixed non-base64url body', { ...code, invitation: CADRE_INVITATION_PREFIX_EXPECTED + '!'.repeat(40) }],
      ['a name the decoder refuses', { ...code, name: 'n'.repeat(300) }]
    ]
    for (const [label, input] of bad) {
      let message = ''
      try { encodeNetworkJoinCode(input) } catch (e) { message = (e as Error).message }
      expect(message, label).to.not.equal('')
      expect(message, label).to.match(/^encodeNetworkJoinCode: /)
      for (const w of windows16(input.invitation)) expect(message.includes(w), label).to.equal(false)
    }
  })
})

describe('64-04: real-encoder fixtures (JV-10)', () => {
  const names = ['v2-1-member', 'v2-2-members', 'v2-6-members', 'v2-non-ascii-name', 'v1-legacy-1-member', 'v1-114-no-prefix'] as const

  it('JV-10a..b exactly the six names; lengths and alphabet', () => {
    expect(Object.keys(JOIN_CODE_FIXTURES).sort()).to.deep.equal([...names].sort())
    for (const n of names) {
      const f = JOIN_CODE_FIXTURES[n]
      expect(f.text.length, n).to.equal(f.chars)
      expect(f.text, n).to.match(/^[\x21-\x7e]+$/)
      expect(looksLikeJoinCode(f.text), n).to.equal(true)
    }
  })

  it('JV-10c every v2 fixture decodes and re-encodes byte-identically through real cadre-core', () => {
    for (const n of ['v2-1-member', 'v2-2-members', 'v2-6-members', 'v2-non-ascii-name'] as const) {
      const f = JOIN_CODE_FIXTURES[n]
      const d = decodeNetworkJoinCode(f.text)
      if (!d.ok) throw new Error(n + ': expected ok')
      expect(d.code.v, n).to.equal(2)
      expect(d.fingerprint, n).to.equal(f.fingerprint)
      expect(d.code.networkHash, n).to.equal(f.networkHash)
      expect(d.code.name, n).to.equal(f.name)
      const inv = decodeCadreInvitation(d.code.invitation)
      expect(inv.members.length, n).to.equal(f.members)
      expect(encodeCadreInvitation(inv) === d.code.invitation, n).to.equal(true)
    }
  })

  it('JV-10d sizes', () => {
    const one = JOIN_CODE_FIXTURES['v2-1-member'].chars
    const six = JOIN_CODE_FIXTURES['v2-6-members'].chars
    const v1 = JOIN_CODE_FIXTURES['v1-legacy-1-member'].chars
    expect(one).to.be.at.least(1370)
    expect(six).to.be.at.most(4096)
    expect(v1).to.be.at.least(1700)
    expect((v1 - one) / v1).to.be.at.least(0.15)
  })

  it('JV-10e v1 fixtures', () => {
    const legacy = decodeNetworkJoinCode(JOIN_CODE_FIXTURES['v1-legacy-1-member'].text)
    if (!legacy.ok) throw new Error('v1-legacy-1-member: expected ok')
    expect(legacy.code.v).to.equal(1)
    expect(legacy.code.invitation.startsWith(CADRE_INVITATION_PREFIX_EXPECTED)).to.equal(true)
    expect(decodeNetworkJoinCode(JOIN_CODE_FIXTURES['v1-114-no-prefix'].text)).to.deep.equal({ ok: false, reason: 'invitation-older-version' })
  })

  it('JV-10f the non-ASCII name', () => {
    const f = JOIN_CODE_FIXTURES['v2-non-ascii-name']
    expect([...f.name].some((c) => c.charCodeAt(0) > 0x7e)).to.equal(true)
    const d = decodeNetworkJoinCode(f.text)
    expect(d.ok && d.code.name).to.equal(f.name)
  })

  it('JV-10g the committed file is not stale', function () {
    this.timeout(30_000)
    const fresh = buildJoinCodeFixtures()
    expect(Object.keys(fresh).sort()).to.deep.equal(Object.keys(JOIN_CODE_FIXTURES).sort())
    for (const n of names) {
      expect(fresh[n].chars, n).to.equal(JOIN_CODE_FIXTURES[n].chars)
      expect(fresh[n].members, n).to.equal(JOIN_CODE_FIXTURES[n].members)
      if (n.startsWith('v2-')) expect(decodeNetworkJoinCode(fresh[n].text).ok, n).to.equal(true)
    }
  })
})

describe('64-04: join-code source hygiene (JV-11)', () => {
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const CONSOLE = ['console', '\\.'].join('')
  const consoleHit = (stripped: string): boolean => new RegExp(CONSOLE).test(stripped)
  const codecIdentifiers = ['B' + 'uffer', 'Text' + 'Encoder', 'Text' + 'Decoder']
  const identifierHits = (stripped: string): string[] => codecIdentifiers.filter((id) => new RegExp(`\\b${id}\\b`).test(stripped))
  const read = (rel: string): string => stripComments(readFileSync(join(SRC_DIR, rel), 'utf8'))

  it('JV-11 no console in join-code.ts or network-join.ts; no byte-codec identifier in join-code.ts', () => {
    expect(consoleHit(read('networks/join-code.ts'))).to.equal(false)
    expect(consoleHit(read('networks/network-join.ts'))).to.equal(false)
    expect(identifierHits(read('networks/join-code.ts'))).to.deep.equal([])
  })

  it('JV-11 positive control: the scanner flags a planted call and ignores a commented one', () => {
    const planted = ['console', '.log(code)'].join('')
    expect(consoleHit(stripComments(`const x = 1\n${planted}\n`))).to.equal(true)
    expect(consoleHit(stripComments(`const x = 1\n// ${planted}\n/* ${planted} */\n`))).to.equal(false)
    expect(identifierHits(stripComments('const t = new ' + codecIdentifiers[1] + '()'))).to.deep.equal([codecIdentifiers[1]])
  })
})
