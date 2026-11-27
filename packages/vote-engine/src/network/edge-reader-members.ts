/**
 * Keep read-only edge readers (the officer's browser dashboard) out of the `members` of a cadre invitation.
 *
 * cadre-core's `createCadreInvitation` names this machine's addresses and then up to three other members'
 * (`selectCadreInvitationMembers`), connected members first. A paired dashboard is an authorized member with a
 * signed `CadrePeer` record carrying its relay circuit address, and the minting phone is connected to it, so it
 * was named ahead of the phones that actually serve the network. A joiner then holds the browser as a place to
 * redeem and as a restart dial hint.
 *
 * The signal is the same one the cohort refusal uses (`edge-reader-refusal.ts`): a dashboard's CONTROL node
 * handles {@link EDGE_READER_PROTOCOL} (VoteTorrent cadre-core patch, before any peer connects), so the minting
 * node's control peer store lists the marker for it. Only the peer's own identify can put the marker there; no
 * phone handles or dials it. A dashboard the minting node has not identified in this process is not known and
 * is left in (it then ranks behind connected members).
 *
 * The `members` field is a dial hint the issuer does not sign; dropping entries changes no signature.
 */
import { EDGE_READER_PROTOCOL } from './edge-reader-refusal.js'

/** The peer id an invitation member address names: its last `/p2p/` component. */
export function memberAddressPeerId (addr: string): string | undefined {
  if (typeof addr !== 'string') return undefined
  const i = addr.lastIndexOf('/p2p/')
  if (i < 0) return undefined
  const id = addr.slice(i + 5).split('/')[0]
  return id !== undefined && id.length > 0 ? id : undefined
}

interface PeerStoreLike {
  all?: () => Promise<Array<{ id?: unknown; protocols?: unknown }>> | Array<{ id?: unknown; protocols?: unknown }>
}

/**
 * The peer ids whose record in `libp2pNode`'s peer store lists `protocol` (default the edge-reader marker).
 * Never throws: an unreadable peer store yields an empty set.
 */
export async function edgeReaderPeerIds (libp2pNode: unknown, protocol: string = EDGE_READER_PROTOCOL): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const store = (libp2pNode as { peerStore?: PeerStoreLike } | null | undefined)?.peerStore
    if (store === undefined || typeof store.all !== 'function') return out
    const peers = await store.all()
    if (!Array.isArray(peers)) return out
    for (const peer of peers) {
      if (!Array.isArray(peer?.protocols) || !peer.protocols.includes(protocol)) continue
      try {
        const id = String((peer.id as { toString(): string }).toString())
        if (id.length > 0 && id !== '[object Object]') out.add(id)
      } catch {
        // an id that cannot be read names nobody
      }
    }
  } catch {
    // an unreadable peer store excludes nobody
  }
  return out
}

/**
 * `members` without the addresses of `edgeReaders`, order kept. When every address would go, the list is
 * returned unchanged: an invitation with no member cannot be redeemed at all, and the minting machine's own
 * addresses (always first) are never an edge reader's on a phone.
 */
export function withoutEdgeReaderMembers (members: readonly string[], edgeReaders: ReadonlySet<string>): string[] {
  if (edgeReaders.size === 0) return [...members]
  const kept = members.filter((addr) => {
    const id = memberAddressPeerId(addr)
    return id === undefined || !edgeReaders.has(id)
  })
  return kept.length > 0 ? kept : [...members]
}

/** The minted cadre-core invitation slice this module reads and rewrites. */
export interface MintedCadreInvitation<I extends { members: string[] } = { members: string[] }> {
  encoded: string
  invitation: I
}

/**
 * Drop the edge readers `controlNode` has identified from a freshly minted invitation. Returns a copy of the
 * minted value: unchanged when nothing is dropped; otherwise `invitation.members` is filtered and whose
 * `encoded` is re-encoded with `encode` (cadre-core's `encodeCadreInvitation`). Never logs the invitation.
 */
export async function excludeEdgeReaderMembers<I extends { members: string[] }, M extends MintedCadreInvitation<I>> (
  minted: M,
  controlNode: unknown,
  encode: (invitation: I) => string
): Promise<M & { droppedEdgeReaders: number }> {
  const members = Array.isArray(minted?.invitation?.members) ? minted.invitation.members : []
  const edge = await edgeReaderPeerIds(controlNode)
  const kept = withoutEdgeReaderMembers(members, edge)
  const dropped = members.length - kept.length
  if (dropped === 0) return { ...minted, droppedEdgeReaders: 0 }
  const invitation = { ...minted.invitation, members: kept } as I
  return { ...minted, invitation, encoded: encode(invitation), droppedEdgeReaders: dropped }
}
