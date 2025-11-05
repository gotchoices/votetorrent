/**
 * Tests for authorization system (isPrivileged)
 *
 * These tests verify that the authorization system correctly checks user privileges
 * based on their Officer roles and scopes in active administrations.
 */

import { expect } from 'aegir/chai';
import { Database } from '@quereus/quereus';
import { CUSTOM_FUNCTIONS } from '../src/database/custom-functions.js';
import { UserEngine } from '../src/user/user-engine.js';
import type { EngineContext } from '../src/types.js';
import type { User } from '@votetorrent/vote-core';
import {
	generatePrivateKey,
	getPublicKey,
	signMessage,
	hashMessage,
} from '../src/common/crypto-utils.js';

/**
 * Helper to collect async iterable results into an array
 */
async function collectRows<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const results: T[] = [];
	for await (const row of iterable) {
		results.push(row);
	}
	return results;
}

// TODO: Fix Quereus memory table persistence issue causing test failures
// These tests work individually but fail when run together with custom-functions.spec.ts
// because views/tables persist across test suites
describe.skip('Authorization System', () => {
	let db: Database;
	let ctx: EngineContext;
	let userEngine: UserEngine;

	// Test data
	const authoritySid = 'authority-test-1';
	const userSid1 = 'user-test-1';
	const userSid2 = 'user-test-2';
	const userSid3 = 'user-test-3';

	beforeEach(async () => {
		// Create fresh database
		db = new Database();

		// Register custom functions
		const mainSchema = db.schemaManager.getMainSchema();
		for (const funcDef of CUSTOM_FUNCTIONS) {
			mainSchema.addFunction(funcDef);
		}

		// Create test schema
		await db.exec(`
			-- Create Scope view
			CREATE VIEW Scope AS SELECT * FROM (VALUES
				('rn', 'Revise Network'),
				('rad', 'Revise or replace the Admin'),
				('vrg', 'Validate registrations'),
				('iad', 'Invite other Authorities'),
				('uai', 'Update Authority Information'),
				('ceb', 'Create/Edit ballot templates'),
				('mel', 'Manage Elections'),
				('cap', 'Configure Authority Peers')
			) AS Scope(Code, Name);

			-- Create simplified User table
			CREATE TABLE User (
				Sid TEXT PRIMARY KEY
			);

			-- Create simplified Authority table
			CREATE TABLE Authority (
				Sid TEXT PRIMARY KEY
			);

			-- Create Admin table
			CREATE TABLE Admin (
				AuthoritySid TEXT,
				EffectiveAt TEXT,
				ThresholdPolicies TEXT DEFAULT '[]',
				PRIMARY KEY (AuthoritySid, EffectiveAt)
			);

			-- Create CurrentAdmin view
			CREATE VIEW CurrentAdmin AS
				SELECT AuthoritySid, MAX(EffectiveAt) AS EffectiveAt
				FROM Admin
				WHERE EffectiveAt <= datetime('now')
				GROUP BY AuthoritySid;

			-- Create Officer table
			CREATE TABLE Officer (
				AuthoritySid TEXT,
				AdminEffectiveAt TEXT,
				UserSid TEXT,
				Title TEXT,
				Scopes TEXT DEFAULT '[]',
				PRIMARY KEY (AuthoritySid, AdminEffectiveAt, UserSid)
			);
		`);

		// Insert test data
		await db.exec(`
			-- Insert users
			INSERT INTO User (Sid) VALUES
				('${userSid1}'),
				('${userSid2}'),
				('${userSid3}');

			-- Insert authority
			INSERT INTO Authority (Sid) VALUES ('${authoritySid}');

			-- Insert current admin (effective yesterday)
			INSERT INTO Admin (AuthoritySid, EffectiveAt, ThresholdPolicies)
			VALUES (
				'${authoritySid}',
				datetime('now', '-1 day'),
				'[]'
			);

			-- Insert officers with different scopes
			-- User 1: Has 'rad' and 'mel' scopes
			INSERT INTO Officer (AuthoritySid, AdminEffectiveAt, UserSid, Title, Scopes)
			VALUES (
				'${authoritySid}',
				datetime('now', '-1 day'),
				'${userSid1}',
				'Chief Administrator',
				'["rad", "mel"]'
			);

			-- User 2: Has 'vrg' scope only
			INSERT INTO Officer (AuthoritySid, AdminEffectiveAt, UserSid, Title, Scopes)
			VALUES (
				'${authoritySid}',
				datetime('now', '-1 day'),
				'${userSid2}',
				'Registration Validator',
				'["vrg"]'
			);

			-- User 3: Not an officer at all
		`);

		// Create engine context
		const mockUser: User = {
			sid: userSid1,
			name: 'Test User',
			image: {},
			activeKeys: [],
		};

		ctx = {
			db,
			config: {
				invitationSpanMinutes: 60,
			},
			user: mockUser,
		};

		userEngine = new UserEngine(ctx);
	});

	afterEach(async () => {
		await db.close();
	});

	describe('isPrivileged()', () => {
		it('should return true when user has the requested scope', async () => {
			const isPrivileged = await userEngine.isPrivileged('rad', userSid1);
			expect(isPrivileged).to.be.true;
		});

		it('should return true for multiple scopes a user has', async () => {
			const hasRad = await userEngine.isPrivileged('rad', userSid1);
			const hasMel = await userEngine.isPrivileged('mel', userSid1);

			expect(hasRad).to.be.true;
			expect(hasMel).to.be.true;
		});

		it('should return false when user does not have the requested scope', async () => {
			// User 1 has 'rad' and 'mel' but not 'vrg'
			const isPrivileged = await userEngine.isPrivileged('vrg', userSid1);
			expect(isPrivileged).to.be.false;
		});

		it('should return true when checking different user with different scope', async () => {
			// User 2 has 'vrg' scope
			const isPrivileged = await userEngine.isPrivileged('vrg', userSid2);
			expect(isPrivileged).to.be.true;
		});

		it('should return false for user who is not an officer', async () => {
			// User 3 is not an officer
			const isPrivileged = await userEngine.isPrivileged('rad', userSid3);
			expect(isPrivileged).to.be.false;
		});

		it('should return false for non-existent scope', async () => {
			// @ts-expect-error Testing invalid scope
			const isPrivileged = await userEngine.isPrivileged('invalid', userSid1);
			expect(isPrivileged).to.be.false;
		});

		it('should return false for non-existent user', async () => {
			const isPrivileged = await userEngine.isPrivileged('rad', 'non-existent-user');
			expect(isPrivileged).to.be.false;
		});

		it('should only check privileges in current administration', async () => {
			// Insert a future administration where user1 loses 'rad' scope
			await db.exec(`
				INSERT INTO Admin (AuthoritySid, EffectiveAt, ThresholdPolicies)
				VALUES (
					'${authoritySid}',
					datetime('now', '+1 day'),
					'[]'
				);

				INSERT INTO Officer (AuthoritySid, AdminEffectiveAt, UserSid, Title, Scopes)
				VALUES (
					'${authoritySid}',
					datetime('now', '+1 day'),
					'${userSid1}',
					'Chief Administrator',
					'["mel"]'
				);
			`);

			// User should still have 'rad' because current admin is yesterday's
			const hasRad = await userEngine.isPrivileged('rad', userSid1);
			expect(hasRad).to.be.true;
		});

		it('should handle officers in past administrations correctly', async () => {
			// Insert an old administration
			await db.exec(`
				INSERT INTO Admin (AuthoritySid, EffectiveAt, ThresholdPolicies)
				VALUES (
					'${authoritySid}',
					datetime('now', '-10 days'),
					'[]'
				);

				INSERT INTO Officer (AuthoritySid, AdminEffectiveAt, UserSid, Title, Scopes)
				VALUES (
					'${authoritySid}',
					datetime('now', '-10 days'),
					'${userSid3}',
					'Former Officer',
					'["rad"]'
				);
			`);

			// User 3 should NOT have privileges because they're in an old admin
			const isPrivileged = await userEngine.isPrivileged('rad', userSid3);
			expect(isPrivileged).to.be.false;
		});

		it('should handle empty scopes array', async () => {
			// Insert officer with no scopes
			await db.exec(`
				INSERT INTO User (Sid) VALUES ('user-no-scopes');

				INSERT INTO Officer (AuthoritySid, AdminEffectiveAt, UserSid, Title, Scopes)
				VALUES (
					'${authoritySid}',
					datetime('now', '-1 day'),
					'user-no-scopes',
					'No Privileges Officer',
					'[]'
				);
			`);

			const isPrivileged = await userEngine.isPrivileged('rad', 'user-no-scopes');
			expect(isPrivileged).to.be.false;
		});
	});
});
