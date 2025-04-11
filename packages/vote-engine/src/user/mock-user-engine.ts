import type {
	CreateUserHistory,
	IUserEngine,
	User,
	UserKey,
	UserHistory,
	DeviceAdvertisement,
	ReviseUserHistory,
	RevokeUserKeyHistory,
	AddUserKeyHistory,
} from '@votetorrent/vote-core';
import { UserHistoryEvent } from '@votetorrent/vote-core';

export class MockUserEngine implements IUserEngine {
	private mockUser: User = {
		sid: 'mock-user-sid',
		name: 'Mock User',
		image: { url: 'https://example.com/mock-image.jpg' },
		activeKeys: [],
	};

	private mockHistory: UserHistory[] = [];

	constructor(private readonly user: User) {}

	async create(user: CreateUserHistory): Promise<void> {
		this.mockUser = {
			sid: 'mock-user-sid',
			name: user.info.name,
			image: user.info.image,
			activeKeys: [user.userKey],
		};
		this.mockHistory.push(user);
	}

	async revise(user: ReviseUserHistory): Promise<void> {
		this.mockUser = {
			...this.mockUser,
			name: user.info.name,
			image: user.info.image,
		};
		this.mockHistory.push(user);
	}

	async revokeKey(key: string): Promise<void> {
		this.mockUser.activeKeys = this.mockUser.activeKeys.filter(
			(k) => k.key !== key
		);
		const history: RevokeUserKeyHistory = {
			event: UserHistoryEvent.revokeKey,
			timestamp: Date.now(),
			signature: { signature: 'mock-signature', signerKey: 'mock-key' },
			key,
		};
		this.mockHistory.push(history);
	}

	async addKey(key: UserKey): Promise<void> {
		this.mockUser.activeKeys.push(key);
		const history: AddUserKeyHistory = {
			event: UserHistoryEvent.addKey,
			timestamp: Date.now(),
			signature: { signature: 'mock-signature', signerKey: 'mock-key' },
			userKey: key,
		};
		this.mockHistory.push(history);
	}

	async get(networkSid: string): Promise<User | undefined> {
		return this.mockUser;
	}

	async *getHistory(
		userSid: string,
		forward: boolean
	): AsyncIterable<UserHistory> {
		const history = forward
			? this.mockHistory
			: [...this.mockHistory].reverse();
		for (const item of history) {
			yield item;
		}
	}

	async connectDevice(): Promise<DeviceAdvertisement> {
		return {
			multiAddress: '/ip4/127.0.0.1/tcp/1234',
			token: 'mock-device-token',
		};
	}
}
