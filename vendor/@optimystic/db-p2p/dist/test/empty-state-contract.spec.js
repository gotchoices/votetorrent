import { expect } from 'chai';
import { NetworkTransactor, Tracker, TransactorSource, emptyTransforms } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { createMesh } from '../src/testing/mesh-harness.js';
// Pins the "empty-state" contract at every layer boundary so future refactors can't
// silently reintroduce the ticket-5 class of bug (layer drift on unknown / pending-only
// state). Each layer pair asserts both empty-ish states round-trip:
//   - "does not exist"        → block id was never touched
//   - "pending-only metadata" → storageRepo.pend seeded metadata but no commit
// See tickets/complete/5-get-block-throws-on-pending-only-metadata.md for the canonical bug.
const UNKNOWN_ID = 'never-seen-block';
const PENDING_ID = 'pending-only-block';
const makeBlock = (id) => ({
    header: {
        id,
        type: 'test',
        collectionId: 'empty-state-collection'
    }
});
const makePendInsert = (blockId, actionId) => ({
    actionId,
    policy: 'c',
    transforms: {
        inserts: { [blockId]: makeBlock(blockId) },
        updates: {},
        deletes: []
    }
});
/**
 * Seeds a pending-only state (metadata exists, no committed revision) by calling pend
 * against the storage without a matching commit. Used across all layer-pair tests so
 * the same underlying condition is observed through every boundary.
 */
async function seedPendingOnly(storageRepo, blockId, actionId) {
    const result = await storageRepo.pend(makePendInsert(blockId, actionId));
    if (!result.success) {
        throw new Error('seedPendingOnly: pend did not succeed');
    }
}
const buildNetworkTransactor = (mesh) => {
    const repoByPeer = new Map();
    for (const node of mesh.nodes) {
        repoByPeer.set(node.peerId.toString(), node.coordinatorRepo);
    }
    return new NetworkTransactor({
        timeoutMs: 3_000,
        abortOrCancelTimeoutMs: 3_000,
        keyNetwork: mesh.keyNetwork,
        getRepo: (peerId) => {
            const repo = repoByPeer.get(peerId.toString());
            if (!repo)
                throw new Error(`Unknown peer ${peerId.toString()}`);
            return repo;
        }
    });
};
describe('Empty-state contract (cross-layer)', function () {
    // Contract assertions — fast-fail is the point. If any call stalls on an empty
    // block read, the spec has surfaced a latent regression.
    this.timeout(5_000);
    describe('BlockStorage ↔ StorageRepo', () => {
        let rawStorage;
        let storageRepo;
        beforeEach(() => {
            rawStorage = new MemoryRawStorage();
            storageRepo = new StorageRepo(blockId => new BlockStorage(blockId, rawStorage));
        });
        it('unknown block: storageRepo.get returns { state: {} }, no throw', async function () {
            this.timeout(3_000);
            const result = await storageRepo.get({ blockIds: [UNKNOWN_ID] });
            // Contract: an unknown block round-trips as a canonical empty-state entry.
            expect(result[UNKNOWN_ID]).to.deep.equal({ state: {} });
        });
        it('pending-only block: storageRepo.get returns { state: {} }, no throw', async function () {
            this.timeout(3_000);
            await seedPendingOnly(storageRepo, PENDING_ID, 'action-pending-1');
            const result = await storageRepo.get({ blockIds: [PENDING_ID] });
            // Contract pinned by ticket-5 fix: pending-only metadata (no committed rev) is
            // indistinguishable from "does not exist" at the no-context read path — both
            // yield { state: {} }. state.pendings is NOT populated unless a committed
            // revision exists (see storage-repo.ts:73-84).
            expect(result[PENDING_ID]).to.deep.equal({ state: {} });
        });
    });
    describe('StorageRepo ↔ CoordinatorRepo (1-node mesh)', () => {
        let mesh;
        beforeEach(async () => {
            mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
        });
        it('unknown block: coordinatorRepo.get returns { state: {} } without escalating into a hang', async function () {
            this.timeout(3_000);
            const coord = mesh.nodes[0].coordinatorRepo;
            const result = await coord.get({ blockIds: [UNKNOWN_ID] });
            // Contract: on a 1-node mesh the cluster-fetch fallback must terminate cleanly
            // for an unknown block — no infinite loop querying self, canonical empty-state
            // returned.
            expect(result[UNKNOWN_ID]).to.deep.equal({ state: {} });
        });
        it('pending-only block: coordinatorRepo.get returns { state: {} }, no throw', async function () {
            this.timeout(3_000);
            const node = mesh.nodes[0];
            await seedPendingOnly(node.storageRepo, PENDING_ID, 'action-pending-2');
            const result = await node.coordinatorRepo.get({ blockIds: [PENDING_ID] });
            // Contract: pending-only metadata propagates through the coordinator layer as
            // { state: {} } — the cluster-fetch fallback must not throw when no committed
            // latest is found on any peer.
            expect(result[PENDING_ID]).to.deep.equal({ state: {} });
        });
    });
    describe('CoordinatorRepo ↔ NetworkTransactor (1-node mesh)', () => {
        let mesh;
        let transactor;
        beforeEach(async () => {
            mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
            transactor = buildNetworkTransactor(mesh);
        });
        it('unknown block: networkTransactor.get returns { state: {} }, merge path does not raise "missing"', async function () {
            this.timeout(3_000);
            const result = await transactor.get({ blockIds: [UNKNOWN_ID] });
            // Contract: the merge in network-transactor.ts (~lines 118-149) must accept a
            // coordinator response of `{ [id]: { state: {} } }` as a valid, complete reply.
            expect(result[UNKNOWN_ID]).to.deep.equal({ state: {} });
        });
        it('pending-only block: networkTransactor.get returns { state: {} }, no throw', async function () {
            this.timeout(3_000);
            await seedPendingOnly(mesh.nodes[0].storageRepo, PENDING_ID, 'action-pending-3');
            const result = await transactor.get({ blockIds: [PENDING_ID] });
            // Contract: the merge path treats pending-only { state: {} } the same as unknown
            // — no throw, single-entry record returned.
            expect(result[PENDING_ID]).to.deep.equal({ state: {} });
        });
    });
    describe('NetworkTransactor ↔ Collection (TransactorSource + Tracker, 1-node mesh)', () => {
        let mesh;
        let transactor;
        beforeEach(async () => {
            mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1, superMajorityThreshold: 0.51 });
            transactor = buildNetworkTransactor(mesh);
        });
        it('TransactorSource.tryGet on unknown block returns undefined', async function () {
            this.timeout(3_000);
            const source = new TransactorSource('empty-state-collection', transactor, undefined);
            const block = await source.tryGet(UNKNOWN_ID);
            // Contract: tryGet interprets an empty-state response as "not found" and returns
            // undefined to Collection/Tracker — never throws.
            expect(block).to.equal(undefined);
        });
        it('TransactorSource.tryGet on pending-only block returns undefined (no materialized block without context)', async function () {
            this.timeout(3_000);
            await seedPendingOnly(mesh.nodes[0].storageRepo, PENDING_ID, 'action-pending-4');
            const source = new TransactorSource('empty-state-collection', transactor, undefined);
            const block = await source.tryGet(PENDING_ID);
            // Contract: pending-only (no committed rev) surfaces as undefined at the
            // Collection seam when no ActionContext is supplied — matches storage-repo's
            // no-context path. A caller providing context.actionId would get the pending
            // applied, but that's covered by the storage-repo-level spec.
            expect(block).to.equal(undefined);
        });
        it('Tracker.tryGet over an empty source returns undefined, does not throw', async function () {
            this.timeout(3_000);
            const source = new TransactorSource('empty-state-collection', transactor, undefined);
            const tracker = new Tracker(source, emptyTransforms());
            const block = await tracker.tryGet(UNKNOWN_ID);
            // Contract: Tracker layered over an empty source returns undefined for unknown
            // ids — no throw, no hang.
            expect(block).to.equal(undefined);
        });
    });
});
//# sourceMappingURL=empty-state-contract.spec.js.map