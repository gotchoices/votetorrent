/**
 * keyholder-driver-bindings.test.ts — phase 67 plan 14. The three driver bindings (`keyholder-accept`,
 * `keyholder-dkg-driver`, `key-release-ceremony`) and the keyholder-identity binding default to ONE store
 * (the app's AsyncStorage object), an explicit storage wins, and every old name is still a function at its
 * old path. Nothing here prints a key or a signature.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReleaseKeyTask } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { provisionKeyholderIdentity } from '../../../engines/keyholder-identity';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { driveKeyholderDkg, keyholderDkgRowState } from '../keyholder-dkg-driver';
import { keyReleaseErrorCopyKey, releaseKeyholderShare } from '../key-release-ceremony';

function makeVaultHarness() {
	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	return { wrapper, vault };
}

function makeTask(userId: string): ReleaseKeyTask {
	return { type: 'release-key', userId, network: { name: 'Net' }, election: { election: { title: 'T' } } } as unknown as ReleaseKeyTask;
}

function makeKeysTasksEngine() {
	const completeKeyRelease = jest.fn(async (_task: unknown, _signer?: unknown) => undefined);
	const getEngine = jest.fn(async () => ({ completeKeyRelease })) as unknown as <T>(engineName: string) => Promise<T>;
	return { completeKeyRelease, getEngine };
}

function makeDkgEngine() {
	const getDkgStatus = jest.fn(async (electionId: string, selfUserId?: string) => ({
		electionId,
		revision: 1,
		threshold: 2,
		phase: 'complete',
		currentAttempt: 1,
		currentRound: null,
		roster: [],
		awaitingUserIds: [],
		attempts: [],
		disqualified: [],
		electionKey: null,
		self: selfUserId === undefined ? undefined : { userId: selfUserId, isParticipant: true, isDisqualified: false, hasShare: true },
	}));
	const advanceDkg = jest.fn();
	const getEngine = jest.fn(async () => ({ getDkgStatus, advanceDkg })) as unknown as <T>(engineName: string) => Promise<T>;
	return { getDkgStatus, advanceDkg, getEngine };
}

describe('keyholder driver bindings', () => {
	beforeEach(async () => {
		await AsyncStorage.clear();
	});

	it('B1 shared default store: an identity provisioned through the identity binding without storage is found by the release and DKG bindings without storage', async () => {
		const { vault } = makeVaultHarness();
		const provisioned = await provisionKeyholderIdentity({ vault }, 'slot-b1');
		provisioned.release();
		const userId = provisioned.userId;

		const keys = makeKeysTasksEngine();
		const outcome = await releaseKeyholderShare({ getEngine: keys.getEngine, vault }, makeTask(userId));
		expect(outcome).toEqual({ kind: 'released' });
		expect(keys.completeKeyRelease).toHaveBeenCalledTimes(1);

		const dkg = makeDkgEngine();
		const drive = await driveKeyholderDkg({ getEngine: dkg.getEngine, vault }, 'e1', userId);
		expect(dkg.getDkgStatus).toHaveBeenCalledWith('e1', userId);
		expect(drive.advanced).toBe(false);
		expect(dkg.advanceDkg).not.toHaveBeenCalled();
	});

	it('B2 explicit storage wins: an identity in an explicit store is released with that store and not found without it', async () => {
		const { vault } = makeVaultHarness();
		const storage = createMapStorage() as unknown as KeyVaultStorage;
		const provisioned = await provisionKeyholderIdentity({ vault, storage }, 'slot-b2');
		provisioned.release();
		const task = makeTask(provisioned.userId);

		const withStore = makeKeysTasksEngine();
		expect(await releaseKeyholderShare({ getEngine: withStore.getEngine, vault, storage }, task)).toEqual({ kind: 'released' });
		expect(withStore.completeKeyRelease).toHaveBeenCalledTimes(1);

		const withoutStore = makeKeysTasksEngine();
		expect(await releaseKeyholderShare({ getEngine: withoutStore.getEngine, vault }, task)).toEqual({ kind: 'failed', code: 'identity-not-found', authDenied: false });
		expect(withoutStore.completeKeyRelease).not.toHaveBeenCalled();
	});

	it('B3 forwarded names: every old export is a function at its old path, and the mapping still answers', () => {
		expect(typeof acceptKeyholderInvitation).toBe('function');
		expect(typeof driveKeyholderDkg).toBe('function');
		expect(typeof releaseKeyholderShare).toBe('function');
		expect(typeof keyholderDkgRowState).toBe('function');
		expect(typeof keyReleaseErrorCopyKey).toBe('function');
		expect(keyholderDkgRowState(null)).toBe('loading');
	});
});
