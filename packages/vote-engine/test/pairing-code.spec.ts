/**
 * pairing-code.spec.ts — phase 66 plan 02: the `vtpair1.` pairing code (D-06, D-18, D-23).
 *
 *   PC-1..PC-4   round trip, no double encoding, addresses survive, paste tolerance
 *   PC-5..PC-10  old-style / not-a-pairing-code / versions / caps / structure / field shapes
 *   PC-11        error hygiene (fixed messages, no input echoed)
 *   PC-12        source hygiene with positive controls
 *   PC-B1..PC-B3 QR byte budget (one version 40-L symbol)
 */
import { expect } from 'chai'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCadreInvitation, encodeCadreInvitation, type CadreInvitation } from '@serfab/cadre-core'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  decodePairingCode,
  encodePairingCode,
  PAIRING_CODE_MAX_CHARS,
  PAIRING_CODE_PREFIX,
  PAIRING_QR_BYTE_BUDGET,
  PairingCodeError,
  type PairingCodeFailure,
  type PairingStatement
} from '../src/pairing/pairing-code.js'
import { decodeNetworkJoinCode, encodeNetworkJoinCode, NETWORK_JOIN_CODE_PREFIX_V2 } from '../src/networks/join-code.js'
import { bytesToBase64url, toCanonicalDatetime } from '../src/utils.js'
import { randomEd25519KeyB64, randomJoinAnchor, randomPeerId } from './fixtures/join-code-fixtures.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// ---------------------------------------------------------------------------------------------
// fixture builders

const relayAddr = (relayPeerId: string, memberPeerId: string): string =>
  `/dns4/tunnel.inspiringlab.com.np/tcp/443/wss/p2p/${relayPeerId}/p2p-circuit/p2p/${memberPeerId}`

function pairingInvitation (addressCount: number): { inv: CadreInvitation, mint: string, members: string[] } {
  const relay = randomPeerId()
  const members: string[] = []
  for (let i = 0; i < addressCount; i++) members.push(relayAddr(relay, randomPeerId()))
  const issuerKey = randomEd25519KeyB64()
  const b64 = (n: number): string => bytesToBase64url(new Uint8Array(randomBytes(n)))
  const inv = {
    v: 1,
    partyId: 'votetorrent',
    invitePrivateKey: b64(32),
    invite: {
      key: randomEd25519KeyB64(),
      peerId: null,
      expiresAt: '2026-11-03T10:15:00.000',
      totalUses: 1,
      stampId: b64(32),
      issuerKey,
      issuerSig: b64(64)
    },
    ownerKeys: [issuerKey],
    members
  } as unknown as CadreInvitation
  return { inv, mint: encodeCadreInvitation(inv), members }
}

function joinCodeFor (addressCount: number): { joinCode: string, mint: string, members: string[] } {
  const { mint, members } = pairingInvitation(addressCount)
  return { joinCode: encodeNetworkJoinCode({ v: 2, invitation: mint, ...randomJoinAnchor() }), mint, members }
}

function p256Statement (opts: { uncompressed?: boolean } = {}): PairingStatement {
  const priv = p256.utils.randomSecretKey()
  const keyPub = bytesToHex(p256.getPublicKey(priv, opts.uncompressed !== true))
  let sig = ''
  for (let i = 0; i < 2000; i++) {
    const der = p256.sign(new Uint8Array(randomBytes(32)), priv, { format: 'der', lowS: false })
    if (der.length === 72) { sig = bytesToHex(der); break }
  }
  if (sig === '') throw new Error('could not draw a 72-byte DER signature')
  return {
    userId: randomUUID(),
    requesterPeerId: randomPeerId(),
    nonce: bytesToBase64url(new Uint8Array(randomBytes(16))),
    expiresAt: toCanonicalDatetime(Date.now() + 15 * 60_000),
    keyPub,
    sig
  }
}

const asciiEscape = (json: string): string => json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const b64u = (text: string): string => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rawPairing = (headerObj: unknown, joinPart: string): string => PAIRING_CODE_PREFIX + b64u(asciiEscape(JSON.stringify(headerObj))) + '.' + joinPart
const rawHeaderJson = (text: string, joinPart: string): string => PAIRING_CODE_PREFIX + b64u(text) + '.' + joinPart

function windows16 (s: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 16 <= s.length; i++) out.push(s.slice(i, i + 16))
  return out
}

function failureOf (fn: () => unknown): PairingCodeError {
  try {
    fn()
  } catch (e) {
    if (e instanceof PairingCodeError) return e
    throw new Error('threw a non-PairingCodeError')
  }
  throw new Error('did not throw')
}

const expectReason = (text: unknown, reason: PairingCodeFailure): void => {
  expect(failureOf(() => decodePairingCode(text)).reason).to.equal(reason)
}

// Shared valid pieces for the hand-built legs.
const base = joinCodeFor(2)
const goodStatement = p256Statement()
const goodCode = encodePairingCode({ statement: goodStatement, joinCode: base.joinCode })
const headerObjOf = (over: Record<string, unknown> = {}, drop: string[] = []): Record<string, unknown> => {
  const o: Record<string, unknown> = { v: 1, ...goodStatement, ...over }
  for (const k of drop) delete o[k]
  return o
}

// ---------------------------------------------------------------------------------------------

describe('66-02: vtpair1 codec (PC-1..PC-4)', () => {
  it('PC-1 round trip: statement and join code come back exactly as given', () => {
    const st = p256Statement()
    const { joinCode } = joinCodeFor(3)
    const code = encodePairingCode({ statement: st, joinCode })
    expect(code).to.match(/^vtpair1\.[A-Za-z0-9_-]+\.vtjoin2\.[A-Za-z0-9_-]+$/)
    const back = decodePairingCode(code)
    expect(back.statement).to.deep.equal(st)
    expect(back.joinCode).to.equal(joinCode)
  })

  it('PC-2 no double encoding: the join code is the verbatim suffix', () => {
    const st = p256Statement()
    const { joinCode } = joinCodeFor(2)
    const code = encodePairingCode({ statement: st, joinCode })
    const header = code.slice(PAIRING_CODE_PREFIX.length, code.indexOf('.', PAIRING_CODE_PREFIX.length))
    expect(code.endsWith('.' + joinCode)).to.equal(true)
    expect(code.length).to.equal(PAIRING_CODE_PREFIX.length + header.length + 1 + joinCode.length)
    expect(code).to.equal(PAIRING_CODE_PREFIX + header + '.' + joinCode)
  })

  it('PC-3 the minted addresses survive byte for byte (D-18)', () => {
    const { joinCode, mint, members } = joinCodeFor(4)
    const decoded = decodePairingCode(encodePairingCode({ statement: p256Statement(), joinCode }))
    const inner = decodeNetworkJoinCode(decoded.joinCode)
    expect(inner.ok).to.equal(true)
    if (!inner.ok) return
    expect(inner.code.invitation).to.equal(mint)
    expect(decodeCadreInvitation(inner.code.invitation).members).to.deep.equal(members)
  })

  it('PC-4 paste tolerance: whitespace anywhere is ignored (D-23)', () => {
    const want = decodePairingCode(goodCode)
    const dot1 = goodCode.indexOf('.')
    const dot2 = goodCode.indexOf('.', dot1 + 1)
    const insert = (s: string, at: number, ws: string): string => s.slice(0, at) + ws + s.slice(at)
    const variants = [
      ' ' + goodCode + ' ',
      '\n' + goodCode + '\r\n',
      insert(goodCode, 10, ' '),
      insert(goodCode, 30, '\t'),
      insert(goodCode, dot1, '\n'),
      insert(goodCode, dot1 + 1, '\r\n'),
      insert(goodCode, dot2, ' '),
      insert(goodCode, dot2 + 5, '\r'),
      insert(insert(insert(goodCode, goodCode.length - 20, '\n'), 100, ' \t '), 400, '\r\n')
    ]
    for (const v of variants) expect(decodePairingCode(v)).to.deep.equal(want)
  })
})

describe('66-02: vtpair1 rejections (PC-5..PC-10)', () => {
  const hex40 = 'a1'.repeat(20)
  const b43 = 'A'.repeat(43)

  it('PC-5 old-style Phase 50 sign-in code is its own reason; near misses are not-pairing-code', () => {
    expectReason(`${hex40}.${b43}`, 'old-style-code')
    expectReason(` ${hex40}.\n${b43}`, 'old-style-code')
    expectReason(`${hex40.slice(1)}.${b43}`, 'not-pairing-code')
    expectReason(`${hex40.toUpperCase()}.${b43}`, 'not-pairing-code')
    expectReason(`${hex40}.${b43.slice(1)}`, 'not-pairing-code')
    expectReason(`${hex40}.${b43}.${b43}`, 'not-pairing-code')
  })

  it('PC-6 not a pairing code', () => {
    for (const t of ['', 'hello', base.joinCode, 'https://example.com/join']) expectReason(t, 'not-pairing-code')
  })

  it('PC-7 versions', () => {
    const tail = goodCode.slice(PAIRING_CODE_PREFIX.length)
    expectReason('vtpair2.' + tail, 'unsupported-version')
    expectReason('vtpair10.' + tail, 'unsupported-version')
    expectReason(rawPairing(headerObjOf({ v: 2 }), base.joinCode), 'unsupported-version')
    expectReason(rawPairing(headerObjOf({ v: '1' }), base.joinCode), 'malformed')
  })

  it('PC-8 caps', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) expectReason(bad, 'malformed')
    expectReason(PAIRING_CODE_PREFIX + 'A'.repeat(PAIRING_CODE_MAX_CHARS + 1 - PAIRING_CODE_PREFIX.length), 'malformed')
    expectReason(goodCode + ' '.repeat(4 * PAIRING_CODE_MAX_CHARS), 'malformed')
    const six = joinCodeFor(6)
    const code6 = encodePairingCode({ statement: p256Statement(), joinCode: six.joinCode })
    expect(code6.length).to.be.lessThan(PAIRING_CODE_MAX_CHARS)
    expect(decodePairingCode(code6).joinCode).to.equal(six.joinCode)
  })

  it('PC-9 structure', () => {
    const j = base.joinCode
    const hdr = goodCode.slice(PAIRING_CODE_PREFIX.length, goodCode.indexOf('.', PAIRING_CODE_PREFIX.length))
    expectReason(PAIRING_CODE_PREFIX + hdr, 'malformed')
    expectReason('vtpair1..' + j, 'malformed')
    expectReason(PAIRING_CODE_PREFIX + hdr + '.', 'malformed')
    expectReason(PAIRING_CODE_PREFIX + hdr + '.vtjoin1.' + 'abc', 'malformed')
    expectReason(PAIRING_CODE_PREFIX + hdr + '.vtjoin2.', 'malformed')
    expectReason(PAIRING_CODE_PREFIX + hdr.slice(0, 10) + '!' + hdr.slice(11) + '.' + j, 'malformed')
    expectReason(rawHeaderJson('not json at all', j), 'malformed')
    expectReason(rawPairing([1, 2, 3], j), 'malformed')
    expectReason(rawPairing(headerObjOf({ extra: 'x' }), j), 'malformed')
    expectReason(rawPairing(headerObjOf({}, ['sig']), j), 'malformed')
    // a header byte above 0x7f: base64url of raw bytes including 0xC3
    expectReason(PAIRING_CODE_PREFIX + b64u('{"v":1,"userId":"Ã"}') + '.' + j, 'malformed')
    expectReason(PAIRING_CODE_PREFIX + 'A'.repeat(2049) + '.' + j, 'malformed')
  })

  it('PC-10 field shapes: bad ones are malformed, edge ones decode', () => {
    const j = base.joinCode
    const bad = (over: Record<string, unknown>, drop: string[] = []): void => expectReason(rawPairing(headerObjOf(over, drop), j), 'malformed')
    bad({ nonce: 'A'.repeat(21) })
    bad({ nonce: 'A'.repeat(23) })
    bad({ expiresAt: '2026-11-03T10:15:00Z' })
    bad({ expiresAt: '2026-11-03T10:15:00.000' })
    bad({ expiresAt: '2026-11-03T10:15:0' })
    bad({ keyPub: 'a'.repeat(64) })
    bad({ keyPub: 'a'.repeat(65) + 'g' })
    bad({ sig: 'a'.repeat(127) })
    bad({ sig: 'a'.repeat(127) + 'z' })
    bad({ sig: 'a'.repeat(14) })
    bad({ sig: 'a'.repeat(290) })
    bad({ userId: 'has space' })
    bad({ userId: '' })
    bad({ userId: 'u'.repeat(257) })
    bad({}, ['requesterPeerId'])
    bad({ requesterPeerId: '' })
    bad({ requesterPeerId: 'has space' })
    bad({ requesterPeerId: 'peeré' })
    bad({ requesterPeerId: 'p'.repeat(129) })
    bad({ requesterPeerId: 12345 })

    const ok = (over: Record<string, unknown>): PairingStatement => decodePairingCode(rawPairing(headerObjOf(over), j)).statement
    expect(ok({ keyPub: 'AB'.repeat(65) }).keyPub).to.equal('AB'.repeat(65))
    expect(ok({ sig: 'c'.repeat(128) }).sig).to.equal('c'.repeat(128))
    expect(ok({ requesterPeerId: 'p'.repeat(128) }).requesterPeerId).to.equal('p'.repeat(128))
    expect(ok({ keyPub: 'ab'.repeat(33) }).keyPub).to.have.length(66)

    expect(() => encodePairingCode({ statement: { ...goodStatement, requesterPeerId: undefined as unknown as string }, joinCode: j })).to.throw(Error)
  })
})

describe('66-02: vtpair1 error hygiene (PC-11)', () => {
  const j = base.joinCode
  const failing: string[] = [
    '', 'hello', base.joinCode, 'x'.repeat(40),
    `${'a1'.repeat(20)}.${'A'.repeat(43)}`,
    goodCode.replace('vtpair1.', 'vtpair2.'),
    rawPairing(headerObjOf({ v: 2 }), j),
    rawPairing(headerObjOf({ v: '1' }), j),
    'vtpair1.' + goodCode.slice(8, goodCode.indexOf('.', 8)),
    'vtpair1..' + j,
    rawHeaderJson('not json at all', j),
    rawPairing(headerObjOf({ extra: 'x' }), j),
    rawPairing(headerObjOf({ nonce: 'A'.repeat(21) }), j),
    rawPairing(headerObjOf({ requesterPeerId: 'has space' }), j),
    rawPairing(headerObjOf({}, ['requesterPeerId']), j),
    rawPairing(headerObjOf({ userId: 'secret-user-' + 'z'.repeat(30) + ' x' }), j),
    goodCode + ' '.repeat(4 * PAIRING_CODE_MAX_CHARS)
  ]

  it('PC-11 every failure is a PairingCodeError with one of four fixed messages and no input echoed', () => {
    const messages = new Set<string>()
    for (const text of failing) {
      const err = failureOf(() => decodePairingCode(text))
      expect(err).to.be.instanceOf(Error)
      expect(err.name).to.equal('PairingCodeError')
      expect(['malformed', 'unsupported-version', 'not-pairing-code', 'old-style-code']).to.include(err.reason)
      messages.add(err.message)
      const surface = [err.message, String(err), JSON.stringify(Object.assign({}, err))].join('\n')
      if (text.length >= 16) for (const w of windows16(text)) expect(surface.includes(w), 'leaked a window of the input').to.equal(false)
    }
    expect(messages.size).to.be.at.most(4)
  })

  it('PC-11 encoder refusals are plain errors that leak nothing', () => {
    const cases: Array<() => unknown> = [
      () => encodePairingCode({ statement: { ...goodStatement, nonce: 'short' }, joinCode: j }),
      () => encodePairingCode({ statement: goodStatement, joinCode: 'vtjoin1.' + j.slice(8) }),
      () => encodePairingCode({ statement: goodStatement, joinCode: NETWORK_JOIN_CODE_PREFIX_V2 + 'AAAA' })
    ]
    const secrets = [goodStatement.userId + goodStatement.sig + goodStatement.keyPub, j]
    for (const fn of cases) {
      let err: unknown
      try { fn() } catch (e) { err = e }
      expect(err).to.be.instanceOf(Error)
      expect(err).to.not.be.instanceOf(PairingCodeError)
      const msg = (err as Error).message
      for (const s of secrets) for (const w of windows16(s)) expect(msg.includes(w)).to.equal(false)
    }
  })
})

describe('66-02: pairing-code source hygiene (PC-12)', () => {
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const CONSOLE = ['console', '\\.'].join('')
  const consoleHit = (stripped: string): boolean => new RegExp(CONSOLE).test(stripped)
  const codecIdentifiers = ['B' + 'uffer', 'Text' + 'Encoder', 'Text' + 'Decoder']
  const identifierHits = (stripped: string): string[] => codecIdentifiers.filter((id) => new RegExp(`\\b${id}\\b`).test(stripped))
  const nodeSpecifierHit = (stripped: string): boolean => new RegExp(['from\\s+[\'"]', 'node', ':'].join('')).test(stripped)
  const importSpecifiers = (stripped: string): string[] => [...stripped.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!)
  const src = stripComments(readFileSync(join(SRC_DIR, 'pairing', 'pairing-code.ts'), 'utf8'))

  it('PC-12 no console, no byte-codec identifier, no node: specifier, only the two allowed imports', () => {
    expect(consoleHit(src)).to.equal(false)
    expect(identifierHits(src)).to.deep.equal([])
    expect(nodeSpecifierHit(src)).to.equal(false)
    expect(importSpecifiers(src).sort()).to.deep.equal(['../networks/join-code.js', '../utils.js'])
  })

  it('PC-12 positive controls: the scanners flag planted tokens and ignore comments', () => {
    const planted = ['console', '.log(code)'].join('')
    expect(consoleHit(stripComments(`const x = 1\n${planted}\n`))).to.equal(true)
    expect(consoleHit(stripComments(`// ${planted}\n/* ${planted} */\n`))).to.equal(false)
    for (const id of codecIdentifiers) expect(identifierHits(stripComments(`const t = new ${id}()`))).to.deep.equal([id])
    expect(nodeSpecifierHit(`import { x } from 'node:` + `crypto'`)).to.equal(true)
    expect(importSpecifiers(`import { a } from '../utils.js'\nimport b from "x"\n`)).to.deep.equal(['../utils.js', 'x'])
  })
})

describe('66-02: QR byte budget (PC-B1..PC-B3, D-23)', () => {
  const { joinCode: jc4 } = joinCodeFor(4)
  const codeCompressed = encodePairingCode({ statement: p256Statement(), joinCode: jc4 })
  const codeUncompressed = encodePairingCode({ statement: p256Statement({ uncompressed: true }), joinCode: jc4 })

  it(`PC-B1 realistic code (owner + 3 members, P-256) is ${codeCompressed.length} chars <= ${PAIRING_QR_BYTE_BUDGET}`, () => {
    expect(codeCompressed).to.match(/^[\x21-\x7e]+$/)
    expect(codeCompressed.length).to.be.at.most(PAIRING_QR_BYTE_BUDGET)
  })

  it(`PC-B2 same with an uncompressed key is ${codeUncompressed.length} chars <= ${PAIRING_QR_BYTE_BUDGET}`, () => {
    expect(codeUncompressed).to.match(/^[\x21-\x7e]+$/)
    expect(codeUncompressed.length).to.be.at.most(PAIRING_QR_BYTE_BUDGET)
  })

  const st = p256Statement()
  const lengths: number[] = []
  const codes = [1, 2, 3, 4, 5, 6].map((n) => {
    const jc = joinCodeFor(n).joinCode
    const code = encodePairingCode({ statement: st, joinCode: jc })
    lengths.push(code.length)
    return { n, jc, code }
  })
  for (const { n, jc, code } of codes) {
    const fits = code.length <= PAIRING_QR_BYTE_BUDGET
    it(`PC-B3 ${n} address${n === 1 ? '' : 'es'}: ${code.length} chars (${fits ? 'fits' : 'over budget'})`, () => {
      const back = decodePairingCode(code)
      expect(back.statement).to.deep.equal(st)
      expect(back.joinCode).to.equal(jc)
    })
  }
  it('PC-B3 lengths strictly increase with the address count and at least 4 addresses fit', () => {
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]!).to.be.greaterThan(lengths[i - 1]!)
    const largestFit = codes.filter((c) => c.code.length <= PAIRING_QR_BYTE_BUDGET).map((c) => c.n).pop() ?? 0
    expect(largestFit).to.be.at.least(4)
  })
})
