import type { LocalStorage } from "@votetorrent/vote-core";
import AsyncStorage from "@react-native-async-storage/async-storage";

export class LocalStorageReact implements LocalStorage {
	async getItem<T>(key: string): Promise<T | undefined> {
		const value = await AsyncStorage.getItem(key);
		return value ? JSON.parse(value) as T : undefined;
	}

	async setItem<T>(key: string, value: T): Promise<void> {
		await AsyncStorage.setItem(key, JSON.stringify(value));
	}

	async removeItem(key: string): Promise<void> {
		await AsyncStorage.removeItem(key);
	}

	async clear(): Promise<void> {
		await AsyncStorage.clear();
	}
}
