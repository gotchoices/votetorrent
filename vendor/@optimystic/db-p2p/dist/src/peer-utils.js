import { isPeerId } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
function toPeerIdString(id) {
    try {
        if (id == null)
            return null;
        // PeerId instance
        if (typeof id?.toString === 'function')
            return id.toString();
        // Wrapped object { id: PeerId | string }
        const inner = id.id;
        if (inner && typeof inner.toString === 'function')
            return inner.toString();
        if (typeof inner === 'string')
            return inner;
        // Raw string
        if (typeof id === 'string')
            return id;
        return null;
    }
    catch {
        return null;
    }
}
export function peersEqual(a, b) {
    const as = toPeerIdString(a);
    const bs = toPeerIdString(b);
    return as != null && bs != null && as === bs;
}
/**
 * Re-brand any structurally-typed peer representation (e.g. db-core's
 * structural IPeerNetwork `{ toString, equals }` stubs) into a real,
 * symbol-branded PeerId. This is a pure re-brand, NOT a lenient/best-effort
 * match: `peerIdFromString()` is allowed to throw on genuinely malformed
 * input (P2P-10/D-06/T-38-02) — callers must not catch this and fall back.
 */
export function toBrandedPeerId(peerId) {
    return isPeerId(peerId) ? peerId : peerIdFromString(peerId.toString());
}
//# sourceMappingURL=peer-utils.js.map