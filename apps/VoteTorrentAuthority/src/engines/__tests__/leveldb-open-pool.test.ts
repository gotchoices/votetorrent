/**
 * leveldb-open-pool: the app keeps at most `maxOpen` native LevelDB databases open, closes idle
 * ones, and reopens them on demand without the caller noticing (notes 19 E76 memory finding).
 *
 * The fake native LevelDB below keeps data across a close (like the files on disk), refuses a
 * second open of a name that is already open (LevelDB's LOCK), and refuses a close while an
 * iterator is open, so a pool that closed a database under a reader fails here.
 */
import { Database } from '@quereus/quereus';
import { createIsolatedStoreModule } from '@quereus/store';
import { ReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
import { LevelDBOpenPool, type NativeLevelDB, type NativeLevelDBIterator } from '../leveldb-open-pool';

const hex = (b: ArrayBuffer): string => Buffer.from(new Uint8Array(b)).toString('hex');
const unhex = (h: string): ArrayBuffer => {
	const bytes = Uint8Array.from(Buffer.from(h, 'hex'));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const key = (s: string): ArrayBuffer => unhex(Buffer.from(s).toString('hex'));
const text = (b: ArrayBuffer | null): string | null => (b === null ? null : Buffer.from(new Uint8Array(b)).toString());

class FakeWriteBatch {
	ops: Array<[string, ArrayBuffer | null]> = [];
	put(k: ArrayBuffer, v: ArrayBuffer): void {
		this.ops.push([hex(k), v]);
	}
	delete(k: ArrayBuffer): void {
		this.ops.push([hex(k), null]);
	}
	close(): void {}
}

/** In-memory LevelDB "disk"; lowercase hex keys sort in the same order as their bytes. */
class FakeDisk {
	readonly files = new Map<string, Map<string, ArrayBuffer>>();
	readonly open = new Set<string>();
	opens = 0;
	maxOpenSeen = 0;

	openFn = (name: string, createIfMissing: boolean, errorIfExists: boolean): NativeLevelDB => {
		if (this.open.has(name)) {
			throw new Error(`IO error: lock ${name}/LOCK: already held by process`);
		}
		const exists = this.files.has(name);
		if (!exists && !createIfMissing) {
			throw new Error(`Invalid argument: ${name} does not exist`);
		}
		if (exists && errorIfExists) {
			throw new Error(`Invalid argument: ${name} exists`);
		}
		if (!exists) {
			this.files.set(name, new Map());
		}
		this.open.add(name);
		this.opens++;
		this.maxOpenSeen = Math.max(this.maxOpenSeen, this.open.size);
		return this.handle(name);
	};

	private handle(name: string): NativeLevelDB {
		const data = this.files.get(name)!;
		let closed = false;
		let iterators = 0;
		const live = (): void => {
			if (closed) {
				throw new Error(`${name}: native handle used after close`);
			}
		};
		return {
			put: (k, v) => {
				live();
				data.set(hex(k as ArrayBuffer), v as ArrayBuffer);
			},
			getBuf: (k) => {
				live();
				return data.get(hex(k as ArrayBuffer)) ?? null;
			},
			delete: (k) => {
				live();
				data.delete(hex(k as ArrayBuffer));
			},
			write: (batch) => {
				live();
				for (const [k, v] of (batch as FakeWriteBatch).ops) {
					if (v === null) {
						data.delete(k);
					} else {
						data.set(k, v);
					}
				}
			},
			close: () => {
				live();
				if (iterators > 0) {
					throw new Error(`${name}: closed with ${iterators} open iterator(s)`);
				}
				closed = true;
				this.open.delete(name);
			},
			newIterator: () => {
				live();
				iterators++;
				// A LevelDB iterator reads a snapshot taken when it was made.
				const entries = [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
				let at = -1;
				const it: NativeLevelDBIterator = {
					valid: () => at >= 0 && at < entries.length,
					seek: (target) => {
						const t = hex(target as ArrayBuffer);
						at = entries.findIndex(([k]) => k >= t);
						if (at < 0) {
							at = entries.length;
						}
						return it;
					},
					seekToFirst: () => {
						at = 0;
						return it;
					},
					seekLast: () => {
						at = entries.length - 1;
						return it;
					},
					next: () => {
						at++;
					},
					prev: () => {
						at--;
					},
					keyBuf: () => unhex(entries[at][0]),
					valueBuf: () => entries[at][1],
					close: () => {
						iterators--;
					},
				};
				return it;
			},
		};
	}
}

/**
 * rn-leveldb's own JS wrapper (3.11.1): a second open of a name that is already open returns the SAME native
 * handle (no LOCK error), and a close by any holder frees it for all of them. A close through a freed handle
 * throws, as the real `leveldbClose/db-idx-out-of-bounds` does.
 */
const rnLevelDBSharing = (disk: FakeDisk) => {
	const open = new Map<string, NativeLevelDB>();
	return (name: string, createIfMissing: boolean, errorIfExists: boolean): NativeLevelDB => {
		const held = open.get(name);
		if (held) {
			return held;
		}
		const native = disk.openFn(name, createIfMissing, errorIfExists);
		const shared: NativeLevelDB = {
			...native,
			close: () => {
				if (open.get(name) === shared) {
					open.delete(name);
				}
				native.close();
			},
		};
		open.set(name, shared);
		return shared;
	};
};

describe('LevelDBOpenPool', () => {
	let disk: FakeDisk;
	let clock: number;
	let pool: LevelDBOpenPool;
	const now = (): number => clock;

	beforeEach(() => {
		jest.useFakeTimers();
		disk = new FakeDisk();
		clock = 0;
	});
	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('LP-1: keeps at most maxOpen native databases open, and every database still reads and writes', () => {
		pool = new LevelDBOpenPool({ maxOpen: 3, idleCloseMs: 60_000, now });
		const open = pool.openFn(disk.openFn);
		const dbs = Array.from({ length: 10 }, (_, i) => open(`db${i}`, true, false));
		dbs.forEach((db, i) => db.put(key('k'), key(`v${i}`)));
		dbs.forEach((db, i) => expect(text(db.getBuf(key('k'))!)).toBe(`v${i}`));

		expect(disk.maxOpenSeen).toBe(3);
		expect(pool.stats()).toEqual({ databases: 10, nativeOpen: 3, nativeOpens: 30, poolCloses: 27 });
	});

	it('LP-2: closes a database idle for idleCloseMs and reopens it on the next call', () => {
		pool = new LevelDBOpenPool({ maxOpen: 8, idleCloseMs: 1_000, now });
		const open = pool.openFn(disk.openFn);
		const a = open('a', true, false);
		const b = open('b', true, false);
		a.put(key('x'), key('1'));
		clock = 600;
		b.put(key('y'), key('2'));

		clock = 1_000;
		jest.advanceTimersByTime(1_000);
		expect([...disk.open]).toEqual(['b']);

		expect(text(a.getBuf(key('x')))).toBe('1');
		expect([...disk.open].sort()).toEqual(['a', 'b']);

		clock = 5_000;
		jest.advanceTimersByTime(1_000);
		expect(disk.open.size).toBe(0);
		expect(pool.stats().nativeOpen).toBe(0);
	});

	it('LP-3: never closes a database under an open iterator, and closes it once the iterator closes', () => {
		pool = new LevelDBOpenPool({ maxOpen: 1, idleCloseMs: 1_000, now });
		const open = pool.openFn(disk.openFn);
		const a = open('a', true, false);
		a.put(key('k1'), key('1'));
		a.put(key('k2'), key('2'));
		const it = a.newIterator().seekToFirst();

		const b = open('b', true, false);
		b.put(key('k'), key('b'));
		clock = 10_000;
		jest.advanceTimersByTime(1_000);
		expect(disk.open.has('a')).toBe(true);

		const seen: Array<string | null> = [];
		for (; it.valid(); it.next()) {
			seen.push(text(it.keyBuf()));
		}
		it.close();
		it.close();
		expect(seen).toEqual(['k1', 'k2']);

		b.getBuf(key('k'));
		expect([...disk.open]).toEqual(['b']);
	});

	it('LP-4: a reopen never passes errorIfExists, and the first open still reports open errors', () => {
		pool = new LevelDBOpenPool({ maxOpen: 1, idleCloseMs: 1_000, now });
		const open = pool.openFn(disk.openFn);
		const a = open('a', true, true);
		open('b', true, false);
		expect(text((a.put(key('k'), key('v')), a.getBuf(key('k'))))).toBe('v');
		expect(() => open('missing', false, false)).toThrow('does not exist');
		expect(pool.stats().databases).toBe(2);
	});

	it('LP-5: a database the caller closed stays closed and leaves the pool', () => {
		pool = new LevelDBOpenPool({ maxOpen: 1, idleCloseMs: 1_000, now });
		const open = pool.openFn(disk.openFn);
		const a = open('a', true, false);
		open('b', true, false);
		a.close();
		a.close();
		expect(() => a.getBuf(key('k'))).toThrow('LevelDB a is closed');
		expect(pool.stats()).toMatchObject({ databases: 1, nativeOpen: 1 });
	});

	it('LP-7: two openers of one name share one native handle, and the pool never frees it under the other (F4)', () => {
		// Two providers on one database name (a second rnDbFactory call) open every store twice, and rn-leveldb
		// gives both the same native handle. Before the fix, the pool closed it for one opener (over the cap or
		// idle) and the other's next call or close hit the freed handle (leveldbClose/db-idx-out-of-bounds).
		// Both twins open at once: a cap of 2 lets them share; a third database pushes the least recently used out.
		pool = new LevelDBOpenPool({ maxOpen: 2, idleCloseMs: 1_000, now });
		const open = pool.openFn(rnLevelDBSharing(disk));
		const a1 = open('a', true, false);
		const a2 = open('a', true, false);
		a2.put(key('k'), key('1'));
		a1.put(key('k2'), key('2'));
		open('b', true, false).put(key('k'), key('b'));
		expect(text(a2.getBuf(key('k')))).toBe('1');
		expect(text(a1.getBuf(key('k2')))).toBe('2');

		// the idle sweep closes everything idle, twins included, without touching a freed handle
		clock = 5_000;
		jest.advanceTimersByTime(1_000);
		expect(disk.open.size).toBe(0);

		a1.close();
		a1.close();
		expect(() => a1.getBuf(key('k'))).toThrow('LevelDB a is closed');
		expect(text(a2.getBuf(key('k')))).toBe('1');
		expect(disk.open.has('a')).toBe(true);

		a2.close();
		expect(disk.open.has('a')).toBe(false);
		expect(pool.stats()).toMatchObject({ databases: 1 });
	});

	it('LP-6: a quereus database over the pooled plugin gives the same answers with only 2 databases open', async () => {
		jest.useRealTimers();
		pool = new LevelDBOpenPool({ maxOpen: 2, idleCloseMs: 1_000, now });
		const nativeBatch = FakeWriteBatch as unknown as ConstructorParameters<typeof ReactNativeLevelDBProvider>[0]['WriteBatch'];
		const provider = new ReactNativeLevelDBProvider({
			openFn: pool.openFn(disk.openFn),
			WriteBatch: nativeBatch,
			databaseName: 'lp6',
			createIfMissing: true,
		});
		const db = new Database();
		db.registerModule('store', createIsolatedStoreModule({ provider }));
		db.setDefaultVtabName('store');

		const tables = ['a', 'b', 'c', 'd'];
		for (const t of tables) {
			await db.exec(`create table ${t} (id integer primary key, grp text not null, n integer not null)`);
			await db.exec(`create index ${t}_grp on ${t} (grp)`);
		}
		for (let i = 1; i <= 30; i++) {
			for (const t of tables) {
				await db.exec(`insert into ${t} (id, grp, n) values (${i}, '${i % 3 === 0 ? 'x' : 'y'}', ${i})`);
			}
		}
		await db.exec(`update b set n = n * 10 where grp = 'x'`);
		await db.exec(`delete from c where id > 20`);
		clock = 50_000;
		pool.sweep();

		const rows: Array<Record<string, unknown>> = [];
		for await (const row of db.eval(
			`select a.grp as grp, count(*) as cnt, sum(b.n) as sb, sum(d.n) as sd
			   from a join b on b.id = a.id join d on d.id = a.id left join c on c.id = a.id
			  where c.id is not null group by a.grp order by a.grp`,
		)) {
			rows.push(row);
		}

		expect(rows).toEqual([
			{ grp: 'x', cnt: 6, sb: 630, sd: 63 },
			{ grp: 'y', cnt: 14, sb: 147, sd: 147 },
		]);
		expect(disk.files.size).toBeGreaterThan(8);
		expect(disk.maxOpenSeen).toBeLessThanOrEqual(2);
		expect(pool.stats().poolCloses).toBeGreaterThan(0);
		clock += 10_000;
		pool.sweep();
		expect(pool.stats().nativeOpen).toBe(0);
		await db.close();
	});
});
