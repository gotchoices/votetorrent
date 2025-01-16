import { fromString } from "uint8arrays";
import { BlockId } from "../../db-core/src/index.js";

export function blockIdToBytes(blockId: BlockId): Uint8Array {
	return fromString(blockId, 'base32');
}

/** True if the given object has no keys.  This should not be used for classes or objects with proto fields. */
export function recordEmpty<T>(record: Record<string, T>): boolean {
	for (const key in record) return false;
	return true;
}
