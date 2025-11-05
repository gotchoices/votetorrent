import type {
	CreateUserHistory,
	DeviceAdvertisement,
	IUserEngine,
	ReviseUserHistory,
	Scope,
	SID,
	User,
	UserHistory,
	UserKey,
} from '@votetorrent/vote-core';
import type { EngineContext } from '../types.js';

export class UserEngine implements IUserEngine {
	constructor(private readonly ctx: EngineContext) {}

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
		userSid: string,
		forward: boolean
	): AsyncIterable<UserHistory> {
		throw new Error('Not implemented');
	}

	async getSummary(): Promise<User | undefined> {
		throw new Error('Not implemented');
	}

	/**
	 * Check if a user has a specific privilege scope
	 *
	 * @param scope - The scope to check (e.g., 'rad', 'vrg', 'mel')
	 * @param userSid - The user's SID to check privileges for
	 * @returns True if the user has the specified scope in any active administration
	 *
	 * @remarks
	 * This method queries the Officer table to check if the user is an administrator
	 * with the specified scope in any currently effective administration.
	 *
	 * The query checks:
	 * 1. User is an officer in the current administration (via CurrentAdmin view)
	 * 2. User's scopes JSON array contains the requested scope
	 */
	async isPrivileged(scope: Scope, userSid: SID): Promise<boolean> {
		try {
			// Query to check if user has the specified scope in any current administration
			const stmt = this.ctx.db.prepare(`
				SELECT 1
				FROM Officer O
				JOIN CurrentAdmin CA ON CA.AuthoritySid = O.AuthoritySid
					AND CA.EffectiveAt = O.AdminEffectiveAt
				WHERE O.UserSid = ?
					AND EXISTS (
						SELECT 1
						FROM json_array_elements_text(O.Scopes) AS S(scope)
						WHERE S.scope = ?
					)
				LIMIT 1
			`);

			// Execute query with parameters
			const rows: any[] = [];
			for await (const row of stmt.all({ 1: userSid, 2: scope })) {
				rows.push(row);
			}

			// If we got any rows back, the user has the privilege
			return rows.length > 0;
		} catch (error) {
			// Log error and return false for safety
			console.error(`Error checking privileges for user ${userSid} and scope ${scope}:`, error);
			return false;
		}
	}

	async revise(user: ReviseUserHistory): Promise<void> {
		throw new Error('Not implemented');
	}

	async revokeKey(key: string): Promise<void> {
		throw new Error('Not implemented');
	}
}
