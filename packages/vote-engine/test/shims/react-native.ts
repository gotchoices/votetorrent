export type AsyncStorageType = {
	getItem: <T>(key: string) => Promise<T | undefined>;
	setItem: <T>(key: string, value: T) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
	clear: () => Promise<void>;
};

const memoryStore: Map<string, string> = new Map();

export const AsyncStorage: AsyncStorageType = {
	async getItem<T>(key: string): Promise<T | undefined> {
		return memoryStore.has(key)
			? (JSON.parse(memoryStore.get(key)!) as T)
			: undefined;
	},
	async setItem<T>(key: string, value: T): Promise<void> {
		memoryStore.set(key, JSON.stringify(value));
	},
	async removeItem(key: string): Promise<void> {
		memoryStore.delete(key);
	},
	async clear(): Promise<void> {
		memoryStore.clear();
	},
};
