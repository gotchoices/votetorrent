import type {
	CreateUserHistory,
	DeviceAdvertisement,
	IUserEngine,
	ReviseUserHistory,
	User,
	UserHistory,
	UserKey,
} from '@votetorrent/vote-core';

export class UserEngine implements IUserEngine {
	constructor(private readonly user: User) {}

	async addKey(key: UserKey): Promise<void> {
		throw new Error('Not implemented');
	}

	async connectDevice(): Promise<DeviceAdvertisement> {
		throw new Error('Not implemented');
	}

	async create(user: CreateUserHistory): Promise<void> {
		throw new Error('Not implemented');
	}

	async *getHistory(
		userId: string,
		forward: boolean
	): AsyncIterable<UserHistory> {
		throw new Error('Not implemented');
	}

	async getSummary(): Promise<User | undefined> {
		throw new Error('Not implemented');
	}

	async isPrivileged(): Promise<boolean> {
		throw new Error('Not implemented');
	}

	async revise(user: ReviseUserHistory): Promise<void> {
		throw new Error('Not implemented');
	}

	async revokeKey(key: string): Promise<void> {
		throw new Error('Not implemented');
	}
}
