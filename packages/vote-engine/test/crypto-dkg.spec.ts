/**
 * crypto-dkg.spec.ts
 *
 * RFC 9591 Appendix E.5 (FROST(secp256k1, SHA-256)) and frost-rs secp256k1 DKG
 * known-answer tests for `src/crypto/dkg.ts` (D-13, D-14, D-16, D-17, D-25),
 * plus a 3-of-5 end-to-end simulation through the wrapper, threshold bounds,
 * commit-reveal and round-1/round-3 blame attribution.
 *
 * Style follows noble-dedupe-regression.spec.ts (mocha describe/it + chai expect).
 * The RFC 9591 constants below cite Appendix E.5 (test vectors) and Appendix
 * C.1 `secret_share_combine` / C.2 `vss_verify` (the operations this module's
 * `reconstructGroupSecret` and `validateReleasedShare` wrap).
 */

import { expect } from 'chai'
import type { DKG_Secret } from '@noble/curves/abstract/frost.js'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  DkgError,
  assertDkgThreshold,
  commitRound1,
  deriveGroupCommitments,
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  parseDkgSecret,
  reconstructGroupSecret,
  serializeDkgSecret,
  validateReleasedShare,
  verifyRound1Commit,
  verifyRound1Package,
  type DkgContext,
  type DkgReceivedShare,
  type DkgRound1Wire
} from '../src/crypto/dkg.ts'
import { FROST_SECP256K1_DKG_VECTORS } from './fixtures/frost-secp256k1-dkg-vectors.ts'

const CTX: DkgContext = { electionId: 'election-aaaa', revision: 1, attempt: 1 }

// ---------------------------------------------------------------------------
// RFC 9591 Appendix E.5 — FROST(secp256k1, SHA-256), MIN=2, MAX=3
// Appendix C.1 secret_share_combine / C.2 vss_verify are the operations
// `reconstructGroupSecret` and `validateReleasedShare` wrap.
// ---------------------------------------------------------------------------
const E5_GROUP_SECRET_KEY = '0d004150d27c3bf2a42f312683d35fac7394b1e9e318249c1bfe7f0795a83114'
const E5_GROUP_PUBLIC_KEY = '02f37c34b66ced1fb51c34a90bdae006901f10625cc06c4f64663b0eae87d87b4f'
const E5_COEFFICIENT_1 = 'fbf85eadae3058ea14f19148bb72b45e4399c0b16028acaf0395c9b03c823579'
const E5_SECOND_COMMITMENT = '033edecb0840954631b668f2ccd1250832007486de1dbe3d08b84466b26e215eec'
const E5_P1_SHARE = '08f89ffe80ac94dcb920c26f3f46140bfc7f95b493f8310f5fc1ea2b01f4254c'
const E5_P2_SHARE = '04f0feac2edcedc6ce1253b7fab8c86b856a797f44d83d82a385554e6e401984'
const E5_P3_SHARE = '00e95d59dd0d46b0e303e500b62b7ccb0e555d49f5b849f5e748c071da8c0dbc'

function e5GroupCommitments (): string[] {
  const res = secp256k1_FROST.utils.generateSecretPolynomial(
    { min: 2, max: 3 },
    hexToBytes(E5_GROUP_SECRET_KEY),
    [secp256k1_FROST.utils.Fn.fromBytes(hexToBytes(E5_COEFFICIENT_1))]
  )
  return res.commitment.map((c) => bytesToHex(c))
}

describe('crypto-dkg: RFC 9591 Appendix E.5 (FROST(secp256k1, SHA-256)) known-answer tests', () => {
  it('pins the second group commitment to coefficient[1]*G, computed via generateSecretPolynomial', () => {
    const commitments = e5GroupCommitments()
    expect(commitments[0]).to.equal(E5_GROUP_PUBLIC_KEY)
    expect(commitments[1]).to.equal(E5_SECOND_COMMITMENT)
  })

  it('reconstructGroupSecret over every 2-of-3 subset returns the RFC 9591 E.5 group_secret_key', () => {
    const groupCommitments = e5GroupCommitments()
    const id1 = secp256k1_FROST.Identifier.fromNumber(1)
    const id2 = secp256k1_FROST.Identifier.fromNumber(2)
    const id3 = secp256k1_FROST.Identifier.fromNumber(3)
    const all = [
      { identifier: id1, signingShare: E5_P1_SHARE },
      { identifier: id2, signingShare: E5_P2_SHARE },
      { identifier: id3, signingShare: E5_P3_SHARE }
    ]
    for (const combo of [[0, 1], [0, 2], [1, 2], [0, 1, 2]]) {
      const shares = combo.map((i) => all[i]!)
      const result = reconstructGroupSecret({
        threshold: 2,
        participants: 3,
        groupPublicKey: E5_GROUP_PUBLIC_KEY,
        groupCommitments,
        shares
      })
      expect(bytesToHex(result.secretKey)).to.equal(E5_GROUP_SECRET_KEY)
      expect(result.rejectedIdentifiers).to.deep.equal([])
    }
  })

  it('validateReleasedShare is true for P1, P2 and P3 against the pinned group commitments', () => {
    const groupCommitments = e5GroupCommitments()
    const id1 = secp256k1_FROST.Identifier.fromNumber(1)
    const id2 = secp256k1_FROST.Identifier.fromNumber(2)
    const id3 = secp256k1_FROST.Identifier.fromNumber(3)
    expect(validateReleasedShare(2, 3, groupCommitments, { identifier: id1, signingShare: E5_P1_SHARE })).to.equal(true)
    expect(validateReleasedShare(2, 3, groupCommitments, { identifier: id2, signingShare: E5_P2_SHARE })).to.equal(true)
    expect(validateReleasedShare(2, 3, groupCommitments, { identifier: id3, signingShare: E5_P3_SHARE })).to.equal(true)
  })

  it('a bit-flipped P2 share fails validateReleasedShare, and reconstructGroupSecret still recovers group_secret_key over [P1, badP2, P3] with P2 rejected', () => {
    const groupCommitments = e5GroupCommitments()
    const id1 = secp256k1_FROST.Identifier.fromNumber(1)
    const id2 = secp256k1_FROST.Identifier.fromNumber(2)
    const id3 = secp256k1_FROST.Identifier.fromNumber(3)
    const p2Bytes = hexToBytes(E5_P2_SHARE)
    p2Bytes[0] = p2Bytes[0]! ^ 0x01
    const badP2Hex = bytesToHex(p2Bytes)

    expect(validateReleasedShare(2, 3, groupCommitments, { identifier: id2, signingShare: badP2Hex })).to.equal(false)

    const result = reconstructGroupSecret({
      threshold: 2,
      participants: 3,
      groupPublicKey: E5_GROUP_PUBLIC_KEY,
      groupCommitments,
      shares: [
        { identifier: id1, signingShare: E5_P1_SHARE },
        { identifier: id2, signingShare: badP2Hex },
        { identifier: id3, signingShare: E5_P3_SHARE }
      ]
    })
    expect(bytesToHex(result.secretKey)).to.equal(E5_GROUP_SECRET_KEY)
    expect(result.rejectedIdentifiers).to.deep.equal([id2])
  })
})

// ---------------------------------------------------------------------------
// frost-rs secp256k1 DKG interoperability vectors (fixture pinned, see
// test/fixtures/frost-secp256k1-dkg-vectors.ts for commit + sha256)
// ---------------------------------------------------------------------------

describe('crypto-dkg: frost-rs secp256k1 DKG known-answer tests', () => {
  const v = FROST_SECP256K1_DKG_VECTORS
  const signers = { min: v.config.MIN_PARTICIPANTS, max: v.config.MAX_PARTICIPANTS }
  const Fn = secp256k1_FROST.utils.Fn

  function rebuildSecret (pid: 1 | 2 | 3) {
    const inp = v.inputs[String(pid) as '1' | '2' | '3']
    const res = secp256k1_FROST.utils.generateSecretPolynomial(
      signers,
      hexToBytes(inp.signing_key),
      [Fn.fromBytes(hexToBytes(inp.coefficient))]
    )
    return { inp, res }
  }

  function toR1Public (pid: 1 | 2 | 3, res: ReturnType<typeof rebuildSecret>['res'], inp: ReturnType<typeof rebuildSecret>['inp']): DkgRound1Wire {
    return {
      identifier: secp256k1_FROST.Identifier.fromNumber(pid),
      commitment: res.commitment.map((c) => bytesToHex(c)),
      proofOfKnowledge: inp.proof_of_knowledge
    }
  }

  it('round1 packages reproduce the vector vss_commitments for all three participants', () => {
    for (const pid of [1, 2, 3] as const) {
      const { inp, res } = rebuildSecret(pid)
      expect(bytesToHex(res.commitment[0]!)).to.equal(inp.vss_commitments[0])
      expect(bytesToHex(res.commitment[1]!)).to.equal(inp.vss_commitments[1])
    }
  })

  it('dkgRound2 outputs equal the vector signing_shares sent to each other participant', () => {
    const parts = { 1: rebuildSecret(1), 2: rebuildSecret(2), 3: rebuildSecret(3) }
    const r1pub = {
      1: toR1Public(1, parts[1].res, parts[1].inp),
      2: toR1Public(2, parts[2].res, parts[2].inp),
      3: toR1Public(3, parts[3].res, parts[3].inp)
    }
    for (const pid of [1, 2, 3] as const) {
      const secret = {
        identifier: Fn.fromBytes(hexToBytes(secp256k1_FROST.Identifier.fromNumber(pid))),
        coefficients: parts[pid].res.coefficients,
        commitment: parts[pid].res.commitment,
        signers,
        step: 1 as const
      }
      const others = ([1, 2, 3] as const).filter((x) => x !== pid).map((o) => r1pub[o])
      const round2 = dkgRound2(secret, others)
      for (const o of ([1, 2, 3] as const).filter((x) => x !== pid)) {
        const recipientId = secp256k1_FROST.Identifier.fromNumber(o)
        const signingShares = v.inputs[String(o) as '1' | '2' | '3'].signing_shares as Record<string, string>
        expect(bytesToHex(round2[recipientId]!)).to.equal(signingShares[String(pid)])
      }
    }
  })

  it('dkgRound3 yields the vector verifying_key, each signing_share and each verifying_share, and deriveGroupCommitments matches round3', () => {
    const parts = { 1: rebuildSecret(1), 2: rebuildSecret(2), 3: rebuildSecret(3) }
    const r1pub = {
      1: toR1Public(1, parts[1].res, parts[1].inp),
      2: toR1Public(2, parts[2].res, parts[2].inp),
      3: toR1Public(3, parts[3].res, parts[3].inp)
    }
    const secrets = ([1, 2, 3] as const).reduce((acc, pid) => {
      acc[pid] = {
        identifier: Fn.fromBytes(hexToBytes(secp256k1_FROST.Identifier.fromNumber(pid))),
        coefficients: parts[pid].res.coefficients,
        commitment: parts[pid].res.commitment,
        signers,
        step: 1 as const
      }
      return acc
    }, {} as Record<1 | 2 | 3, DKG_Secret>)

    const othersByPid = ([1, 2, 3] as const).reduce((acc, pid) => {
      acc[pid] = ([1, 2, 3] as const).filter((x) => x !== pid).map((o) => r1pub[o])
      return acc
    }, {} as Record<1 | 2 | 3, DkgRound1Wire[]>)

    const round2out = ([1, 2, 3] as const).reduce((acc, pid) => {
      acc[pid] = dkgRound2(secrets[pid], othersByPid[pid])
      return acc
    }, {} as Record<1 | 2 | 3, Record<string, Uint8Array>>)

    for (const pid of [1, 2, 3] as const) {
      const others = ([1, 2, 3] as const).filter((x) => x !== pid)
      const received: DkgReceivedShare[] = others.map((o) => ({
        dealer: secp256k1_FROST.Identifier.fromNumber(o),
        share: round2out[o][secp256k1_FROST.Identifier.fromNumber(pid)]!
      }))
      const key = dkgRound3(secrets[pid], othersByPid[pid], received)
      expect(key.groupPublicKey).to.equal(v.inputs.verifying_key)
      expect(bytesToHex(key.signingShare)).to.equal(v.inputs[String(pid) as '1' | '2' | '3'].signing_share)
      const ownId = secp256k1_FROST.Identifier.fromNumber(pid)
      expect(key.verifyingShares[ownId]).to.equal(v.inputs[String(pid) as '1' | '2' | '3'].verifying_share)

      const allR1 = [r1pub[1], r1pub[2], r1pub[3]]
      const recomputed = deriveGroupCommitments(allR1)
      expect(recomputed).to.deep.equal(key.groupCommitments)
      expect(recomputed[0]).to.equal(v.inputs.verifying_key)
    }
  })
})

// ---------------------------------------------------------------------------
// 3-of-5 end-to-end simulation through the wrapper only
// ---------------------------------------------------------------------------

describe('crypto-dkg: 3-of-5 simulation through the wrapper', () => {
  const USERS = ['user-a', 'user-b', 'user-c', 'user-d', 'user-e']
  const THRESHOLD = 3
  const PARTICIPANTS = 5

  function runDkg () {
    const ids = USERS.map((u) => dkgIdentifierForUser(u))
    const round1 = ids.map((id) => dkgRound1(id, THRESHOLD, PARTICIPANTS))
    const publics = round1.map((r) => r.public)

    // Round-trip each secret through serializeDkgSecret/parseDkgSecret between round1 and round2.
    const secretsAfterRound1Roundtrip = round1.map((r) => parseDkgSecret(serializeDkgSecret(r.secret)))

    const round2Outputs = secretsAfterRound1Roundtrip.map((secret, i) => {
      const others = publics.filter((_, j) => j !== i)
      return dkgRound2(secret, others)
    })

    // Round-trip again between round2 and round3.
    const secretsAfterRound2Roundtrip = secretsAfterRound1Roundtrip.map((secret) => parseDkgSecret(serializeDkgSecret(secret)))

    const keys = secretsAfterRound2Roundtrip.map((secret, i) => {
      const others = publics.filter((_, j) => j !== i)
      const myId = publics[i]!.identifier
      const received: DkgReceivedShare[] = others.map((o, k) => {
        const dealerIndex = publics.findIndex((p) => p.identifier === o.identifier)
        return { dealer: o.identifier, share: round2Outputs[dealerIndex]![myId]! }
      })
      return dkgRound3(secret, others, received)
    })

    return { publics, keys }
  }

  it('each R1 package verifies against its own commitRound1 hex', () => {
    const ids = USERS.map((u) => dkgIdentifierForUser(u))
    for (const id of ids) {
      const { public: pkg } = dkgRound1(id, THRESHOLD, PARTICIPANTS)
      const commitHex = commitRound1(CTX, pkg)
      expect(verifyRound1Commit(CTX, pkg, commitHex)).to.equal(true)
    }
  })

  it('all five participants agree on groupPublicKey, and serialize/parse round-trips do not break completion', () => {
    const { keys } = runDkg()
    const groupKeys = new Set(keys.map((k) => k.groupPublicKey))
    expect(groupKeys.size).to.equal(1)
  })

  it('every 3-subset of the five released shares reconstructs a key whose public point equals groupPublicKey', () => {
    const { keys } = runDkg()
    const groupPublicKey = keys[0]!.groupPublicKey
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))

    const combos: number[][] = []
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) {
        for (let c = b + 1; c < 5; c++) combos.push([a, b, c])
      }
    }
    for (const combo of combos) {
      const shares = combo.map((i) => released[i]!)
      const result = reconstructGroupSecret({
        threshold: THRESHOLD,
        participants: PARTICIPANTS,
        groupPublicKey,
        groupCommitments,
        shares
      })
      const derivedPub = bytesToHex(secp256k1.getPublicKey(result.secretKey, true))
      expect(derivedPub).to.equal(groupPublicKey)
    }
  })

  it('2 valid shares give insufficient-shares', () => {
    const { keys } = runDkg()
    const groupPublicKey = keys[0]!.groupPublicKey
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.slice(0, 2).map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
    expect(() => reconstructGroupSecret({ threshold: THRESHOLD, participants: PARTICIPANTS, groupPublicKey, groupCommitments, shares: released }))
      .to.throw(DkgError)
      .with.property('code', 'insufficient-shares')
  })

  it('3 valid shares plus 1 bogus share reconstruct, with the bogus identifier rejected', () => {
    const { keys } = runDkg()
    const groupPublicKey = keys[0]!.groupPublicKey
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.slice(0, 3).map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
    const bogus = { identifier: keys[3]!.identifier, signingShare: bytesToHex(new Uint8Array(32).fill(0x07)) }
    const result = reconstructGroupSecret({
      threshold: THRESHOLD,
      participants: PARTICIPANTS,
      groupPublicKey,
      groupCommitments,
      shares: [...released, bogus]
    })
    const derivedPub = bytesToHex(secp256k1.getPublicKey(result.secretKey, true))
    expect(derivedPub).to.equal(groupPublicKey)
    expect(result.rejectedIdentifiers).to.deep.equal([bogus.identifier])
  })

  it('a duplicated identifier among the valid shares is used once', () => {
    const { keys } = runDkg()
    const groupPublicKey = keys[0]!.groupPublicKey
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.slice(0, 3).map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
    const duplicate = { ...released[0]! }
    const result = reconstructGroupSecret({
      threshold: THRESHOLD,
      participants: PARTICIPANTS,
      groupPublicKey,
      groupCommitments,
      shares: [...released, duplicate]
    })
    expect(result.usedIdentifiers.filter((id) => id === duplicate.identifier)).to.have.length(1)
  })

  it('a wrong groupPublicKey input throws group-key-mismatch', () => {
    const { keys } = runDkg()
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.slice(0, 3).map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
    const wrongKey = bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(0x09), true))
    expect(() => reconstructGroupSecret({ threshold: THRESHOLD, participants: PARTICIPANTS, groupPublicKey: wrongKey, groupCommitments, shares: released }))
      .to.throw(DkgError)
      .with.property('code', 'group-key-mismatch')
  })
})

// ---------------------------------------------------------------------------
// Threshold bounds (D-16)
// ---------------------------------------------------------------------------

describe('crypto-dkg: threshold bounds (D-16, 2 <= k <= n)', () => {
  const invalid: Array<[number, number]> = [[1, 3], [0, 3], [4, 3], [2, 1], [2.5, 4], [2, NaN]]
  const valid: Array<[number, number]> = [[2, 2], [3, 5], [5, 5]]

  for (const [threshold, participants] of invalid) {
    it(`assertDkgThreshold(${threshold}, ${participants}) throws threshold-out-of-range`, () => {
      expect(() => assertDkgThreshold(threshold, participants)).to.throw(DkgError).with.property('code', 'threshold-out-of-range')
    })
    it(`dkgRound1 rejects threshold=${threshold}, participants=${participants}`, () => {
      expect(() => dkgRound1(dkgIdentifierForUser('u'), threshold, participants)).to.throw(DkgError).with.property('code', 'threshold-out-of-range')
    })
    it(`reconstructGroupSecret rejects threshold=${threshold}, participants=${participants}`, () => {
      expect(() => reconstructGroupSecret({
        threshold, participants, groupPublicKey: E5_GROUP_PUBLIC_KEY, groupCommitments: e5GroupCommitments(), shares: []
      })).to.throw(DkgError).with.property('code', 'threshold-out-of-range')
    })
  }

  for (const [threshold, participants] of valid) {
    it(`assertDkgThreshold(${threshold}, ${participants}) passes`, () => {
      expect(() => assertDkgThreshold(threshold, participants)).to.not.throw()
    })
  }
})

// ---------------------------------------------------------------------------
// Commit-reveal (R0)
// ---------------------------------------------------------------------------

describe('crypto-dkg: commit-reveal (R0)', () => {
  const pkg: DkgRound1Wire = dkgRound1(dkgIdentifierForUser('commit-user'), 2, 3).public

  it('verifyRound1Commit is false when a commitment element is swapped', () => {
    const commitHex = commitRound1(CTX, pkg)
    const tampered: DkgRound1Wire = { ...pkg, commitment: [...pkg.commitment].reverse() }
    expect(verifyRound1Commit(CTX, tampered, commitHex)).to.equal(false)
  })

  it('verifyRound1Commit is false when ctx.attempt differs', () => {
    const commitHex = commitRound1(CTX, pkg)
    expect(verifyRound1Commit({ ...CTX, attempt: CTX.attempt + 1 }, pkg, commitHex)).to.equal(false)
  })

  it('verifyRound1Commit is false when ctx.revision differs', () => {
    const commitHex = commitRound1(CTX, pkg)
    expect(verifyRound1Commit({ ...CTX, revision: CTX.revision + 1 }, pkg, commitHex)).to.equal(false)
  })

  it('verifyRound1Commit is false when ctx.electionId differs', () => {
    const commitHex = commitRound1(CTX, pkg)
    expect(verifyRound1Commit({ ...CTX, electionId: CTX.electionId + '-other' }, pkg, commitHex)).to.equal(false)
  })

  it('verifyRound1Commit is false when the proofOfKnowledge is altered', () => {
    const commitHex = commitRound1(CTX, pkg)
    const pokBytes = hexToBytes(pkg.proofOfKnowledge)
    pokBytes[0] = pokBytes[0]! ^ 0x01
    const tampered: DkgRound1Wire = { ...pkg, proofOfKnowledge: bytesToHex(pokBytes) }
    expect(verifyRound1Commit(CTX, tampered, commitHex)).to.equal(false)
  })
})

// ---------------------------------------------------------------------------
// Round-1 blame
// ---------------------------------------------------------------------------

describe('crypto-dkg: round-1 blame attribution', () => {
  const THRESHOLD = 3
  const PARTICIPANTS = 5
  const USERS = ['u1', 'u2', 'u3', 'u4', 'u5']

  function fresh () {
    const ids = USERS.map((u) => dkgIdentifierForUser(u))
    return ids.map((id) => dkgRound1(id, THRESHOLD, PARTICIPANTS))
  }

  it('verifyRound1Package is false for exactly the package with a tampered PoK, true for the rest; dkgRound2 attributes invalid-round1 to that dealer', () => {
    const rounds = fresh()
    const [mine, ...rest] = rounds
    const others = rest.map((r) => r.public)
    const tamperedIndex = 1
    const tamperedPkg = others[tamperedIndex]!
    const pokBytes = hexToBytes(tamperedPkg.proofOfKnowledge)
    pokBytes[0] = pokBytes[0]! ^ 0x01
    const tampered: DkgRound1Wire = { ...tamperedPkg, proofOfKnowledge: bytesToHex(pokBytes) }
    const tamperedOthers = others.map((o, i) => (i === tamperedIndex ? tampered : o))

    for (let i = 0; i < tamperedOthers.length; i++) {
      const result = verifyRound1Package(mine!.secret, tamperedOthers[i]!)
      expect(result, `package ${i} verification`).to.equal(i !== tamperedIndex)
    }

    expect(() => dkgRound2(mine!.secret, tamperedOthers))
      .to.throw(DkgError)
      .with.property('dealer', tampered.identifier)
    try {
      dkgRound2(mine!.secret, tamperedOthers)
      expect.fail('expected dkgRound2 to throw')
    } catch (e) {
      expect(e).to.be.instanceOf(DkgError)
      expect((e as InstanceType<typeof DkgError>).code).to.equal('invalid-round1')
    }
  })

  it('passing max-2 packages throws malformed-input', () => {
    const rounds = fresh()
    const [mine, ...rest] = rounds
    const others = rest.slice(0, rest.length - 1).map((r) => r.public)
    expect(() => dkgRound2(mine!.secret, others)).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('two packages with the same identifier throw duplicate-identifier', () => {
    const rounds = fresh()
    const [mine, ...rest] = rounds
    const others = rest.map((r) => r.public)
    const duped = [...others.slice(0, others.length - 1), others[0]!]
    expect(() => dkgRound2(mine!.secret, duped)).to.throw(DkgError).with.property('code', 'duplicate-identifier')
  })
})

// ---------------------------------------------------------------------------
// Round-3 blame
// ---------------------------------------------------------------------------

describe('crypto-dkg: round-3 blame attribution', () => {
  it('one received share altered gives invalid-share with dealer set to that dealer', () => {
    const THRESHOLD = 3
    const PARTICIPANTS = 5
    const USERS = ['r3-a', 'r3-b', 'r3-c', 'r3-d', 'r3-e']
    const ids = USERS.map((u) => dkgIdentifierForUser(u))
    const round1 = ids.map((id) => dkgRound1(id, THRESHOLD, PARTICIPANTS))
    const publics = round1.map((r) => r.public)
    const round2Outputs = round1.map((r, i) => {
      const others = publics.filter((_, j) => j !== i)
      return dkgRound2(r.secret, others)
    })

    const victim = 0
    const others = publics.filter((_, j) => j !== victim)
    const myId = publics[victim]!.identifier
    const received: DkgReceivedShare[] = others.map((o) => {
      const dealerIndex = publics.findIndex((p) => p.identifier === o.identifier)
      return { dealer: o.identifier, share: round2Outputs[dealerIndex]![myId]! }
    })
    const tamperedDealer = received[0]!.dealer
    const tamperedShare = new Uint8Array(received[0]!.share)
    tamperedShare[0] = tamperedShare[0]! ^ 0x01
    const tamperedReceived = received.map((r) => (r.dealer === tamperedDealer ? { dealer: r.dealer, share: tamperedShare } : r))

    try {
      dkgRound3(round1[victim]!.secret, others, tamperedReceived)
      expect.fail('expected dkgRound3 to throw')
    } catch (e) {
      expect(e).to.be.instanceOf(DkgError)
      expect((e as InstanceType<typeof DkgError>).code).to.equal('invalid-share')
      expect((e as InstanceType<typeof DkgError>).dealer).to.equal(tamperedDealer)
    }
  })
})

// ---------------------------------------------------------------------------
// Malformed input fails closed
// ---------------------------------------------------------------------------

describe('crypto-dkg: malformed input fails closed with malformed-input', () => {
  it('dkgRound1 rejects a non-hex identifier', () => {
    expect(() => dkgRound1('not-hex', 2, 3)).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('parseDkgSecret rejects a bad version', () => {
    const good = serializeDkgSecret(dkgRound1(dkgIdentifierForUser('p'), 2, 3).secret)
    const obj = JSON.parse(good)
    obj.v = 2
    expect(() => parseDkgSecret(JSON.stringify(obj))).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('parseDkgSecret rejects a wrong coefficient count', () => {
    const good = serializeDkgSecret(dkgRound1(dkgIdentifierForUser('p2'), 3, 5).secret)
    const obj = JSON.parse(good)
    obj.coefficients.pop()
    obj.commitment.pop()
    expect(() => parseDkgSecret(JSON.stringify(obj))).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('parseDkgSecret rejects a step outside {1,2}', () => {
    const good = serializeDkgSecret(dkgRound1(dkgIdentifierForUser('p3'), 2, 3).secret)
    const obj = JSON.parse(good)
    obj.step = 3
    expect(() => parseDkgSecret(JSON.stringify(obj))).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('parseDkgSecret rejects malformed JSON', () => {
    expect(() => parseDkgSecret('{not json')).to.throw(DkgError).with.property('code', 'malformed-input')
  })

  it('deriveGroupCommitments rejects a malformed point', () => {
    const pkg: DkgRound1Wire = { identifier: dkgIdentifierForUser('x'), commitment: ['zz'], proofOfKnowledge: 'aa' }
    expect(() => deriveGroupCommitments([pkg])).to.throw(DkgError).with.property('code', 'malformed-input')
  })
})
