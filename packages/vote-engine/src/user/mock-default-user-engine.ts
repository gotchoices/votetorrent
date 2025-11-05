import type { DefaultUser, IDefaultUserEngine } from '@votetorrent/vote-core';
import { MOCK_DEFAULT_USER } from '../mock-data.js';

export class MockDefaultUserEngine implements IDefaultUserEngine {
	private mockDefaultUser: DefaultUser = MOCK_DEFAULT_USER;

	async get(): Promise<DefaultUser | undefined> {
		return this.mockDefaultUser;
	}

	async set(user: DefaultUser): Promise<void> {
		this.mockDefaultUser = user;
	}
}
