// redial-gate.mjs - notes 19 E28: the in-process proof that the 64-59 fourth dial source supplied the officer's re-dial.
// installRedialResolveProbe wraps a node's resolveControlDialAddrs (instance level; the reconcile pass calls this.resolveControlDialAddrs).
// redialGate reads the ring. No log line is read and no debug namespace is armed.
const RING_CAP = 5000
const isEmptyList = (r) => Array.isArray(r) && r.length === 0

export function installRedialResolveProbe (node, ring) {
  const original = node.resolveControlDialAddrs
  node.resolveControlDialAddrs = async function (peerId, resolved) {
    let peerRecordNull = false
    let error
    try { peerRecordNull = isEmptyList(await this.resolvePeerAddrs(peerId)) } catch (e) { error = String(e?.name ?? 'Error') }
    const push = (list, thrown) => {
      const addrs = Array.isArray(list) ? list.map((a) => String(a)) : []
      ring.push({ at: Date.now(), peerId, peerRecordNull, resolvedLen: Array.isArray(list) ? list.length : 0, addrs, ...(error ? { error } : {}), ...(thrown ? { thrown } : {}) })
      while (ring.length > RING_CAP) ring.shift()
    }
    let out
    try {
      out = await original.call(this, peerId, resolved)
    } catch (e) {
      push([], String(e?.name ?? 'Error'))
      throw e
    }
    push(out)
    return out
  }
  return node
}

/** records: the ring; {peer, since}: the sibling's full peer id and the epoch ms after which a call counts. */
export function redialGate (records, { peer, since }) {
  const mine = (records ?? []).filter((r) => r && r.peerId === peer && r.at >= since)
  const suffix = `/p2p-circuit/p2p/${peer}`
  const circuit = (r) => Array.isArray(r.addrs) && r.addrs.some((a) => typeof a === 'string' && a.endsWith(suffix))
  const calls = mine.length
  const nonEmptyCalls = mine.filter((r) => Array.isArray(r.addrs) && r.addrs.length > 0).length
  const circuitCalls = mine.filter(circuit).length
  const recordNullCalls = mine.filter((r) => r.peerRecordNull === true).length
  const redialResolves = mine.filter((r) => r.peerRecordNull === true && !r.error && !r.thrown && circuit(r)).length
  return { calls, nonEmptyCalls, circuitCalls, recordNullCalls, redialResolves, verdict: redialResolves >= 1 ? 'PASS' : 'FAIL redial-not-patch-path' }
}
