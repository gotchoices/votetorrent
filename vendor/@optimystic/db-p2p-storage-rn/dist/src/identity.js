import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { identityKey } from './keys.js';
export const DEFAULT_PEER_KEY_NAME = 'peer-private-key';
/**
 * Loads the persisted React Native peer's libp2p private key, or generates a
 * fresh Ed25519 key on first call and persists it.
 *
 * The key is stored as raw protobuf bytes under a dedicated identity tag —
 * LevelDB stores arbitrary byte sequences natively, so there is no base64
 * round-trip (unlike a text-only KV store). Mirrors the shape of
 * `loadOrCreateBrowserPeerKey` and `loadOrCreateNSPeerKey`.
 *
 * The returned `PrivateKey` can be passed directly to
 * `createLibp2pNode({ privateKey })`, giving a React Native peer a stable,
 * restart-surviving identity.
 */
export async function loadOrCreateRNPeerKey(db, keyName = DEFAULT_PEER_KEY_NAME) {
    const stored = await db.get(identityKey(keyName));
    if (stored && stored.byteLength > 0) {
        return privateKeyFromProtobuf(stored);
    }
    const key = await generateKeyPair('Ed25519');
    const bytes = privateKeyToProtobuf(key);
    await db.put(identityKey(keyName), bytes);
    return key;
}
//# sourceMappingURL=identity.js.map