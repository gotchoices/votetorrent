import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateRNPeerKey } from '../src/identity.js';
import { LevelDBKVStore } from '../src/leveldb-kv-store.js';
import { openAtPath, openTestDb } from './classic-level-driver.js';
describe('loadOrCreateRNPeerKey', () => {
    let handle;
    beforeEach(async () => {
        handle = await openTestDb();
    });
    afterEach(async () => {
        await handle.cleanup();
    });
    it('generates a key on first call and returns it on subsequent calls', async () => {
        const key1 = await loadOrCreateRNPeerKey(handle.db);
        const key2 = await loadOrCreateRNPeerKey(handle.db);
        expect(peerIdFromPrivateKey(key1).toString()).to.equal(peerIdFromPrivateKey(key2).toString());
    });
    it('different keyNames yield different identities', async () => {
        const a = await loadOrCreateRNPeerKey(handle.db, 'a');
        const b = await loadOrCreateRNPeerKey(handle.db, 'b');
        expect(peerIdFromPrivateKey(a).toString()).to.not.equal(peerIdFromPrivateKey(b).toString());
    });
    it('survives close + reopen on the same database path', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'optimystic-rn-identity-'));
        try {
            const db1 = await openAtPath(dir);
            const key1 = await loadOrCreateRNPeerKey(db1);
            const peerId1 = peerIdFromPrivateKey(key1).toString();
            await db1.close();
            const db2 = await openAtPath(dir);
            const key2 = await loadOrCreateRNPeerKey(db2);
            const peerId2 = peerIdFromPrivateKey(key2).toString();
            await db2.close();
            expect(peerId2).to.equal(peerId1);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('identity keys do not collide with KV store keys (distinct tag bytes)', async () => {
        // LevelDBKVStore tags keys with TAG_KV; identity uses TAG_IDENTITY. The
        // two should be independent regardless of name overlap.
        const kv = new LevelDBKVStore(handle.db, '');
        await kv.set('peer-private-key', 'not-the-real-key');
        const key = await loadOrCreateRNPeerKey(handle.db);
        // KV value is unchanged...
        expect(await kv.get('peer-private-key')).to.equal('not-the-real-key');
        // ...and the identity helper still produced a valid Ed25519 key.
        expect(peerIdFromPrivateKey(key).toString().length).to.be.greaterThan(0);
    });
});
//# sourceMappingURL=identity.spec.js.map