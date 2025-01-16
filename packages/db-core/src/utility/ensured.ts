// Retrieves a value from a record, generating an entry if none exists

export function ensured<K extends string | number | symbol, V>(map: Record<K, V>, key: K, makeNew: () => V, existing?: (existing: V) => void) {
	let v = map[key];
	if (typeof v === 'undefined') {
		v = makeNew();
		map[key] = v;
	} else if (existing) {
		existing(v);
	}
	return v;
}
