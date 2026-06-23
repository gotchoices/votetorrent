import { sha256 } from 'multiformats/hashes/sha2';
import { Chain, entryAt } from "../index.js";
import { nameof } from "../utility/nameof.js";
import { LogDataBlockType, LogHeaderBlockType } from "./index.js";
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
export const priorHash$ = nameof("priorHash");
export class Log {
    chain;
    constructor(chain) {
        this.chain = chain;
    }
    get id() {
        return this.chain.id;
    }
    /** Opens a presumably existing log. */
    static async open(store, id) {
        const chain = await Chain.open(store, id, Log.getChainOptions(store));
        return chain ? new Log(chain) : undefined;
    }
    /** Creates a new log. */
    static async create(store, options) {
        return new Log(await Chain.create(store, {
            ...Log.getChainOptions(store),
            newId: options?.newId,
            existingHeaderId: options?.existingHeaderId,
        }));
    }
    /** Adds a new entry to the log. */
    async addActions(actions, actionId, rev, getBlockIds, collectionIds = [], timestamp = Date.now()) {
        const entry = { timestamp, rev, action: { actionId, actions, blockIds: [], collectionIds } };
        const tailPath = await this.chain.add(entry);
        const entryWithBlockIds = { ...entry, action: { ...entry.action, blockIds: getBlockIds() } };
        this.chain.updateAt(tailPath, entryWithBlockIds);
        return { entry: entryWithBlockIds, tailPath };
    }
    /** Adds a checkpoint to the log. */
    async addCheckpoint(pendings, rev, timestamp = Date.now()) {
        const entry = { timestamp, rev, checkpoint: { pendings } };
        const tailPath = await this.chain.add(entry);
        return { entry, tailPath };
    }
    /** Gets the action context of the log. */
    async getActionContext() {
        const tailPath = await this.chain.getTail();
        if (!tailPath || tailPath.block.entries.length === 0) {
            return undefined;
        }
        const checkpoint = await this.findCheckpoint(tailPath);
        // Hermes V1 codegen bug: `[...arr, ...await asyncCall()]` evaluated as an
        // object-literal field value silently produces the number 0 instead of an
        // array. Extracting the await into a local variable bypasses the buggy
        // codegen path. Keep this workaround until Hermes V1 ships a fix.
        const additional = checkpoint ? await this.pendingFrom(checkpoint.path) : [];
        return {
            committed: checkpoint ? [...checkpoint.pendings, ...additional] : [],
            rev: checkpoint?.rev ?? 0,
        };
    }
    /** Gets the actions from startRev (exclusive), to latest in the log. */
    async getFrom(startRev) {
        const entries = [];
        const pendings = [];
        let rev;
        let checkpointPath;
        // Step through collecting both pending and entries until a checkpoint is found
        for await (const path of this.chain.select(undefined, false)) {
            const entry = entryAt(path);
            rev = rev ?? entry.rev;
            if (entry.checkpoint) {
                checkpointPath = path;
                pendings.unshift(...entry.checkpoint.pendings);
                break;
            }
            pendings.unshift({ actionId: entry.action.actionId, rev: entry.rev });
            if (startRev !== undefined && entry.rev > startRev) {
                entries.unshift(entry.action);
            } // Can't stop at rev, because we need to collect all pending actions for the context
        }
        // Continue stepping past the checkpoint until the given rev is reached
        if (checkpointPath) {
            for await (const path of this.chain.select(checkpointPath, false)) {
                const entry = entryAt(path);
                if (startRev !== undefined && entry.rev > startRev) {
                    if (entry.action) {
                        entries.unshift(entry.action);
                    }
                }
                else {
                    break;
                }
            }
        }
        return { context: rev ? { committed: pendings, rev } : undefined, entries };
    }
    /** Enumerates log entries from the given starting path or end if undefined, in forward (from tail to head) or reverse (from head to tail) order. */
    async *select(starting, forward = true) {
        for await (const path of this.chain.select(starting, forward)) {
            yield entryAt(path);
        }
    }
    /** Returns the set of pending transactions in the most recent checkpoint, at or preceding the given path. */
    async findCheckpoint(starting) {
        let lastPath;
        let rev;
        for await (const path of this.chain.select(starting, false)) {
            const entry = entryAt(path);
            rev = rev ?? entry.rev;
            if (entry.checkpoint) {
                return { path, pendings: entry.checkpoint.pendings, rev };
            }
            lastPath = path;
        }
        return lastPath ? { path: lastPath, pendings: [], rev } : undefined;
    }
    /** Returns the set of pending actions following, the given checkpoint path. */
    async pendingFrom(starting) {
        const pendings = [];
        for await (const actionPath of this.chain.select(starting)) {
            const entry = entryAt(actionPath);
            if (entry?.action) {
                pendings.push({ actionId: entry.action.actionId, rev: entry.rev });
            }
        }
        return pendings;
    }
    static getChainOptions(store) {
        return {
            createDataBlock: () => ({ header: store.createBlockHeader(LogDataBlockType) }),
            createHeaderBlock: (id) => ({ header: store.createBlockHeader(LogHeaderBlockType, id) }),
            newBlock: async (newTail, oldTail) => {
                if (oldTail) {
                    const hash = await sha256.digest(new TextEncoder().encode(JSON.stringify(oldTail)));
                    newTail.priorHash = uint8ArrayToString(hash.digest, 'base64url');
                }
            },
        };
    }
}
//# sourceMappingURL=log.js.map