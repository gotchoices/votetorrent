/**
 * Keeps only a few of the app's LevelDB databases open at once (notes 19 E76 memory finding).
 *
 * Quereus opens one LevelDB per table and per index (100+ for one network) and never closes them.
 * With LevelDB's default options each open database holds its own block cache (up to 8 MB) and
 * write buffer (up to 4 MB), which grew a rig Voter's native heap to ~800 MB
 * (the officer Authority was killed for memory at ~1.8 GB RSS). Same module as the Voter's
 * leveldb-open-pool.ts.
 *
 * `openFn` hands the LevelDB plugin a pooled database instead of the native one. A pooled database
 * looks open to its caller until the caller closes it, but its native handle is closed when it has
 * been idle for `idleCloseMs`, or when more than `maxOpen` are open (least recently used first), and
 * it is reopened on the next call. A database with an open iterator is never closed under it, so
 * `maxOpen` is a soft cap while many iterators are open at once.
 *
 * One name is one pooled database, however many callers open it (UAT 65 finding F4). rn-leveldb's own
 * wrapper hands a second open of a name that is already open the SAME native handle, and a close by any
 * holder frees it for all. Two quereus providers on one database name (a second rnDbFactory call for a
 * network) open every store twice. As two pooled databases, the pool closed the shared handle for one and
 * the other's next call or close hit the freed index (`leveldbClose/db-idx-out-of-bounds`), which failed a
 * schema migration half-way. Now each opener gets a lease on the one pooled database, and the native
 * handle is closed for good only when the last lease closes.
 *
 * This module never imports rn-leveldb; rn-db-factory hands it the native open function.
 */

export interface NativeLevelDBIterator {
	valid(): boolean;
	seek(target: ArrayBuffer | string): NativeLevelDBIterator;
	seekToFirst(): NativeLevelDBIterator;
	seekLast(): NativeLevelDBIterator;
	next(): void;
	prev(): void;
	keyBuf(): ArrayBuffer;
	valueBuf(): ArrayBuffer;
	close(): void;
}

export interface NativeLevelDB {
	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;
	getBuf(key: ArrayBuffer | string): ArrayBuffer | null;
	delete(key: ArrayBuffer | string): void;
	close(): void;
	newIterator(): NativeLevelDBIterator;
	write(batch: unknown): void;
}

export type NativeLevelDBOpenFn = (name: string, createIfMissing: boolean, errorIfExists: boolean) => NativeLevelDB;

export interface LevelDBOpenPoolOptions {
	/** most native databases open at once; default 16 */
	maxOpen?: number;
	/** close a native database unused for this long; default 30 s */
	idleCloseMs?: number;
	now?: () => number;
}

export interface LevelDBOpenPoolStats {
	/** pooled databases the caller has not closed */
	databases: number;
	/** of those, how many hold a native handle now */
	nativeOpen: number;
	/** native opens, counting the first open of each database */
	nativeOpens: number;
	/** native closes made by the pool (idle or over the cap) */
	poolCloses: number;
}

export const DEFAULT_MAX_OPEN = 16;
export const DEFAULT_IDLE_CLOSE_MS = 30_000;

export class LevelDBOpenPool {
	readonly maxOpen: number;
	readonly idleCloseMs: number;
	private readonly now: () => number;
	/** databases holding a native handle, least recently used first */
	private readonly lru = new Set<PooledLevelDB>();
	/** the one pooled database per name, while any lease on it is open */
	private readonly byName = new Map<string, PooledLevelDB>();
	private databases = 0;
	private nativeOpens = 0;
	private poolCloses = 0;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: LevelDBOpenPoolOptions = {}) {
		this.maxOpen = Math.max(1, options.maxOpen ?? DEFAULT_MAX_OPEN);
		this.idleCloseMs = Math.max(1, options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS);
		this.now = options.now ?? Date.now;
	}

	/**
	 * An open function for the LevelDB plugin whose databases this pool manages. A name that is already
	 * open is shared, like rn-leveldb shares its native handle: the caller gets a lease on the same
	 * pooled database, and errorIfExists does not apply (rn-leveldb does not check it for a shared name).
	 */
	openFn(nativeOpen: NativeLevelDBOpenFn): NativeLevelDBOpenFn {
		return (name, createIfMissing, errorIfExists) => {
			const shared = this.byName.get(name);
			if (shared !== undefined) {
				return shared.lease();
			}
			const db = new PooledLevelDB(this, nativeOpen, name, createIfMissing, errorIfExists);
			this.byName.set(name, db);
			return db.lease();
		};
	}

	stats(): LevelDBOpenPoolStats {
		return {
			databases: this.databases,
			nativeOpen: this.lru.size,
			nativeOpens: this.nativeOpens,
			poolCloses: this.poolCloses,
		};
	}

	/** Close every native handle idle for `idleCloseMs` that has no open iterator. */
	sweep(): void {
		const cutoff = this.now() - this.idleCloseMs;
		for (const db of [...this.lru]) {
			if (db.lastUsedAt <= cutoff) {
				this.closeNative(db);
			}
		}
		this.syncTimer();
	}

	/** @internal */
	opened(db: PooledLevelDB, first: boolean): void {
		this.nativeOpens++;
		if (first) {
			this.databases++;
		}
		this.used(db);
	}

	/** @internal before a native open: close the least recently used so the open stays within the cap */
	makeRoom(): void {
		this.shrinkTo(this.maxOpen - 1, null);
	}

	/** @internal mark `db` most recently used, then close the least recently used over the cap */
	used(db: PooledLevelDB): void {
		db.lastUsedAt = this.now();
		this.lru.delete(db);
		this.lru.add(db);
		this.shrinkTo(this.maxOpen, db);
		this.syncTimer();
	}

	/** @internal the last lease on `db` closed */
	released(db: PooledLevelDB): void {
		this.lru.delete(db);
		if (this.byName.get(db.name) === db) {
			this.byName.delete(db.name);
		}
		this.databases--;
		this.syncTimer();
	}

	private shrinkTo(limit: number, keep: PooledLevelDB | null): void {
		if (this.lru.size <= limit) {
			return;
		}
		for (const victim of [...this.lru]) {
			if (this.lru.size <= limit) {
				break;
			}
			if (victim !== keep) {
				this.closeNative(victim);
			}
		}
	}

	private closeNative(db: PooledLevelDB): void {
		if (db.closeNative()) {
			this.lru.delete(db);
			this.poolCloses++;
		}
	}

	/** run the idle sweep only while some native handle is open */
	private syncTimer(): void {
		if (this.lru.size > 0 && this.sweepTimer === null) {
			this.sweepTimer = setInterval(() => this.sweep(), this.idleCloseMs);
		} else if (this.lru.size === 0 && this.sweepTimer !== null) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}
}

class PooledLevelDB implements NativeLevelDB {
	lastUsedAt = 0;
	private handle: NativeLevelDB | null;
	private openIterators = 0;
	private closedByCaller = false;
	private leases = 0;

	constructor(
		private readonly pool: LevelDBOpenPool,
		private readonly nativeOpen: NativeLevelDBOpenFn,
		readonly name: string,
		private readonly createIfMissing: boolean,
		errorIfExists: boolean,
	) {
		// The first open runs now, so a bad name or a locked database still fails at open.
		pool.makeRoom();
		this.handle = nativeOpen(name, createIfMissing, errorIfExists);
		pool.opened(this, true);
	}

	/** One opener's view of this database: its own close, and calls refused after that close. */
	lease(): NativeLevelDB {
		this.leases++;
		let open = true;
		const live = (): PooledLevelDB => {
			if (!open) {
				throw new Error(`LevelDB ${this.name} is closed`);
			}
			return this;
		};
		return {
			put: (key, value) => live().put(key, value),
			getBuf: (key) => live().getBuf(key),
			delete: (key) => live().delete(key),
			write: (batch) => live().write(batch),
			newIterator: () => live().newIterator(),
			close: () => {
				if (!open) {
					return;
				}
				open = false;
				this.leases--;
				if (this.leases === 0) {
					this.close();
				}
			},
		};
	}

	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void {
		this.native().put(key, value);
	}

	getBuf(key: ArrayBuffer | string): ArrayBuffer | null {
		return this.native().getBuf(key);
	}

	delete(key: ArrayBuffer | string): void {
		this.native().delete(key);
	}

	write(batch: unknown): void {
		this.native().write(batch);
	}

	newIterator(): NativeLevelDBIterator {
		const iterator = this.native().newIterator();
		this.openIterators++;
		let open = true;
		const release = (): void => {
			if (open) {
				open = false;
				this.openIterators--;
				this.pool.used(this);
			}
		};
		const pooled: NativeLevelDBIterator = {
			valid: () => iterator.valid(),
			seek: (target) => {
				iterator.seek(target);
				return pooled;
			},
			seekToFirst: () => {
				iterator.seekToFirst();
				return pooled;
			},
			seekLast: () => {
				iterator.seekLast();
				return pooled;
			},
			next: () => iterator.next(),
			prev: () => iterator.prev(),
			keyBuf: () => iterator.keyBuf(),
			valueBuf: () => iterator.valueBuf(),
			close: () => {
				try {
					iterator.close();
				} finally {
					release();
				}
			},
		};
		return pooled;
	}

	/** The last lease closed: close the native handle for good and leave the pool. */
	close(): void {
		if (this.closedByCaller) {
			return;
		}
		this.closedByCaller = true;
		const handle = this.handle;
		this.handle = null;
		this.pool.released(this);
		handle?.close();
	}

	/** @internal close the native handle unless an iterator is open; true when it closed */
	closeNative(): boolean {
		if (this.handle === null || this.openIterators > 0) {
			return false;
		}
		const handle = this.handle;
		this.handle = null;
		handle.close();
		return true;
	}

	private native(): NativeLevelDB {
		if (this.closedByCaller) {
			throw new Error(`LevelDB ${this.name} is closed`);
		}
		if (this.handle === null) {
			// It exists now; errorIfExists only ever applies to the first open.
			this.pool.makeRoom();
			this.handle = this.nativeOpen(this.name, this.createIfMissing, false);
			this.pool.opened(this, false);
		} else {
			this.pool.used(this);
		}
		return this.handle;
	}
}

/** The one pool each app process shares across all its networks' databases. */
export const leveldbOpenPool = new LevelDBOpenPool();
