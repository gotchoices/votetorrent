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
//# sourceMappingURL=peer-utils.js.map