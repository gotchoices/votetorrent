import { sha256 } from 'multiformats/hashes/sha2';
export async function blockIdToBytes(blockId) {
    const input = new TextEncoder().encode(blockId);
    const mh = await sha256.digest(input);
    return mh.digest;
}
//# sourceMappingURL=block-id-to-bytes.js.map