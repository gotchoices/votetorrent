import { sha256 } from 'multiformats/hashes/sha2';
import { toString } from 'uint8arrays/to-string';
/**
 * SHA-256 string hash function.
 *
 * @param str - The string to hash
 * @returns A base64url-encoded SHA-256 hash string
 */
export async function hashString(str) {
    const input = new TextEncoder().encode(str);
    const mh = await sha256.digest(input);
    return toString(mh.digest, 'base64url');
}
//# sourceMappingURL=hash-string.js.map