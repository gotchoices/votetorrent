import { expect } from 'chai';
import { Tree } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor } from '../src/testing/mesh-harness.js';
describe('Fresh-node DDL (solo, real production stack)', function () {
    // Tighter than the 10s package default: these are forcing-function repros for a
    // solo-node DDL hang — if any call stalls, fast-fail is the whole point.
    this.timeout(5_000);
    let mesh;
    let transactor;
    beforeEach(async () => {
        mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
        transactor = buildNetworkTransactor(mesh);
    });
    it('fresh Tree.createOrOpen + tree.replace on a solo node completes without throwing', async function () {
        const tree = await Tree.createOrOpen(transactor, 'solo-test-tree', entry => entry.key);
        const entry = { key: 1, value: 'first' };
        // This is the exact call that fails in sereus-health's SchemaManager.storeSchema
        // (tree.replace on a never-before-written Collection). The expected failure on main
        // is `Error: Cannot add to non-existent chain` from chain.ts:102.
        await tree.replace([[entry.key, entry]]);
        const retrieved = await tree.get(entry.key);
        expect(retrieved).to.deep.equal(entry);
    });
    it('schema-manager pattern: read-first Tree, then write Tree on same id + same transactor', async function () {
        // Mirrors quereus-plugin-optimystic's SchemaManager: getSchema opens a fresh Tree
        // and calls tree.find (read-only) before storeSchema opens ANOTHER fresh Tree on
        // the same id (no collection-caching outside a transaction) and calls tree.replace.
        const schemaTreeId = 'optimystic/schema';
        // 1. getSchema-equivalent: fresh Tree, read-only find on empty btree.
        const readerTree = await Tree.createOrOpen(transactor, schemaTreeId, entry => entry[0]);
        // Plugin calls tree.find(tableName) — reads a (possibly empty) btree.
        // Any local state this creates must not corrupt a later write via a second Tree instance.
        await readerTree.find('App.types');
        // 2. storeSchema-equivalent: another fresh Tree on the same id, then replace.
        const writerTree = await Tree.createOrOpen(transactor, schemaTreeId, entry => entry[0]);
        await writerTree.replace([['App.types', ['App.types', { columns: [] }]]]);
        // 3. Round-trip
        const retrieved = await writerTree.get('App.types');
        expect(retrieved).to.deep.equal(['App.types', { columns: [] }]);
    });
    it('two sequential DDLs: schema tree writes two schemas back-to-back', async function () {
        // First table works in isolation; maybe the second one trips the chain-add bug
        // once the schema block has a committed revision + pending metadata interaction.
        const schemaTreeId = 'optimystic/schema';
        const tree1 = await Tree.createOrOpen(transactor, schemaTreeId, entry => entry[0]);
        await tree1.replace([['App.types', ['App.types', { columns: ['id'] }]]]);
        const tree2 = await Tree.createOrOpen(transactor, schemaTreeId, entry => entry[0]);
        await tree2.replace([['App.users', ['App.users', { columns: ['email'] }]]]);
        expect(await tree2.get('App.types')).to.deep.equal(['App.types', { columns: ['id'] }]);
        expect(await tree2.get('App.users')).to.deep.equal(['App.users', { columns: ['email'] }]);
    });
});
//# sourceMappingURL=fresh-node-ddl.spec.js.map