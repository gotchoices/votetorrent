/**
 * Portable type aliases for peer networking.
 *
 * These minimal structural types decouple db-core from any concrete
 * networking library (e.g. libp2p).  Concrete implementations in
 * transport packages (db-p2p) satisfy these structurally.
 */
/** Create a lightweight PeerId from its string representation. */
export function peerIdFromString(id) {
    return {
        toString: () => id,
        equals: (other) => other != null
            && typeof other === 'object'
            && 'toString' in other
            && typeof other.toString === 'function'
            && other.toString() === id,
    };
}
//# sourceMappingURL=types.js.map