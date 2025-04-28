import { fromString } from "uint8arrays";
import type { BlockId } from "../index.js";

export function blockIdToBytes(blockId: BlockId): Uint8Array {
	return fromString(blockId, 'base64url');
}
