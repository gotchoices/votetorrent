export interface AsyncStorageType {
  getItem<T>(key: string): Promise<T | undefined>
  setItem<T>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
}

const memoryStore = new Map<string, string>()

export const AsyncStorage: AsyncStorageType = {
  async getItem<T>(key: string): Promise<T | undefined> {
    return memoryStore.has(key)
      ? (JSON.parse(memoryStore.get(key) ?? 'undefined') as T)
      : undefined
  },
  async setItem<T>(key: string, value: T): Promise<void> {
    memoryStore.set(key, JSON.stringify(value))
  },
  async removeItem (key: string): Promise<void> {
    memoryStore.delete(key)
  },
  async clear (): Promise<void> {
    memoryStore.clear()
  }
}
