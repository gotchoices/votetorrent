import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays';
// Helper function to generate base64url encoded ActionIds
export function generateRandomActionId() {
    const bytes = randomBytes(8);
    return uint8ArrayToString(bytes, 'base64url');
}
//# sourceMappingURL=generate-random-action-id.js.map