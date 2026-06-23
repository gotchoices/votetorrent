import { Log, Atomic, Tracker, copyTransforms, CacheSource, isTransformsEmpty, TransactorSource } from "../index.js";
import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { Latches } from "../utility/latches.js";
const PendingRetryDelayMs = 100;
export class Collection {
    id;
    transactor;
    handlers;
    source;
    sourceCache;
    tracker;
    filterConflict;
    pending = [];
    latchId;
    constructor(id, transactor, handlers, source, 
    /** Cache of unmodified blocks from the source */
    sourceCache, 
    /** Tracked Changes */
    tracker, filterConflict) {
        this.id = id;
        this.transactor = transactor;
        this.handlers = handlers;
        this.source = source;
        this.sourceCache = sourceCache;
        this.tracker = tracker;
        this.filterConflict = filterConflict;
        this.latchId = `Collection:${this.id}`;
    }
    static async createOrOpen(transactor, id, init) {
        // Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
        const source = new TransactorSource(id, transactor, undefined);
        const sourceCache = new CacheSource(source);
        const tracker = new Tracker(sourceCache);
        const header = await source.tryGet(id);
        if (header) { // Collection already exists
            // Bootstrap ActionContext from the committed tail before walking the chain.
            // This allows the transactor to serve pending non-tail blocks during Log.open.
            await Collection.bootstrapContext(source, transactor, header);
            const log = (await Log.open(tracker, id));
            source.actionContext = await log.getActionContext();
        }
        else { // Collection does not exist
            const headerBlock = init.createHeaderBlock(id, tracker);
            tracker.insert(headerBlock);
            source.actionContext = undefined;
            await Log.open(tracker, id);
        }
        return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict);
    }
    async act(...actions) {
        const release = await Latches.acquire(this.latchId);
        try {
            await this.actInternal(...actions);
        }
        finally {
            release();
        }
    }
    async actInternal(...actions) {
        await this.internalTransact(...actions);
        this.pending.push(...actions);
    }
    async internalTransact(...actions) {
        const atomic = new Atomic(this.tracker);
        for (const action of actions) {
            const handler = this.handlers[action.type];
            if (!handler) {
                throw new Error(`No handler for action type ${action.type}`);
            }
            await handler(action, atomic);
        }
        atomic.commit();
    }
    /** Load external changes and update our context to the latest log revision - resolve any conflicts with our pending actions. */
    async update() {
        const release = await Latches.acquire(this.latchId);
        try {
            await this.updateInternal();
        }
        finally {
            release();
        }
    }
    async updateInternal() {
        // Start with a context that can see to the end of the log
        const source = new TransactorSource(this.id, this.transactor, undefined);
        const tracker = new Tracker(source);
        // Bootstrap context from committed tail so pending blocks are accessible.
        // Read through tracker so Chain.open inside Log.open reuses the cached header.
        const header = await tracker.tryGet(this.id);
        if (header) {
            await Collection.bootstrapContext(source, this.transactor, header);
        }
        // Get the latest entries from the log, starting from where we left off
        const actionContext = this.source.actionContext;
        const log = await Log.open(tracker, this.id);
        const latest = log ? await log.getFrom(actionContext?.rev ?? 0) : undefined;
        // Process the entries and track the blocks they affect
        let anyConflicts = false;
        for (const entry of latest?.entries ?? []) {
            // Filter any pending actions that conflict with the remote actions
            this.pending = this.pending.map(p => this.doFilterConflict(p, entry.actions) ? p : undefined)
                .filter(Boolean);
            this.sourceCache.clear(entry.blockIds);
            anyConflicts = anyConflicts || this.tracker.conflicts(new Set(entry.blockIds)).length > 0;
        }
        // On conflicts, clear related caching and block-tracking and replay logical operations
        if (anyConflicts) {
            await this.replayActions();
        }
        // Update our context to the latest
        this.source.actionContext = latest?.context;
    }
    /** Push our pending actions to the transactor */
    async sync() {
        const release = await Latches.acquire(this.latchId);
        try {
            await this.syncInternal();
        }
        finally {
            release();
        }
    }
    async syncInternal() {
        const bytes = randomBytes(16);
        const actionId = uint8ArrayToString(bytes, 'base64url');
        while (this.pending.length || !isTransformsEmpty(this.tracker.transforms)) {
            // Snapshot the pending actions so that any new actions aren't assumed to be part of this action
            const pending = [...this.pending];
            // Create a snapshot tracker for the action, so that we can ditch the log changes if we have to retry the action
            const snapshot = copyTransforms(this.tracker.transforms);
            const tracker = new Tracker(this.sourceCache, snapshot);
            // Add the action to the log (in local tracking space)
            const log = await Log.open(tracker, this.id);
            if (!log) {
                throw new Error(`Log not found for collection ${this.id}`);
            }
            const newRev = (this.source.actionContext?.rev ?? 0) + 1;
            const addResult = await log.addActions(pending, actionId, newRev, () => tracker.transformedBlockIds());
            // Commit the action to the transactor
            const staleFailure = await this.source.transact(tracker.transforms, actionId, newRev, this.id, addResult.tailPath.block.header.id);
            if (staleFailure) {
                if (staleFailure.pending) {
                    // Wait for short time to allow the pending actions to commit (bounded backoff)
                    await new Promise(resolve => setTimeout(resolve, PendingRetryDelayMs));
                }
                // Fetch latest state - updateInternal() will call replayActions() if there are conflicts
                await this.updateInternal();
            }
            else {
                // Clear the pending actions that were part of this action
                this.pending = this.pending.slice(pending.length);
                // Reset cache and replay any actions that were added during the action
                const transforms = tracker.reset();
                await this.replayActions();
                this.sourceCache.transformCache(transforms);
                this.source.actionContext = this.source.actionContext
                    ? { committed: [...this.source.actionContext.committed, { actionId, rev: newRev }], rev: newRev }
                    : { committed: [{ actionId, rev: newRev }], rev: newRev };
            }
        }
    }
    async updateAndSync() {
        const release = await Latches.acquire(this.latchId);
        try {
            await this.updateInternal();
            await this.syncInternal();
        }
        finally {
            release();
        }
    }
    async *selectLog(forward = true) {
        const log = await Log.open(this.tracker, this.id);
        if (!log) {
            throw new Error(`Log not found for collection ${this.id}`);
        }
        for await (const entry of log.select(undefined, forward)) {
            if (entry.action) {
                yield* forward ? entry.action.actions : entry.action.actions.reverse();
            }
        }
    }
    async replayActions() {
        this.tracker.reset();
        // Replay pending actions against the fresh tracker state (always called under latch)
        for (const action of this.pending) {
            await this.internalTransact(action);
        }
    }
    getReadDependencies() {
        return this.source.getReadDependencies();
    }
    clearReadDependencies() {
        this.source.clearReadDependencies();
    }
    /** Called for each local action that may be in conflict with a remote action (always called under latch).
     * @param action - The local action to check
     * @param potential - The remote action that is potentially in conflict
     * @returns true if the action should be kept, false to discard it
     */
    doFilterConflict(action, potential) {
        if (this.filterConflict) {
            const replacement = this.filterConflict(action, potential);
            if (!replacement) {
                return false;
            }
            else if (replacement !== action) {
                // Queue replacement - it will be applied in replayActions()
                this.pending.push(replacement);
            }
        }
        return true;
    }
    /** Bootstrap ActionContext from the committed tail block's state.
     * The tail is always committed first (commit protocol guarantee), so it's readable
     * with context=undefined. Its state.latest contains the ActionRev of the most recent
     * committed action — exactly the proof needed for the transactor to serve pending
     * non-tail blocks during chain walks.
     */
    static async bootstrapContext(source, transactor, header) {
        const tailId = header.tailId;
        if (tailId) {
            const tailResult = await transactor.get({ blockIds: [tailId] });
            const tailState = tailResult?.[tailId]?.state;
            if (tailState?.latest) {
                source.actionContext = {
                    committed: [{ actionId: tailState.latest.actionId, rev: tailState.latest.rev }],
                    rev: tailState.latest.rev,
                };
            }
        }
    }
}
//# sourceMappingURL=collection.js.map