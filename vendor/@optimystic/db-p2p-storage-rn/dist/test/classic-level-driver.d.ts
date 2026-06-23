import type { LevelDBLike } from '../src/leveldb-like.js';
export interface TestDbHandle {
    db: LevelDBLike;
    path: string;
    cleanup(): Promise<void>;
}
/**
 * Open a fresh file-backed `LevelDBLike` database in an isolated temp directory.
 * Returns a `cleanup()` function so the spec can release the handle and remove
 * the directory in `afterEach`.
 */
export declare function openTestDb(): Promise<TestDbHandle>;
/**
 * Open a file-backed `LevelDBLike` at a caller-controlled path. Used by tests
 * that close and reopen the same database (identity persistence). Caller is
 * responsible for cleanup.
 */
export declare function openAtPath(path: string): Promise<LevelDBLike>;
//# sourceMappingURL=classic-level-driver.d.ts.map