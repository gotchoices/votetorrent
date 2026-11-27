// join-reads.spec.ts: plain-Node proof of the shared Voter join, strand port and results read (phase 67
// plan 19). cadre-core is never loaded: the three functions the join needs are counting fakes passed
// through the REQUIRED `cadre` seam, and the join-bootstrap store is the shared factory over a Map-backed
// KvStorage passed through the REQUIRED `joinBootstrapStore` seam. vote-engine's real `joinNetwork` runs
// over an access-recording fake node and a fake networks engine. Any digest-shaped value is generated here.
import { expect } from 'chai'
import type { NetworkJoinCode } from '@votetorrent/vote-engine/rn'
import {
  VOTER_JOIN_BOOTSTRAP_KEY,
  belongsToOtherCadre,
  createAssociationRequestDigestFn,
  createJoinBootstrapStore,
  createVoterStrandPort,
  invitationExpiresAtMs,
  isSelfAdmitted,
  readElectionResults,
  runVoterNetworkJoin,
  sanitizeVoterJoinBootstrap,
  type ElectionResultsReadDeps,
  type VoterJoinBootstrapWriter,
  type VoterJoinCadre,
  type VoterJoinNode,
} from '../../src/voter/index.js'
import type { KvStorage } from '../../src/platform/storage.js'

class MapKv implements KvStorage {
  readonly map = new Map<string, string>()
  async getItem (key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  async setItem (key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async removeItem (key: string): Promise<void> {
    this.map.delete(key)
  }
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n))

const SELF = 'peer-self'
const MEMBER_ID = '12D3KooWMemberMemberMemberMemberMemberMemberMemberMemb'
const MEMBER = `/ip4/203.0.113.7/tcp/4001/ws/p2p/${MEMBER_ID}`
const INVITATION_TEXT = 'encoded-invitation'
const CODE: NetworkJoinCode = {
  v: 1,
  invitation: INVITATION_TEXT,
  networkHash: 'a1b2c3d4e5f60718',
  name: 'Utah County Elections',
  genesis: { userId: 'u', signerKey: 'k', authorityId: 'a', adminEffectiveAt: '2026-10-12T10:00:00' },
  digest: base64url(randomBytes(32)),
}
const NET_REF = { hash: CODE.networkHash, relays: [], name: CODE.name, primaryAuthorityDomainName: 'example.org' }
const ADMITTED_ROW = { peerId: SELF, vouchSig: null, vouchUsage: 'usage-1' }
const JOIN_NODE_MEMBERS = new Set([
  'partyId', 'peerId', 'redeemCadreInvitation', 'getControlDatabase', 'getTrustedOwnerStore',
  'getControlNode', 'refreshMembershipGate', 'reconcileControlCohort',
])

interface FakeNodeOptions {
  selfRow?: Record<string, unknown> | null
  redeem?: () => Promise<unknown>
  connections?: unknown[]
  anchorOwners?: string[]
  controlDatabase?: boolean
  trustedOwnerStore?: boolean
}

function createAccessRecordingNode (opts: FakeNodeOptions = {}): {
  node: VoterJoinNode
  reads: string[]
  calls: { redeem: number, refresh: unknown[], reconcile: number }
  closed: string[]
} {
  const closed: string[] = []
  const calls = { redeem: 0, refresh: [] as unknown[], reconcile: 0 }
  const connections = opts.connections ?? [
    { remotePeer: { toString: () => MEMBER_ID }, close: async () => { closed.push(MEMBER_ID) } },
  ]
  const plain = {
    partyId: 'votetorrent',
    peerId: { toString: () => SELF },
    redeemCadreInvitation: async (invitation: unknown) => {
      calls.redeem += 1
      return opts.redeem === undefined ? { peerId: MEMBER_ID, invitation } : opts.redeem()
    },
    getControlDatabase: () => (opts.controlDatabase === false
      ? null
      : {
          queryCadrePeers: async () => (opts.selfRow === null || opts.selfRow === undefined ? [] : [opts.selfRow]),
          queryCadreInvites: async () => [{ key: 'invite-key' }],
          queryCadreInviteUsages: async () => [{ usageStampId: 'usage-1', inviteKey: 'invite-key' }],
          querySeedPeers: async () => [{ peerId: SELF }, { peerId: MEMBER_ID }],
        }),
    getTrustedOwnerStore: () => (opts.trustedOwnerStore === false ? null : { has: () => true, all: () => new Set(opts.anchorOwners ?? []) }),
    getControlNode: () => ({ getConnections: () => connections }),
    refreshMembershipGate: async (reason: unknown) => { calls.refresh.push(reason) },
    reconcileControlCohort: async () => { calls.reconcile += 1 },
  }
  const reads: string[] = []
  const node = new Proxy(plain, {
    get (target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop, receiver)
      if (!JOIN_NODE_MEMBERS.has(prop)) throw new Error(`join touched a node member outside VoterJoinNode: ${prop}`)
      reads.push(prop)
      return Reflect.get(target, prop, receiver)
    },
  })
  return { node: node as unknown as VoterJoinNode, reads, calls, closed }
}

function fakeCadre (overrides: Partial<{ decode: (encoded: string) => any, verify: boolean, merge: () => Promise<number> }> = {}): { cadre: VoterJoinCadre, counts: { decode: number, verify: number, merge: number }, mergeArgs: unknown[][] } {
  const counts = { decode: 0, verify: 0, merge: 0 }
  const mergeArgs: unknown[][] = []
  const decode = overrides.decode ?? (() => ({ partyId: 'votetorrent', members: [MEMBER], invite: { expiresAt: '2099-01-01T00:00:00' } }))
  const cadre = {
    decodeCadreInvitation: (encoded: string) => { counts.decode += 1; return decode(encoded) },
    verifyInvitationAdmission: () => { counts.verify += 1; return overrides.verify ?? true },
    mergeSeedPeers: async (...args: unknown[]) => { counts.merge += 1; mergeArgs.push(args); return overrides.merge === undefined ? 1 : overrides.merge() },
  } as unknown as VoterJoinCadre
  return { cadre, counts, mergeArgs }
}

function fakeStore (): { kv: MapKv, store: ReturnType<typeof createJoinBootstrapStore>, writes: () => number } {
  const kv = new MapKv()
  let writes = 0
  const inner = createJoinBootstrapStore(kv, VOTER_JOIN_BOOTSTRAP_KEY, sanitizeVoterJoinBootstrap)
  const store = {
    readJoinBootstrap: () => inner.readJoinBootstrap(),
    rememberJoinBootstrap: async (addrs: readonly string[]) => { writes += 1; await inner.rememberJoinBootstrap(addrs) },
  }
  return { kv, store, writes: () => writes }
}

async function rejection (p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

const joinedEngine = (calls: unknown[][] = []) => ({
  joinFromStrand: async (...args: unknown[]) => {
    calls.push(args)
    return { ok: true as const, outcome: 'joined' as const, networkRef: NET_REF, fingerprint: '17b0 6508 2fd5 aab2' }
  },
})

describe('voter join and reads: the shared join, strand port and results read (67-19)', () => {
  describe('join helpers', () => {
    it('J1: invitationExpiresAtMs reads a zone-less T-form datetime as UTC and is null for a missing or empty one', () => {
      expect(invitationExpiresAtMs({ invite: { expiresAt: '2026-11-11T11:26:21.316' } })).to.equal(Date.parse('2026-11-11T11:26:21.316Z'))
      expect(invitationExpiresAtMs({ invite: { expiresAt: '2026-11-11T11:26:21Z' } })).to.equal(Date.parse('2026-11-11T11:26:21Z'))
      expect(invitationExpiresAtMs({ invite: { expiresAt: null } })).to.equal(null)
      expect(invitationExpiresAtMs({ invite: { expiresAt: '' } })).to.equal(null)
      expect(invitationExpiresAtMs({})).to.equal(null)
      expect(invitationExpiresAtMs(undefined)).to.equal(null)
      expect(invitationExpiresAtMs({ invite: { expiresAt: 'soon' } })).to.equal(null)
    })

    it('J2: belongsToOtherCadre refuses only an anchor that pins owners none of which the invitation pins', async () => {
      const invitation = { ownerKeys: ['owner-b1', 'owner-b2'] }
      expect(await belongsToOtherCadre(createAccessRecordingNode().node, invitation)).to.equal(false)
      expect(await belongsToOtherCadre(createAccessRecordingNode({ anchorOwners: ['owner-x', 'owner-b2'] }).node, invitation)).to.equal(false)
      expect(await belongsToOtherCadre(createAccessRecordingNode({ anchorOwners: ['owner-a'] }).node, invitation)).to.equal(true)
      const anchored = createAccessRecordingNode({ anchorOwners: ['owner-a'] }).node
      expect(await belongsToOtherCadre(anchored, {})).to.equal(false)
      expect(await belongsToOtherCadre(anchored, { ownerKeys: [] })).to.equal(false)
      expect(await belongsToOtherCadre(createAccessRecordingNode({ anchorOwners: ['owner-a'], trustedOwnerStore: false }).node, invitation)).to.equal(false)
    })

    it('J3: isSelfAdmitted is false without a store, a db, an own row or with an owner-vouched row, never calling verify; otherwise it returns verify\'s answer', async () => {
      let verifyCalls = 0
      const verify = ((..._args: unknown[]) => { verifyCalls += 1; return true }) as unknown as VoterJoinCadre['verifyInvitationAdmission']
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: ADMITTED_ROW, trustedOwnerStore: false }).node, verify)).to.equal(false)
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: ADMITTED_ROW, controlDatabase: false }).node, verify)).to.equal(false)
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: null }).node, verify)).to.equal(false)
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: { peerId: SELF, vouchSig: 'sig', vouchUsage: null } }).node, verify)).to.equal(false)
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: { ...ADMITTED_ROW, vouchUsage: 'other' } }).node, verify)).to.equal(false)
      expect(verifyCalls).to.equal(0)
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: ADMITTED_ROW }).node, verify)).to.equal(true)
      expect(verifyCalls).to.equal(1)
      const refuse = (() => false) as unknown as VoterJoinCadre['verifyInvitationAdmission']
      expect(await isSelfAdmitted(createAccessRecordingNode({ selfRow: ADMITTED_ROW }).node, refuse)).to.equal(false)
    })
  })

  describe('runVoterNetworkJoin', () => {
    it('J4: refuses with a TypeError before any node, store or cadre call when a seam is missing', async () => {
      const { cadre, counts } = fakeCadre()
      const { store, writes } = fakeStore()
      const noStore = createAccessRecordingNode()
      const e1 = await rejection(runVoterNetworkJoin({ node: noStore.node, networksEngine: joinedEngine(), user: undefined, code: CODE, cadre } as never))
      expect(e1).to.be.instanceOf(TypeError)
      expect((e1 as Error).message).to.include('are required')
      const noCadre = createAccessRecordingNode()
      const e2 = await rejection(runVoterNetworkJoin({ node: noCadre.node, networksEngine: joinedEngine(), user: undefined, code: CODE, joinBootstrapStore: store } as never))
      expect(e2).to.be.instanceOf(TypeError)
      expect((e2 as Error).message).to.include('are required')
      const partialCadre = createAccessRecordingNode()
      const e3 = await rejection(runVoterNetworkJoin({ node: partialCadre.node, networksEngine: joinedEngine(), user: undefined, code: CODE, cadre: { decodeCadreInvitation: cadre.decodeCadreInvitation }, joinBootstrapStore: store } as never))
      expect(e3).to.be.instanceOf(TypeError)
      const badStore = createAccessRecordingNode()
      const e4 = await rejection(runVoterNetworkJoin({ node: badStore.node, networksEngine: joinedEngine(), user: undefined, code: CODE, cadre, joinBootstrapStore: {} as VoterJoinBootstrapWriter }))
      expect(e4).to.be.instanceOf(TypeError)
      for (const msg of [e1, e2, e3, e4].map(e => (e as Error).message)) {
        expect(msg).to.equal('voter-network-join: cadre and joinBootstrapStore are required')
        expect(msg).to.not.include(INVITATION_TEXT)
      }
      expect(noStore.reads).to.deep.equal([])
      expect(noCadre.reads).to.deep.equal([])
      expect(partialCadre.reads).to.deep.equal([])
      expect(badStore.reads).to.deep.equal([])
      expect(noStore.calls.redeem + noCadre.calls.redeem + partialCadre.calls.redeem + badStore.calls.redeem).to.equal(0)
      expect(counts).to.deep.equal({ decode: 0, verify: 0, merge: 0 })
      expect(writes()).to.equal(0)
    })

    it('J5: a code whose invitation the decoder rejects resolves ok:false with no redemption and no store write', async () => {
      const { cadre } = fakeCadre({ decode: () => { throw new Error('not base64url JSON') } })
      const { kv, store, writes } = fakeStore()
      const { node, calls } = createAccessRecordingNode()
      const joinCalls: unknown[][] = []
      const result = await runVoterNetworkJoin({ node, networksEngine: joinedEngine(joinCalls), user: undefined, code: CODE, cadre, joinBootstrapStore: store })
      expect(result).to.include({ ok: false, reason: 'invitation-malformed' })
      expect(calls.redeem).to.equal(0)
      expect(joinCalls).to.have.length(0)
      expect(writes()).to.equal(0)
      expect(kv.map.size).to.equal(0)
    })

    it('J6: the happy path redeems, joins from the strand and remembers only the invitation\'s members', async () => {
      const { cadre, counts } = fakeCadre()
      const { kv, store } = fakeStore()
      const { node, reads, calls } = createAccessRecordingNode()
      const joinCalls: unknown[][] = []
      const steps: string[] = []
      const result = await runVoterNetworkJoin({ node, networksEngine: joinedEngine(joinCalls), user: undefined, code: CODE, cadre, joinBootstrapStore: store, onStep: s => steps.push(s) })
      expect(result).to.include({ ok: true, outcome: 'joined', admittedVia: 'redeemed' })
      expect(counts.decode).to.equal(1)
      expect(calls.redeem).to.equal(1)
      expect(steps).to.deep.equal(['admitting', 'syncing', 'done'])
      expect(joinCalls).to.have.length(1)
      expect(joinCalls[0]![0]).to.equal(CODE)
      const options = joinCalls[0]![2] as { getPeerCount: () => number }
      expect(options.getPeerCount()).to.equal(1)
      expect(await store.readJoinBootstrap()).to.deep.equal([MEMBER])
      const raw = kv.map.get(VOTER_JOIN_BOOTSTRAP_KEY) as string
      expect(raw).to.be.a('string')
      expect(raw).to.not.include(INVITATION_TEXT)
      expect(raw).to.not.include(CODE.digest)
      expect(kv.map.size).to.equal(1)
      expect(reads.length).to.be.greaterThan(0)
      for (const prop of reads) expect(JOIN_NODE_MEMBERS.has(prop), prop).to.equal(true)
    })

    it('J6b: a redemption that throws but seated this node runs the skipped post-steps through the injected cadre', async () => {
      const { cadre, counts, mergeArgs } = fakeCadre()
      const { store } = fakeStore()
      let admittedChecks = 0
      const rec = createAccessRecordingNode({ redeem: async () => { throw new Error('StreamStateError') } })
      const plainDb = {
        queryCadrePeers: async () => (admittedChecks++ === 0 ? [] : [ADMITTED_ROW]),
        queryCadreInvites: async () => [{ key: 'invite-key' }],
        queryCadreInviteUsages: async () => [{ usageStampId: 'usage-1', inviteKey: 'invite-key' }],
        querySeedPeers: async () => [{ peerId: SELF }, { peerId: MEMBER_ID }],
      }
      ;(rec.node as unknown as { getControlDatabase: () => unknown }).getControlDatabase = () => plainDb
      const result = await runVoterNetworkJoin({ node: rec.node, networksEngine: joinedEngine(), user: undefined, code: CODE, cadre, joinBootstrapStore: store, admissionTimeoutMs: 5_000 })
      expect(result).to.include({ ok: true, admittedVia: 'self-admission' })
      expect(rec.closed).to.deep.equal([MEMBER_ID])
      expect(counts.merge).to.equal(1)
      expect(mergeArgs[0]![1]).to.deep.equal([{ peerId: MEMBER_ID }])
      expect(rec.calls.refresh).to.deep.equal(['invitation-redeemed'])
      expect(rec.calls.reconcile).to.equal(1)
      expect(counts.verify).to.be.greaterThan(0)
      for (const prop of rec.reads) expect(JOIN_NODE_MEMBERS.has(prop), prop).to.equal(true)
    })

    it('J7: a finite admissionTimeoutMs reaches joinNetwork (a never-admitted fallback gives up at it, not at the 20 s default)', async function () {
      this.timeout(5_000)
      const { cadre } = fakeCadre()
      const { store, writes } = fakeStore()
      const { node, calls } = createAccessRecordingNode({ redeem: async () => { throw new Error('StreamStateError') }, selfRow: null })
      const joinCalls: unknown[][] = []
      const started = Date.now()
      const result = await runVoterNetworkJoin({ node, networksEngine: joinedEngine(joinCalls), user: undefined, code: CODE, cadre, joinBootstrapStore: store, admissionTimeoutMs: 300 })
      expect(result).to.include({ ok: false, reason: 'not-admitted' })
      expect(Date.now() - started).to.be.lessThan(4_000)
      expect(calls.redeem).to.equal(1)
      expect(joinCalls).to.have.length(0)
      expect(writes()).to.equal(0)
    })
  })

  describe('strand port', () => {
    it('P1: createVoterStrandPort collects eval rows, forwards mutate to exec, and close touches nothing; the digest factory decodes 32 bytes and refuses other lengths', async () => {
      const evalCalls: Array<[string, unknown]> = []
      const execCalls: Array<[string, unknown]> = []
      let closeCalls = 0
      const db = {
        eval: async function * (sql: string, params: unknown) {
          evalCalls.push([sql, params])
          yield { a: 1 }
          yield { a: 2 }
        },
        exec: async (sql: string, params: unknown) => { execCalls.push([sql, params]) },
        close: async () => { closeCalls += 1 },
      }
      const port = createVoterStrandPort(db as never)
      expect(await port.query('select :x', { x: 1 })).to.deep.equal([{ a: 1 }, { a: 2 }])
      expect(evalCalls).to.deep.equal([['select :x', { x: 1 }]])
      await port.mutate('insert :y', { y: 2 })
      expect(execCalls).to.deep.equal([['insert :y', { y: 2 }]])
      await port.close()
      expect(closeCalls).to.equal(0)

      const bytes32 = randomBytes(32)
      const good = base64url(bytes32)
      expect(good).to.have.length(43)
      const digestOf = (value: string) => createAssociationRequestDigestFn({ query: async <T>() => [{ d: value }] as unknown as T[] })
      const init = { id: 'r-1', authorityId: 'a-1', registrantId: 'g-1', electionId: 'e-1', submittedAt: '2026-01-01T00:00:00' } as never
      const decoded = await digestOf(good)(init, 'requester-key')
      expect(decoded).to.be.instanceOf(Uint8Array)
      expect(decoded).to.have.length(32)
      expect([...decoded]).to.deep.equal([...bytes32])
      const short = await rejection(digestOf(base64url(randomBytes(10)))(init, 'requester-key'))
      expect((short as Error).message.startsWith('voter-request-transports: digest is not a 32-byte')).to.equal(true)
      const empty = await rejection(digestOf('')(init, 'requester-key'))
      expect((empty as Error).message.startsWith('voter-request-transports: digest is not a 32-byte')).to.equal(true)
    })
  })

  describe('readElectionResults', () => {
    const TALLIED = { status: 'tallied', electionId: 'e-1', revision: 2, threshold: 2, keyholdersUsed: 2, blockCount: 1, totals: { valid: 1, invalid: 0, excluded: 0 }, ballots: [], tallyRoot: 'ab', blockRoot: 'cd', tally: { marker: 'tree' } }

    function resultsDeps (opts: { elections?: Array<{ id: string }>, results?: unknown, publication?: unknown, fallbackElectionId?: string, onUnavailable?: ElectionResultsReadDeps['onUnavailable'] } = {}) {
      const engineNames: string[] = []
      const resultsCalls: string[] = []
      const publicationCalls: unknown[][] = []
      const deps: ElectionResultsReadDeps = {
        fallbackElectionId: opts.fallbackElectionId,
        onUnavailable: opts.onUnavailable,
        getEngine: async <T>(name: string): Promise<T> => {
          engineNames.push(name)
          if (name === 'elections') {
            return { getElections: async () => (opts.elections ?? [{ id: 'e-1' }]).map(e => ({ ...e, title: 't', authorityName: 'a', date: 4_000_000_000_000, type: 'a' })) } as unknown as T
          }
          if (name === 'electionResults') {
            return {
              getElectionResults: async (id: string) => {
                resultsCalls.push(id)
                if (opts.results instanceof Error) throw opts.results
                return opts.results ?? TALLIED
              },
            } as unknown as T
          }
          if (name === 'tallyPublication') {
            return {
              readPublishedTally: async (...args: unknown[]) => {
                publicationCalls.push(args)
                if (opts.publication instanceof Error) throw opts.publication
                return opts.publication ?? null
              },
            } as unknown as T
          }
          throw new Error(`unexpected engine ${name}`)
        },
      }
      return { deps, engineNames, resultsCalls, publicationCalls }
    }

    it('R1: with no election the results engine is never requested and the read is no-election / unknown', async () => {
      const f = resultsDeps({ elections: [] })
      const read = await readElectionResults(f.deps)
      expect(read).to.deep.equal({ results: { status: 'no-election', electionId: '' }, publication: 'unknown' })
      expect(f.engineNames).to.deep.equal(['elections'])
      expect(f.resultsCalls).to.deep.equal([])
      const seeded = resultsDeps({ elections: [], fallbackElectionId: 'seed-1' })
      const seededRead = await readElectionResults(seeded.deps)
      expect(seededRead.results.status).to.equal('tallied')
      expect(seeded.resultsCalls).to.deep.equal(['seed-1'])
    })

    it('R2: a tallied result passes the engine\'s published tally through by identity, verdicts untouched', async () => {
      const published = { electionId: 'e-1', revision: 2, blockRoot: 'cd', tallyRoot: 'ab', blockCount: 1, publishedAt: '2026-11-02T10:00:00.000Z', publisherUserId: 'officer-1', publisherKey: 'k', signatureValid: false, treeCheck: { ok: false, reason: 'root-mismatch', detail: 'x' }, matchesRecomputed: false, tally: null }
      const f = resultsDeps({ publication: published })
      const read = await readElectionResults(f.deps)
      expect(read.results).to.equal(TALLIED as never)
      expect(read.publication).to.equal(published)
      expect((read.publication as typeof published).signatureValid).to.equal(false)
      expect((read.publication as typeof published).treeCheck.ok).to.equal(false)
      expect((read.publication as typeof published).matchesRecomputed).to.equal(false)
      expect(f.engineNames).to.deep.equal(['elections', 'electionResults', 'tallyPublication'])
      expect(f.publicationCalls).to.deep.equal([['e-1', 2, TALLIED.tally]])
      const none = resultsDeps({ publication: null })
      expect((await readElectionResults(none.deps)).publication).to.equal(null)
    })

    it('R3: a throwing readPublishedTally gives unknown', async () => {
      const f = resultsDeps({ publication: new Error('row unreadable') })
      const read = await readElectionResults(f.deps)
      expect(read.results.status).to.equal('tallied')
      expect(read.publication).to.equal('unknown')
    })

    it('R4: a non-tallied result gives unknown without requesting tallyPublication', async () => {
      const f = resultsDeps({ results: { status: 'awaiting-keys', electionId: 'e-1', phase: 'releasing', revision: 2, threshold: 2, participants: 3, releasedCount: 1, releasingKeysAt: null } })
      const read = await readElectionResults(f.deps)
      expect(read.results.status).to.equal('awaiting-keys')
      expect(read.publication).to.equal('unknown')
      expect(f.engineNames).to.deep.equal(['elections', 'electionResults'])
    })

    it('R5: an unavailable result calls onUnavailable exactly once with the engine reason', async () => {
      const reasons: string[] = []
      const f = resultsDeps({ results: { status: 'unavailable', electionId: 'e-1', reason: 'read-failed', detail: 'boom' }, onUnavailable: r => reasons.push(r) })
      const read = await readElectionResults(f.deps)
      expect(read.results.status).to.equal('unavailable')
      expect(read.publication).to.equal('unknown')
      expect(reasons).to.deep.equal(['read-failed'])
      const quiet = resultsDeps({ results: { status: 'unavailable', electionId: 'e-1', reason: 'read-failed', detail: 'boom' } })
      expect((await readElectionResults(quiet.deps)).results.status).to.equal('unavailable')
    })

    it('R6: a throwing getElectionResults rejects', async () => {
      const f = resultsDeps({ results: new Error('engine down') })
      const e = await rejection(readElectionResults(f.deps))
      expect((e as Error).message).to.equal('engine down')
    })
  })
})
