import { ClassicLevel } from 'classic-level';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Test-only `LevelDBLike` driver backed by `classic-level`, the Node-native
 * LevelDB binding maintained by the Level team. Production code uses
 * `openOptimysticRNDb` (which wraps `rn-leveldb`); this driver lets the same
 * storage classes run under Mocha without the React Native native module.
 *
 * Each `openTestDb()` returns an isolated, file-backed database in a fresh
 * temp directory; the matching `cleanup()` closes the handle and removes the
 * directory. File-backed (not in-memory) so we can also exercise the
 * close + reopen path that the identity helper relies on.
 */
class ClassicLevelAdapter {
    db;
    constructor(db) {
        this.db = db;
    }
    async get(key) {
        const value = await this.db.get(key);
        return value === undefined ? undefined : new Uint8Array(value);
    }
    async put(key, value) {
        await this.db.put(key, value);
    }
    async delete(key) {
        await this.db.del(key);
    }
    batch() {
        const chain = this.db.batch();
        return {
            put(key, value) {
                chain.put(key, value);
                return this;
            },
            delete(key) {
                chain.del(key);
                return this;
            },
            async write() {
                await chain.write();
            },
        };
    }
    iterator(options = {}) {
        // classic-level natively supports gte/gt/lte/lt/reverse/limit/keys/values
        // — pass through, but request `view` encoding so we get back Uint8Array
        // rather than Buffer/string.
        const iter = this.db.iterator({
            ...(options.gte !== undefined && { gte: options.gte }),
            ...(options.gt !== undefined && { gt: options.gt }),
            ...(options.lte !== undefined && { lte: options.lte }),
            ...(options.lt !== undefined && { lt: options.lt }),
            ...(options.reverse && { reverse: true }),
            ...(options.limit !== undefined && { limit: options.limit }),
            keyEncoding: 'view',
            valueEncoding: 'view',
            ...(options.keys && { values: false }),
        });
        let closed = false;
        return {
            async next() {
                if (closed)
                    return undefined;
                const entry = await iter.next();
                if (entry === undefined)
                    return undefined;
                const [k, v] = entry;
                return [new Uint8Array(k), v ? new Uint8Array(v) : new Uint8Array(0)];
            },
            async close() {
                if (closed)
                    return;
                closed = true;
                await iter.close();
            },
        };
    }
    async close() {
        await this.db.close();
    }
}
/**
 * Open a fresh file-backed `LevelDBLike` database in an isolated temp directory.
 * Returns a `cleanup()` function so the spec can release the handle and remove
 * the directory in `afterEach`.
 */
export async function openTestDb() {
    const dir = mkdtempSync(join(tmpdir(), 'optimystic-rn-leveldb-'));
    const db = new ClassicLevel(dir, { keyEncoding: 'view', valueEncoding: 'view' });
    await db.open();
    const adapter = new ClassicLevelAdapter(db);
    return {
        db: adapter,
        path: dir,
        cleanup: async () => {
            try {
                await adapter.close();
            }
            catch {
                // Already closed by test — fine.
            }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
/**
 * Open a file-backed `LevelDBLike` at a caller-controlled path. Used by tests
 * that close and reopen the same database (identity persistence). Caller is
 * responsible for cleanup.
 */
export async function openAtPath(path) {
    const db = new ClassicLevel(path, { keyEncoding: 'view', valueEncoding: 'view' });
    await db.open();
    return new ClassicLevelAdapter(db);
}
//# sourceMappingURL=classic-level-driver.js.map