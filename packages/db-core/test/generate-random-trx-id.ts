import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays/dist/src/to-string';
import type { TrxId } from '../src';

// Helper function to generate base64url encoded TrxIds
export function generateRandomTrxId(): TrxId {
	const bytes = randomBytes(8);
	return uint8ArrayToString(bytes, 'base64url');
}
