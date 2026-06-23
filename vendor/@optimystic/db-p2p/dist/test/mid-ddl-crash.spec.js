import { expect } from 'chai';
import { Tree } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor } from '../src/testing/mesh-harness.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
class InjectedCrash extends Error {
    constructor(method, when) {
        super(`[InjectedCrash] ${when} ${method}`);
        this.name = 'InjectedCrash';
    }
}
class CrashingRawStorage {
    inner;
    trigger;
    matchCount = 0;
    hasFired = false;
    constructor(inner, trigger) {
        this.inner = inner;
        this.trigger = trigger;
    }
    /** Did the configured fault actually fire? */
    get fired() { return this.hasFired; }
    shouldFire(method, args, blockId, actionId) {
        if (this.hasFired)
            return false;
        if (this.trigger.method !== method)
            return false;
        if (this.trigger.blockId !== undefined && this.trigger.blockId !== blockId)
            return false;
        if (this.trigger.actionId !== undefined && this.trigger.actionId !== actionId)
            return false;
        if (this.trigger.predicate && !this.trigger.predicate(args))
            return false;
        const skip = this.trigger.skipCount ?? 0;
        if (this.matchCount < skip) {
            this.matchCount++;
            return false;
        }
        this.matchCount++;
        return true;
    }
    async invoke(method, args, blockId, actionId, call) {
        const fire = this.shouldFire(method, args, blockId, actionId);
        if (fire && this.trigger.when === 'before') {
            this.hasFired = true;
            throw new InjectedCrash(method, 'before');
        }
        const result = await call();
        if (fire && this.trigger.when === 'after') {
            this.hasFired = true;
            throw new InjectedCrash(method, 'after');
        }
        return result;
    }
    getMetadata(blockId) {
        return this.invoke('getMetadata', [blockId], blockId, undefined, () => this.inner.getMetadata(blockId));
    }
    saveMetadata(blockId, metadata) {
        return this.invoke('saveMetadata', [blockId, metadata], blockId, undefined, () => this.inner.saveMetadata(blockId, metadata));
    }
    getRevision(blockId, rev) {
        return this.invoke('getRevision', [blockId, rev], blockId, undefined, () => this.inner.getRevision(blockId, rev));
    }
    saveRevision(blockId, rev, actionId) {
        return this.invoke('saveRevision', [blockId, rev, actionId], blockId, actionId, () => this.inner.saveRevision(blockId, rev, actionId));
    }
    listRevisions(blockId, startRev, endRev) {
        // No async-iterator fault injection wired in — not needed by the current crash plans.
        return this.inner.listRevisions(blockId, startRev, endRev);
    }
    getPendingTransaction(blockId, actionId) {
        return this.invoke('getPendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.getPendingTransaction(blockId, actionId));
    }
    savePendingTransaction(blockId, actionId, transform) {
        return this.invoke('savePendingTransaction', [blockId, actionId, transform], blockId, actionId, () => this.inner.savePendingTransaction(blockId, actionId, transform));
    }
    deletePendingTransaction(blockId, actionId) {
        return this.invoke('deletePendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.deletePendingTransaction(blockId, actionId));
    }
    listPendingTransactions(blockId) {
        return this.inner.listPendingTransactions(blockId);
    }
    getTransaction(blockId, actionId) {
        return this.invoke('getTransaction', [blockId, actionId], blockId, actionId, () => this.inner.getTransaction(blockId, actionId));
    }
    saveTransaction(blockId, actionId, transform) {
        return this.invoke('saveTransaction', [blockId, actionId, transform], blockId, actionId, () => this.inner.saveTransaction(blockId, actionId, transform));
    }
    getMaterializedBlock(blockId, actionId) {
        return this.invoke('getMaterializedBlock', [blockId, actionId], blockId, actionId, () => this.inner.getMaterializedBlock(blockId, actionId));
    }
    saveMaterializedBlock(blockId, actionId, block) {
        return this.invoke('saveMaterializedBlock', [blockId, actionId, block], blockId, actionId, () => this.inner.saveMaterializedBlock(blockId, actionId, block));
    }
    promotePendingTransaction(blockId, actionId) {
        return this.invoke('promotePendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.promotePendingTransaction(blockId, actionId));
    }
}
// ============================================================================
// Test helpers
// ============================================================================
const SOLO_OPTIONS = {
    responsibilityK: 1,
    clusterSize: 1,
    superMajorityThreshold: 0.51
};
const buildCrashingMesh = (raw, trigger) => {
    const proxy = new CrashingRawStorage(raw, trigger);
    return createMesh(1, { ...SOLO_OPTIONS, rawStorageFactory: () => proxy })
        .then(mesh => ({ mesh, proxy }));
};
const rebuildCleanMesh = (raw) => createMesh(1, { ...SOLO_OPTIONS, rawStorageFactory: () => raw });
const makeHeader = (id) => ({
    id: id,
    type: 'test-block',
    collectionId: 'coll-mid-ddl'
});
const makeBlock = (id, extra) => ({
    header: makeHeader(id),
    ...extra
});
const makeInsertTransforms = (blocks) => ({
    inserts: blocks,
    updates: {},
    deletes: []
});
const preSeedMetadata = async (raw, blockIds) => {
    for (const blockId of blockIds) {
        const existing = await raw.getMetadata(blockId);
        if (!existing) {
            await raw.saveMetadata(blockId, { latest: undefined, ranges: [[0]] });
        }
    }
};
const assertIsCrash = (err) => {
    // The crash may be wrapped by outer layers (StorageRepo.commit returns { success: false, reason }).
    // At the throw-site in pend, the rejection surfaces directly — match both.
    if (err instanceof InjectedCrash)
        return;
    if (err instanceof Error && err.message.includes('[InjectedCrash]'))
        return;
    throw new Error(`Expected an InjectedCrash, got: ${err?.message ?? String(err)}`);
};
// ============================================================================
// Specs
// ============================================================================
describe('Mid-DDL crash recovery (solo node)', function () {
    // Same 5s budget as fresh-node-ddl.spec.ts — tests exercising crash+restart must
    // complete well inside a production-style timeout; if they hang, that's the bug.
    this.timeout(5_000);
    // ------------------------------------------------------------------------
    // Crash-A1: metadata seeded, pending not yet persisted (`when: 'before'`)
    // ------------------------------------------------------------------------
    describe('Crash-A1: savePendingTransaction fails before persist (single block)', () => {
        const blockA = 'block-crash-a1';
        const actionId = 'action-crash-a1';
        const pendRequest = () => ({
            actionId,
            transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['hello'] }) }),
            policy: 'c'
        });
        it('raw state after crash: metadata seeded, no pending', async () => {
            const raw = new MemoryRawStorage();
            const { mesh, proxy } = await buildCrashingMesh(raw, {
                method: 'savePendingTransaction',
                when: 'before',
                blockId: blockA
            });
            let caught;
            try {
                await mesh.nodes[0].storageRepo.pend(pendRequest());
            }
            catch (err) {
                caught = err;
            }
            assertIsCrash(caught);
            expect(proxy.fired).to.equal(true);
            const meta = await raw.getMetadata(blockA);
            expect(meta, 'metadata seeded by BlockStorage.savePendingTransaction').to.not.equal(undefined);
            expect(meta?.latest, 'no committed revision yet').to.equal(undefined);
            const pending = await raw.getPendingTransaction(blockA, actionId);
            expect(pending, 'pending never persisted').to.equal(undefined);
        });
        it('read after crash returns empty state (depends on pending-only-metadata ticket)', async () => {
            const raw = new MemoryRawStorage();
            const { mesh } = await buildCrashingMesh(raw, {
                method: 'savePendingTransaction',
                when: 'before',
                blockId: blockA
            });
            await mesh.nodes[0].storageRepo.pend(pendRequest()).catch(() => { });
            const recovered = await rebuildCleanMesh(raw);
            const result = await recovered.nodes[0].storageRepo.get({ blockIds: [blockA] });
            expect(result[blockA]?.state, 'pending-only metadata surfaces as empty state').to.deep.equal({});
        });
        it('retry pend with same actionId reaches commit after crash', async () => {
            const raw = new MemoryRawStorage();
            const { mesh } = await buildCrashingMesh(raw, {
                method: 'savePendingTransaction',
                when: 'before',
                blockId: blockA
            });
            await mesh.nodes[0].storageRepo.pend(pendRequest()).catch(() => { });
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            const retry = await repo.pend(pendRequest());
            expect(retry.success, 'retry pend succeeds').to.equal(true);
            const commit = await repo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(commit.success, 'subsequent commit succeeds').to.equal(true);
            const final = await repo.get({ blockIds: [blockA] });
            expect(final[blockA]?.state.latest?.rev).to.equal(1);
        });
        it('cancel after crash is a no-op that leaves a retryable clean state', async () => {
            const raw = new MemoryRawStorage();
            const { mesh } = await buildCrashingMesh(raw, {
                method: 'savePendingTransaction',
                when: 'before',
                blockId: blockA
            });
            await mesh.nodes[0].storageRepo.pend(pendRequest()).catch(() => { });
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            // Cancel must not throw even though there's nothing to delete.
            await repo.cancel({ actionId, blockIds: [blockA] });
            // Fresh pend (new actionId) must still succeed.
            const freshActionId = 'action-after-cancel';
            const fresh = await repo.pend({
                actionId: freshActionId,
                transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['retry'] }) }),
                policy: 'c'
            });
            expect(fresh.success).to.equal(true);
        });
    });
    // ------------------------------------------------------------------------
    // Crash-B: partial pending across multiple blocks (`when: 'before'`)
    //
    // With `when: 'before'` on block[1], the proxy throws without delegating, so
    // block[1]'s pending is not persisted. Block[0] and block[2] run concurrently
    // under Promise.all and DO complete their writes. Result: genuinely partial.
    // ------------------------------------------------------------------------
    describe('Crash-B: partial pending across 3 blocks', () => {
        const b0 = 'crash-b-block-0';
        const b1 = 'crash-b-block-1';
        const b2 = 'crash-b-block-2';
        const staleActionId = 'stale-multi-action';
        const multiPend = () => ({
            actionId: staleActionId,
            transforms: makeInsertTransforms({
                [b0]: makeBlock(b0, { items: ['v0'] }),
                [b1]: makeBlock(b1, { items: ['v1'] }),
                [b2]: makeBlock(b2, { items: ['v2'] })
            }),
            policy: 'c'
        });
        it('crash leaves partial pending (b1 missing) and does not permanently wedge any block', async () => {
            const raw = new MemoryRawStorage();
            const { mesh, proxy } = await buildCrashingMesh(raw, {
                method: 'savePendingTransaction',
                when: 'before',
                blockId: b1
            });
            let caught;
            try {
                await mesh.nodes[0].storageRepo.pend(multiPend());
            }
            catch (err) {
                caught = err;
            }
            assertIsCrash(caught);
            expect(proxy.fired).to.equal(true);
            // b0 and b2 wrote pending (Promise.all fans out concurrently), b1 did not.
            const p0 = await raw.getPendingTransaction(b0, staleActionId);
            const p1 = await raw.getPendingTransaction(b1, staleActionId);
            const p2 = await raw.getPendingTransaction(b2, staleActionId);
            expect(p0, 'b0 pending persisted').to.not.equal(undefined);
            expect(p1, 'b1 pending NOT persisted (crash before)').to.equal(undefined);
            expect(p2, 'b2 pending persisted').to.not.equal(undefined);
            // Recovery: cancel the stale action across all blocks; then a fresh action on the
            // same block-set must succeed (no permanent wedge).
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            await repo.cancel({ actionId: staleActionId, blockIds: [b0, b1, b2] });
            // Pending entries across all three must now be gone.
            expect(await raw.getPendingTransaction(b0, staleActionId)).to.equal(undefined);
            expect(await raw.getPendingTransaction(b1, staleActionId)).to.equal(undefined);
            expect(await raw.getPendingTransaction(b2, staleActionId)).to.equal(undefined);
            const freshActionId = 'fresh-after-b-crash';
            const fresh = await repo.pend({
                actionId: freshActionId,
                transforms: makeInsertTransforms({
                    [b0]: makeBlock(b0, { items: ['new0'] }),
                    [b1]: makeBlock(b1, { items: ['new1'] }),
                    [b2]: makeBlock(b2, { items: ['new2'] })
                }),
                policy: 'c'
            });
            expect(fresh.success, 'fresh pend on same blocks after cancel succeeds').to.equal(true);
        });
    });
    // ------------------------------------------------------------------------
    // Crash-C: partial commit across multiple blocks
    //
    // Commit processes blockIds sequentially (not Promise.all), so aborting on
    // block[1] genuinely leaves block[2] unprocessed. Fault: saveMetadata on b1
    // during setLatest (meta.latest !== undefined), `when: 'after'`.
    // ------------------------------------------------------------------------
    describe('Crash-C: partial commit across 3 blocks', () => {
        const b0 = 'crash-c-block-0';
        const b1 = 'crash-c-block-1';
        const b2 = 'crash-c-block-2';
        const actionId = 'action-crash-c';
        it('crash mid-batch commit: b0,b1 fully committed; b2 untouched; retry-commit rolls b2 forward idempotently', async () => {
            const raw = new MemoryRawStorage();
            // Pre-seed metadata so pend-path saveMetadata doesn't fire the trigger.
            await preSeedMetadata(raw, [b0, b1, b2]);
            // First pend the multi-block action on the plain raw storage (no crash).
            // We do this by building a non-crashing mesh first, pending, then swapping in
            // a fresh crashing mesh for the commit phase.
            const pendingMesh = await rebuildCleanMesh(raw);
            const pendResult = await pendingMesh.nodes[0].storageRepo.pend({
                actionId,
                transforms: makeInsertTransforms({
                    [b0]: makeBlock(b0, { items: ['v0'] }),
                    [b1]: makeBlock(b1, { items: ['v1'] }),
                    [b2]: makeBlock(b2, { items: ['v2'] })
                }),
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
            // Attach the crashing wrapper. Trigger: saveMetadata on b1 where meta.latest !== undefined
            // (i.e., setLatest, not the pend-phase seed; seed doesn't exist here anyway).
            const { mesh: crashMesh, proxy } = await buildCrashingMesh(raw, {
                method: 'saveMetadata',
                when: 'after',
                blockId: b1,
                predicate: (args) => {
                    const meta = args[1];
                    return meta?.latest !== undefined;
                }
            });
            const commitResult = await crashMesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [b0, b1, b2],
                tailId: b0,
                rev: 1
            });
            expect(proxy.fired, 'crash fired during commit').to.equal(true);
            // StorageRepo.commit catches the internalCommit throw and returns { success: false }.
            expect(commitResult.success, 'commit returns failure').to.equal(false);
            // Verify raw state: b0 + b1 fully committed, b2 untouched.
            const m0 = await raw.getMetadata(b0);
            const m1 = await raw.getMetadata(b1);
            const m2 = await raw.getMetadata(b2);
            expect(m0?.latest?.rev, 'b0 latest updated').to.equal(1);
            expect(m1?.latest?.rev, 'b1 latest updated (setLatest succeeded then proxy threw `after`)').to.equal(1);
            expect(m2?.latest, 'b2 never processed').to.equal(undefined);
            // b2 still has pending and no revision.
            expect(await raw.getPendingTransaction(b2, actionId), 'b2 pending still present').to.not.equal(undefined);
            expect(await raw.getRevision(b2, 1), 'b2 has no revision').to.equal(undefined);
            // Recovery: retry-commit with same (actionId, rev). b0+b1 already match the request
            // exactly, so they're treated as idempotent no-ops; b2 rolls forward to rev=1.
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            const retry = await repo.commit({
                actionId,
                blockIds: [b0, b1, b2],
                tailId: b0,
                rev: 1
            });
            expect(retry.success, 'retry-commit succeeds — idempotent on b0,b1; advances b2').to.equal(true);
            // All three blocks are now at rev=1 with the same actionId.
            const m0After = await raw.getMetadata(b0);
            const m1After = await raw.getMetadata(b1);
            const m2After = await raw.getMetadata(b2);
            expect(m0After?.latest?.rev).to.equal(1);
            expect(m1After?.latest?.rev).to.equal(1);
            expect(m2After?.latest?.rev, 'b2 advanced to rev=1 on retry').to.equal(1);
            expect(m2After?.latest?.actionId).to.equal(actionId);
            // b2's pending was promoted and its revision was written.
            expect(await raw.getRevision(b2, 1), 'b2 revision written').to.equal(actionId);
            expect(await raw.getPendingTransaction(b2, actionId), 'b2 pending promoted').to.equal(undefined);
            expect(await raw.getTransaction(b2, actionId), 'b2 action in committed log').to.not.equal(undefined);
            // Final read on b2 sees the materialized block.
            const final = await repo.get({ blockIds: [b2] });
            expect(final[b2]?.state.latest?.rev).to.equal(1);
        });
    });
    // ------------------------------------------------------------------------
    // Crash-D2: revision durable, pending not promoted, latest not updated
    // (fault: promotePendingTransaction, `when: 'before'`)
    // ------------------------------------------------------------------------
    describe('Crash-D2: crash before promotePendingTransaction', () => {
        const blockA = 'crash-d2-block';
        const actionId = 'action-crash-d2';
        it('retry-commit reaches full success (saveRevision is idempotent)', async () => {
            const raw = new MemoryRawStorage();
            const pending = await rebuildCleanMesh(raw);
            await pending.nodes[0].storageRepo.pend({
                actionId,
                transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['d2'] }) }),
                policy: 'c'
            });
            const { mesh, proxy } = await buildCrashingMesh(raw, {
                method: 'promotePendingTransaction',
                when: 'before',
                blockId: blockA,
                actionId
            });
            const commitResult = await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(proxy.fired).to.equal(true);
            expect(commitResult.success).to.equal(false);
            // Raw state: revision durable; pending still present; action NOT in committed log;
            // metadata.latest unchanged.
            expect(await raw.getRevision(blockA, 1), 'revision durable').to.equal(actionId);
            expect(await raw.getPendingTransaction(blockA, actionId), 'pending still present').to.not.equal(undefined);
            expect(await raw.getTransaction(blockA, actionId), 'not yet in committed log').to.equal(undefined);
            const metaBefore = await raw.getMetadata(blockA);
            expect(metaBefore?.latest, 'latest not updated').to.equal(undefined);
            // Recovery: retry-commit with same actionId+rev.
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            const retry = await repo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(retry.success, 'retry-commit succeeds').to.equal(true);
            const meta = await raw.getMetadata(blockA);
            expect(meta?.latest?.rev).to.equal(1);
            expect(meta?.latest?.actionId).to.equal(actionId);
            expect(await raw.getTransaction(blockA, actionId), 'action now in committed log').to.not.equal(undefined);
            expect(await raw.getPendingTransaction(blockA, actionId), 'pending promoted/removed').to.equal(undefined);
            const final = await repo.get({ blockIds: [blockA] });
            expect(final[blockA]?.block, 'block materialized and readable').to.not.equal(undefined);
            expect(final[blockA]?.state.latest?.rev).to.equal(1);
        });
    });
    // ------------------------------------------------------------------------
    // Crash-D3: pending promoted, saveMetadata(setLatest) throws before delegating
    //
    // With the MemoryRawStorage metadata-clone fix in place, this crash now matches
    // persistent-store semantics: saveMetadata never ran, so `meta.latest` is
    // unchanged in durable storage even though the pending was promoted and the
    // revision was saved. Recovery is surfaced as `StorageRepo.recoverBlock`, which
    // reconciles `meta.latest` with the highest contiguous fully-promoted revision.
    // ------------------------------------------------------------------------
    describe('Crash-D3: crash before setLatest (recoverBlock reconciles)', () => {
        const blockA = 'crash-d3-block';
        const actionId = 'action-crash-d3';
        const seedPending = async (raw) => {
            const pending = await rebuildCleanMesh(raw);
            await pending.nodes[0].storageRepo.pend({
                actionId,
                transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['d3'] }) }),
                policy: 'c'
            });
        };
        const crashTrigger = {
            method: 'saveMetadata',
            when: 'before',
            blockId: blockA,
            predicate: (args) => {
                const meta = args[1];
                return meta?.latest !== undefined;
            }
        };
        it('raw revision + committed action are durable; pending is removed', async () => {
            const raw = new MemoryRawStorage();
            await seedPending(raw);
            const { mesh, proxy } = await buildCrashingMesh(raw, crashTrigger);
            const result = await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(proxy.fired).to.equal(true);
            expect(result.success).to.equal(false);
            // Durable side-effects that DID complete.
            expect(await raw.getRevision(blockA, 1)).to.equal(actionId);
            expect(await raw.getTransaction(blockA, actionId), 'action promoted to committed log').to.not.equal(undefined);
            expect(await raw.getPendingTransaction(blockA, actionId), 'pending removed by promote').to.equal(undefined);
        });
        it('retry-commit fails without recovery (pending gone, latest still undefined)', async () => {
            const raw = new MemoryRawStorage();
            await seedPending(raw);
            const { mesh } = await buildCrashingMesh(raw, crashTrigger);
            await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            // With the metadata-clone fix, latest is still undefined on retry.
            // The idempotency short-circuit can't fire (latest is undefined), and the
            // pending-missing check throws — commit cannot recover on its own.
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            let err;
            try {
                await repo.commit({
                    actionId,
                    blockIds: [blockA],
                    tailId: blockA,
                    rev: 1
                });
            }
            catch (e) {
                err = e;
            }
            expect(err, 'retry-commit throws because the pending record is gone').to.be.instanceOf(Error);
            expect(err.message).to.include(`Pending action ${actionId} not found`);
        });
        it('crash before setLatest leaves latest unchanged in raw storage (no reference leak)', async () => {
            const raw = new MemoryRawStorage();
            await seedPending(raw);
            const { mesh } = await buildCrashingMesh(raw, crashTrigger);
            await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            // With MemoryRawStorage now cloning on get/save, the pre-crash
            // `meta.latest = latest` mutation no longer leaks into stored state.
            // On-disk picture matches a persistent backend.
            const meta = await raw.getMetadata(blockA);
            expect(meta?.latest, 'raw latest unchanged after saveMetadata crash').to.equal(undefined);
            // Consequence: a fresh default read sees empty state until recovery runs.
            const recovered = await rebuildCleanMesh(raw);
            const read = await recovered.nodes[0].storageRepo.get({ blockIds: [blockA] });
            expect(read[blockA]?.state, 'default read sees empty state pre-recovery').to.deep.equal({});
        });
        it('recoverBlock reconciles latest with max(revisions) and materializes the committed state', async () => {
            const raw = new MemoryRawStorage();
            await seedPending(raw);
            const { mesh, proxy } = await buildCrashingMesh(raw, crashTrigger);
            await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(proxy.fired).to.equal(true);
            // Pre-recovery durable invariants.
            const metaBefore = await raw.getMetadata(blockA);
            expect(metaBefore?.latest, 'pre-recovery: latest still undefined on durable storage').to.equal(undefined);
            expect(await raw.getRevision(blockA, 1), 'revision durable').to.equal(actionId);
            expect(await raw.getTransaction(blockA, actionId), 'action in committed log').to.not.equal(undefined);
            // Pre-recovery read: empty state.
            const recovered = await rebuildCleanMesh(raw);
            const repo = recovered.nodes[0].storageRepo;
            const preRead = await repo.get({ blockIds: [blockA] });
            expect(preRead[blockA]?.state, 'default read before recovery sees empty state').to.deep.equal({});
            // Run recovery.
            await repo.recoverBlock(blockA);
            // Post-recovery durable invariants.
            const metaAfter = await raw.getMetadata(blockA);
            expect(metaAfter?.latest?.rev, 'recoverBlock advanced latest').to.equal(1);
            expect(metaAfter?.latest?.actionId).to.equal(actionId);
            // Default read now materializes the committed block.
            const postRead = await repo.get({ blockIds: [blockA] });
            expect(postRead[blockA]?.state.latest?.rev).to.equal(1);
            expect(postRead[blockA]?.block, 'block materializes after recovery').to.not.equal(undefined);
        });
        it('recoverBlock on a block with no metadata is a safe no-op', async () => {
            const raw = new MemoryRawStorage();
            const mesh = await rebuildCleanMesh(raw);
            const repo = mesh.nodes[0].storageRepo;
            const unknownBlock = 'block-never-seen';
            // Must not throw.
            await repo.recoverBlock(unknownBlock);
            // Metadata remains absent.
            expect(await raw.getMetadata(unknownBlock)).to.equal(undefined);
        });
        it('recoverBlock does NOT advance past a Crash-D2-style state (revision durable, action not yet in committed log)', async () => {
            // Reproduce Crash-D2 raw state: revision saved, pending NOT promoted, latest unchanged.
            const raw = new MemoryRawStorage();
            const pending = await rebuildCleanMesh(raw);
            await pending.nodes[0].storageRepo.pend({
                actionId,
                transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['d2-gap'] }) }),
                policy: 'c'
            });
            const { mesh, proxy } = await buildCrashingMesh(raw, {
                method: 'promotePendingTransaction',
                when: 'before',
                blockId: blockA,
                actionId
            });
            await mesh.nodes[0].storageRepo.commit({
                actionId,
                blockIds: [blockA],
                tailId: blockA,
                rev: 1
            });
            expect(proxy.fired).to.equal(true);
            // Sanity: Crash-D2 raw shape.
            expect(await raw.getRevision(blockA, 1), 'revision durable').to.equal(actionId);
            expect(await raw.getPendingTransaction(blockA, actionId), 'pending still present').to.not.equal(undefined);
            expect(await raw.getTransaction(blockA, actionId), 'action NOT in committed log').to.equal(undefined);
            const metaBefore = await raw.getMetadata(blockA);
            expect(metaBefore?.latest, 'latest still undefined before recovery').to.equal(undefined);
            // Recovery must NOT advance past a revision whose action is not promoted —
            // retry-commit (the Crash-D2 path) is the canonical path for that state.
            const recovered = await rebuildCleanMesh(raw);
            await recovered.nodes[0].storageRepo.recoverBlock(blockA);
            const metaAfter = await raw.getMetadata(blockA);
            expect(metaAfter?.latest, 'recoverBlock left latest alone at Crash-D2 boundary').to.equal(undefined);
        });
    });
    // ------------------------------------------------------------------------
    // Crash during schema-block commit (Tree.createOrOpen + tree.replace)
    //
    // Drives the real DDL flow via NetworkTransactor. After a crash during the
    // commit phase, a fresh Tree.createOrOpen on the same id must either see a
    // coherent state or surface a clear error — not silently corrupt.
    // ------------------------------------------------------------------------
    describe('Crash during Tree DDL commit (schema-block scenario)', () => {
        const treeId = 'crash-schema-tree';
        it('crash before any saveRevision: Tree retries succeed post-recovery', async () => {
            const raw = new MemoryRawStorage();
            // Fault on the FIRST saveRevision — aborts commit before any block gets a revision.
            const { mesh } = await buildCrashingMesh(raw, {
                method: 'saveRevision',
                when: 'before'
            });
            const crashingTransactor = buildNetworkTransactor(mesh);
            let ddlErr;
            try {
                const tree = await Tree.createOrOpen(crashingTransactor, treeId, (entry) => entry.key);
                await tree.replace([[1, { key: 1, value: 'first' }]]);
            }
            catch (err) {
                ddlErr = err;
            }
            expect(ddlErr, 'DDL surfaces an error (not a silent success)').to.not.equal(undefined);
            // Recovery: fresh Tree on the same id must not silently corrupt — it should
            // either succeed (rolled-back or committed state) or surface a clear,
            // actionable error (NOT `non-existent chain`, per the dependency ticket).
            const recovered = await rebuildCleanMesh(raw);
            const recoveredTransactor = buildNetworkTransactor(recovered);
            let recoverErr;
            let finalValue;
            try {
                const tree2 = await Tree.createOrOpen(recoveredTransactor, treeId, (entry) => entry.key);
                await tree2.replace([[1, { key: 1, value: 'second' }]]);
                finalValue = await tree2.get(1);
            }
            catch (err) {
                recoverErr = err;
            }
            if (recoverErr) {
                const message = recoverErr.message ?? '';
                // Silent-corruption sentinels — any of these means the crash wedged the DB.
                expect(message).to.not.include('non-existent chain');
                expect(message).to.not.include('not found during restore attempt');
            }
            else {
                expect(finalValue).to.deep.equal({ key: 1, value: 'second' });
            }
        });
    });
});
//# sourceMappingURL=mid-ddl-crash.spec.js.map