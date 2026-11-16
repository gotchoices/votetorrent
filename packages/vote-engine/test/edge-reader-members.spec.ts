/**
 * edge-reader-members.spec.ts — a minted cadre invitation never names a paired dashboard (edge reader) as a
 * member (src/network/edge-reader-members.ts). Ordinary suite: fake peer stores, no libp2p node.
 * The real-node proof is EX-1 in dashboard-edge-exclusion.harness.spec.ts.
 */
import { expect } from 'chai'
import {
  edgeReaderPeerIds, excludeEdgeReaderMembers, memberAddressPeerId, withoutEdgeReaderMembers
} from '../src/network/edge-reader-members.js'
import { EDGE_READER_PROTOCOL } from '../src/network/edge-reader-refusal.js'

const OWN = '/dns4/r.example/tcp/443/wss/p2p/RELAY/p2p-circuit/p2p/OFFICER'
const BROWSER = '/dns4/r.example/tcp/443/wss/p2p/RELAY/p2p-circuit/p2p/BROWSER'
const KH = '/ip4/203.0.113.9/tcp/4001/ws/p2p/KH'

function store (peers: Array<{ id: string, protocols: string[] }>, throws = false): unknown {
  return {
    peerStore: {
      all: async () => {
        if (throws) throw new Error('unreadable')
        return peers.map((p) => ({ id: { toString: () => p.id }, protocols: p.protocols }))
      }
    }
  }
}

describe('edge-reader invitation members (EM)', () => {
  it('EM-1 memberAddressPeerId reads the last /p2p/ component (a circuit address names its target, not the relay)', () => {
    expect(memberAddressPeerId(OWN)).to.equal('OFFICER')
    expect(memberAddressPeerId(KH)).to.equal('KH')
    expect(memberAddressPeerId('/ip4/1.2.3.4/tcp/1')).to.equal(undefined)
  })

  it('EM-2 edgeReaderPeerIds lists only peers whose own record names the marker; an unreadable store lists none', async () => {
    const node = store([{ id: 'BROWSER', protocols: ['/ipfs/id/1.0.0', EDGE_READER_PROTOCOL] }, { id: 'KH', protocols: ['/ipfs/id/1.0.0'] }])
    expect([...await edgeReaderPeerIds(node)]).to.deep.equal(['BROWSER'])
    expect((await edgeReaderPeerIds(store([], true))).size).to.equal(0)
    expect((await edgeReaderPeerIds(null)).size).to.equal(0)
    expect((await edgeReaderPeerIds({})).size).to.equal(0)
  })

  it('EM-3 withoutEdgeReaderMembers keeps order, drops every address of an edge reader, and never empties the list', () => {
    const browser2 = '/ip4/203.0.113.8/tcp/4001/ws/p2p/BROWSER'
    expect(withoutEdgeReaderMembers([OWN, BROWSER, KH, browser2], new Set(['BROWSER']))).to.deep.equal([OWN, KH])
    expect(withoutEdgeReaderMembers([OWN, KH], new Set())).to.deep.equal([OWN, KH])
    expect(withoutEdgeReaderMembers([BROWSER], new Set(['BROWSER']))).to.deep.equal([BROWSER])
  })

  it('EM-4 excludeEdgeReaderMembers re-encodes only when it dropped something, and never mutates the minted value', async () => {
    const invitation = { v: 1, invite: { key: 'k' }, members: [OWN, BROWSER, KH] }
    const minted = { encoded: 'sereus-invite:1.ORIGINAL', invitation, reach: 'anywhere' }
    const calls: unknown[] = []
    const encode = (i: unknown): string => { calls.push(i); return 'sereus-invite:1.NEW' }
    const out = await excludeEdgeReaderMembers(minted, store([{ id: 'BROWSER', protocols: [EDGE_READER_PROTOCOL] }]), encode)
    expect(out.droppedEdgeReaders).to.equal(1)
    expect(out.encoded).to.equal('sereus-invite:1.NEW')
    expect(out.invitation.members).to.deep.equal([OWN, KH])
    expect((out as any).reach).to.equal('anywhere')
    expect(calls).to.deep.equal([{ v: 1, invite: { key: 'k' }, members: [OWN, KH] }])
    expect(minted.invitation.members, 'the minted value is untouched').to.deep.equal([OWN, BROWSER, KH])
    const same = await excludeEdgeReaderMembers(minted, store([{ id: 'KH', protocols: [] }]), encode)
    expect(same.droppedEdgeReaders).to.equal(0)
    expect(same.encoded).to.equal('sereus-invite:1.ORIGINAL')
    expect(calls).to.have.length(1)
  })
})
