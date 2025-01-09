import { fromString } from "uint8arrays";
import { BlockId } from "../../db-core/src/index.js";

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

export function blockIdToBytes(blockId: BlockId): Uint8Array {
	return fromString(blockId, 'base32');
}

/** True if the given object has no keys.  This should not be used for classes or objects with proto fields. */
export function recordEmpty<T>(record: Record<string, T>): boolean {
	for (const key in record) return false;
	return true;
}
