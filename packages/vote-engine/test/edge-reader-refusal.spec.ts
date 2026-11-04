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

  /**
   * ER-TT-7's shape rules as a pure function over the two stripped sources, so the negative controls run the SAME
   * rules against mutated copies. Returns the names of the rules that fail (empty: the shape holds).
   *  - the createLibp2pNode literal ends with the conditional cohortRefusal spread, with one isNetworkMember key;
   *    the R-G4 gater spread is conditional and sits before it;
   *  - attach follows the node assignment, with only the R-G4 declaration block (if any) between them;
   *  - R-G4 order inside that block: unhandle(cluster, repo) < handle(marker) < gate open < seed dial, its only awaits
   *    are those two, and it never names cohortRefusal;
   *  - the gate exists only with the key; startStrand forwards cohortRefusal and edgeReaderProtocol conditionally only.
   */
  function shapeFailures (sim: string, cn: string): string[] {
    const fail: string[] = []
    const callAt = sim.indexOf('await createLibp2pNode(')
    const literal = callAt < 0 ? '' : blockAt(sim, callAt)
    if (!/\.\.\.\(cohortRefusal \? \{ isNetworkMember: cohortRefusal\.isNetworkMember \} : \{\}\)\s*\}$/.test(literal)) fail.push('refusal-spread-conditional-and-last')
    if ((literal.match(/isNetworkMember:/g) ?? []).length !== 1) fail.push('one-isNetworkMember-key')
    const gaterSpread = literal.indexOf('...(edgeReaderGate ? { connectionGater: edgeReaderGate.connectionGater } : {}),')
    if (gaterSpread < 0 || gaterSpread > literal.indexOf('...(cohortRefusal ?')) fail.push('gater-spread-conditional-before-refusal')
    if ((literal.match(/connectionGater:/g) ?? []).length !== 1) fail.push('one-connectionGater-key-in-literal')
    if (!/const edgeReaderGate = typeof config\.edgeReaderProtocol === 'string' && config\.edgeReaderProtocol\.length > 0\s*\? edgeReaderDeclarationGate\(revocationGateOptions\.connectionGater\)\s*: undefined;/.test(sim)) fail.push('gate-only-with-key')
    const assignAt = sim.indexOf('instance.libp2pNode = node;')
    const attachAt = sim.indexOf('cohortRefusal?.attach(node);', assignAt)
    if (assignAt < 0 || attachAt < 0) {
      fail.push('attach-after-assignment')
    } else {
      const between = sim.slice(assignAt + 'instance.libp2pNode = node;'.length, attachAt)
      if (between.trim() !== '') {
        const ifAt = between.indexOf('if (edgeReaderGate) {')
        const block = ifAt < 0 ? '' : blockAt(between, ifAt)
        const rest = ifAt < 0 ? between : between.slice(0, ifAt) + between.slice(ifAt + 'if (edgeReaderGate) '.length + block.length)
        if (ifAt < 0 || rest.trim() !== '') fail.push('only-the-declaration-block-before-attach')
        const at = (needle: string): number => block.indexOf(needle)
        const unhandle = at('await node.unhandle([`${protocolPrefix}/cluster/1.0.0`, `${protocolPrefix}/repo/1.0.0`]);')
        const handle = at('await node.handle(config.edgeReaderProtocol,')
        const open = at('edgeReaderGate.open();')
        const dial = at('node.dial(addrs)')
        if (!(unhandle >= 0 && handle > unhandle && open > handle && dial > open)) fail.push('unhandle<handle<open<dial')
        if ((block.match(/\bawait\b/g) ?? []).length !== 2) fail.push('only-two-awaits-in-block')
        if (block.includes('cohortRefusal')) fail.push('block-never-names-cohortRefusal')
      }
    }
    const startAt = cn.indexOf('this.strandManager.startStrand(')
    const start = startAt < 0 ? '' : blockAt(cn, startAt)
    const refusalLines = start.split('\n').filter((l) => l.includes('cohortRefusal'))
    if (refusalLines.length !== 1 || !/^\s*\.\.\.\(this\.config\.strandCohortRefusal !== undefined && \{ cohortRefusal: this\.config\.strandCohortRefusal \}\),\s*$/.test(refusalLines[0] ?? '')) fail.push('startStrand-cohortRefusal-conditional-only')
    const edgeLines = start.split('\n').filter((l) => l.includes('edgeReaderProtocol'))
    if (edgeLines.length !== 1 || !/^\s*\.\.\.\(this\.config\.edgeReaderProtocol !== undefined && \{ edgeReaderProtocol: this\.config\.edgeReaderProtocol \}\),\s*$/.test(edgeLines[0] ?? '')) fail.push('startStrand-edgeReaderProtocol-conditional-only')
    return fail
  }

  it('ER-TT-7 source: the createLibp2pNode spread is conditional and last; startStrand has no unconditional cohortRefusal; attach follows the R-G4 declaration, which unhandles and handles before the gate opens or the seed is dialled', () => {
    const sim = strip(readFileSync(join(cadreDist, 'strand-instance-manager.js'), 'utf8'))
    const cn = strip(readFileSync(join(cadreDist, 'cadre-node.js'), 'utf8'))
    expect(shapeFailures(sim, cn), 'the installed shape').to.deep.equal([])

    // Negative controls: each mutation of the real source must trip the rule it breaks.
    const mutate = (src: string, from: string, to: string): string => {
      expect(src.split(from).length - 1, `mutation anchor appears once: ${from.slice(0, 50)}`).to.equal(1)
      return src.replace(from, to)
    }
    const openLine = 'edgeReaderGate.open();'
    const handleLine = 'await node.handle(config.edgeReaderProtocol,'
    const cases: Array<{ rule: string, sim?: string, cn?: string }> = [
      // the gate opens before the marker is handled
      { rule: 'unhandle<handle<open<dial', sim: mutate(mutate(sim, openLine, ''), handleLine, openLine + '\n' + handleLine) },
      // attach removed
      { rule: 'attach-after-assignment', sim: mutate(sim, 'cohortRefusal?.attach(node);', '') },
      // something else between the assignment and attach
      { rule: 'only-the-declaration-block-before-attach', sim: mutate(sim, 'cohortRefusal?.attach(node);', 'await Promise.resolve();\ncohortRefusal?.attach(node);') },
      // the refusal spread made unconditional
      { rule: 'refusal-spread-conditional-and-last', sim: mutate(sim, '...(cohortRefusal ? { isNetworkMember: cohortRefusal.isNetworkMember } : {})', 'isNetworkMember: cohortRefusal.isNetworkMember') },
      // the gate built without the key
      { rule: 'gate-only-with-key', sim: mutate(sim, "typeof config.edgeReaderProtocol === 'string' && config.edgeReaderProtocol.length > 0", 'true') },
      // startStrand forwards cohortRefusal unconditionally
      { rule: 'startStrand-cohortRefusal-conditional-only', cn: mutate(cn, '...(this.config.strandCohortRefusal !== undefined && { cohortRefusal: this.config.strandCohortRefusal }),', 'cohortRefusal: this.config.strandCohortRefusal,') },
      // startStrand forwards edgeReaderProtocol unconditionally
      { rule: 'startStrand-edgeReaderProtocol-conditional-only', cn: mutate(cn, '...(this.config.edgeReaderProtocol !== undefined && { edgeReaderProtocol: this.config.edgeReaderProtocol }),', 'edgeReaderProtocol: this.config.edgeReaderProtocol,') }
    ]
    for (const c of cases) {
      expect(shapeFailures(c.sim ?? sim, c.cn ?? cn), `negative control ${c.rule}`).to.include(c.rule)
    }
  })

  it('ER-TT-7b the R-G4 gate helper, run from its own installed source: closed denies every gated check, open delegates to the base gater', () => {
    const sim = strip(readFileSync(join(cadreDist, 'strand-instance-manager.js'), 'utf8'))
    const src = (sim.match(/const EDGE_READER_GATED_CHECKS = [\s\S]*?\nfunction edgeReaderDeclarationGate\(base\) \{[\s\S]*?\n\}/) ?? [])[0]
    expect(src, 'the gate helper is in the installed source').to.be.a('string')
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const make = new Function(`${src!}; return { gate: edgeReaderDeclarationGate, checks: EDGE_READER_GATED_CHECKS };`)() as { gate: (b?: any) => any, checks: string[] }
    expect(make.checks).to.include.members(['denyDialPeer', 'denyDialMultiaddr', 'denyInboundConnection', 'denyOutboundConnection'])
    const base = { denyDialPeer: () => 'base', filterMultiaddrForPeer: () => 'kept' }
    const g = make.gate(base)
    for (const name of make.checks) expect(g.connectionGater[name](), `${name} while closed`).to.equal(true)
    expect(g.connectionGater.filterMultiaddrForPeer(), 'non-gated keys of the base are kept').to.equal('kept')
    g.open()
    expect(g.connectionGater.denyDialPeer()).to.equal('base')
    expect(g.connectionGater.denyInboundConnection(), 'a check the base lacks allows once open').to.equal(false)
    const bare = make.gate(undefined)
    expect(bare.connectionGater.denyDialMultiaddr()).to.equal(true)
    bare.open()
    expect(bare.connectionGater.denyDialMultiaddr()).to.equal(false)
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
