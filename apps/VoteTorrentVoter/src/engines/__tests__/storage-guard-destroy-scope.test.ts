/**
 * Spike 105: destroyScope closes the cached LevelDB for ONE scope before destroying it (rn-leveldb
 * refuses to destroy an open DB), and the next provider(scope) call opens it afresh. Other scopes
 * are untouched.
 */
const mockCloses: string[] = [];
jest.mock('@optimystic/db-p2p-storage-rn', () => ({
	openOptimysticRNDb: ({ name }: { name: string }) => ({ name, close: async () => { mockCloses.push(name); } }),
	LevelDBRawStorage: class MockRawStorage { mockDb: unknown; constructor (mockDb: unknown) { this.mockDb = mockDb } },
}), { virtual: true });

import { LevelDB } from 'rn-leveldb';
import { createScopedRnStorageProvider } from '../storage-guard';

describe('createScopedRnStorageProvider().destroyScope', () => {
	const destroyDB = jest.fn();
	beforeAll(() => { (LevelDB as unknown as { destroyDB: jest.Mock }).destroyDB = destroyDB; });
	beforeEach(() => { mockCloses.length = 0; destroyDB.mockReset(); });

	it('closes the open control DB, then destroys exactly that one store', async () => {
		const provider = createScopedRnStorageProvider('vt-test');
		try { provider('control-766f7465746f7272656e74'); provider('strand-abc'); } catch { /* the persistence guard may refuse the fake; the cache is what matters */ }
		await provider.destroyScope('control-766f7465746f7272656e74');
		expect(mockCloses).toEqual(['vt-test-control-766f7465746f7272656e74']);
		expect(destroyDB).toHaveBeenCalledTimes(1);
		expect(destroyDB).toHaveBeenCalledWith('vt-test-control-766f7465746f7272656e74', true);
	});

	it('destroys a scope that was never opened in this process without closing anything', async () => {
		const provider = createScopedRnStorageProvider('vt-test');
		await provider.destroyScope('control-766f7465746f7272656e74');
		expect(mockCloses).toEqual([]);
		expect(destroyDB).toHaveBeenCalledWith('vt-test-control-766f7465746f7272656e74', true);
	});
});
