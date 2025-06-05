import type { Scope } from '../authority/models';
import type {
	User,
	DefaultUser,
	CreateUserHistory,
	ReviseUserHistory,
	UserKey,
	UserHistory,
	DeviceAdvertisement,
} from './models';
import type { SID } from '../common';

export type IUserEngine = {
	addKey(key: UserKey): Promise<void>;
	connectDevice(): Promise<DeviceAdvertisement>;
	create(user: CreateUserHistory): Promise<void>;
	getHistory(userSid: SID, forward: boolean): AsyncIterable<UserHistory>;
	getSummary(): Promise<User | undefined>;
	isPrivileged(scope: Scope, sid: SID): Promise<boolean>;
	revise(user: ReviseUserHistory): Promise<void>;
	revokeKey(key: string): Promise<void>;
};

export type IDefaultUserEngine = {
	get(): Promise<DefaultUser | undefined>;
	set(user: DefaultUser): Promise<void>;
};
