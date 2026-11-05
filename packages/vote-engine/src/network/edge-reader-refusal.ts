/**
 * Edge-reader cohort refusal: keeps strand peers that declared themselves read-only edge readers (the
 * officer's browser dashboard, whose strand node stores nothing) out of this node's strand write cohorts
 * and coordinator choice.
 *
 * Phones (the Authority and Voter apps) create ONE tracker per CadreNode and pass `tracker.hook` as
 * cadre-core's `strandCohortRefusal`. cadre-core calls the hook once per strand-node build and turns the
 * returned object into that strand node's Optimystic `isNetworkMember` predicate; it then calls `attach`
 * with the built libp2p node.
 *
 * The signal is the peer's OWN identify: a dashboard strand node handles `EDGE_READER_PROTOCOL`, and a peer
 * is refused only after an identify (or a peer record) listing that protocol arrived on this node. Phones
 * never handle or dial the marker, so no stream on it can put the marker into another peer's record; a
 * peer can only get itself refused. Reads are unaffected (the predicate only decides where this node sends
 * storage).
 *
 * Contract:
 * - `hook(strandId)` returns the SAME object for a strand on every call (a hibernation rebuild re-attaches
 *   the new node to the same set). A new process starts empty and relearns at the next identify.
 * - `refuses(peerId)` is synchronous, never throws, and is true only for a peer seen declaring.
 * - The per-strand set never shrinks, except FIFO eviction past `maxPeersPerStrand`.
 * - No timers, no logging, no imports. Every event handler catches its own errors.
 */

/** The marker protocol a read-only edge reader's strand node handles (and closes at once). */
export const EDGE_READER_PROTOCOL = '/votetorrent/edge-reader/1.0.0'

/** The most refused peers remembered per strand; the oldest is evicted first. */
export const EDGE_READER_REFUSAL_MAX_PEERS = 256

/** What the hook returns for one strand (cadre-core's `StrandCohortRefusal` shape). */
export interface EdgeReaderStrandRefusal {
  refuses(peerId: string): boolean
  attach(libp2pNode: unknown): void
}

export interface EdgeReaderRefusalOptions {
  /** Marker protocol to look for. Defaults to {@link EDGE_READER_PROTOCOL}. */
  protocol?: string
  /** Per-strand cap. Defaults to {@link EDGE_READER_REFUSAL_MAX_PEERS}. */
  maxPeersPerStrand?: number
}

export interface EdgeReaderRefusal {
  /** Pass as cadre-core `CadreNodeConfig.strandCohortRefusal`. */
  hook: (strandId: string) => EdgeReaderStrandRefusal | undefined
  has(strandId: string, peerId: string): boolean
  refused(strandId: string): readonly string[]
  /** Total refused peers across all strands. */
  size(): number
}

interface ListenerTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void
}

function peerIdString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  try {
    const s = typeof value === 'string' ? value : (value as { toString(): unknown }).toString()
    return typeof s === 'string' && s.length > 0 && s !== '[object Object]' ? s : undefined
  } catch {
    return undefined
  }
}

function listsProtocol(protocols: unknown, protocol: string): boolean {
  return Array.isArray(protocols) && protocols.includes(protocol)
}

export function createEdgeReaderRefusal(options?: EdgeReaderRefusalOptions): EdgeReaderRefusal {
  const protocol = typeof options?.protocol === 'string' && options.protocol.length > 0 ? options.protocol : EDGE_READER_PROTOCOL
  const cap =
    typeof options?.maxPeersPerStrand === 'number' && Number.isInteger(options.maxPeersPerStrand) && options.maxPeersPerStrand > 0
      ? options.maxPeersPerStrand
      : EDGE_READER_REFUSAL_MAX_PEERS
  // Insertion-ordered: the first key is the oldest, evicted first.
  const sets = new Map<string, Set<string>>()
  const refusals = new Map<string, EdgeReaderStrandRefusal>()

  const setFor = (strandId: string): Set<string> => {
    let set = sets.get(strandId)
    if (!set) {
      set = new Set<string>()
      sets.set(strandId, set)
    }
    return set
  }

  const add = (strandId: string, rawId: unknown): void => {
    const id = peerIdString(rawId)
    if (id === undefined) return
    const set = setFor(strandId)
    if (set.has(id)) return
    set.add(id)
    while (set.size > cap) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  const hook = (strandId: string): EdgeReaderStrandRefusal | undefined => {
    if (typeof strandId !== 'string' || strandId.length === 0) return undefined
    const existing = refusals.get(strandId)
    if (existing) return existing
    const refusal: EdgeReaderStrandRefusal = {
      refuses(peerId: string): boolean {
        try {
          return typeof peerId === 'string' && (sets.get(strandId)?.has(peerId) ?? false)
        } catch {
          return false
        }
      },
      attach(libp2pNode: unknown): void {
        try {
          const node = libp2pNode as Partial<ListenerTarget> & { peerStore?: { all?: unknown } }
          if (node && typeof node.addEventListener === 'function') {
            node.addEventListener('peer:update', (event: unknown) => {
              try {
                const peer = (event as { detail?: { peer?: { id?: unknown; protocols?: unknown } } })?.detail?.peer
                if (peer && listsProtocol(peer.protocols, protocol)) add(strandId, peer.id)
              } catch {
                // A malformed event refuses nobody.
              }
            })
            node.addEventListener('peer:identify', (event: unknown) => {
              try {
                const detail = (event as { detail?: { peerId?: unknown; protocols?: unknown } })?.detail
                if (detail && listsProtocol(detail.protocols, protocol)) add(strandId, detail.peerId)
              } catch {
                // A malformed event refuses nobody.
              }
            })
          }
          const all = node?.peerStore?.all
          if (typeof all === 'function') {
            Promise.resolve()
              .then(() => (all as () => unknown).call(node.peerStore))
              .then((peers: unknown) => {
                if (!Array.isArray(peers)) return
                for (const peer of peers as Array<{ id?: unknown; protocols?: unknown }>) {
                  if (peer && listsProtocol(peer.protocols, protocol)) add(strandId, peer.id)
                }
              })
              .catch(() => {
                // A peerStore that cannot be read refuses nobody; live events still teach the set.
              })
          }
        } catch {
          // Never fail a strand-node build over the refusal.
        }
      },
    }
    refusals.set(strandId, refusal)
    return refusal
  }

  return {
    hook,
    has: (strandId, peerId) => sets.get(strandId)?.has(peerId) ?? false,
    refused: (strandId) => [...(sets.get(strandId) ?? [])],
    size: () => {
      let n = 0
      for (const set of sets.values()) n += set.size
      return n
    },
  }
}
