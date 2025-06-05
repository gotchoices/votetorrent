export type LocalStorage = {
  getItem<TValue>(key: string): Promise<TValue | undefined>;
  setItem<TValue>(key: string, value: TValue): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
};
