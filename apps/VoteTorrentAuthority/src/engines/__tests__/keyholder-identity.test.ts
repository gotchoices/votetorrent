/**
 * Phase 62 Plan 26 (D-16/D-21): keyholder-identity.ts — fresh identity provisioning, the public
 * identity store, and the per-signature signer. Uses the shared `createFakeSecretWrapper`/
 * `createMapStorage` fixture over `createAuthorityKeyVault` with this plan's auth-required
 * `keyholderVaultPrompt` wrap — the same construction `keyholder-vault.ts` itself uses.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/curves/utils.js';
import { createAuthorityKeyVault } from '../key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../__fixtures__/fake-secret-wrapper';
import {
	KEYHOLDER_SIGNING_KEY_LIFETIME_MS,
	createKeyholderSigner,
	discardKeyholderIdentity,
	getKeyholderIdentity,
	keyholderSigningKeyAlias,
	listKeyholderIdentities,
	provisionKeyholderIdentity,
} from '../keyholder-identity';
import type { KeyVaultStorage } from '../key-vault';
import { keyholderDkgReceivingKeyAlias } from '@votetorrent/vote-engine/rn';

function makeHarness(options?: { failWrapAt?: number; failUnwrapCode?: string }) {
	const wrapper = createFakeSecretWrapper(options);
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const identityStorage = createMapStorage();
	return { wrapper, vault, identityStorage };
}

function isHexCompressedPoint(hex: string): boolean {
	return /^(02|03)[0-9a-f]{64}$/.test(hex);
}

describe('keyholder-identity.ts (D-21/D-16)', () => {
	it('I1 fresh: two provisions mint distinct userIds, signing keys and receiving keys', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		const b = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-b');

		expect(a.userId).not.toBe(b.userId);
		expect(a.record.signingPublicKey).not.toBe(b.record.signingPublicKey);
		expect(a.record.dkgReceivingPublicKey).not.toBe(b.record.dkgReceivingPublicKey);
		expect(isHexCompressedPoint(a.record.signingPublicKey)).toBe(true);
		expect(isHexCompressedPoint(a.record.dkgReceivingPublicKey)).toBe(true);
		expect(isHexCompressedPoint(b.record.signingPublicKey)).toBe(true);
		expect(isHexCompressedPoint(b.record.dkgReceivingPublicKey)).toBe(true);

		expect(a.provisioning.signingKey.key).toBe(a.record.signingPublicKey);
		expect(a.provisioning.signingKey.type).toBe('M');
		const nowDeltaMs = Math.abs(a.provisioning.signingKey.expiration - (Date.now() + KEYHOLDER_SIGNING_KEY_LIFETIME_MS));
		expect(nowDeltaMs).toBeLessThan(60_000);
		expect(a.provisioning.dkgPublicKey).toBe(a.record.dkgReceivingPublicKey);
	});

	it('I2 vault: after provision, hasSecret is true for both aliases; exactly 2 auth wraps, 0 unwraps', async () => {
		const { vault, identityStorage, wrapper } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');

		expect(await vault.hasSecret(keyholderSigningKeyAlias(a.userId))).toBe(true);
		expect(await vault.hasSecret(keyholderDkgReceivingKeyAlias(a.userId))).toBe(true);
		expect(wrapper.authWraps).toBe(2);
		expect(wrapper.authUnwraps).toBe(0);
	});

	it('I3 no plaintext at rest: the identity record is public-only, and no storage value carries a private-key field', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');

		expect(Object.keys(a.record).sort()).toEqual(
			['createdAt', 'dkgReceivingPublicKey', 'inviteSlotCid', 'signingKeyType', 'signingPublicKey', 'userId', 'v'].sort()
		);
		for (const raw of identityStorage.values()) {
			expect(raw).not.toContain('"privateKey"');
			expect(raw).not.toContain('"signingPriv"');
		}
	});

	it('I4 accept signer: provisioning.sign verifies against signingKey.key with ZERO unwraps, and rejects after release()', async () => {
		const { vault, identityStorage, wrapper } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		const digest = new Uint8Array(32).fill(7);

		const sig = await a.provisioning.sign(digest);
		expect(sig.signerKey).toBe(a.record.signingPublicKey);
		expect(sig.signerUserId).toBe(a.userId);
		expect(secp256k1.verify(hexToBytes(sig.signature), digest, hexToBytes(sig.signerKey))).toBe(true);
		expect(wrapper.unwrapCalls).toBe(0);

		a.release();
		await expect(a.provisioning.sign(digest)).rejects.toMatchObject({ code: 'signing-key-missing' });
	});

	it('I5 rollback: a failing receiving-key put deletes the signing alias and writes no identity record', async () => {
		const { vault, identityStorage } = makeHarness({ failWrapAt: 2 });
		await expect(provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a')).rejects.toBeTruthy();

		expect(await listKeyholderIdentities(identityStorage)).toHaveLength(0);
		const keptKeys = identityStorage.values().join('\n');
		expect(keptKeys).not.toContain('vt.keyholder-signing.');
	});

	it('I6 store: getKeyholderIdentity/listKeyholderIdentities, a dropping storage, and a corrupt store', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		expect(await getKeyholderIdentity(a.userId, identityStorage)).toEqual(a.record);
		expect(await listKeyholderIdentities(identityStorage)).toEqual([a.record]);

		const dropStorage: KeyVaultStorage = {
			async getItem() {
				return null;
			},
			async setItem() {
				/* silently drops */
			},
			async removeItem() {
				/* no-op */
			},
		};
		await expect(provisionKeyholderIdentity({ vault, storage: dropStorage }, 'slot-b')).rejects.toMatchObject({
			code: 'store-write-failed',
		});

		const corruptStorage = createMapStorage();
		await corruptStorage.setItem('vt.keyholder-identities.v1', 'not json');
		await expect(getKeyholderIdentity('any', corruptStorage)).rejects.toMatchObject({ code: 'store-corrupt' });
		expect(await corruptStorage.getItem('vt.keyholder-identities.v1')).toBe('not json');

		const v2Storage = createMapStorage();
		await v2Storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 2, identities: [] }));
		await expect(listKeyholderIdentities(v2Storage)).rejects.toMatchObject({ code: 'store-corrupt' });
	});

	it('I7 discard: removes both aliases and the record; a second discard resolves (idempotent)', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');

		await discardKeyholderIdentity({ vault, storage: identityStorage }, a.userId);
		expect(await vault.hasSecret(keyholderSigningKeyAlias(a.userId))).toBe(false);
		expect(await vault.hasSecret(keyholderDkgReceivingKeyAlias(a.userId))).toBe(false);
		expect(await getKeyholderIdentity(a.userId, identityStorage)).toBeUndefined();

		await expect(discardKeyholderIdentity({ vault, storage: identityStorage }, a.userId)).resolves.toBeUndefined();
	});

	it('I8a signer: createKeyholderSigner performs exactly 1 auth-required unwrap and verifies', async () => {
		const { vault, identityStorage, wrapper } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		const signer = createKeyholderSigner({ vault }, a.record);
		const digest = new Uint8Array(32).fill(3);

		const before = wrapper.authUnwraps;
		const sig = await signer.sign(digest);
		expect(wrapper.authUnwraps).toBe(before + 1);
		expect(sig.signerUserId).toBe(a.userId);
		expect(secp256k1.verify(hexToBytes(sig.signature), digest, hexToBytes(a.record.signingPublicKey))).toBe(true);
	});

	it('I8b signer: signing-key-missing when the alias is absent', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		await vault.deleteSecret(keyholderSigningKeyAlias(a.userId));
		const signer = createKeyholderSigner({ vault }, a.record);
		await expect(signer.sign(new Uint8Array(32))).rejects.toMatchObject({ code: 'signing-key-missing' });
	});

	it('I8c signer: signing-key-mismatch when the record was swapped for another key, before any signature', async () => {
		const { vault, identityStorage } = makeHarness();
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		const b = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-b');
		const tamperedRecord = { ...a.record, signingPublicKey: b.record.signingPublicKey };
		const signer = createKeyholderSigner({ vault }, tamperedRecord);
		await expect(signer.sign(new Uint8Array(32))).rejects.toMatchObject({ code: 'signing-key-mismatch' });
	});

	it('I8d signer: an unwrap throwing CANCELED surfaces as auth-denied', async () => {
		// provisionKeyholderIdentity only ever WRAPS (putSecret); it never unwraps — so a vault
		// configured to fail every UNWRAP still provisions successfully, and only the later
		// `createKeyholderSigner` unwrap attempt sees the failure.
		const { vault, identityStorage } = makeHarness({ failUnwrapCode: 'CANCELED' });
		const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
		const signer = createKeyholderSigner({ vault }, a.record);
		await expect(signer.sign(new Uint8Array(32))).rejects.toMatchObject({ code: 'auth-denied' });
	});

	describe('vault hygiene (WR-G4-01 / WR-G4-02)', () => {
		type Vault = ReturnType<typeof makeHarness>['vault'];
		function spyVault(
			base: Vault,
			opts: { failPutAt?: number; failDeleteAlias?: (alias: string) => boolean; failDeleteOnce?: boolean }
		) {
			const captured: Uint8Array[] = [];
			const deleteAttempts: string[] = [];
			let puts = 0;
			let deleteFailed = false;
			const vault = {
				...base,
				hasSecret: base.hasSecret.bind(base),
				getSecret: base.getSecret.bind(base),
				putSecret: async (alias: string, secret: Uint8Array, policy: never) => {
					puts += 1;
					captured.push(secret);
					if (opts.failPutAt === puts) throw new Error('biometric cancelled');
					return base.putSecret(alias, secret, policy);
				},
				deleteSecret: async (alias: string) => {
					deleteAttempts.push(alias);
					if (opts.failDeleteAlias?.(alias) && !(opts.failDeleteOnce && deleteFailed)) {
						deleteFailed = true;
						throw new Error('vault delete failed');
					}
					return base.deleteSecret(alias);
				},
			} as unknown as Vault;
			return { vault, captured, deleteAttempts };
		}
		const allZero = (b: Uint8Array) => b.every((x) => x === 0);

		it('V-1 discard keeps the record when a vault delete fails, still attempts both, and a retry succeeds', async () => {
			const { vault, identityStorage } = makeHarness();
			const a = await provisionKeyholderIdentity({ vault, storage: identityStorage }, 'slot-a');
			const sAlias = keyholderSigningKeyAlias(a.userId);
			const spy = spyVault(vault, { failDeleteAlias: (x) => x === sAlias, failDeleteOnce: true });
			await expect(discardKeyholderIdentity({ vault: spy.vault, storage: identityStorage }, a.userId)).rejects.toMatchObject({
				code: 'store-write-failed',
			});
			expect(spy.deleteAttempts).toContain(keyholderDkgReceivingKeyAlias(a.userId));
			expect(await getKeyholderIdentity(a.userId, identityStorage)).toEqual(a.record);

			await expect(discardKeyholderIdentity({ vault: spy.vault, storage: identityStorage }, a.userId)).resolves.toBeUndefined();
			expect(await vault.hasSecret(sAlias)).toBe(false);
			expect(await vault.hasSecret(keyholderDkgReceivingKeyAlias(a.userId))).toBe(false);
			expect(await getKeyholderIdentity(a.userId, identityStorage)).toBeUndefined();
		});

		it('V-3 a failing FIRST vault write zeroes both private keys and surfaces the error', async () => {
			const { vault, identityStorage } = makeHarness();
			const spy = spyVault(vault, { failPutAt: 1 });
			await expect(provisionKeyholderIdentity({ vault: spy.vault, storage: identityStorage }, 'slot-a')).rejects.toThrow(
				'biometric cancelled'
			);
			expect(spy.captured.length).toBeGreaterThanOrEqual(1);
			for (const b of spy.captured) expect(allZero(b)).toBe(true);
			expect(await listKeyholderIdentities(identityStorage)).toHaveLength(0);
		});

		it('V-4 a store-write failure zeroes the keys, deletes both aliases and still reports store-write-failed even if a cleanup delete rejects', async () => {
			const { vault } = makeHarness();
			const spy = spyVault(vault, { failDeleteAlias: () => true });
			const dropStorage: KeyVaultStorage = {
				async getItem() {
					return null;
				},
				async setItem() {},
				async removeItem() {},
			};
			await expect(provisionKeyholderIdentity({ vault: spy.vault, storage: dropStorage }, 'slot-a')).rejects.toMatchObject({
				code: 'store-write-failed',
			});
			for (const b of spy.captured) expect(allZero(b)).toBe(true);
			expect(spy.deleteAttempts).toHaveLength(2);
		});

		it('V-5 a rejecting rollback delete never replaces the original receiving-key error', async () => {
			const { vault, identityStorage } = makeHarness();
			const spy = spyVault(vault, { failPutAt: 2, failDeleteAlias: () => true });
			await expect(provisionKeyholderIdentity({ vault: spy.vault, storage: identityStorage }, 'slot-a')).rejects.toThrow(
				'biometric cancelled'
			);
			for (const b of spy.captured) expect(allZero(b)).toBe(true);
		});
	});
});
