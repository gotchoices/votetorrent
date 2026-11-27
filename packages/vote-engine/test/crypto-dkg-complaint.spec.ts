/**
 * crypto-dkg-complaint.spec.ts
 *
 * Share ciphertexts with a key-commitment tag, and attributable complaint
 * verdicts, for `src/crypto/dkg.ts` (D-16, D-17, D-25). Style follows
 * noble-dedupe-regression.spec.ts (mocha describe/it + chai expect).
 */

import { expect } from 'chai'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  DkgError,
  buildComplaintEvidence,
  decryptShare,
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  encryptShare,
  generateDkgReceivingKey,
  reconstructGroupSecret,
  verifyComplaintEvidence,
  type DkgContext,
  type DkgReceivedShare,
  type EncryptedShare
} from '../src/crypto/dkg.ts'

const CTX: DkgContext = { electionId: 'election-bbbb', revision: 2, attempt: 1 }

describe('crypto-dkg-complaint: generateDkgReceivingKey / round-trip', () => {
  it('generateDkgReceivingKey returns a 32-byte private key and a 66-hex compressed public key', () => {
    const key = generateDkgReceivingKey()
    expect(key.privateKey).to.be.instanceOf(Uint8Array)
    expect(key.privateKey.length).to.equal(32)
    expect(key.publicKey).to.match(/^[0-9a-f]{66}$/)
  })

  it('encryptShare then decryptShare returns the exact share bytes, and wire fields match shape', () => {
    const dealer = dkgIdentifierForUser('dealer-1')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('recipient-1')
    const share = new Uint8Array(32).fill(0x11)

    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    expect(enc.v).to.equal(1)
    expect(enc.nonce).to.match(/^[0-9a-f]{24}$/)
    expect(enc.keyCommitment).to.match(/^[0-9a-f]{64}$/)
    expect(enc.ephemeralPublicKey).to.match(/^[0-9a-f]{66}$/)

    const decrypted = decryptShare(CTX, enc, recipient.privateKey)
    expect(bytesToHex(decrypted)).to.equal(bytesToHex(share))
  })

  it('two encryptions of the same share use different ephemeral public keys', () => {
    const dealer = dkgIdentifierForUser('dealer-2')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('recipient-2')
    const share = new Uint8Array(32).fill(0x22)

    const enc1 = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    const enc2 = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    expect(enc1.ephemeralPublicKey).to.not.equal(enc2.ephemeralPublicKey)
  })
})

describe('crypto-dkg-complaint: AAD binding', () => {
  function freshEnc () {
    const dealer = dkgIdentifierForUser('aad-dealer')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('aad-recipient')
    const share = new Uint8Array(32).fill(0x33)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    return { enc, recipient }
  }

  it('decrypting with ctx.attempt+1 throws share-decrypt-failed', () => {
    const { enc, recipient } = freshEnc()
    expect(() => decryptShare({ ...CTX, attempt: CTX.attempt + 1 }, enc, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })

  it('decrypting with ctx.revision+1 throws share-decrypt-failed', () => {
    const { enc, recipient } = freshEnc()
    expect(() => decryptShare({ ...CTX, revision: CTX.revision + 1 }, enc, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })

  it('decrypting with a different ctx.electionId throws share-decrypt-failed', () => {
    const { enc, recipient } = freshEnc()
    expect(() => decryptShare({ ...CTX, electionId: CTX.electionId + '-x' }, enc, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })

  it('decrypting with enc.dealer swapped throws share-decrypt-failed', () => {
    const { enc, recipient } = freshEnc()
    const swapped: EncryptedShare = { ...enc, dealer: enc.dealer + '-other' }
    expect(() => decryptShare(CTX, swapped, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })

  it('decrypting with enc.recipient swapped throws share-decrypt-failed', () => {
    const { enc, recipient } = freshEnc()
    const swapped: EncryptedShare = { ...enc, recipient: enc.recipient + '-other' }
    expect(() => decryptShare(CTX, swapped, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })
})

describe('crypto-dkg-complaint: key commitment and malformed fields', () => {
  it('decrypting with a different recipient private key throws key-commitment-mismatch', () => {
    const dealer = dkgIdentifierForUser('km-dealer')
    const recipient = generateDkgReceivingKey()
    const impostor = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('km-recipient')
    const share = new Uint8Array(32).fill(0x44)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    expect(() => decryptShare(CTX, enc, impostor.privateKey))
      .to.throw(DkgError).with.property('code', 'key-commitment-mismatch')
  })

  it('a tampered keyCommitment throws key-commitment-mismatch', () => {
    const dealer = dkgIdentifierForUser('km-dealer-2')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('km-recipient-2')
    const share = new Uint8Array(32).fill(0x55)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    const tagBytes = hexToBytes(enc.keyCommitment)
    tagBytes[0] = tagBytes[0]! ^ 0x01
    const tampered: EncryptedShare = { ...enc, keyCommitment: bytesToHex(tagBytes) }
    expect(() => decryptShare(CTX, tampered, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'key-commitment-mismatch')
  })

  it('a tampered ciphertext throws share-decrypt-failed', () => {
    const dealer = dkgIdentifierForUser('ct-dealer')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('ct-recipient')
    const share = new Uint8Array(32).fill(0x66)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    const ctBytes = hexToBytes(enc.ciphertext)
    ctBytes[0] = ctBytes[0]! ^ 0x01
    const tampered: EncryptedShare = { ...enc, ciphertext: bytesToHex(ctBytes) }
    expect(() => decryptShare(CTX, tampered, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'share-decrypt-failed')
  })

  it('a malformed nonce length throws malformed-input', () => {
    const dealer = dkgIdentifierForUser('mn-dealer')
    const recipient = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('mn-recipient')
    const share = new Uint8Array(32).fill(0x77)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)
    const tampered: EncryptedShare = { ...enc, nonce: enc.nonce.slice(0, 10) }
    expect(() => decryptShare(CTX, tampered, recipient.privateKey))
      .to.throw(DkgError).with.property('code', 'malformed-input')
  })
})

// ---------------------------------------------------------------------------
// Complaint verdict matrix
// ---------------------------------------------------------------------------

describe('crypto-dkg-complaint: complaint verdicts', () => {
  const THRESHOLD = 2
  const PARTICIPANTS = 3

  function honestDealerSetup () {
    const dealerId = dkgIdentifierForUser('verdict-dealer')
    const recipientId = dkgIdentifierForUser('verdict-recipient')
    const dealerR1 = dkgRound1(dealerId, THRESHOLD, PARTICIPANTS)
    const recipientR1 = dkgRound1(recipientId, THRESHOLD, PARTICIPANTS)
    const thirdId = dkgIdentifierForUser('verdict-third')
    const thirdR1 = dkgRound1(thirdId, THRESHOLD, PARTICIPANTS)

    // The dealer runs round2 against {recipient, third} to compute the real share for recipient.
    const dealerRound2 = dkgRound2(dealerR1.secret, [recipientR1.public, thirdR1.public])
    const honestShare = dealerRound2[recipientR1.public.identifier]!

    const recipientKey = generateDkgReceivingKey()
    return { dealerPkg: dealerR1.public, recipientId: recipientR1.public.identifier, honestShare, recipientKey }
  }

  it('honest dealer + evidence from buildComplaintEvidence yields complainant-fault/share-valid', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const evidence = buildComplaintEvidence(enc, recipientKey.privateKey)
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, enc, dealerPkg, evidence)
    expect(result).to.deep.equal({ verdict: 'complainant-fault', reason: 'share-valid' })
  })

  it('a share that fails its own Feldman commitment yields dealer-fault/invalid-share', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const badShare = new Uint8Array(honestShare)
    badShare[0] = badShare[0]! ^ 0x01
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, badShare)
    const evidence = buildComplaintEvidence(enc, recipientKey.privateKey)
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, enc, dealerPkg, evidence)
    expect(result).to.deep.equal({ verdict: 'dealer-fault', reason: 'invalid-share' })
  })

  it('a dealer posting random bytes as ciphertext under the correct key yields dealer-fault/undecryptable', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const garbled: EncryptedShare = { ...enc, ciphertext: bytesToHex(new Uint8Array(enc.ciphertext.length / 2).fill(0xee)) }
    const evidence = buildComplaintEvidence(garbled, recipientKey.privateKey)
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, garbled, dealerPkg, evidence)
    expect(result).to.deep.equal({ verdict: 'dealer-fault', reason: 'undecryptable' })
  })

  it('a complainant presenting a random valid curve point as sharedSecret yields unresolved/key-commitment-mismatch', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const randomPoint = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
    const fakeEvidence = { dealer: enc.dealer, recipient: enc.recipient, sharedSecret: randomPoint }
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, enc, dealerPkg, fakeEvidence)
    expect(result).to.deep.equal({ verdict: 'unresolved', reason: 'key-commitment-mismatch' })
  })

  it('a dealer-posted keyCommitment derived from a different shared secret: decryptShare throws key-commitment-mismatch, and the honest recipient evidence yields unresolved/key-commitment-mismatch (A6)', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const tagBytes = hexToBytes(enc.keyCommitment)
    tagBytes[0] = tagBytes[0]! ^ 0x01
    const tampered: EncryptedShare = { ...enc, keyCommitment: bytesToHex(tagBytes) }

    expect(() => decryptShare(CTX, tampered, recipientKey.privateKey))
      .to.throw(DkgError).with.property('code', 'key-commitment-mismatch')

    const honestEvidence = buildComplaintEvidence(tampered, recipientKey.privateKey)
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, tampered, dealerPkg, honestEvidence)
    expect(result).to.deep.equal({ verdict: 'unresolved', reason: 'key-commitment-mismatch' })
  })

  it('a sharedSecret that is not a valid point yields complainant-fault/malformed-evidence', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const fakeEvidence = { dealer: enc.dealer, recipient: enc.recipient, sharedSecret: 'zz'.repeat(33) }
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, enc, dealerPkg, fakeEvidence)
    expect(result).to.deep.equal({ verdict: 'complainant-fault', reason: 'malformed-evidence' })
  })

  it('evidence whose dealer/recipient fields mismatch the ciphertext yields complainant-fault/malformed-evidence', () => {
    const { dealerPkg, recipientId, honestShare, recipientKey } = honestDealerSetup()
    const enc = encryptShare(CTX, dealerPkg.identifier, recipientId, recipientKey.publicKey, honestShare)
    const honestEvidence = buildComplaintEvidence(enc, recipientKey.privateKey)
    const mismatched = { ...honestEvidence, recipient: honestEvidence.recipient + '-other' }
    const result = verifyComplaintEvidence(CTX, THRESHOLD, PARTICIPANTS, enc, dealerPkg, mismatched)
    expect(result).to.deep.equal({ verdict: 'complainant-fault', reason: 'malformed-evidence' })
  })
})

// ---------------------------------------------------------------------------
// End-to-end: 3-of-5 DKG with every round-2 share traveling as EncryptedShare
// ---------------------------------------------------------------------------

describe('crypto-dkg-complaint: end-to-end through EncryptedShare', () => {
  it('a 3-of-5 DKG where every round-2 share is encrypted, decrypted and fed to dkgRound3 reaches one agreed groupPublicKey, reconstructible from any 3 shares', () => {
    const THRESHOLD = 3
    const PARTICIPANTS = 5
    const USERS = ['e2e-a', 'e2e-b', 'e2e-c', 'e2e-d', 'e2e-e']
    const ids = USERS.map((u) => dkgIdentifierForUser(u))
    const receivingKeys = USERS.map(() => generateDkgReceivingKey())
    const round1 = ids.map((id) => dkgRound1(id, THRESHOLD, PARTICIPANTS))
    const publics = round1.map((r) => r.public)

    // Every dealer computes round2, then encrypts each recipient's share.
    const encryptedByDealer = round1.map((r, i) => {
      const others = publics.filter((_, j) => j !== i)
      const round2 = dkgRound2(r.secret, others)
      const encs: Record<string, EncryptedShare> = {}
      for (const recipientPub of others) {
        const recipientIndex = publics.findIndex((p) => p.identifier === recipientPub.identifier)
        const share = round2[recipientPub.identifier]!
        encs[recipientPub.identifier] = encryptShare(
          CTX, publics[i]!.identifier, recipientPub.identifier, receivingKeys[recipientIndex]!.publicKey, share
        )
      }
      return encs
    })

    const keys = round1.map((r, i) => {
      const others = publics.filter((_, j) => j !== i)
      const myId = publics[i]!.identifier
      const received: DkgReceivedShare[] = others.map((o) => {
        const dealerIndex = publics.findIndex((p) => p.identifier === o.identifier)
        const enc = encryptedByDealer[dealerIndex]![myId]!
        const share = decryptShare(CTX, enc, receivingKeys[i]!.privateKey)
        return { dealer: o.identifier, share }
      })
      return dkgRound3(r.secret, others, received)
    })

    const groupKeys = new Set(keys.map((k) => k.groupPublicKey))
    expect(groupKeys.size).to.equal(1)

    const groupPublicKey = keys[0]!.groupPublicKey
    const groupCommitments = keys[0]!.groupCommitments
    const released = keys.map((k) => ({ identifier: k.identifier, signingShare: bytesToHex(k.signingShare) }))
    const subset = released.slice(0, 3)
    const result = reconstructGroupSecret({ threshold: THRESHOLD, participants: PARTICIPANTS, groupPublicKey, groupCommitments, shares: subset })
    const derivedPub = bytesToHex(secp256k1.getPublicKey(result.secretKey, true))
    expect(derivedPub).to.equal(groupPublicKey)
  })
})

// ---------------------------------------------------------------------------
// No secret leakage in DkgError messages
// ---------------------------------------------------------------------------

describe('crypto-dkg-complaint: no secret leakage in DkgError messages', () => {
  it('each triggered DkgError message contains none of the known share/key/shared-secret hex encodings', () => {
    const dealer = dkgIdentifierForUser('leak-dealer')
    const recipient = generateDkgReceivingKey()
    const impostor = generateDkgReceivingKey()
    const recipientId = dkgIdentifierForUser('leak-recipient')
    const share = new Uint8Array(32).fill(0x99)
    const enc = encryptShare(CTX, dealer, recipientId, recipient.publicKey, share)

    const secrets = [
      bytesToHex(share),
      bytesToHex(recipient.privateKey),
      bytesToHex(impostor.privateKey)
    ]

    const errors: DkgError[] = []
    try {
      decryptShare(CTX, enc, impostor.privateKey)
    } catch (e) {
      if (e instanceof DkgError) errors.push(e)
    }
    try {
      decryptShare({ ...CTX, attempt: CTX.attempt + 1 }, enc, recipient.privateKey)
    } catch (e) {
      if (e instanceof DkgError) errors.push(e)
    }
    try {
      decryptShare(CTX, { ...enc, nonce: enc.nonce.slice(0, 2) }, recipient.privateKey)
    } catch (e) {
      if (e instanceof DkgError) errors.push(e)
    }

    expect(errors.length).to.be.greaterThan(0)
    for (const err of errors) {
      for (const secretHex of secrets) {
        expect(err.message).to.not.include(secretHex)
      }
    }
  })
})
