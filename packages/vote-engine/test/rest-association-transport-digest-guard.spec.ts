/**
 * rest-association-transport-digest-guard.spec.ts — CR-03 (51-REVIEW).
 *
 * `RestAssociationTransport` asks the remote endpoint for the digest and then signs it with the
 * device's HARDWARE key. Before this gate, the ONLY thing checked before signing was that the
 * handshake echoed back a field out of the request body it was just handed — which any endpoint
 * can do, including a hostile or MITM'd one. That made the binding a blind signing oracle: the
 * endpoint chose all 32 bytes, and the resulting Secure Enclave / StrongBox signature could be
 * replayed against any row whose digest tuple the attacker could precompute.
 *
 * These tests drive a real `node:http` server through the real binding and assert the two
 * properties that matter:
 *   1. an HONEST endpoint (one that serves the engine's own digest tuple, exactly as
 *      `scripts/device-proof/association-rest-bridge.mjs` does) is still accepted — otherwise
 *      the guard would be a total outage of the D-17 ceremony rather than a control;
 *   2. a HOSTILE endpoint that returns any other digest is refused, and — the part that makes
 *      this a real security assertion rather than an error-message assertion — the signing
 *      callback is NEVER invoked. A test that only checked for a throw would still pass if the
 *      device had already signed the attacker's bytes.
 *
 * The hostile endpoint here echoes `submittedAt` / `requestId` / `nonce` back PERFECTLY, so
 * these cases also pin the finding's core claim: the echo checks alone do not stop it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { AssociationAttestationAnswer, AssociationRequestInit, DeviceAttestation, Signature } from '@votetorrent/vote-core'
import { RestAssociationTransport } from '../src/association/transport/rest-association-transport.js'
import {
  computeAssociationAttestationDigest,
  computeAssociationRequestDigest
} from '../src/association/transport/association-request-digest.js'
import { randomTestKeyPair } from './fixtures/keys.js'

/** What the endpoint puts in the `digest` field of both handshakes. */
type DigestPolicy = 'honest' | 'hostile'

interface Harness {
  baseUrl: string
  close: () => Promise<void>
}

async function startEndpoint (policy: DigestPolicy): Promise<Harness> {
  // 32 bytes the attacker chose. In the real exploit these would be
  // Digest(RegistrantId_victim, K_device, DeviceHash_attacker, ...) — for the purposes of this
  // test all that matters is that they are NOT the tuple the client can derive.
  const attackerChosenDigest = 'f'.repeat(64)

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw.length > 0 ? JSON.parse(raw) : {}
      const url = req.url ?? '/'

      if (url === '/association-requests/digest') {
        const { init, requesterKey } = body as { init: AssociationRequestInit; requesterKey: string }
        // NOTE the PERFECT submittedAt echo on BOTH branches — that check cannot tell these
        // two endpoints apart, which is precisely the finding.
        send(res, 200, {
          digest: policy === 'honest' ? computeAssociationRequestDigest(init, requesterKey) : attackerChosenDigest,
          submittedAt: init.submittedAt
        })
        return
      }

      if (url === '/association-attestations/digest') {
        const { answer } = body as { answer: AssociationAttestationAnswer }
        send(res, 200, {
          digest: policy === 'honest' ? computeAssociationAttestationDigest(answer) : attackerChosenDigest,
          requestId: answer.requestId,
          nonce: answer.nonce
        })
        return
      }

      if (url === '/association-requests') {
        send(res, 200, { requestId: (body as { init: AssociationRequestInit }).init.id })
        return
      }

      if (url === '/association-attestations') {
        send(res, 200, {})
        return
      }

      send(res, 404, { error: 'not found' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A signer that RECORDS whether it was ever asked to sign. That flag is the real assertion. */
function makeCountingSigner (): { publicHex: string; calls: number; sign: (digest: Uint8Array) => Promise<Signature> } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const priv = hexToBytes(privateHex)
  const state = {
    publicHex,
    calls: 0,
    sign: async (digest: Uint8Array): Promise<Signature> => {
      state.calls += 1
      return { signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: publicHex, signerUserId: '' }
    }
  }
  return state
}

function makeInit (deviceKey: string): AssociationRequestInit {
  return {
    id: 'assoc-req-guard-0001',
    authorityId: 'authority-sid-0001',
    registrantId: 'registrant-0001',
    deviceKey,
    electionId: 'election-0001',
    submittedAt: new Date().toISOString()
  } as AssociationRequestInit
}

function makeAnswer (): AssociationAttestationAnswer {
  return {
    requestId: 'assoc-req-guard-0001',
    nonce: 'nonce-guard-0001',
    attestation: { type: 'ios', deviceId: 'key-id-0001', attestationTime: new Date().toISOString() } as unknown as DeviceAttestation,
    deviceHash: 'b'.repeat(64)
  } as AssociationAttestationAnswer
}

describe('RestAssociationTransport refuses to sign endpoint-chosen digests (CR-03, 51-REVIEW)', () => {
  describe('an honest endpoint serving the engine tuple', () => {
    let harness: Harness

    before(async () => { harness = await startEndpoint('honest') })
    after(async () => { await harness.close() })

    it('leg 1 still completes — the guard is a control, not an outage', async () => {
      const signer = makeCountingSigner()
      const transport = new RestAssociationTransport({ baseUrl: harness.baseUrl })
      const id = await transport.submitRequest(makeInit(signer.publicHex), signer.publicHex, signer.sign)
      expect(id).to.equal('assoc-req-guard-0001')
      expect(signer.calls, 'the honest digest must actually be signed').to.equal(1)
    })

    it('leg 2 still completes', async () => {
      const signer = makeCountingSigner()
      const transport = new RestAssociationTransport({ baseUrl: harness.baseUrl })
      await transport.submitAttestation(makeAnswer(), signer.publicHex, signer.sign)
      expect(signer.calls).to.equal(1)
    })
  })

  describe('a hostile endpoint with a perfect echo', () => {
    let harness: Harness

    before(async () => { harness = await startEndpoint('hostile') })
    after(async () => { await harness.close() })

    it('leg 1 is refused, and the device key is NEVER asked to sign', async () => {
      const signer = makeCountingSigner()
      const transport = new RestAssociationTransport({ baseUrl: harness.baseUrl })
      let thrown: unknown
      try {
        await transport.submitRequest(makeInit(signer.publicHex), signer.publicHex, signer.sign)
      } catch (err) { thrown = err }
      expect(thrown, 'a mismatched digest must throw').to.be.instanceOf(Error)
      expect((thrown as Error).message).to.contain('does not match the tuple this client computed locally')
      expect(signer.calls, 'THE assertion: the hardware key must never have signed the attacker bytes').to.equal(0)
    })

    it('leg 2 is refused, and the device key is NEVER asked to sign', async () => {
      const signer = makeCountingSigner()
      const transport = new RestAssociationTransport({ baseUrl: harness.baseUrl })
      let thrown: unknown
      try {
        await transport.submitAttestation(makeAnswer(), signer.publicHex, signer.sign)
      } catch (err) { thrown = err }
      expect(thrown, 'a mismatched digest must throw').to.be.instanceOf(Error)
      expect((thrown as Error).message).to.contain('does not match the tuple this client computed locally')
      expect(signer.calls, 'THE assertion: the hardware key must never have signed the attacker bytes').to.equal(0)
    })

    it('the refusal message never leaks the digest bytes or a signature', async () => {
      const signer = makeCountingSigner()
      const transport = new RestAssociationTransport({ baseUrl: harness.baseUrl })
      let message = ''
      try {
        await transport.submitRequest(makeInit(signer.publicHex), signer.publicHex, signer.sign)
      } catch (err) { message = (err as Error).message }
      expect(message).to.not.contain('f'.repeat(64))
    })
  })

  it('leg 1 rejects an init whose deviceKey disagrees with requesterKey, before any network call', async () => {
    // The digest tuple binds requesterKey into the DeviceKey position; a caller who bound the
    // two independently must get an attributable error, not an opaque digest mismatch.
    const signer = makeCountingSigner()
    const transport = new RestAssociationTransport({ baseUrl: 'http://127.0.0.1:1/never-reached' })
    let thrown: unknown
    try {
      await transport.submitRequest(makeInit('a-different-key'), signer.publicHex, signer.sign)
    } catch (err) { thrown = err }
    expect(thrown).to.be.instanceOf(Error)
    expect(signer.calls).to.equal(0)
  })
})
