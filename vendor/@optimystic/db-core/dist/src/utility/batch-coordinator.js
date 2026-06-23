import { Pending } from "./pending.js";
import { createLogger } from "../logger.js";
const log = createLogger('batch-coordinator');
/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 */
export function makeBatchesByPeer(blockPeers, payload, getBlockPayload, excludedPeers) {
    const groups = blockPeers.reduce((acc, [blockId, peerId]) => {
        const peerId_str = peerId.toString();
        const coordinator = acc.get(peerId_str) ?? { peerId, blockId, excludedPeers };
        acc.set(peerId_str, { ...coordinator, payload: getBlockPayload(payload, blockId, coordinator.payload) });
        return acc;
    }, new Map());
    return Array.from(groups.values());
}
/**
 * Iterates over all batches that have not completed, whether subsumed or not
 */
export function* incompleteBatches(batches) {
    const stack = [...batches];
    while (stack.length > 0) {
        const batch = stack.pop();
        if (!batch.request || !batch.request.isResponse) {
            yield batch;
        }
        if (batch.subsumedBy && batch.subsumedBy.length) {
            stack.push(...batch.subsumedBy);
        }
    }
}
/**
 * Checks if all completed batches (ignoring failures) satisfy a predicate
 */
export function everyBatch(batches, predicate) {
    // For each root batch require that SOME node in its retry tree satisfies the predicate.
    // Use iterative DFS to avoid recursion depth and minimize allocations.
    for (const root of batches) {
        let found = false;
        const stack = [root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (predicate(node)) {
                found = true;
                break;
            }
            if (node.subsumedBy && node.subsumedBy.length) {
                for (let i = 0; i < node.subsumedBy.length; i++)
                    stack.push(node.subsumedBy[i]);
            }
        }
        if (!found)
            return false;
    }
    return true;
}
/**
 * Iterates over all batches that satisfy an optional predicate, whether subsumed or not
 */
export function* allBatches(batches, predicate) {
    const stack = [...batches];
    while (stack.length > 0) {
        const batch = stack.pop();
        if (!predicate || predicate(batch)) {
            yield batch;
        }
        if (batch.subsumedBy && batch.subsumedBy.length) {
            stack.push(...batch.subsumedBy);
        }
    }
}
/**
 * Returns a new blockId list payload with the given block id appended
 */
export function mergeBlocks(_payload, blockId, mergeWithPayload) {
    return [...(mergeWithPayload ?? []), blockId];
}
/**
 * Processes a set of batches, retrying any failures until success or expiration
 * @param batches - The batches to process - each represents a group of blocks centered on a coordinating peer
 * @param process - The function to call for a given batch
 * @param getBlockIds - The function to call to get the block ids for a given batch
 * @param getBlockPayload - The function to call to get the payload given a parent payload and block id, and optionally merge with an existing payload
 * @param expiration - The expiration time for the operation
 * @param findCoordinator - The function to call to find a coordinator for a block id
 */
export async function processBatches(batches, process, getBlockIds, getBlockPayload, expiration, findCoordinator) {
    // Root-map ensures retries are recorded on the original batch to avoid deep trees
    const rootOf = new WeakMap();
    for (const b of batches)
        rootOf.set(b, b);
    // Process a set of batches concurrently and enqueue retries flatly onto the root's subsumedBy list
    const processSet = async (set) => {
        await Promise.all(set.map(async (batch) => {
            batch.request = new Pending(process(batch)
                .catch(async (e) => {
                // Always rethrow the ORIGINAL first-attempt error `e` so batch.request.error
                // preserves the root cause. If retry setup itself fails (e.g., findCoordinator
                // throws "self-exhausted" on a solo node), that retry error MUST NOT mask `e`.
                if (expiration > Date.now()) {
                    const excludedPeers = [batch.peerId, ...(batch.excludedPeers ?? [])];
                    log('retry peer=%s excluded=%d', batch.peerId.toString(), excludedPeers.length);
                    try {
                        const retries = await createBatchesForPayload(getBlockIds(batch), batch.payload, getBlockPayload, excludedPeers, findCoordinator);
                        if (retries.length > 0 && expiration > Date.now()) {
                            const root = rootOf.get(batch) ?? batch;
                            root.subsumedBy = [...(root.subsumedBy ?? []), ...retries];
                            for (const r of retries)
                                rootOf.set(r, root);
                            // Process retries, but ensure further failures also attach to the same root
                            await processSet(retries);
                        }
                    }
                    catch (retryErr) {
                        log('retry:setup-failed peer=%s original=%o retry=%o', batch.peerId.toString(), e, retryErr);
                        // Swallow retryErr; the original `e` is authoritative.
                    }
                }
                throw e;
            }));
        }));
        // Wait for all in this set to settle
        await Promise.all(set.map(b => b.request?.result().catch(() => { })));
    };
    await processSet(batches);
}
/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 * This is a placeholder function that will be implemented by the caller
 */
export async function createBatchesForPayload(blockIds, payload, getBlockPayload, excludedPeers, findCoordinator) {
    // Group by block id
    const distinctBlockIds = new Set(blockIds);
    // Find coordinator for each key
    const blockIdPeerId = await Promise.all(Array.from(distinctBlockIds).map(async (bid) => [bid, await findCoordinator(bid, { excludedPeers })]));
    // Group blocks around their coordinating peers
    const batches = makeBatchesByPeer(blockIdPeerId, payload, getBlockPayload, excludedPeers);
    log('createBatches blockIds=%d batches=%d excluded=%d', distinctBlockIds.size, batches.length, excludedPeers.length);
    return batches;
}
//# sourceMappingURL=batch-coordinator.js.map