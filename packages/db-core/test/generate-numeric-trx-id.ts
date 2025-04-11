import type { TrxId } from "../src/collection/transaction";
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

// Helper function to generate deterministic UUIDs for testing
export function generateNumericTrxId(num: number): TrxId {
	// Convert num to Uint8Array handling is num is larger than 255
	const bytes = new Uint8Array(4);
	bytes[0] = num & 0xff;
	bytes[1] = (num >> 8) & 0xff;
	bytes[2] = (num >> 16) & 0xff;
	bytes[3] = (num >> 24) & 0xff;
	// Encode num as a base64url
	return uint8ArrayToString(bytes, 'base64url');
}
