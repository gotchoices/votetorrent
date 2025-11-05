import type {
	AddUserKeyHistory,
	CreateUserHistory,
	DeviceAdvertisement,
	IUserEngine,
	ReviseUserHistory,
	RevokeUserKeyHistory,
	Scope,
	User,
	UserHistory,
	UserKey,
} from '@votetorrent/vote-core';
import { UserHistoryEvent } from '@votetorrent/vote-core';
import {
	MOCK_CURRENT_USER,
	MOCK_USER_HISTORY_EVENTS,
	generateId, // For new user IDs if needed
} from '../mock-data.js';

export class MockUserEngine implements IUserEngine {
	// Store local copies of the mock data to allow for modification within an instance
	private mockUser: User;
	private mockHistory: UserHistory[];

	constructor() {
		// Deep copy to prevent modifying the constants in mock-data.ts
		this.mockUser = JSON.parse(JSON.stringify(MOCK_CURRENT_USER));
		this.mockHistory = JSON.parse(JSON.stringify(MOCK_USER_HISTORY_EVENTS));
	}

	async addKey(key: UserKey): Promise<void> {
		this.mockUser = {
			...this.mockUser,
			activeKeys: [...this.mockUser.activeKeys, key],
		};
		const historyEntry: AddUserKeyHistory = {
			event: UserHistoryEvent.addKey,
			timestamp: Date.now(), // Use current time for new history
			signature: {
				signature: 'mock-signature-1',
				signerKey: this.mockUser.activeKeys[0]?.key || 'mock-signer-key-1',
			}, // Sign with an existing key or mock
			userKey: key,
		};
		this.mockHistory = [...this.mockHistory, historyEntry];
	}

	async connectDevice(): Promise<DeviceAdvertisement> {
		return {
			multiAddress: '/ip4/127.0.0.1/tcp/1234', // Static mock response
			token: 'mock-device-token-1',
		};
	}

	async create(userInit: CreateUserHistory): Promise<void> {
		// This method re-initializes the user for this engine instance
		this.mockUser = {
			id: generateId('user'), // Generate a new ID for the created user
			name: userInit.name,
			image: userInit.image,
			activeKeys: [userInit.userKey],
		};
		// The userInit itself is a history event, add it to this instance's history
		this.mockHistory = [userInit, ...this.mockHistory]; // Prepend create event or adjust as needed
		// Or, if create replaces all history for the new user:
		// this.mockHistory = [userInit];
	}

	async *getHistory(
		userId: string, // Potentially use this if engine could manage multiple users, but currently manages one
		forward: boolean
	): AsyncIterable<UserHistory> {
		// Ensure userId matches, though this mock engine instance only has one user's history.
		if (userId !== this.mockUser.id) {
			console.warn(
				`MockUserEngine: getHistory called for ID ${userId}, but current user is ${this.mockUser.id}. Returning history for current user.`
			);
			// Or throw new Error(`User ID ${userId} does not match current mock user.`);
		}
		const historyToIterate = forward
			? this.mockHistory
			: [...this.mockHistory].reverse();
		for (const item of historyToIterate) {
			yield item;
		}
	}

	async getSummary(): Promise<User | undefined> {
		return this.mockUser;
	}

	async isPrivileged(scope: Scope, userId: string): Promise<boolean> {
		// Simple mock, always returns true
		return true;
	}

	async revise(userRevise: ReviseUserHistory): Promise<void> {
		this.mockUser = {
			...this.mockUser,
			name: userRevise.info.name,
			image: userRevise.info.image,
		};
		this.mockHistory = [...this.mockHistory, userRevise];
	}

	async revokeKey(keyToRevoke: string): Promise<void> {
		const newActiveKeys = this.mockUser.activeKeys.filter(
			(k) => k.key !== keyToRevoke
		);
		this.mockUser = {
			...this.mockUser,
			activeKeys: newActiveKeys,
		};
		const historyEntry: RevokeUserKeyHistory = {
			event: UserHistoryEvent.revokeKey,
			timestamp: Date.now(),
			signature: {
				signature: 'mock-signature-1',
				signerKey: newActiveKeys[0]?.key || 'mock-signer-key-1',
			}, // Sign with a remaining key or user ID
			key: keyToRevoke,
		};
		this.mockHistory = [...this.mockHistory, historyEntry];
	}
}
