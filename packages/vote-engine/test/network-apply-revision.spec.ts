// NetworkEngine.applyRevision — "Add servers" end to end: an officer proposes new relays, then
// applies the proposal under a signed 'rn' admin approval; Network.UpdateNetworkValid admits the
// UPDATE only with that signature. Covers the refusals (no 'rn' scope, threshold > 1, a bad
// signature, a withdrawn proposal) and that a refusal writes nothing.

import { expect } from 'chai'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ElectionType, type NetworkRevision, type Scope, type Signature } from '@votetorrent/vote-core'
import { createTestNetwork, makeTestNetworkInit, makeTestSignCallback, type TestNetworkContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { hexToBytes } from '@noble/curves/utils.js'

const NEW_RELAYS = ['/dns4/relay.example.com/tcp/443/wss', '/dns4/relay-2.example.com/tcp/443/wss']

function revisionWith (relays: string[]): NetworkRevision {
  return {
    name: 'Test Network',
    imageRef: { url: 'https://cdn.example.com/logo.png' },
    relays,
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

async function latestRevision (net: TestNetworkContext): Promise<number> {
  const row = await net.ctx.db.prepare("select max(Revision) as r from ProposedNetwork where Name = 'Test Network'").get({})
  return Number(row!.r)
}

async function storedRelays (net: TestNetworkContext): Promise<string[]> {
  const row = await net.ctx.db.prepare('select Relays from Network').get({})
  return JSON.parse(String(row!.Relays)) as string[]
}

async function rnSessionCount (net: TestNetworkContext): Promise<number> {
  const row = await net.ctx.db.prepare("select count(*) as n from AdminSigning where Scope = 'rn'").get({})
  return Number(row!.n)
}

async function rejection (promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection')
}

describe('NetworkEngine.applyRevision', () => {
  it('applies a proposed server list under a signed rn approval and resolves the proposal', async () => {
    const net = await createTestNetwork()
    await net.networkEngine.proposeRevision(revisionWith(NEW_RELAYS))
    const revision = await latestRevision(net)
    const before = await net.networkEngine.getDetails()
    expect(before.proposed).to.not.equal(undefined)
    expect(before.proposedRevision).to.equal(revision)

    await net.networkEngine.applyRevision('Test Network', revision, makeTestSignCallback(net.user))

    expect(await storedRelays(net)).to.deep.equal(NEW_RELAYS)
    const details = await net.networkEngine.getDetails()
    expect(details.network.relays).to.deep.equal(NEW_RELAYS)
    expect(details.proposed).to.equal(undefined)
    expect((await net.networkEngine.getStatistics()).serverCount).to.equal(2)
    // The approval is a completed rn session (AdminSigning + AdminSignature).
    const signed = await net.ctx.db
      .prepare("select count(*) as n from AdminSigning A join AdminSignature S on S.SigningNonce = A.Nonce where A.Scope = 'rn'")
      .get({})
    expect(Number(signed!.n)).to.equal(1)
  })

  it('refuses an officer without the rn scope, writing nothing', async () => {
    const init = makeTestNetworkInit()
    init.admin.officers[0]!.init.scopes = ['rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] as Scope[]
    const net = await createTestNetwork({ network: init })
    await net.networkEngine.proposeRevision(revisionWith(NEW_RELAYS))
    const before = await storedRelays(net)

    const err = await rejection(net.networkEngine.applyRevision('Test Network', await latestRevision(net), makeTestSignCallback(net.user)))
    expect(err.message).to.include('Revise Network')
    expect(await storedRelays(net)).to.deep.equal(before)
    expect(await rnSessionCount(net)).to.equal(0)
  })

  it('refuses when the rn threshold needs more than one approval, writing nothing', async () => {
    const init = makeTestNetworkInit()
    init.admin.thresholdPolicies = [{ policy: 'rad', threshold: 1 }, { policy: 'rn', threshold: 2 }]
    const net = await createTestNetwork({ network: init })
    await net.networkEngine.proposeRevision(revisionWith(NEW_RELAYS))
    const before = await storedRelays(net)

    const err = await rejection(net.networkEngine.applyRevision('Test Network', await latestRevision(net), makeTestSignCallback(net.user)))
    expect(err.name).to.equal('FeatureNotAvailableError')
    expect(await storedRelays(net)).to.deep.equal(before)
    expect(await rnSessionCount(net)).to.equal(0)
  })

  it('rolls back entirely when the signature is not by the officer\'s registered key', async () => {
    const net = await createTestNetwork()
    await net.networkEngine.proposeRevision(revisionWith(NEW_RELAYS))
    const before = await storedRelays(net)
    const stranger = randomTestKeyPair()
    const forged = async (digest: Uint8Array): Promise<Signature> => ({
      signerUserId: net.user.id,
      signerKey: stranger.publicHex,
      signature: bytesToHex(secp256k1.sign(digest, hexToBytes(stranger.privateHex)))
    })

    const err = await rejection(net.networkEngine.applyRevision('Test Network', await latestRevision(net), forged))
    expect(err.message).to.include('SignerKeyValid')
    expect(await storedRelays(net)).to.deep.equal(before)
    expect(await rnSessionCount(net)).to.equal(0)
    // The proposal stays open so it can be applied properly.
    expect((await net.networkEngine.getDetails()).proposed?.proposed.relays).to.deep.equal(NEW_RELAYS)
  })

  it('refuses a withdrawn proposal and an unknown revision', async () => {
    const net = await createTestNetwork()
    await net.networkEngine.proposeRevision(revisionWith(NEW_RELAYS))
    const revision = await latestRevision(net)
    await net.networkEngine.cancelRevision('Test Network', revision)

    expect((await rejection(net.networkEngine.applyRevision('Test Network', revision, makeTestSignCallback(net.user)))).message)
      .to.include('No open proposed revision')
    expect((await rejection(net.networkEngine.applyRevision('Test Network', revision + 5, makeTestSignCallback(net.user)))).message)
      .to.include('No open proposed revision')
  })

  it('a direct UPDATE without the rn signature is still refused by the schema', async () => {
    const net = await createTestNetwork()
    const err = await rejection(
      net.ctx.db.exec(
        "update Network with context SigningNonce = null, Tid = 1 set Relays = :relays where Name = 'Test Network'",
        { relays: JSON.stringify(NEW_RELAYS) }
      )
    )
    expect(err.message).to.include('UpdateNetworkValid')
  })
})
