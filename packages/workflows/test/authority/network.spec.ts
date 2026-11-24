// network.spec.ts: the Authority network-membership group moved into @votetorrent/workflows (phase 67
// plan 17): the pinned constants, the required-dependency refusals (a TypeError before any node, engine,
// signer or store access), the own-network reader over a Map store, a voter join-code round trip over a
// real-encoder fixture, the per-node pairing guard and the revocation planner. Nothing in this file prints
// a code, an invitation, a fixture value or a console line (every console method is counted and must stay
// at zero).
import { expect } from 'chai'
import { decodeNetworkJoinCode } from '@votetorrent/vote-engine/rn'
import type { KvStorage } from '../../src/platform/storage.js'
import {
  ACTIVE_NETWORKS_KEY,
  PAIR_INVITE_LIFETIME_MS,
  PAIR_INVITE_USES,
  PAIRING_INVITE_MAX_ADDRS,
  PAIRING_STATEMENT_LIFETIME_MS,
  REVOCATION_GRACE_MS,
  REVOCATION_RESULTS,
  VOTER_INVITE_LIFETIME_MS,
  VOTER_INVITE_USES,
  VoterInviteError,
  completeAuthorityJoin,
  createPairingInvitation,
  createVoterJoinCode,
  hostPairMint,
  loadPairingCapabilityState,
  planRevocationActions,
  readActiveNetworkHash,
  requestPairingCode,
  runAuthorityNetworkJoin,
  startPairMintHost,
} from '../../src/authority/network.js'
import type { OwnerMintLogEntry, PairingPlatform, PairMintHostInput } from '../../src/authority/network.js'
import { JOIN_CODE_FIXTURES } from '../../../vote-engine/test/fixtures/join-code-fixtures.generated.js'

/** A fake whose every property read is counted; the shared code must never touch it before its refusal. */
function counted<T extends object>(): { fake: T; reads: () => number } {
  let reads = 0
  const fake = new Proxy({} as T, {
    get(_target, _prop) {
      reads += 1
      return undefined
    },
    has() {
      reads += 1
      return false
    },
  })
  return { fake, reads: () => reads }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  return undefined
}

function mapKv(): KvStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    async getItem(key) {
      return raw.has(key) ? (raw.get(key) as string) : null
    },
    async setItem(key, value) {
      raw.set(key, value)
    },
    async removeItem(key) {
      raw.delete(key)
    },
  }
}

const fn = () => undefined
const cadreFns = {
  decodeCadreInvitation: fn,
  mergeSeedPeers: fn,
  verifyCadrePeerVoucher: fn,
  verifyInvitationAdmission: fn,
} as never
const stores = { rememberJoinBootstrap: async () => undefined, rememberJoinedNetwork: async () => undefined }

function fullPlatform(): PairingPlatform & { records: number } {
  const platform = {
    records: 0,
    async recordPairedBrowser() {
      platform.records += 1
    },
    invitationCodec: { decodeCadreInvitation: fn as never, encodeCadreInvitation: fn as never },
    pairMintClient: {
      findOwnerTargets: async () => [],
      createFailoverClient: () => ({ call: async () => ({ t: 'refused', code: 'malformed' }) as never }),
      classifyError: () => 'other' as const,
    },
  }
  return platform
}

const KEY_PUB = '02' + 'ab'.repeat(32)

describe('authority network group (@votetorrent/workflows/authority)', function () {
  this.timeout(20_000)

  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const saved: Partial<Record<(typeof methods)[number], (...args: unknown[]) => void>> = {}
  let consoleCalls = 0
  before(() => {
    for (const m of methods) {
      saved[m] = console[m]
      console[m] = () => {
        consoleCalls += 1
      }
    }
  })
  after(() => {
    for (const m of methods) console[m] = saved[m] as (...args: unknown[]) => void
  })

  it('N1 the lifetime, use, key, grace, revocation-result and pairing constants are the pinned values', () => {
    expect(VOTER_INVITE_USES).to.equal(1000)
    expect(VOTER_INVITE_LIFETIME_MS).to.equal(2_592_000_000)
    expect(PAIR_INVITE_USES).to.equal(1)
    expect(PAIR_INVITE_LIFETIME_MS).to.equal(900_000)
    expect(ACTIVE_NETWORKS_KEY).to.equal('recentNetworks')
    expect(REVOCATION_GRACE_MS).to.equal(600_000)
    expect([...REVOCATION_RESULTS]).to.deep.equal(['removed', 'gone', 'not-owner', 'refused', 'withdrawn', 'expired'])
    expect(Object.isFrozen(REVOCATION_RESULTS)).to.equal(true)
    expect(PAIRING_INVITE_MAX_ADDRS).to.equal(4)
    expect(PAIRING_STATEMENT_LIFETIME_MS).to.equal(840_000)
  })

  describe('N2 every platform and cadre-core dependency is required, refused before any other access', () => {
    const code = { v: 2, invitation: 'x', networkHash: 'h', name: 'n', genesis: {}, digest: 'd' } as never

    it('runAuthorityNetworkJoin without cadre functions', async () => {
      const node = counted()
      const engine = counted()
      const err = await rejection(runAuthorityNetworkJoin({ node: node.fake as never, networksEngine: engine.fake as never, user: undefined, code, stores } as never))
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('authority-network-join: cadre-core functions are required')
      expect(node.reads()).to.equal(0)
      expect(engine.reads()).to.equal(0)
    })

    it('runAuthorityNetworkJoin with a partial cadre object', async () => {
      const node = counted()
      const partial = { decodeCadreInvitation: fn, mergeSeedPeers: fn } as never
      const err = await rejection(runAuthorityNetworkJoin({ node: node.fake as never, networksEngine: {} as never, user: undefined, code, cadre: partial, stores }))
      expect((err as Error).message).to.equal('authority-network-join: cadre-core functions are required')
      expect(node.reads()).to.equal(0)
    })

    it('runAuthorityNetworkJoin without join stores', async () => {
      const node = counted()
      const engine = counted()
      const store = counted()
      const err = await rejection(
        runAuthorityNetworkJoin({ node: node.fake as never, networksEngine: engine.fake as never, user: undefined, code, cadre: cadreFns, stores: store.fake as never }),
      )
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('authority-network-join: join stores are required')
      expect(node.reads()).to.equal(0)
      expect(engine.reads()).to.equal(0)
    })

    it('completeAuthorityJoin without verifiers never calls selectNetwork', async () => {
      const node = counted()
      let selected = 0
      const err = await rejection(
        completeAuthorityJoin({
          node: node.fake as never,
          networkRef: { hash: 'h', name: 'n' } as never,
          selectNetwork: async () => {
            selected += 1
          },
          refreshOwnerTrust: async () => undefined,
        } as never),
      )
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('authority-network-join: self-voucher verifiers are required')
      expect(selected).to.equal(0)
      expect(node.reads()).to.equal(0)
    })

    it('createVoterJoinCode without an encoder never calls getFoundingAnchor', async () => {
      const node = counted()
      const engine = counted()
      const err = await rejection(
        createVoterJoinCode({ node: node.fake as never, networksEngine: engine.fake as never, networkHash: 'h', founder: { userId: 'u', signerKey: 'k' } } as never),
      )
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('voter-invite: an invitation encoder is required')
      expect(node.reads()).to.equal(0)
      expect(engine.reads()).to.equal(0)
    })

    it('createPairingInvitation without an encoder', async () => {
      const node = counted()
      const err = await rejection(createPairingInvitation(node.fake as never, {} as never))
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('voter-invite: an invitation encoder is required')
      expect(node.reads()).to.equal(0)
    })

    it('hostPairMint and startPairMintHost with an input missing the revocation store', async () => {
      const input = { readOwnNetworkHash: async () => null, isEnabled: async () => true, mintLog: {}, encodeInvitation: fn } as never
      for (const host of [hostPairMint, startPairMintHost]) {
        const node = counted()
        const err = await rejection(host(node.fake as never, input))
        expect(err).to.be.instanceOf(TypeError)
        expect((err as Error).message).to.equal('pair-mint-host: platform dependencies are required')
        expect(node.reads()).to.equal(0)
      }
      const none = counted()
      const err = await rejection(hostPairMint(none.fake as never, undefined as never))
      expect((err as Error).message).to.equal('pair-mint-host: platform dependencies are required')
      expect(none.reads()).to.equal(0)
    })

    it('requestPairingCode with a platform missing the pair-mint client never calls the signer', async () => {
      const node = counted()
      const signer = counted()
      const platform = { recordPairedBrowser: fn, invitationCodec: { decodeCadreInvitation: fn, encodeCadreInvitation: fn } } as never
      const err = await rejection(
        requestPairingCode(
          { node: node.fake as never, db: {} as never, signer: signer.fake as never, networkHash: 'h', userId: 'u', keyPub: KEY_PUB, readAnchor: async () => ({ ok: false, anchor: 'not-open' }) },
          platform,
        ),
      )
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('dashboard-pairing: platform dependencies are required')
      expect(node.reads()).to.equal(0)
      expect(signer.reads()).to.equal(0)
    })

    it('loadPairingCapabilityState without a device-user reader', async () => {
      const node = counted()
      const err = await rejection(loadPairingCapabilityState({ node: node.fake, db: null, networkHash: 'h', userId: 'u' }, {} as never))
      expect(err).to.be.instanceOf(TypeError)
      expect((err as Error).message).to.equal('dashboard-pairing: platform dependencies are required')
      expect(node.reads()).to.equal(0)
    })
  })

  describe('N3 readActiveNetworkHash over a Map-backed store', () => {
    it('absent, first-entry, over-long, corrupt and rejecting reads', async () => {
      const kv = mapKv()
      expect(await readActiveNetworkHash(kv)).to.equal(null)
      kv.raw.set(ACTIVE_NETWORKS_KEY, JSON.stringify([{ hash: 'h1' }, { hash: 'h2' }]))
      expect(await readActiveNetworkHash(kv)).to.equal('h1')
      kv.raw.set(ACTIVE_NETWORKS_KEY, JSON.stringify([{ hash: 'a'.repeat(129) }]))
      expect(await readActiveNetworkHash(kv)).to.equal(null)
      kv.raw.set(ACTIVE_NETWORKS_KEY, '{')
      expect(await readActiveNetworkHash(kv)).to.equal(null)
      const rejecting: KvStorage = { ...kv, getItem: async () => { throw new Error('disk') } }
      expect(await readActiveNetworkHash(rejecting)).to.equal(null)
    })
  })

  describe('N4 createVoterJoinCode round trip', () => {
    const decoded = decodeNetworkJoinCode(JOIN_CODE_FIXTURES['v2-1-member'].text)
    if (!decoded.ok) throw new Error('fixture does not decode')
    const anchor = decoded.code
    const SELF_KEY = 'owner-self'
    const EXPIRES = '2030-01-01T00:00:00'

    function readyOwnerNode() {
      let mints = 0
      const node = {
        peerId: { toString: () => 'peer-self' },
        getMultiaddrs: () => ['/ip4/203.0.113.1/tcp/1/ws'],
        getIdentityOwnerKey: () => ({ publicKeyB64: SELF_KEY, privateKeyB64: 'priv' }),
        getControlDatabase: () => ({
          getOwnerKeys: async () => new Set([SELF_KEY]),
          ensureOwnerKey: async () => false,
          queryCadrePeers: async () => [],
        }),
        getSeedBootstrapService: () => ({ canAuthorize: () => true }),
        trustOwnerKeys: async () => undefined,
        initializeSeedBootstrap: async () => undefined,
        createCadreInvitation: async () => {
          mints += 1
          // The fixture's own real-encoder invitation stands in for a fresh mint (the encoder self-checks it).
          return { encoded: anchor.invitation, invitation: { invite: { expiresAt: EXPIRES } } }
        },
      }
      return { node, mints: () => mints }
    }

    it('the code decodes back to v2 with the anchor fields, the invitation and the pass-through fields; the encoder is unused', async () => {
      const { node, mints } = readyOwnerNode()
      let encodes = 0
      const engine = {
        getFoundingAnchor: async () => ({ networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest, fingerprint: 'fp-test' }),
      }
      const result = await createVoterJoinCode({
        node,
        networksEngine: engine as never,
        networkHash: anchor.networkHash,
        founder: { userId: 'u', signerKey: 'k' },
        encodeInvitation: () => {
          encodes += 1
          return ''
        },
      })
      const back = decodeNetworkJoinCode(result.code)
      expect(back.ok).to.equal(true)
      if (!back.ok) return
      expect(back.code.v).to.equal(2)
      expect(back.code.networkHash).to.equal(anchor.networkHash)
      expect(back.code.name).to.equal(anchor.name)
      expect(back.code.genesis).to.deep.equal(anchor.genesis)
      expect(back.code.digest).to.equal(anchor.digest)
      expect(back.code.invitation).to.equal(anchor.invitation)
      expect(result.fingerprint).to.equal('fp-test')
      expect(result.networkName).to.equal(anchor.name)
      expect(result.expiresAt).to.equal(EXPIRES)
      expect(mints()).to.equal(1)
      expect(encodes).to.equal(0)
    })

    it('a not-founding-officer engine rejection maps to VoterInviteError not-founding-officer', async () => {
      const { node, mints } = readyOwnerNode()
      const engine = {
        getFoundingAnchor: async () => {
          throw Object.assign(new Error('refused'), { code: 'not-founding-officer' })
        },
      }
      const err = await rejection(
        createVoterJoinCode({ node, networksEngine: engine as never, networkHash: anchor.networkHash, founder: { userId: 'u', signerKey: 'k' }, encodeInvitation: () => '' }),
      )
      expect(err).to.be.instanceOf(VoterInviteError)
      expect((err as VoterInviteError).reason).to.equal('not-founding-officer')
      expect(mints()).to.equal(0)
    })
  })

  describe('N5 the pairing guard is per node', () => {
    function pairingNode(withControl: boolean, id: string) {
      return {
        partyId: 'party',
        peerId: { toString: () => id },
        getControlNode: () => (withControl ? {} : null),
        listOwnerKeys: async () => [],
        getControlDatabase: () => null,
        resolvePeerAddrs: async () => [],
      }
    }

    it('a second call on the same node is cancelled while another node proceeds', async () => {
      const platform = fullPlatform()
      let signs = 0
      const signer = async () => {
        signs += 1
        return { signerUserId: 'u', signerKey: KEY_PUB, signature: 'ab'.repeat(32) } as never
      }
      let release: (v: { ok: false; anchor: 'not-open' }) => void = () => undefined
      const gate = new Promise<{ ok: false; anchor: 'not-open' }>((resolve) => {
        release = resolve
      })
      const nodeA = pairingNode(true, 'peerA')
      const nodeB = pairingNode(false, 'peerB')
      const base = { db: {} as never, signer, networkHash: 'h', userId: 'u', keyPub: KEY_PUB }
      const first = requestPairingCode({ ...base, node: nodeA, readAnchor: () => gate }, platform)
      const second = await requestPairingCode({ ...base, node: nodeA, readAnchor: async () => ({ ok: false, anchor: 'not-open' }) }, platform)
      expect(second).to.deep.equal({ ok: false, reason: 'cancelled' })
      const other = await requestPairingCode({ ...base, node: nodeB, readAnchor: async () => ({ ok: false, anchor: 'not-open' }) }, platform)
      expect(other.ok).to.equal(false)
      expect((other as { reason: string }).reason).to.equal('build-failed')
      release({ ok: false, anchor: 'not-open' })
      const done = await first
      expect(done).to.deep.equal({ ok: false, reason: 'build-failed', anchor: 'not-open' })
      // The slot is free again once the first attempt settled.
      const again = await requestPairingCode({ ...base, node: nodeA, readAnchor: async () => ({ ok: false, anchor: 'not-open' }) }, platform)
      expect(again).to.deep.equal({ ok: false, reason: 'build-failed', anchor: 'not-open' })
      expect(signs).to.equal(0)
      expect(platform.records).to.equal(0)
    })
  })

  describe('N6 planRevocationActions', () => {
    const entry = (extra: Partial<OwnerMintLogEntry> = {}): OwnerMintLogEntry =>
      ({ outcome: 'approved', inviteKey: 'ik', nonce: 'n1', userId: 'u1', expiresAt: '2030-01-01T00:00:00', at: 1, ...extra }) as unknown as OwnerMintLogEntry
    const rows = [{ userId: 'u1', nonce: 'n1' }]
    const opts = { nowMs: 1_000, maxActions: 10 }

    it('remove with a usage row, withdraw without one, nothing once marked removed', () => {
      expect(planRevocationActions(rows, [entry()], [{ inviteKey: 'ik', peerId: 'pX' }], opts)).to.deep.equal([{ kind: 'remove', nonce: 'n1', peerId: 'pX' }])
      expect(planRevocationActions(rows, [entry()], [], opts)).to.deep.equal([{ kind: 'withdraw', nonce: 'n1', inviteKey: 'ik' }])
      expect(planRevocationActions(rows, [entry({ revocation: { result: 'removed', at: 1 } })], [{ inviteKey: 'ik', peerId: 'pX' }], opts)).to.deep.equal([])
    })
  })

  it('N7 nothing in this group wrote to the console', () => {
    expect(consoleCalls).to.equal(0)
  })
})
