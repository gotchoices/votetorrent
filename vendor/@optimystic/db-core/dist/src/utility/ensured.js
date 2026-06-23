// Retrieves a value from a record, generating an entry if none exists
export function ensured(map, key, makeNew, existing) {
    let v = map[key];
    if (typeof v === 'undefined') {
        v = makeNew();
        map[key] = v;
    }
    else if (existing) {
        existing(v);
    }
    return v;
}
export function ensuredMap(map, key, makeNew, existing) {
    let v = map.get(key);
    if (typeof v === 'undefined') {
        v = makeNew();
        map.set(key, v);
    }
    else if (existing) {
        existing(v);
    }
    return v;
}
//# sourceMappingURL=ensured.js.map