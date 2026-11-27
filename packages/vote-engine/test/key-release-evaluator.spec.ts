/**
 * key-release-evaluator.spec.ts (62-20, Task 1)
 *
 * DB-free cases for the three pure `src/key-release/*` modules: the D-20
 * release-window detector, the D-14/D-17 release evaluator, and the D-18
 * block-payload contract. The evaluator and block-payload cases build a
 * real 3-of-5 FROST DKG with 62-05's primitives (no stubs), following the
 * same `runDkg()` pattern as `test/crypto-dkg.spec.ts`'s "3-of-5 simulation
 * through the wrapper" describe block.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { ElectionEvent, type ElectionKeyRecord } from '@votetorrent/vote-core'
import {
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  parseDkgSecret,
  reconstructGroupSecret,
  serializeDkgSecret,
  type DkgReceivedShare
} from '../src/crypto/dkg.js'
import { encryptBlockContent, serializeBlockCiphertext } from '../src/crypto/index.js'
import { hasEnteredReleasingKeys, releasingKeysAt } from '../src/key-release/release-window.js'
import { evaluateKeyRelease, type KeyReleaseRow, type KeyReleaseSnapshot } from '../src/key-release/key-release-evaluator.js'
import {
  encryptElectionBlock,
  openElectionBlock,
  parseElectionBlockPayload,
  serializeElectionBlockPayload
} from '../src/key-release/election-block.js'

// ---------------------------------------------------------------------------
// release-window
// ---------------------------------------------------------------------------

describe('key-release: release-window (D-20)', () => {
  describe('releasingKeysAt', () => {
    it('extracts a positive epoch-ms number under the releasingKeys key', () => {
      expect(releasingKeysAt({ releasingKeys: 1700000000000 })).to.equal(1700000000000)
    })

    it('is null for null', () => {
      expect(releasingKeysAt(null)).to.equal(null)
    })

    it('is null for undefined', () => {
      expect(releasingKeysAt(undefined)).to.equal(null)
    })

    it('is null for a non-object (number)', () => {
      expect(releasingKeysAt(42)).to.equal(null)
    })

    it('is null for a non-object (array)', () => {
      expect(releasingKeysAt([1700000000000])).to.equal(null)
    })

    it('is null for a missing key', () => {
      expect(releasingKeysAt({})).to.equal(null)
    })

    it('is null for 0', () => {
      expect(releasingKeysAt({ releasingKeys: 0 })).to.equal(null)
    })

    it('is null for a negative number', () => {
      expect(releasingKeysAt({ releasingKeys: -1 })).to.equal(null)
    })

    it('is null for NaN', () => {
      expect(releasingKeysAt({ releasingKeys: Number.NaN })).to.equal(null)
    })

    it('is null for Infinity', () => {
      expect(releasingKeysAt({ releasingKeys: Number.POSITIVE_INFINITY })).to.equal(null)
    })

    it('is null for a non-numeric, non-ISO-Z string', () => {
      expect(releasingKeysAt({ releasingKeys: 'soon' })).to.equal(null)
    })

    it('is null for a JSON-text string passed as the timeline argument itself', () => {
      expect(releasingKeysAt('{"releasingKeys":1700000000000}')).to.equal(null)
    })

    it('accepts a strict ISO-Z string, decoded via Date.parse', () => {
      const iso = '2026-10-01T00:00:00.000Z'
      expect(releasingKeysAt({ [ElectionEvent.releasingKeys]: iso })).to.equal(Date.parse(iso))
    })

    it('is null for a string that is not strict ISO-Z (no Z suffix)', () => {
      expect(releasingKeysAt({ releasingKeys: '2026-10-01T00:00:00.000' })).to.equal(null)
    })

    it('is null for a string that is not strict ISO-Z (wrong format)', () => {
      expect(releasingKeysAt({ releasingKeys: '10/01/2026' })).to.equal(null)
    })
  })

  describe('hasEnteredReleasingKeys', () => {
    const at = 1700000000000
    const timeline = { releasingKeys: at }

    it('is false one ms before the boundary', () => {
      expect(hasEnteredReleasingKeys(timeline, at - 1)).to.equal(false)
    })

    it('is true exactly at the boundary (inclusive)', () => {
      expect(hasEnteredReleasingKeys(timeline, at)).to.equal(true)
    })

    it('is true one ms after the boundary', () => {
      expect(hasEnteredReleasingKeys(timeline, at + 1)).to.equal(true)
    })

    it('is false when releasingKeysAt is null, regardless of now', () => {
      expect(hasEnteredReleasingKeys({}, Number.MAX_SAFE_INTEGER)).to.equal(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Shared real-DKG fixture for the evaluator and block-payload sections
// ---------------------------------------------------------------------------

const USERS = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5']
const THRESHOLD = 3
const PARTICIPANTS = 5

function runDkg () {
  const ids = USERS.map((u) => dkgIdentifierForUser(u))
  const round1 = ids.map((id) => dkgRound1(id, THRESHOLD, PARTICIPANTS))
  const publics = round1.map((r) => r.public)

  // Round-trip each secret through serializeDkgSecret/parseDkgSecret between
  // rounds — same proven idiom as crypto-dkg.spec.ts's "3-of-5 simulation".
  const secretsAfterRound1Roundtrip = round1.map((r) => parseDkgSecret(serializeDkgSecret(r.secret)))

  const round2Outputs = secretsAfterRound1Roundtrip.map((secret, i) => {
    const others = publics.filter((_, j) => j !== i)
    return dkgRound2(secret, others)
  })

  const secretsAfterRound2Roundtrip = secretsAfterRound1Roundtrip.map((secret) => parseDkgSecret(serializeDkgSecret(secret)))

  const keys = secretsAfterRound2Roundtrip.map((secret, i) => {
    const others = publics.filter((_, j) => j !== i)
    const myId = publics[i]!.identifier
    const received: DkgReceivedShare[] = others.map((o) => {
      const dealerIndex = publics.findIndex((p) => p.identifier === o.identifier)
      return { dealer: o.identifier, share: round2Outputs[dealerIndex]![myId]! }
    })
    return dkgRound3(secret, others, received)
  })

  return { publics, keys }
}

let DKG: ReturnType<typeof runDkg>

function userIndex (userId: string): number {
  return USERS.indexOf(userId)
}

function honestRow (userId: string, overrides: Partial<KeyReleaseRow> = {}): KeyReleaseRow {
  const key = DKG.keys[userIndex(userId)]!
  return {
    userId,
    identifier: key.identifier,
    signingShare: bytesToHex(key.signingShare),
    releasedAt: '2026-10-01T00:00:00.000Z',
    signerKey: `signer-key-${userId}`,
    signatureValid: true,
    ...overrides
  }
}

function makeElectionKeyRecord (overrides: Partial<ElectionKeyRecord> = {}): ElectionKeyRecord & { signatureValid: boolean } {
  return {
    electionId: 'election-aaaa',
    revision: 1,
    attempt: 1,
    jointPublicKey: DKG.keys[0]!.groupPublicKey,
    groupCommitments: DKG.keys[0]!.groupCommitments,
    threshold: THRESHOLD,
    participants: PARTICIPANTS,
    publishedAt: '2026-09-01T00:00:00.000Z',
    publisherUserId: 'u-1',
    signatureValid: true,
    ...overrides
  }
}

function makeSnapshot (overrides: Partial<KeyReleaseSnapshot> = {}): KeyReleaseSnapshot {
  return {
    electionId: 'election-aaaa',
    revision: 1,
    isCurrentRevision: true,
    keyholderThreshold: THRESHOLD,
    timeline: { [ElectionEvent.releasingKeys]: 1700000000000 },
    now: 1700000001000,
    electionKey: makeElectionKeyRecord(),
    r4ParticipantUserIds: [...USERS].sort(),
    releases: [],
    transcriptCommitments: DKG.keys[0]!.groupCommitments,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// key-release-evaluator (D-14, D-17)
// ---------------------------------------------------------------------------

describe('key-release: evaluateKeyRelease (D-14, D-17)', () => {
  before(function () {
    this.timeout(60000)
    DKG = runDkg()
  })

  describe('phase gates', () => {
    it('revision null gives no-current-revision', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ revision: null }))
      expect(ev.status.phase).to.equal('no-current-revision')
      expect(ev.status.electionKey).to.equal(null)
      expect(ev.acceptedReleases).to.deep.equal([])
    })

    it('no electionKey gives no-election-key', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ electionKey: null }))
      expect(ev.status.phase).to.equal('no-election-key')
      expect(ev.status.electionKey).to.equal(null)
    })

    it('an electionKey with signatureValid false gives no-election-key', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ electionKey: makeElectionKeyRecord({ signatureValid: false }) }))
      expect(ev.status.phase).to.equal('no-election-key')
      expect(ev.status.electionKey).to.equal(null)
    })

    it('electionKey.threshold differing from the current revision keyholderThreshold gives election-key-inconsistent', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ electionKey: makeElectionKeyRecord({ threshold: THRESHOLD + 1 }) }))
      expect(ev.status.phase).to.equal('election-key-inconsistent')
      expect(ev.status.electionKey).to.not.equal(null)
    })

    it('participants differing from r4ParticipantUserIds.length gives election-key-inconsistent', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ r4ParticipantUserIds: USERS.slice(0, 4).sort() }))
      expect(ev.status.phase).to.equal('election-key-inconsistent')
    })

    it('transcript commitments[0] !== jointPublicKey gives election-key-inconsistent', () => {
      const badCommitments = [`02${'11'.repeat(32)}`, ...DKG.keys[0]!.groupCommitments.slice(1)]
      const ev = evaluateKeyRelease(makeSnapshot({ transcriptCommitments: badCommitments }))
      expect(ev.status.phase).to.equal('election-key-inconsistent')
    })

    it('62-34: transcriptCommitments null (no derivable transcript) gives election-key-inconsistent', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ transcriptCommitments: null }))
      expect(ev.status.phase).to.equal('election-key-inconsistent')
    })

    it('62-34: junk electionKey.groupCommitments with a correct transcript validates shares against the transcript', () => {
      const junk = [`02${'11'.repeat(32)}`, `02${'22'.repeat(32)}`]
      const rows = USERS.slice(0, THRESHOLD).map((u) => honestRow(u))
      const ev = evaluateKeyRelease(makeSnapshot({ electionKey: makeElectionKeyRecord({ groupCommitments: junk }), releases: rows }))
      expect(ev.status.phase).to.equal('reconstructable')
      expect(ev.status.rejectedReleases).to.deep.equal([])
    })

    it('a consistent key with zero releases and now < releasingKeysAt gives before-release-window, awaiting all participants', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ now: 1699999999000, releases: [] }))
      expect(ev.status.phase).to.equal('before-release-window')
      expect(ev.status.awaitingUserIds).to.deep.equal([...USERS].sort())
      expect(ev.status.releasedCount).to.equal(0)
    })
  })

  describe('counting (D-14)', () => {
    it('2 honest releases with the window open gives releasing, releasedCount 2, the other three awaiting', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [honestRow('u-1'), honestRow('u-2')] }))
      expect(ev.status.phase).to.equal('releasing')
      expect(ev.status.releasedCount).to.equal(2)
      expect(ev.status.releasedUserIds).to.deep.equal(['u-1', 'u-2'])
      expect(ev.status.awaitingUserIds).to.deep.equal(['u-3', 'u-4', 'u-5'])
    })

    it('3 honest releases gives reconstructable', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [honestRow('u-1'), honestRow('u-2'), honestRow('u-3')] }))
      expect(ev.status.phase).to.equal('reconstructable')
      expect(ev.status.releasedCount).to.equal(3)
    })

    it('3 honest releases BEFORE the window still gives reconstructable — public shares are public regardless of the clock', () => {
      const ev = evaluateKeyRelease(makeSnapshot({
        now: 1699999999000,
        releases: [honestRow('u-1'), honestRow('u-2'), honestRow('u-3')]
      }))
      expect(ev.status.hasEnteredReleasingKeys).to.equal(false)
      expect(ev.status.phase).to.equal('reconstructable')
    })
  })

  describe('rejections (D-17 filtering)', () => {
    it('a row with signatureValid false gives signature-invalid, not counted', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [honestRow('u-1', { signatureValid: false })] }))
      expect(ev.status.releasedCount).to.equal(0)
      expect(ev.status.rejectedReleases).to.deep.equal([{ userId: 'u-1', reason: 'signature-invalid' }])
    })

    it('a row from a user outside r4ParticipantUserIds gives not-a-participant', () => {
      const outsiderRow: KeyReleaseRow = {
        userId: 'u-9',
        identifier: dkgIdentifierForUser('u-9'),
        signingShare: '11'.repeat(32),
        releasedAt: '2026-10-01T00:00:00.000Z',
        signerKey: 'signer-key-u-9',
        signatureValid: true
      }
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [outsiderRow] }))
      expect(ev.status.rejectedReleases).to.deep.equal([{ userId: 'u-9', reason: 'not-a-participant' }])
    })

    it('a row whose identifier belongs to a different user gives identifier-mismatch', () => {
      const row = honestRow('u-2', { identifier: dkgIdentifierForUser('u-3') })
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [row] }))
      expect(ev.status.rejectedReleases).to.deep.equal([{ userId: 'u-2', reason: 'identifier-mismatch' }])
    })

    it('a row whose signingShare is a different valid scalar gives share-invalid', () => {
      const row = honestRow('u-1', { signingShare: bytesToHex(DKG.keys[2]!.signingShare) })
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [row] }))
      expect(ev.status.rejectedReleases).to.deep.equal([{ userId: 'u-1', reason: 'share-invalid' }])
    })

    it('two honest plus three bogus rows gives releasedCount 2 and phase releasing', () => {
      const badSignature = honestRow('u-4', { signatureValid: false })
      const notParticipant: KeyReleaseRow = {
        userId: 'u-9',
        identifier: dkgIdentifierForUser('u-9'),
        signingShare: '22'.repeat(32),
        releasedAt: '2026-10-01T00:00:00.000Z',
        signerKey: 'signer-key-u-9',
        signatureValid: true
      }
      const shareInvalid = honestRow('u-5', { signingShare: bytesToHex(DKG.keys[2]!.signingShare) })
      const ev = evaluateKeyRelease(makeSnapshot({
        releases: [honestRow('u-1'), honestRow('u-2'), badSignature, notParticipant, shareInvalid]
      }))
      expect(ev.status.releasedCount).to.equal(2)
      expect(ev.status.phase).to.equal('releasing')
      expect(ev.status.rejectedReleases.map((r) => r.userId)).to.deep.equal(['u-4', 'u-5', 'u-9'])
    })
  })

  describe('determinism and sorting', () => {
    it('shuffling the releases array yields deep-equal output', () => {
      const rows = [
        honestRow('u-1'),
        honestRow('u-2'),
        honestRow('u-4', { signatureValid: false }),
        honestRow('u-5', { signingShare: bytesToHex(DKG.keys[2]!.signingShare) })
      ]
      const shuffled = [rows[3]!, rows[1]!, rows[0]!, rows[2]!]
      const a = evaluateKeyRelease(makeSnapshot({ releases: rows }))
      const b = evaluateKeyRelease(makeSnapshot({ releases: shuffled }))
      expect(b.status).to.deep.equal(a.status)
      expect(b.acceptedReleases).to.deep.equal(a.acceptedReleases)
    })

    it('acceptedReleases are sorted by userId', () => {
      const ev = evaluateKeyRelease(makeSnapshot({ releases: [honestRow('u-3'), honestRow('u-1'), honestRow('u-2')] }))
      expect(ev.acceptedReleases.map((r) => r.userId)).to.deep.equal(['u-1', 'u-2', 'u-3'])
    })
  })

  describe('revision pin (non-current revision)', () => {
    it('skips the threshold check for a non-current revision but still applies the participants check', () => {
      const ev = evaluateKeyRelease(makeSnapshot({
        isCurrentRevision: false,
        keyholderThreshold: THRESHOLD + 10, // deliberately mismatched — must be ignored
        electionKey: makeElectionKeyRecord()
      }))
      expect(ev.status.phase).to.not.equal('election-key-inconsistent')
    })

    it('still applies the participants and commitment checks for a non-current revision', () => {
      const ev = evaluateKeyRelease(makeSnapshot({
        isCurrentRevision: false,
        keyholderThreshold: THRESHOLD + 10,
        r4ParticipantUserIds: USERS.slice(0, 4).sort()
      }))
      expect(ev.status.phase).to.equal('election-key-inconsistent')
    })
  })
})

// ---------------------------------------------------------------------------
// election-block (D-18)
// ---------------------------------------------------------------------------

describe('key-release: election-block (D-18)', () => {
  before(function () {
    this.timeout(60000)
    if (DKG === undefined) DKG = runDkg()
  })

  const payload = {
    v: 1 as const,
    votes: [{ ballot: 'b1', choice: 2 }],
    voterRecords: [{ registrantId: 'r-1', at: '2026-10-01T00:00:00Z' }]
  }

  describe('serialize / parse round trip', () => {
    it('serializeElectionBlockPayload then parseElectionBlockPayload is identity', () => {
      const bytes = serializeElectionBlockPayload(payload)
      expect(parseElectionBlockPayload(bytes)).to.deep.equal(payload)
    })

    it('the serialized JSON member order is v, votes, voterRecords', () => {
      const bytes = serializeElectionBlockPayload(payload)
      const text = new TextDecoder().decode(bytes)
      expect(Object.keys(JSON.parse(text))).to.deep.equal(['v', 'votes', 'voterRecords'])
    })
  })

  describe('parseElectionBlockPayload never throws, is strict', () => {
    it('returns null for non-UTF-8 bytes', () => {
      expect(parseElectionBlockPayload(new Uint8Array([0xff, 0xfe, 0xfd]))).to.equal(null)
    })

    it('returns null for non-JSON text', () => {
      expect(parseElectionBlockPayload(utf8ToBytes('not json{'))).to.equal(null)
    })

    it('returns null for an unknown version (v: 3)', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 3, votes: [], voterRecords: [] })))).to.equal(null)
    })

    it('accepts v: 2 (pool block: per-vote ciphertexts) only when every vote is a string', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 2, votes: ['{"ct":1}'], voterRecords: [] })))).to.deep.equal({ v: 2, votes: ['{"ct":1}'], voterRecords: [] })
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 2, votes: [{ ct: 1 }], voterRecords: [] })))).to.equal(null)
    })

    it('returns null for a missing votes member', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 1, voterRecords: [] })))).to.equal(null)
    })

    it('returns null for a missing voterRecords member', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 1, votes: [] })))).to.equal(null)
    })

    it('returns null for a non-array voterRecords', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 1, votes: [], voterRecords: {} })))).to.equal(null)
    })

    it('returns null for an extra top-level member', () => {
      expect(parseElectionBlockPayload(utf8ToBytes(JSON.stringify({ v: 1, votes: [], voterRecords: [], extra: 'x' })))).to.equal(null)
    })
  })

  describe('encryptElectionBlock refuses an incomplete payload before encrypting', () => {
    const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: '' }

    it('throws BlockCipherError invalid-plaintext for a payload missing voterRecords', () => {
      const bad = { v: 1 as const, votes: [] } as unknown as typeof payload
      expect(() => encryptElectionBlock(electionKey, 'block-1', bad)).to.throw().with.property('code', 'invalid-plaintext')
    })

    it('throws BlockCipherError invalid-plaintext for a payload missing votes', () => {
      const bad = { v: 1 as const, voterRecords: [] } as unknown as typeof payload
      expect(() => encryptElectionBlock(electionKey, 'block-1', bad)).to.throw().with.property('code', 'invalid-plaintext')
    })
  })

  describe('round trip and failures under a real DKG joint key Y', () => {
    function reconstructedSecret (): Uint8Array {
      const shares = DKG.keys.slice(0, THRESHOLD).map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
      const result = reconstructGroupSecret({
        threshold: THRESHOLD,
        participants: PARTICIPANTS,
        groupPublicKey: DKG.keys[0]!.groupPublicKey,
        groupCommitments: DKG.keys[0]!.groupCommitments,
        shares
      })
      return result.secretKey
    }

    it('round-trips: encryptElectionBlock then openElectionBlock gives ok:true with deep-equal votes and voterRecords', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
      const s = reconstructedSecret()
      const result = openElectionBlock(s, electionKey, { blockId: 'block-1', ciphertext })
      expect(result.ok).to.equal(true)
      if (result.ok) {
        expect(result.blockId).to.equal('block-1')
        expect(result.payload).to.deep.equal(payload)
      }
    })

    it('round-trips when the ciphertext is passed as its JSON string', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
      const s = reconstructedSecret()
      const result = openElectionBlock(s, electionKey, { blockId: 'block-1', ciphertext: serializeBlockCiphertext(ciphertext) })
      expect(result.ok).to.equal(true)
    })

    it('opening with a different blockId gives authentication-failed', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
      const s = reconstructedSecret()
      const result = openElectionBlock(s, electionKey, { blockId: 'block-2', ciphertext })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('opening with a different (but validly formed) secret key gives authentication-failed', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
      const wrongSecret = secp256k1.utils.randomSecretKey()
      const result = openElectionBlock(wrongSecret, electionKey, { blockId: 'block-1', ciphertext })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('authentication-failed')
    })

    it('a ciphertext whose v field is not 1 gives unsupported-version', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const ciphertext = encryptElectionBlock(electionKey, 'block-1', payload)
      const s = reconstructedSecret()
      const result = openElectionBlock(s, electionKey, { blockId: 'block-1', ciphertext: { ...ciphertext, v: 2 } })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('unsupported-version')
    })

    it('a ciphertext whose decrypted bytes are not a valid payload gives malformed-payload', () => {
      const electionKey = { electionId: 'election-aaaa', revision: 1, jointPublicKey: DKG.keys[0]!.groupPublicKey }
      const notAPayload = encryptBlockContent(electionKey.jointPublicKey, utf8ToBytes('not an election block payload'), {
        electionId: electionKey.electionId,
        revision: electionKey.revision,
        blockId: 'block-1'
      })
      const s = reconstructedSecret()
      const result = openElectionBlock(s, electionKey, { blockId: 'block-1', ciphertext: notAPayload })
      expect(result.ok).to.equal(false)
      if (!result.ok) expect(result.reason).to.equal('malformed-payload')
    })
  })
})
