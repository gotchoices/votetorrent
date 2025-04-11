import type { IDefaultUserEngine, User } from '@votetorrent/vote-core';

export class DefaultUserEngine implements IDefaultUserEngine {
	async set(user: User): Promise<void> {
		throw new Error('Not implemented');
	}
	async get(): Promise<User | undefined> {
		throw new Error('Not implemented');
	}
}
