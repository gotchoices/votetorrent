/**
 * Jest manual mock for rn-leveldb (app-layer Jest environment).
 *
 * rn-leveldb is a native TurboModule binding (JSI). Its real entry point calls
 * `NativeModules.Leveldb.install()` at module load time; under Jest's default RN mock
 * (no native module autolinked) that surface doesn't exist, so tests must not depend on
 * real LevelDB behavior. This mock provides the same class surface
 * (LevelDB/LevelDBIterator/LevelDBWriteBatch) as an in-memory stub — sufficient for any
 * test that only needs the module to resolve and construct without opening a real store.
 *
 * Production behavior: the real native rn-leveldb binding is used at Metro/RN runtime —
 * this mock is Jest-only.
 */

class LevelDBIterator {
	seekToFirst() {}
	seekToLast() {}
	seek() {}
	valid() {
		return false;
	}
	next() {}
	prev() {}
	key() {
		return null;
	}
	value() {
		return null;
	}
	close() {}
}

class LevelDBWriteBatch {
	put() {}
	delete() {}
}

class LevelDB {
	constructor() {
		this._store = new Map();
	}
	get(key) {
		return this._store.has(key) ? this._store.get(key) : null;
	}
	put(key, value) {
		this._store.set(key, value);
	}
	delete(key) {
		this._store.delete(key);
	}
	write(_batch) {}
	newIterator() {
		return new LevelDBIterator();
	}
	close() {}
	destroy() {}
}

module.exports = {
	LevelDB,
	LevelDBIterator,
	LevelDBWriteBatch,
};
