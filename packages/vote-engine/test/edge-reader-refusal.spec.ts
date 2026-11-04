/**
 * edge-reader-refusal.spec.ts
 *
 * The per-node edge-reader refusal tracker (`src/network/edge-reader-refusal.ts`) that the phones pass to
 * cadre-core as `strandCohortRefusal`, and the installed cadre-core resolver it feeds. Ordinary suite: no
 * libp2p node is started; fake nodes are EventTargets with a `peerStore.all` stub.
 *
 * ER-1..ER-7 cover the tracker. ER-TT is the patched cadre-core truth table against the INSTALLED copy this
 * package resolves, loaded with a dynamic import() exactly as DM-7a loads it.
 */
import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EDGE_READER_PROTOCOL,
  EDGE_READER_REFUSAL_MAX_PEERS,
  createEdgeReaderRefusal,
} from '../src/network/edge-reader-refusal.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = join(HERE, '..', 'src', 'network', 'edge-reader-refusal.ts')

// A peer id whose toString() is shaped like a real Ed25519 libp2p id.
function fakePeerId(n: number): { toString(): string } {
  const s = `12D3KooW${'A'.repeat(36)}${String(n).padStart(8, '0')}`
  return { toString: () => s }
}

interface FakeNode extends EventTarget {
  peerStore: { all(): Promise<unknown[]> }
}

function fakeNode(stored: unknown[] = [], allThrows = false): FakeNode {
  const node = new EventTarget() as FakeNode
  node.peerStore = {
    all: async () => {
      if (allThrows) throw new Error('peerStore unavailable')
      return stored
    },
  }
  return node
}

function peerUpdate(node: EventTarget, id: { toString(): string }, protocols: string[]): void {
  node.dispatchEvent(new CustomEvent('peer:update', { detail: { peer: { id, protocols } } }))
}

function peerIdentify(node: EventTarget, id: { toString(): string }, protocols: string[]): void {
  node.dispatchEvent(new CustomEvent('peer:identify', { detail: { peerId: id, protocols } }))
}

// Lets the attach-time async peerStore scan settle.
const settle = () => new Promise((resolve) => setImmediate(resolve))

const OTHER = '/optimystic/strand-s/repo/1.0.0'

describe('edge-reader refusal tracker (ER)', () => {
  it('ER-0 constants: the marker protocol and the per-strand cap', () => {
    expect(EDGE_READER_PROTOCOL).to.equal('/votetorrent/edge-reader/1.0.0')
    expect(EDGE_READER_REFUSAL_MAX_PEERS).to.equal(256)
  })

  it('ER-1 a fresh tracker refuses nothing; hook(s) is sticky per strand and distinct across strands', () => {
    const tracker = createEdgeReaderRefusal()
    const s1 = tracker.hook('s')
    const s2 = tracker.hook('s')
    const t = tracker.hook('t')
    expect(s1).to.not.equal(undefined)
    expect(s1).to.equal(s2)
    expect(t).to.not.equal(s1)
    expect(s1!.refuses(fakePeerId(1).toString())).to.equal(false)
    expect(tracker.size()).to.equal(0)
    expect(tracker.refused('s')).to.deep.equal([])
  })

  it('ER-2 a peer:update listing the marker refuses THAT peer only, and the refusal is sticky', () => {
    const tracker = createEdgeReaderRefusal()
    const refusal = tracker.hook('s')!
    const node = fakeNode()
    refusal.attach!(node)
    const marked = fakePeerId(1)
    const plain = fakePeerId(2)
    peerUpdate(node, plain, [OTHER])
    expect(refusal.refuses(plain.toString())).to.equal(false)
    peerUpdate(node, marked, [OTHER, EDGE_READER_PROTOCOL])
    expect(refusal.refuses(marked.toString())).to.equal(true)
    expect(refusal.refuses(plain.toString())).to.equal(false)
    // A later update without the marker does not un-refuse.
    peerUpdate(node, marked, [OTHER])
    expect(refusal.refuses(marked.toString())).to.equal(true)
    expect(tracker.has('s', marked.toString())).to.equal(true)
    expect(tracker.has('s', plain.toString())).to.equal(false)
  })

  it('ER-3 peer:identify with the marker refuses; the attach-time peerStore scan refuses a stored marker record', async () => {
    const tracker = createEdgeReaderRefusal()
    const refusal = tracker.hook('s')!
    const stored = fakePeerId(3)
    const storedPlain = fakePeerId(4)
    const node = fakeNode([
      { id: stored, protocols: [EDGE_READER_PROTOCOL] },
      { id: storedPlain, protocols: [OTHER] },
    ])
    refusal.attach!(node)
    await settle()
    expect(refusal.refuses(stored.toString())).to.equal(true)
    expect(refusal.refuses(storedPlain.toString())).to.equal(false)
    const identified = fakePeerId(5)
    peerIdentify(node, identified, [EDGE_READER_PROTOCOL])
    expect(refusal.refuses(identified.toString())).to.equal(true)
  })

  it('ER-4 refusals are per strand', () => {
    const tracker = createEdgeReaderRefusal()
    const s = tracker.hook('s')!
    const t = tracker.hook('t')!
    const nodeS = fakeNode()
    const nodeT = fakeNode()
    s.attach!(nodeS)
    t.attach!(nodeT)
    const marked = fakePeerId(6)
    peerUpdate(nodeS, marked, [EDGE_READER_PROTOCOL])
    expect(s.refuses(marked.toString())).to.equal(true)
    expect(t.refuses(marked.toString())).to.equal(false)
    expect(tracker.refused('t')).to.deep.equal([])
  })

  it('ER-5 the cap evicts the oldest first; size() and refused() report it', () => {
    const tracker = createEdgeReaderRefusal({ maxPeersPerStrand: 3 })
    const refusal = tracker.hook('s')!
    const node = fakeNode()
    refusal.attach!(node)
    const [first, second, third, fourth] = [1, 2, 3, 4].map((n) => fakePeerId(100 + n)) as [
      { toString(): string }, { toString(): string }, { toString(): string }, { toString(): string }
    ]
    for (const id of [first, second, third, fourth]) peerUpdate(node, id, [EDGE_READER_PROTOCOL])
    expect(tracker.size()).to.equal(3)
    expect(tracker.refused('s')).to.deep.equal([second, third, fourth].map(String))
    expect(refusal.refuses(first.toString())).to.equal(false)
    expect(refusal.refuses(fourth.toString())).to.equal(true)
    // Re-announcing an already refused peer adds nothing.
    peerUpdate(node, fourth, [EDGE_READER_PROTOCOL])
    expect(tracker.size()).to.equal(3)
  })

  it('ER-6 malformed events, a throwing peerStore.all and a node without addEventListener never throw and refuse nothing', async () => {
    const tracker = createEdgeReaderRefusal()
    const refusal = tracker.hook('s')!
    const node = fakeNode([], true)
    expect(() => refusal.attach!(node)).to.not.throw()
    await settle()
    const bad: unknown[] = [
      undefined,
      null,
      { peer: null },
      { peer: { id: null, protocols: [EDGE_READER_PROTOCOL] } },
      { peer: { id: fakePeerId(7), protocols: 'nope' } },
      { peerId: fakePeerId(8) },
      { peerId: fakePeerId(9), protocols: [5, null] },
    ]
    for (const detail of bad) {
      expect(() => node.dispatchEvent(new CustomEvent('peer:update', { detail }))).to.not.throw()
      expect(() => node.dispatchEvent(new CustomEvent('peer:identify', { detail }))).to.not.throw()
    }
    expect(tracker.size()).to.equal(0)
    expect(() => refusal.attach!({})).to.not.throw()
    expect(() => refusal.attach!(null)).to.not.throw()
    expect(() => refusal.attach!({ addEventListener: 'x', peerStore: { all: 'y' } })).to.not.throw()
    expect(refusal.refuses(undefined as unknown as string)).to.equal(false)
    expect(refusal.refuses({} as unknown as string)).to.equal(false)
    expect(tracker.size()).to.equal(0)
    expect(tracker.hook(undefined as unknown as string)).to.equal(undefined)
  })

  it('ER-7 the comment-stripped module source has no import, setInterval, setTimeout or console.', () => {
    const src = readFileSync(MODULE_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1')
    expect(src).to.not.match(/\bimport\b/)
    expect(src).to.not.match(/\bsetInterval\b/)
    expect(src).to.not.match(/\bsetTimeout\b/)
    expect(src).to.not.match(/\bconsole\./)
  })
})

// ER-TT: the patched cadre-core truth table (rows 1-8) against the installed copy this package resolves.
describe('ER-TT strandCohortRefusal + withholdStrandAddrs (installed patched cadre-core)', () => {
  let resolveFn: (hook: unknown, strandId: string) => any
  let cadreDist: string
  let CadreNode: any

  before(async () => {
    const cadreCore: any = await import('@serfab/cadre-core')
    resolveFn = cadreCore.resolveStrandCohortRefusal
    CadreNode = cadreCore.CadreNode
    // The source checks read the same copy the import above resolves: cadre-core is not hoisted, so it is
    // this package's own node_modules copy (its exports map is import-only, so require.resolve cannot find it).
    cadreDist = join(HERE, '..', 'node_modules', '@serfab', 'cadre-core', 'dist')
    expect(typeof cadreCore.strandCohortTopicOption, 'the imported copy is the one on disk').to.equal('function')
  })

  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  function blockAt(src: string, from: number): string {
    const open = src.indexOf('{', from)
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    return ''
  }

  it('ER-TT-1 non-function hooks give null', () => {
    for (const hook of [undefined, true, {}, 'x']) expect(resolveFn(hook, 's')).to.equal(null)
  })

  it('ER-TT-2 a throwing hook gives null', () => {
    expect(resolveFn(() => { throw new Error('boom') }, 's')).to.equal(null)
  })

  it('ER-TT-3 a hook returning undefined, null, 5 or { refuses: 1 } gives null', () => {
    for (const r of [undefined, null, 5, { refuses: 1 }]) expect(resolveFn(() => r, 's')).to.equal(null)
  })

  it('ER-TT-4 refuses() === true gives isNetworkMember false', () => {
    expect(resolveFn(() => ({ refuses: () => true }), 's').isNetworkMember('p')).to.equal(false)
  })

  it("ER-TT-5 refuses() false/'true'/1/undefined or a throw gives isNetworkMember true", () => {
    for (const v of [false, 'true', 1, undefined]) {
      expect(resolveFn(() => ({ refuses: () => v }), 's').isNetworkMember('p')).to.equal(true)
    }
    expect(resolveFn(() => ({ refuses: () => { throw new Error('x') } }), 's').isNetworkMember('p')).to.equal(true)
  })

  it('ER-TT-6 attach is called once with the node; a throwing attach is swallowed; no attach is a no-op', () => {
    const calls: unknown[] = []
    const node = { id: 'n' }
    resolveFn(() => ({ refuses: () => false, attach: (n: unknown) => calls.push(n) }), 's').attach(node)
    expect(calls).to.deep.equal([node])
    expect(() => resolveFn(() => ({ refuses: () => false, attach: () => { throw new Error('x') } }), 's').attach(node)).to.not.throw()
    expect(resolveFn(() => ({ refuses: () => false }), 's').attach(node)).to.equal(undefined)
  })

  it('ER-TT-7 source: the createLibp2pNode spread is conditional and last; startStrand has no unconditional cohortRefusal', () => {
    const sim = strip(readFileSync(join(cadreDist, 'strand-instance-manager.js'), 'utf8'))
    const literal = blockAt(sim, sim.indexOf('await createLibp2pNode('))
    expect(literal).to.match(/\.\.\.\(cohortRefusal \? \{ isNetworkMember: cohortRefusal\.isNetworkMember \} : \{\}\)\s*\}$/)
    expect((literal.match(/isNetworkMember:/g) ?? []).length).to.equal(1)
    expect(sim).to.match(/instance\.libp2pNode = node;\s*cohortRefusal\?\.attach\(node\);/)
    const cn = strip(readFileSync(join(cadreDist, 'cadre-node.js'), 'utf8'))
    const start = blockAt(cn, cn.indexOf('this.strandManager.startStrand('))
    const lines = start.split('\n').filter((l) => l.includes('cohortRefusal'))
    expect(lines).to.have.length(1)
    expect(lines[0]).to.match(/^\s*\.\.\.\(this\.config\.strandCohortRefusal !== undefined && \{ cohortRefusal: this\.config\.strandCohortRefusal \}\),\s*$/)
  })

  it('ER-TT-8 withhold: one strict read, both seeding sites use the helper, the observer is unchanged', () => {
    const cn = strip(readFileSync(join(cadreDist, 'cadre-node.js'), 'utf8'))
    expect(cn).to.match(/advertisedStrandMultiaddrs\(strandId\) \{\s*return this\.config\.withholdStrandAddrs === true \? \[\] : this\.getStrandMultiaddrs\(strandId\);\s*\}/)
    expect((cn.match(/withholdStrandAddrs/g) ?? []).length).to.equal(1)
    expect(blockAt(cn, cn.indexOf('new StrandAddrService('))).to.match(/getStrandMultiaddrs: \(strandId\) => this\.advertisedStrandMultiaddrs\(/)
    expect(cn).to.match(/resolveStrandAddrs: \(strandId\) => this\.advertisedStrandMultiaddrs\(/)
    expect(cn).to.not.match(/resolveStrandAddrs: \(strandId\) => this\.getStrandMultiaddrs/)
    expect(blockAt(cn, cn.indexOf('new StrandObserverService('))).to.match(/getStrandMultiaddrs: \(strandId\) => this\.getStrandMultiaddrs\(/)
    // Functional, on the live class: only the boolean true withholds.
    const helper = CadreNode.prototype.advertisedStrandMultiaddrs
    const self = (w: unknown) => ({ config: w === 'absent' ? {} : { withholdStrandAddrs: w }, getStrandMultiaddrs: () => ['/ip4/1.2.3.4/tcp/1'] })
    expect(helper.call(self(true), 's')).to.deep.equal([])
    for (const w of ['absent', false, 'true', 1, undefined]) expect(helper.call(self(w), 's')).to.have.length(1)
  })

  it('ER-TT-9 the tracker hook feeds the resolver: a marked peer is not a member, any other peer is', () => {
    const tracker = createEdgeReaderRefusal()
    const node = fakeNode()
    const resolved = resolveFn(tracker.hook, 's')
    expect(resolved).to.not.equal(null)
    resolved.attach(node)
    const marked = fakePeerId(42)
    const other = fakePeerId(43)
    peerUpdate(node, marked, [EDGE_READER_PROTOCOL])
    expect(resolved.isNetworkMember(marked.toString())).to.equal(false)
    expect(resolved.isNetworkMember(other.toString())).to.equal(true)
  })
})
