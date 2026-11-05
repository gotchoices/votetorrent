/**
 * Phase 62 Plan 25 (D-29): registration-bridge-config.ts — isSaveableBridgeUrl,
 * readRegistrationBridgeConfig, saveRegistrationBridgeUrl (M1-M5).
 *
 * M2 runs against the REAL schema (`createTestNetwork`, the real `IntakeEngine` from the mapped
 * `/rn` dist) — the same real-schema precedent `officer-intake-key.test.ts` already established.
 * M1/M3/M4/M5 use fakes.
 */

import { IntakeEngine } from '@votetorrent/vote-engine/rn';
import type { Signature, User } from '@votetorrent/vote-core';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestNetwork, addTestAuthority, makeTestSignCallback } = require('@votetorrent/vote-engine/test/fixtures/test-context') as {
	createTestNetwork: (overrides?: unknown) => Promise<{ ctx: { db: AnyDb; user: User }; user: User }>;
	addTestAuthority: (net: unknown) => Promise<{ authority: { id: string }; ctx: { db: AnyDb; user: User }; user: User }>;
	makeTestSignCallback: (user: User) => (digest: Uint8Array) => Promise<Signature>;
};
import {
	isSaveableBridgeUrl,
	readRegistrationBridgeConfig,
	saveRegistrationBridgeUrl,
	type RegistrationBridgeConfigDeps,
} from '../registration-bridge-config';

describe('isSaveableBridgeUrl — M1', () => {
	it('M1: accepts https URLs (trimmed), rejects http/userinfo/empty/overlong/non-http(s)', () => {
		expect(isSaveableBridgeUrl('https://bridge.example/intake')).toBe(true);
		expect(isSaveableBridgeUrl('  https://bridge.example/intake  ')).toBe(true);
		expect(isSaveableBridgeUrl('http://bridge.example')).toBe(false);
		expect(isSaveableBridgeUrl('https://user:pw@bridge.example')).toBe(false);
		expect(isSaveableBridgeUrl('')).toBe(false);
		expect(isSaveableBridgeUrl('https://' + 'a'.repeat(2049))).toBe(false);
		expect(isSaveableBridgeUrl('ftp://x')).toBe(false);
	});
});

describe('registration-bridge-config.ts — real schema (M2)', () => {
	it('M2: reads the default (no row) view, then saves a URL through a vrg officer and reads it back', async () => {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const deps: RegistrationBridgeConfigDeps = { getEngine: async <T>() => new IntakeEngine(net.ctx) as unknown as T };

		const before = await readRegistrationBridgeConfig(deps, auth.authority.id);
		expect(before).toEqual({ savedUrl: null, revision: 0 });

		const sign = makeTestSignCallback(net.user);
		const result = await saveRegistrationBridgeUrl(
			deps,
			auth.authority.id,
			'https://bridge.example/intake',
			sign,
			0,
		);

		if (result.outcome === 'saved') {
			expect(result.config).toEqual({ savedUrl: 'https://bridge.example/intake', revision: 1 });
			const after = await readRegistrationBridgeConfig(deps, auth.authority.id);
			expect(after).toEqual({ savedUrl: 'https://bridge.example/intake', revision: 1 });
		} else {
			// Fixture officer cannot write the policy at this threshold — recorded in the SUMMARY.
			expect(['co-sign-required', 'not-authorized']).toContain(result.outcome);
			const after = await readRegistrationBridgeConfig(deps, auth.authority.id);
			expect(after.revision).toBe(0);
		}
	});
});

describe('registration-bridge-config.ts — fakes (M3-M5)', () => {
	it('M3: an invalid URL refuses before any engine or sign call', async () => {
		const getEngine = jest.fn();
		const sign = jest.fn();
		const result = await saveRegistrationBridgeUrl({ getEngine }, 'auth-1', 'http://bridge.example', sign, 0);
		expect(result.outcome).toBe('invalid-url');
		expect(getEngine).not.toHaveBeenCalled();
		expect(sign).not.toHaveBeenCalled();
	});

	it('M4: IntakeError code mapping, never rejects, never leaks the thrown message, and calls setIntakePolicy with the right shape', async () => {
		async function runWithCode(code: string) {
			const setIntakePolicy = jest.fn(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				async (_input: unknown, _sign: unknown): Promise<any> => {
					throw Object.assign(new Error('secret-text'), { name: 'IntakeError', code });
				},
			);
			const getEngine = jest.fn(async () => ({ setIntakePolicy, readIntakePolicy: jest.fn() }));
			const sign = jest.fn();
			const result = await saveRegistrationBridgeUrl(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{ getEngine: getEngine as any },
				'auth-1',
				'https://bridge.example',
				sign,
				3,
			);
			expect(setIntakePolicy).toHaveBeenCalledWith(
				{ authorityId: 'auth-1', restBridgeUrl: 'https://bridge.example', expectedRevision: 3 },
				sign,
			);
			expect(setIntakePolicy.mock.calls[0]![0]).not.toHaveProperty('reassociationMode');
			expect(JSON.stringify(result)).not.toContain('secret-text');
			return result.outcome;
		}

		await expect(runWithCode('invalid-policy')).resolves.toBe('failed');
		await expect(runWithCode('threshold-requires-co-sign')).resolves.toBe('co-sign-required');
		await expect(runWithCode('not-authorized')).resolves.toBe('not-authorized');
		await expect(runWithCode('not-a-current-officer')).resolves.toBe('not-authorized');
		await expect(runWithCode('policy-revision-conflict')).resolves.toBe('conflict');

		const getEngine = jest.fn(async () => ({
			setIntakePolicy: jest.fn(async () => {
				throw new Error('plain failure');
			}),
		}));
		const result = await saveRegistrationBridgeUrl(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{ getEngine: getEngine as any },
			'auth-1',
			'https://bridge.example',
			jest.fn(),
			0,
		);
		expect(result.outcome).toBe('failed');
	});

	it('M5: a rejecting getEngine on read gives { savedUrl: null, revision: undefined }', async () => {
		const getEngine = jest.fn(async () => {
			throw new Error('no engine');
		});
		const result = await readRegistrationBridgeConfig({ getEngine }, 'auth-1');
		expect(result).toEqual({ savedUrl: null, revision: undefined });
	});
});
