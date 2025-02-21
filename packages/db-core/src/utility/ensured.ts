// Retrieves a value from a record, generating an entry if none exists
export function ensured<K extends string | number | symbol, V>(
	map: Record<K, V>,
	key: K,
	makeNew: () => Exclude<V, undefined>,
	existing?: (existing: Exclude<V, undefined>) => void
): Exclude<V, undefined> {
	let v = map[key];
	if (typeof v === 'undefined') {
		v = makeNew();
		map[key] = v;
	} else if (existing) {
		existing(v as Exclude<V, undefined>);
	}
	return v as Exclude<V, undefined>;
}

export function ensuredMap<K extends string | number | symbol, V>(
	map: Map<K, V>,
	key: K,
	makeNew: () => Exclude<V, undefined>,
	existing?: (existing: Exclude<V, undefined>) => void
): Exclude<V, undefined> {
	let v = map.get(key);
	if (typeof v === 'undefined') {
		v = makeNew();
		map.set(key, v);
	} else if (existing) {
		existing(v as Exclude<V, undefined>);
	}
	return v as Exclude<V, undefined>;
}
