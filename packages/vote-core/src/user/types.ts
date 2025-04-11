import type { User, DefaultUser, CreateUserHistory, ReviseUserHistory, UserKey, UserHistory, DeviceAdvertisement } from './struct';

export type IUserEngine = {
	create(user: CreateUserHistory): Promise<void>;
	revise(user: ReviseUserHistory): Promise<void>;
	revokeKey(key: string): Promise<void>;
	addKey(key: UserKey): Promise<void>;
	get(networkSid: string): Promise<User | undefined>;
	getHistory(userSid: string, forward: boolean): AsyncIterable<UserHistory>;
	connectDevice(): Promise<DeviceAdvertisement>;
};

export type IDefaultUserEngine = {
	set(user: DefaultUser): Promise<void>;
	get(): Promise<DefaultUser | undefined>;
};
