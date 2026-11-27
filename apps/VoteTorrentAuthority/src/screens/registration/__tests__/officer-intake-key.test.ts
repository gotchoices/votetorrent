/**
 * Phase 62 Plan 21 (D-04): officer-intake-key.ts — readOfficerIntakeKeyState / enableOfficerEncryptedIntake
 * (I1-I5).
 *
 * I1/I2 run against the REAL schema (`createTestNetwork`, the real `IntakeEngine` from the mapped
 * `/rn` dist, the Task 1 fake-wrapper pattern over `createAuthorityKeyVault`). I3-I5 use fakes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { IntakeEngine } from '@votetorrent/vote-engine/rn';
import type { SecretWrapOptions, SecretWrapper, WrappedSecret } from '@votetorrent/attestation-native';
import type { Signature, User } from '@votetorrent/vote-core';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;
// Resolved via jest's moduleNameMapper to the TS source (the package "exports" map blocks this
// deep subpath for tsc) — the same `require()` pattern `compliance-strand.spec.ts` already uses
// for its own otherwise-unresolvable deep import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTestNetwork, addTestAuthority, makeTestSignCallback } = require('@votetorrent/vote-engine/test/fixtures/test-context') as {
	createTestNetwork: (overrides?: unknown) => Promise<{ ctx: { db: AnyDb; user: User }; user: User }>;
	addTestAuthority: (net: unknown) => Promise<{ authority: { id: string }; ctx: { db: AnyDb; user: User }; user: User }>;
	makeTestSignCallback: (user: User) => (digest: Uint8Array) => Promise<Signature>;
};
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import {
	enableOfficerEncryptedIntake,
	readOfficerIntakeKeyState,
	type OfficerIntakeKeyDeps,
} from '../officer-intake-key';

function makeFakeWrapper(): SecretWrapper {
	const store = new Map<string, Uint8Array>();
	let counter = 0;
	return {
		async wrapSecret(keyAlias: string, plaintext: Uint8Array, _options: SecretWrapOptions): Promise<WrappedSecret> {
			const handle = `h${counter++}`;
			store.set(handle, Uint8Array.from(plaintext));
			return { v: 1, alg: 'AES-256-GCM', keyAlias, ivBase64: 'AAAAAAAAAAAAAAAA', ciphertextBase64: handle, securityLevel: 'test-stub' };
		},
		async unwrapSecret(wrapped: WrappedSecret, _options: SecretWrapOptions): Promise<Uint8Array> {
			const entry = store.get(wrapped.ciphertextBase64);
			if (!entry) throw Object.assign(new Error('unknown'), { code: 'UNWRAP_FAILED' });
			return Uint8Array.from(entry);
		},
	};
}

beforeEach(async () => {
	await AsyncStorage.clear();
});

describe('officer-intake-key.ts (D-04, real schema)', () => {
	it('I1: enable publishes a replicated encryption key, recipient resolution returns the officer, and no AsyncStorage value contains the secret hex', async () => {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const vault = createAuthorityKeyVault({ wrapper: makeFakeWrapper(), storage: AsyncStorage });

		const deps: OfficerIntakeKeyDeps = {
			getEngine: async <T>() => new IntakeEngine(net.ctx) as unknown as T,
			vault,
			createSigner: async () => makeTestSignCallback(net.user),
		};

		expect(await readOfficerIntakeKeyState(deps, auth.authority.id)).toBe('not-enabled');

		const state = await enableOfficerEncryptedIntake(deps, auth.authority.id);
		expect(state).toBe('enabled');

		// Recipient resolution returns the officer's userId (D-32 — resolved from the replicated rows).
		const intake = new IntakeEngine(net.ctx);
		const recipients = await intake.listIntakeRecipients(auth.authority.id);
		expect(recipients.recipients.map((r: { userId: string }) => r.userId)).toContain(net.user.id);

		// No AsyncStorage value contains the secret's hex.
		const keys = await AsyncStorage.getAllKeys();
		for (const key of keys) {
			const raw = await AsyncStorage.getItem(key);
			if (raw === null) continue;
			expect(raw).not.toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('I2: a second enable call returns "enabled" and adds no new UserEncryptionKey row', async () => {
		const net = await createTestNetwork();
		const auth = await addTestAuthority(net);
		const vault = createAuthorityKeyVault({ wrapper: makeFakeWrapper(), storage: AsyncStorage });
		const deps: OfficerIntakeKeyDeps = {
			getEngine: async <T>() => new IntakeEngine(net.ctx) as unknown as T,
			vault,
			createSigner: async () => makeTestSignCallback(net.user),
		};

		await enableOfficerEncryptedIntake(deps, auth.authority.id);
		const countRow = (await net.ctx.db
			.prepare('select count(*) as n from UserEncryptionKey where UserId = :userId')
			.get({ userId: net.user.id })) as { n: number };
		expect(countRow.n).toBe(1);

		const secondState = await enableOfficerEncryptedIntake(deps, auth.authority.id);
		expect(secondState).toBe('enabled');

		const countRow2 = (await net.ctx.db
			.prepare('select count(*) as n from UserEncryptionKey where UserId = :userId')
			.get({ userId: net.user.id })) as { n: number };
		expect(countRow2.n).toBe(1);
	});
});

describe('officer-intake-key.ts (D-04, fakes)', () => {
	it('I3: readOfficerIntakeKeyState never throws — returns "unavailable" when getEngine or the status call rejects', async () => {
		const depsRejectEngine: OfficerIntakeKeyDeps = {
			getEngine: async () => {
				throw new Error('engine unavailable');
			},
			createSigner: async () => async () => ({ signerUserId: 'u', signerKey: 'k', signature: 's' }),
		};
		await expect(readOfficerIntakeKeyState(depsRejectEngine, 'auth-1')).resolves.toBe('unavailable');

		const depsRejectStatus: OfficerIntakeKeyDeps = {
			getEngine: async <T>() =>
				({
					getOfficerEncryptionKeyStatus: async () => {
						throw new Error('status read failed');
					},
				}) as unknown as T,
			createSigner: async () => async () => ({ signerUserId: 'u', signerKey: 'k', signature: 's' }),
		};
		await expect(readOfficerIntakeKeyState(depsRejectStatus, 'auth-1')).resolves.toBe('unavailable');
	});

	it('I3b: a contested key reads "enabled-contested"; an uncontested one reads "enabled"; enabling resolves on a contested re-read', async () => {
		const mk = (isContested: boolean): OfficerIntakeKeyDeps => ({
			getEngine: async <T>() =>
				({
					getOfficerEncryptionKeyStatus: async () => ({ isIntakeRecipient: true, isContested }),
					registerOfficerEncryptionKey: async () => undefined,
				}) as unknown as T,
			createSigner: async () => async () => ({ signerUserId: 'u', signerKey: 'k', signature: 's' }),
		});
		await expect(readOfficerIntakeKeyState(mk(true), 'auth-1')).resolves.toBe('enabled-contested');
		await expect(readOfficerIntakeKeyState(mk(false), 'auth-1')).resolves.toBe('enabled');
		await expect(enableOfficerEncryptedIntake(mk(true), 'auth-1')).resolves.toBe('enabled-contested');
	});

	it('I4: when registration succeeds but the re-read state is not "enabled", enableOfficerEncryptedIntake rejects', async () => {
		const deps: OfficerIntakeKeyDeps = {
			getEngine: async <T>() =>
				({
					registerOfficerEncryptionKey: async () => undefined,
					getOfficerEncryptionKeyStatus: async () => ({ isIntakeRecipient: false }),
				}) as unknown as T,
			createSigner: async () => async () => ({ signerUserId: 'u', signerKey: 'k', signature: 's' }),
		};
		await expect(enableOfficerEncryptedIntake(deps, 'auth-1')).rejects.toThrow();
	});

	it('I5: a createSigner rejection propagates UNCHANGED (same object, code intact); readOfficerIntakeKeyState never calls createSigner', async () => {
		const signerError = Object.assign(new Error('x'), { code: 'KEY_INVALIDATED' });
		const createSigner = jest.fn(async () => {
			throw signerError;
		});
		const deps: OfficerIntakeKeyDeps = {
			getEngine: async <T>() =>
				({
					getOfficerEncryptionKeyStatus: async () => ({ isIntakeRecipient: false }),
					registerOfficerEncryptionKey: async () => undefined,
				}) as unknown as T,
			createSigner,
		};

		await readOfficerIntakeKeyState(deps, 'auth-1');
		expect(createSigner).not.toHaveBeenCalled();

		let caught: unknown;
		try {
			await enableOfficerEncryptedIntake(deps, 'auth-1');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(signerError);
		expect((caught as { code: string }).code).toBe('KEY_INVALIDATED');
	});
});
