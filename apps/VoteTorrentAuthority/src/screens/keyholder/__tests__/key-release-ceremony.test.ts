/**
 * key-release-ceremony.test.ts — C1-C6: the release ceremony helper over fakes (a recording
 * keys-tasks engine, the keyholder vault over the fake secret wrapper, Map storage).
 */

import type { ReleaseKeyTask } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { KEYHOLDER_IDENTITY_STORAGE_KEY, keyholderSigningKeyAlias } from '../../../engines/keyholder-identity';
import { keyReleaseErrorCopyKey, releaseKeyholderShare } from '../key-release-ceremony';

const USER_ID = 'keyholder-user-1';
const SIGNING_PUBLIC_KEY = '02' + '11'.repeat(32);

function makeTask(userId = USER_ID): ReleaseKeyTask {
	return { type: 'release-key', userId, network: { name: 'Net' }, election: { election: { title: 'T' } } } as unknown as ReleaseKeyTask;
}

async function makeHarness(options?: { withIdentity?: boolean }) {
	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const storage = createMapStorage();
	if (options?.withIdentity !== false) {
		await vault.putSecret(keyholderSigningKeyAlias(USER_ID), new Uint8Array(32).fill(1), { requireUserAuth: true });
		const record = {
			v: 1 as const,
			userId: USER_ID,
			inviteSlotCid: 'slot',
			signingPublicKey: SIGNING_PUBLIC_KEY,
			signingKeyType: 'M' as const,
			dkgReceivingPublicKey: '03'.repeat(33),
			createdAt: new Date().toISOString(),
		};
		await storage.setItem(KEYHOLDER_IDENTITY_STORAGE_KEY, JSON.stringify({ v: 1, identities: [record] }));
	}
	const completeKeyRelease = jest.fn(async (_task: unknown, _signer?: unknown) => undefined);
	const engine = { completeKeyRelease };
	const getEngine = jest.fn(async () => engine) as unknown as <T>(engineName: string) => Promise<T>;
	return { wrapper, vault, storage, completeKeyRelease, getEngine };
}

describe('releaseKeyholderShare with fakes (C1-C6)', () => {
	it('C1 happy: resolves released and passes a DEFINED keyholder signer for the task userId', async () => {
		const h = await makeHarness();
		const task = makeTask();
		const outcome = await releaseKeyholderShare({ getEngine: h.getEngine, vault: h.vault, storage: h.storage }, task);

		expect(outcome).toEqual({ kind: 'released' });
		expect(h.completeKeyRelease).toHaveBeenCalledTimes(1);
		const [calledTask, signer] = h.completeKeyRelease.mock.calls[0] as [unknown, { userId: string; signingPublicKey: string }];
		expect(calledTask).toBe(task);
		expect(signer).toBeDefined();
		expect(signer.userId).toBe(task.userId);
		expect(signer.signingPublicKey).toBe(SIGNING_PUBLIC_KEY);
	});

	it('C2 no identity: failed identity-not-found, engine never called, 0 unwraps', async () => {
		const h = await makeHarness({ withIdentity: false });
		const outcome = await releaseKeyholderShare({ getEngine: h.getEngine, vault: h.vault, storage: h.storage }, makeTask('someone-else'));

		expect(outcome).toEqual({ kind: 'failed', code: 'identity-not-found', authDenied: false });
		expect(h.getEngine).not.toHaveBeenCalled();
		expect(h.completeKeyRelease).not.toHaveBeenCalled();
		expect(h.wrapper.unwrapCalls).toBe(0);
	});

	it('C3 engine refusal: a release-window-not-open rejection resolves failed with that code, not authDenied, no throw', async () => {
		const h = await makeHarness();
		h.completeKeyRelease.mockRejectedValueOnce(Object.assign(new Error('window'), { code: 'release-window-not-open' }));
		const outcome = await releaseKeyholderShare({ getEngine: h.getEngine, vault: h.vault, storage: h.storage }, makeTask());

		expect(outcome).toEqual({ kind: 'failed', code: 'release-window-not-open', authDenied: false });
	});

	it('C4 biometric denial: auth-denied resolves authDenied true', async () => {
		const h = await makeHarness();
		h.completeKeyRelease.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'auth-denied' }));
		const outcome = await releaseKeyholderShare({ getEngine: h.getEngine, vault: h.vault, storage: h.storage }, makeTask());

		expect(outcome).toEqual({ kind: 'failed', code: 'auth-denied', authDenied: true });
	});

	it('C5 no code: getEngine rejecting a plain Error resolves code unknown and never throws', async () => {
		const h = await makeHarness();
		const getEngine = jest.fn(async () => {
			throw new Error('engine unavailable');
		}) as unknown as <T>(engineName: string) => Promise<T>;
		const outcome = await releaseKeyholderShare({ getEngine, vault: h.vault, storage: h.storage }, makeTask());

		expect(outcome).toEqual({ kind: 'failed', code: 'unknown', authDenied: false });
	});

	it('C6 copy: deviceSigningErrorGeneric exactly when authDenied, else keyholderReleaseError', () => {
		expect(keyReleaseErrorCopyKey({ kind: 'failed', code: 'auth-denied', authDenied: true })).toBe('deviceSigningErrorGeneric');
		expect(keyReleaseErrorCopyKey({ kind: 'failed', code: 'unknown', authDenied: false })).toBe('keyholderReleaseError');
		expect(keyReleaseErrorCopyKey({ kind: 'failed', code: 'release-window-not-open', authDenied: false })).toBe('keyholderReleaseError');
	});
});
