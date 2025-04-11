import type {
	CreateUserHistory,
	IUserEngine,
	User,
	UserKey,
	UserHistory,
	DeviceAdvertisement,
	ReviseUserHistory,
} from '@votetorrent/vote-core';

export class UserEngine implements IUserEngine {
	constructor(private readonly user: User) {}

	async create(user: CreateUserHistory): Promise<void> {
		throw new Error('Not implemented');
	}

	async revise(user: ReviseUserHistory): Promise<void> {
		throw new Error('Not implemented');
	}

	async revokeKey(key: string): Promise<void> {
		throw new Error('Not implemented');
	}

	async addKey(key: UserKey): Promise<void> {
		throw new Error('Not implemented');
	}

	async get(networkSid: string): Promise<User | undefined> {
		throw new Error('Not implemented');
	}

	async *getHistory(
		userSid: string,
		forward: boolean
	): AsyncIterable<UserHistory> {
		throw new Error('Not implemented');
	}

	async connectDevice(): Promise<DeviceAdvertisement> {
		throw new Error('Not implemented');
	}
}
