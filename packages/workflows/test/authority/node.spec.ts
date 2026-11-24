// node.spec.ts: the five Authority node modules moved into @votetorrent/workflows (phase 67 plan 07):
// owner-trust classify/reanchor/read with its three closed log literals, the identity owner key over
// REAL cadre-core helpers, pool rendezvous admission, the self-voucher predicate over REAL cadre-core
// crypto with injected verifiers, the strand port pass-through (close never touches the db) and the
// source hygiene of the shared files. Every key is generated at run time; nothing here prints a key,
// a signature or a digest.
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  cadrePeerVoucherDigest,
  ed25519KeyPairFromLibp2p,
  softwareOwnerSigner,
  verifyCadrePeerVoucher,
  verifyInvitationAdmission,
} from '@serfab/cadre-core'
import { POOL_RENDEZVOUS_PROTOCOL, createPoolIdentity, poolRequests } from '@votetorrent/vote-engine/rn'
import {
  OWNER_REANCHOR_TIMEOUT_MS,
  OWNER_TRUST_CLASSIFY_TIMEOUT_MS,
  OwnerTrustUnreadableError,
  classifyOwnerTrust,
  createStrandPort,
  hostPoolRendezvous,
  isSelfVouched,
  readOwnerTrustClassification,
  reanchorOwnKey,
  withIdentityOwnerKey,
} from '../../src/authority/node.js'
import type {
  IdentityOwnerKeyHelpers,
  OwnerTrustNode,
  SelfVoucherNode,
  SelfVoucherVerifiers,
  StrandSqlDatabase,
} from '../../src/authority/node.js'

const SRC_AUTHORITY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'authority')
const SHARED_FILES = ['owner-trust.ts', 'identity-owner-key.ts', 'pool-rendezvous-host.ts', 'self-voucher.ts', 'strand-port-adapter.ts']
const WARN_LITERALS = ['[owner-trust] reanchor: timed-out', '[owner-trust] reanchor: failed', '[owner-trust] classify: unreadable']

type IdentityKey = Parameters<typeof ed25519KeyPairFromLibp2p>[0]
type CadreHelpers = IdentityOwnerKeyHelpers
const realHelpers: CadreHelpers = { ed25519KeyPairFromLibp2p, softwareOwnerSigner }
const realVerifiers: SelfVoucherVerifiers = { verifyCadrePeerVoucher, verifyInvitationAdmission }

function b64url (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromB64url (text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

/** A libp2p-shaped Ed25519 private key over a fresh seed: raw = seed || public (64 bytes). */
function libp2pKey (type = 'Ed25519'): { key: IdentityKey; publicKeyB64: string } {
  const seed = ed25519.utils.randomSecretKey()
  const pub = ed25519.getPublicKey(seed)
  const raw = new Uint8Array(64)
  raw.set(seed, 0)
  raw.set(pub, 32)
  const key = { type, raw, publicKey: { raw: pub } } as unknown as IdentityKey
  return { key, publicKeyB64: b64url(pub) }
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

describe('authority node (owner-trust, identity owner key, pool rendezvous, self-voucher, strand port)', function () {
  this.timeout(20_000)

  const warns: unknown[][] = []
  const originalWarn = console.warn
  beforeEach(() => {
    warns.length = 0
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
  })
  afterEach(() => {
    console.warn = originalWarn
  })

  describe('N1 classifyOwnerTrust', () => {
    const rows: Array<['persistent' | 'memory', number, string[], string | null, 'ok' | 'needs-reinvite']> = [
      ['persistent', 0, ['a'], 's', 'needs-reinvite'],
      ['persistent', 0, ['a'], 'a', 'ok'],
      ['persistent', 0, ['a'], null, 'needs-reinvite'],
      ['persistent', 1, ['a'], 's', 'ok'],
      ['persistent', 0, [], 's', 'ok'],
      ['memory', 0, ['a'], 's', 'ok'],
    ]
    for (const [storeKind, anchorSize, ownerKeys, selfKey, expected] of rows) {
      it(`${storeKind} anchor=${anchorSize} owners=${ownerKeys.length} self=${selfKey === null ? 'null' : selfKey} -> ${expected}`, () => {
        expect(classifyOwnerTrust({ storeKind, anchorSize, ownerKeys, selfKey })).to.equal(expected)
      })
    }
  })

  describe('N2 reanchorOwnKey', () => {
    it('wired: hands the identity owner signer object to wireOwnKeyIfOwner', async () => {
      const signer = { approve: () => undefined }
      const received: unknown[][] = []
      const node = {
        getIdentityOwnerSigner: () => signer,
        wireOwnKeyIfOwner: async (...args: unknown[]) => {
          received.push(args)
          return true
        },
      }
      expect(await reanchorOwnKey(node)).to.equal('wired')
      expect(received).to.have.length(1)
      expect(received[0]?.[0]).to.equal(signer)
      expect(warns).to.deep.equal([])
    })

    it('not-owner when the wire answers false; a node without a signer is wired with undefined', async () => {
      const received: unknown[][] = []
      const node = {
        wireOwnKeyIfOwner: async (...args: unknown[]) => {
          received.push(args)
          return false
        },
      }
      expect(await reanchorOwnKey(node)).to.equal('not-owner')
      expect(received).to.deep.equal([[undefined]])
      expect(warns).to.deep.equal([])
    })

    it('failed: one closed warn literal, and the planted error text reaches no log', async () => {
      const node = {
        wireOwnKeyIfOwner: async () => {
          throw new Error('planted-secret-text')
        },
      }
      expect(await reanchorOwnKey(node)).to.equal('failed')
      expect(warns).to.deep.equal([['[owner-trust] reanchor: failed']])
      expect(JSON.stringify(warns)).to.not.include('planted-secret-text')
    })

    it('timed-out: a never-settling wire with timeoutMs 20 gives one closed warn literal', async () => {
      const node = { wireOwnKeyIfOwner: () => never<boolean>() }
      expect(await reanchorOwnKey(node, 20)).to.equal('timed-out')
      expect(warns).to.deep.equal([['[owner-trust] reanchor: timed-out']])
    })

    it('fixes both bounds at 5000 ms', () => {
      expect(OWNER_REANCHOR_TIMEOUT_MS).to.equal(5000)
      expect(OWNER_TRUST_CLASSIFY_TIMEOUT_MS).to.equal(5000)
    })
  })

  describe('N3 readOwnerTrustClassification', () => {
    function fakeNode (o: {
      anchor?: string[]
      owners?: string[]
      ownersHang?: boolean
      noStore?: boolean
      noDb?: boolean
      noIdentity?: boolean
    } = {}) {
      const calls = { store: 0, db: 0 }
      const node: OwnerTrustNode = {
        getTrustedOwnerStore: () => {
          calls.store++
          return o.noStore ? null : { all: () => new Set(o.anchor ?? []) }
        },
        getControlDatabase: () => {
          calls.db++
          return o.noDb
            ? null
            : {
                getOwnerKeys: async () => (o.ownersHang ? never<ReadonlySet<string>>() : new Set(o.owners ?? [])),
              }
        },
        getIdentityOwnerKey: () => {
          if (o.noIdentity) throw new Error('planted-secret-text')
          return { publicKeyB64: 'self' }
        },
        wireOwnKeyIfOwner: async () => true,
      }
      return { node, calls }
    }

    it('memory store is ok without reading the store or the database', async () => {
      const { node, calls } = fakeNode({ owners: ['a'] })
      expect(await readOwnerTrustClassification(node, 'memory')).to.equal('ok')
      expect(calls).to.deep.equal({ store: 0, db: 0 })
      expect(warns).to.deep.equal([])
    })

    it('a null store is unreadable with one closed warn literal', async () => {
      const { node } = fakeNode({ noStore: true })
      expect(await readOwnerTrustClassification(node, 'persistent')).to.equal('unreadable')
      expect(warns).to.deep.equal([['[owner-trust] classify: unreadable']])
    })

    it('getOwnerKeys never settling with timeoutMs 20 is unreadable', async () => {
      const { node } = fakeNode({ ownersHang: true })
      expect(await readOwnerTrustClassification(node, 'persistent', 20)).to.equal('unreadable')
      expect(warns).to.deep.equal([['[owner-trust] classify: unreadable']])
    })

    it('a throwing getIdentityOwnerKey is the null-selfKey path: foreign owners read needs-reinvite', async () => {
      const { node } = fakeNode({ noIdentity: true, owners: ['a'], anchor: [] })
      expect(await readOwnerTrustClassification(node, 'persistent')).to.equal('needs-reinvite')
      expect(JSON.stringify(warns)).to.not.include('planted-secret-text')
    })

    it('a self key among the owners is ok', async () => {
      const { node } = fakeNode({ owners: ['a', 'self'], anchor: [] })
      expect(await readOwnerTrustClassification(node, 'persistent')).to.equal('ok')
    })

    it('OwnerTrustUnreadableError has its name and message', () => {
      const e = new OwnerTrustUnreadableError()
      expect(e.name).to.equal('OwnerTrustUnreadableError')
      expect(e.message).to.equal('owner trust could not be classified')
      expect(e).to.be.instanceOf(Error)
    })
  })

  describe('N4 withIdentityOwnerKey over real cadre-core helpers', () => {
    it('restores getIdentityOwnerKey/getIdentityOwnerSigner on the same node, derived once', () => {
      const { key, publicKeyB64 } = libp2pKey()
      const node = { wireOwnKeyIfOwner: async () => true }
      const adapted = withIdentityOwnerKey(node, key, realHelpers)
      expect(adapted).to.equal(node)
      const first = adapted.getIdentityOwnerKey()
      expect(first.publicKeyB64).to.equal(publicKeyB64)
      expect(adapted.getIdentityOwnerKey()).to.equal(first)
      const signer = adapted.getIdentityOwnerSigner()
      expect(signer).to.be.an('object')
      // Secrecy: the private key lives in the closure, never on the node, and nothing was logged.
      const privateKeyB64 = first.privateKeyB64
      expect(privateKeyB64).to.be.a('string').and.not.equal('')
      expect(JSON.stringify(node)).to.not.include(privateKeyB64)
      for (const value of Object.values(node)) {
        if (typeof value === 'string') expect(value).to.not.include(privateKeyB64)
      }
      expect(warns).to.deep.equal([])
    })

    it('a non-Ed25519 identity builds without throwing; derivation throws on first use', () => {
      const { key } = libp2pKey('RSA')
      const adapted = withIdentityOwnerKey({}, key, realHelpers)
      expect(() => adapted.getIdentityOwnerKey()).to.throw()
    })

    it('refuses missing or partial helpers with a TypeError before touching the node', () => {
      const { key } = libp2pKey()
      const node = {}
      expect(() => withIdentityOwnerKey(node, key, undefined as unknown as CadreHelpers)).to.throw(TypeError, /helpers are required/)
      expect(() => withIdentityOwnerKey(node, key, { ed25519KeyPairFromLibp2p } as unknown as CadreHelpers)).to.throw(TypeError, /helpers are required/)
      expect(Object.keys(node)).to.deep.equal([])
    })
  })

  describe('N5 hostPoolRendezvous', () => {
    function fakeControl () {
      const handlers = new Map<string, (stream: unknown, connection: unknown) => void>()
      const unhandled: string[] = []
      return {
        handlers,
        unhandled,
        handle: async (protocol: string, handler: (s: unknown, c: unknown) => void) => {
          handlers.set(protocol, handler)
        },
        unhandle: async (protocol: string) => {
          handlers.delete(protocol)
          unhandled.push(protocol)
        },
        dialProtocol: async () => {
          throw new Error('not dialled in this spec')
        },
      }
    }

    /** A one-request stream: yields the request frame, captures the reply frame. */
    function requestStream (request: unknown) {
      const body = new TextEncoder().encode(JSON.stringify(request))
      const frame = new Uint8Array(4 + body.length)
      new DataView(frame.buffer).setUint32(0, body.length, false)
      frame.set(body, 4)
      let reply: unknown
      let resolveReply: () => void = () => undefined
      const replied = new Promise<void>((r) => {
        resolveReply = r
      })
      return {
        stream: {
          [Symbol.asyncIterator]: () => {
            let sent = false
            return { next: async () => (sent ? never<IteratorResult<Uint8Array>>() : ((sent = true), { done: false, value: frame })) }
          },
          send: (bytes: Uint8Array) => {
            reply = JSON.parse(new TextDecoder().decode(bytes.subarray(4)))
            resolveReply()
          },
          close: async () => undefined,
          abort: () => resolveReply(),
        },
        replied,
        reply: () => reply,
      }
    }

    it('serves members and self, refuses strangers, detaches by unhandling the protocol', async () => {
      const control = fakeControl()
      const asked: string[] = []
      const members = new Set(['member-peer'])
      const detach = await hostPoolRendezvous({
        peerId: { toString: () => 'authority-peer' },
        getControlNode: () => control,
        isAuthorizedMember: async (p) => {
          asked.push(p)
          return members.has(p)
        },
      })
      const handler = control.handlers.get(POOL_RENDEZVOUS_PROTOCOL)
      expect(handler).to.be.a('function')
      const identity = createPoolIdentity()

      const asMember = requestStream(poolRequests.present(identity, 'topic', 1, Date.now()))
      handler!(asMember.stream, { remotePeer: { toString: () => 'member-peer' } })
      await asMember.replied
      expect(asMember.reply()).to.deep.equal({ t: 'coordinators', list: [] })

      const asStranger = requestStream(poolRequests.present(identity, 'topic', 1, Date.now()))
      handler!(asStranger.stream, { remotePeer: { toString: () => 'stranger-peer' } })
      await asStranger.replied
      expect(asStranger.reply()).to.deep.equal({ t: 'error', reason: 'not allowed' })

      const askedBefore = asked.length
      const asSelf = requestStream(poolRequests.present(identity, 'topic', 1, Date.now()))
      handler!(asSelf.stream, { remotePeer: { toString: () => 'authority-peer' } })
      await asSelf.replied
      expect(asSelf.reply()).to.deep.equal({ t: 'coordinators', list: [] })
      expect(asked.length).to.equal(askedBefore)

      await detach()
      expect(control.unhandled).to.deep.equal([POOL_RENDEZVOUS_PROTOCOL])
    })

    it('refuses to attach before the control node runs', async () => {
      let message = ''
      try {
        await hostPoolRendezvous({ peerId: { toString: () => 'p' }, getControlNode: () => null, isAuthorizedMember: () => false })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).to.include('control node is not running')
    })
  })

  describe('N6 isSelfVouched over real cadre-core crypto', () => {
    const PARTY = 'party-n6'
    const PEER = 'self-peer'
    const STAMP = 'stamp-n6'

    type Row = { peerId: string; stampId: string | null; vouchOwner: string | null; vouchSig: string | null; vouchUsage: string | null }

    function voucher (partyId: string, peerId: string, stampId: string) {
      const seed = ed25519.utils.randomSecretKey()
      const ownerKey = b64url(ed25519.getPublicKey(seed))
      const digestBytes = fromB64url(cadrePeerVoucherDigest(partyId, peerId, stampId))
      const sig = b64url(ed25519.sign(digestBytes, seed))
      return { ownerKey, sig }
    }

    function fakeNode (o: {
      partyId?: string
      rows?: Row[]
      anchored?: string[]
      noStore?: boolean
      noDb?: boolean
      usages?: unknown[]
      invites?: unknown[]
    }) {
      const reads = { peers: 0, usages: 0, invites: 0 }
      const anchored = new Set(o.anchored ?? [])
      const node: SelfVoucherNode = {
        partyId: o.partyId ?? PARTY,
        getControlDatabase: () =>
          o.noDb
            ? null
            : {
                queryCadrePeers: async () => {
                  reads.peers++
                  return (o.rows ?? []) as never
                },
                queryCadreInviteUsages: async () => {
                  reads.usages++
                  return (o.usages ?? []) as never
                },
                queryCadreInvites: async () => {
                  reads.invites++
                  return (o.invites ?? []) as never
                },
              },
        getTrustedOwnerStore: () => (o.noStore ? null : { has: (k: string) => anchored.has(k) }),
      }
      return { node, reads }
    }

    it('a self row with an anchored owner and a valid voucher resolves true', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const { node } = fakeNode({ rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [ownerKey] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(true)
    })

    it('the same row with the owner absent from the store resolves false', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const { node } = fakeNode({ rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
    })

    it('a voucher with one changed character resolves false', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
      const { node } = fakeNode({ rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: ownerKey, vouchSig: flipped, vouchUsage: null }], anchored: [ownerKey] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
    })

    it('a node whose partyId differs from the signed one resolves false', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const { node } = fakeNode({ partyId: 'other-party', rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [ownerKey] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
    })

    it('a null store resolves false without reading peers; a null db resolves false', async () => {
      const noStore = fakeNode({ noStore: true, rows: [] })
      expect(await isSelfVouched(noStore.node, PEER, realVerifiers)).to.equal(false)
      expect(noStore.reads.peers).to.equal(0)
      const noDb = fakeNode({ noDb: true })
      expect(await isSelfVouched(noDb.node, PEER, realVerifiers)).to.equal(false)
    })

    it('no own row resolves false', async () => {
      const { ownerKey, sig } = voucher(PARTY, 'someone-else', STAMP)
      const { node } = fakeNode({ rows: [{ peerId: 'someone-else', stampId: STAMP, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [ownerKey] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
    })

    it('an invitation-admitted row with no matching usage resolves false after one read of each table', async () => {
      const { node, reads } = fakeNode({
        rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: null, vouchSig: null, vouchUsage: 'usage-n6' }],
        usages: [{ usageStampId: 'other-usage', inviteKey: 'k' }],
        invites: [{ key: 'k' }],
      })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
      expect(reads).to.deep.equal({ peers: 1, usages: 1, invites: 1 })
    })

    it('a null stampId resolves false', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const { node } = fakeNode({ rows: [{ peerId: PEER, stampId: null, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [ownerKey] })
      expect(await isSelfVouched(node, PEER, realVerifiers)).to.equal(false)
    })

    it('missing verifiers reject with a TypeError before any read', async () => {
      const { ownerKey, sig } = voucher(PARTY, PEER, STAMP)
      const { node, reads } = fakeNode({ rows: [{ peerId: PEER, stampId: STAMP, vouchOwner: ownerKey, vouchSig: sig, vouchUsage: null }], anchored: [ownerKey] })
      let caught: unknown
      try {
        await isSelfVouched(node, PEER, undefined as unknown as SelfVoucherVerifiers)
      } catch (e) {
        caught = e
      }
      expect(caught).to.be.instanceOf(TypeError)
      expect((caught as Error).message).to.include('verifiers are required')
      expect(reads).to.deep.equal({ peers: 0, usages: 0, invites: 0 })
      let partial: unknown
      try {
        await isSelfVouched(node, PEER, { verifyCadrePeerVoucher } as unknown as SelfVoucherVerifiers)
      } catch (e) {
        partial = e
      }
      expect(partial).to.be.instanceOf(TypeError)
      expect(reads).to.deep.equal({ peers: 0, usages: 0, invites: 0 })
    })
  })

  describe('N7 createStrandPort', () => {
    function fakeDb () {
      const evals: Array<[string, Record<string, unknown> | undefined]> = []
      const execs: Array<[string, Record<string, unknown> | undefined]> = []
      let closes = 0
      const db = {
        async * eval (sql: string, params?: Record<string, unknown>) {
          evals.push([sql, params])
          yield { Id: 'a', N: 1 }
          yield { Id: 'b', N: 2 }
        },
        async exec (sql: string, params?: Record<string, unknown>) {
          execs.push([sql, params])
          return undefined
        },
        async close () {
          closes++
          throw new Error('the shared strand database must never be closed by the port')
        },
      }
      return { db: db as StrandSqlDatabase & { close(): Promise<void> }, evals, execs, closes: () => closes }
    }

    it('query collects rows in order and forwards sql/params; mutate execs once; close never touches the db', async () => {
      const f = fakeDb()
      const port = createStrandPort(f.db)
      const params = { id: 'a' }
      const rows = await port.query('select * from T where Id = :id', params)
      expect(rows).to.deep.equal([{ Id: 'a', N: 1 }, { Id: 'b', N: 2 }])
      expect(f.evals).to.have.length(1)
      expect(f.evals[0]?.[0]).to.equal('select * from T where Id = :id')
      expect(f.evals[0]?.[1]).to.equal(params)
      await port.mutate('insert into T values (:id)', params)
      expect(f.execs).to.deep.equal([['insert into T values (:id)', params]])
      await port.close()
      expect(f.closes()).to.equal(0)
    })
  })

  describe('N8 source hygiene of the shared files', () => {
    const text = (file: string) => readFileSync(resolve(SRC_AUTHORITY, file), 'utf8')

    it('owner-trust.ts has exactly three console.warn calls with the three closed literals', () => {
      const src = text('owner-trust.ts')
      const calls = [...src.matchAll(/console\.warn\(\s*'([^']*)'\s*\)/g)].map((m) => m[1])
      expect(src.match(/console\.warn\(/g) ?? []).to.have.length(3)
      expect([...calls].sort()).to.deep.equal([...WARN_LITERALS].sort())
    })

    it('the other four files have no console call', () => {
      for (const file of SHARED_FILES.filter((f) => f !== 'owner-trust.ts')) {
        expect(text(file).match(/console\./g) ?? [], file).to.have.length(0)
      }
    })

    it('no module-global mutable state in any of the five files', () => {
      for (const file of SHARED_FILES) {
        const src = text(file)
        expect(src.match(/^(let|var) /gm) ?? [], file).to.have.length(0)
        expect(src.match(/^(const|export const) [^=]*= new (Map|WeakMap)\(/gm) ?? [], file).to.have.length(0)
      }
    })

    it('identity-owner-key.ts and self-voucher.ts import cadre-core as types only', () => {
      for (const file of ['identity-owner-key.ts', 'self-voucher.ts']) {
        const lines = text(file).split('\n').filter((l) => /^import .*'@serfab\/cadre-core'/.test(l))
        expect(lines.length, file).to.be.greaterThan(0)
        for (const line of lines) expect(line, file).to.match(/^import type /)
      }
    })
  })
})
