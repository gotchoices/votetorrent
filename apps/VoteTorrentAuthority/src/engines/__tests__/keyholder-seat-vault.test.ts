/**
 * keyholder-seat-vault.test.ts — prompt batching, Tier 1. A prompt is one auth-required native wrap or
 * unwrap on the fake wrapper (`authWraps + authUnwraps`), the same counter every keyholder test uses.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { keyholderDkgReceivingKeyAlias, keyholderDkgShareAlias } from '@votetorrent/vote-engine/rn';
import { createAuthorityKeyVault, KEY_VAULT_STORAGE_PREFIX } from '../key-vault';
import type { KeyVaultStorage } from '../key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../keyholder-vault';
import {
	KEYHOLDER_SEAT_KEY_STORAGE_PREFIX,
	KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX,
	VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1,
	createKeyholderSeatVault,
	seatUserIdOfAlias,
	withKeyholderSession,
} from '../keyholder-seat-vault';
import { keyholderSigningKeyAlias } from '../keyholder-identity';
import { createFakeSecretSealer, createFakeSecretWrapper, createMapStorage } from '../__fixtures__/fake-secret-wrapper';
import type { FakeSecretSealerOptions } from '../__fixtures__/fake-secret-wrapper';

const AUTH = { requireUserAuth: true };
const NO_AUTH = { requireUserAuth: false };
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function makeHarness(options?: { failUnwrapCode?: string }) {
	const wrapper = createFakeSecretWrapper(options);
	const storage = createMapStorage();
	const inner = createAuthorityKeyVault({
		wrapper,
		storage: storage as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const vault = createKeyholderSeatVault({
		inner,
		wrapper,
		storage: storage as unknown as KeyVaultStorage,
		wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
		prompt: keyholderVaultPrompt,
	});
	const prompts = () => wrapper.authWraps + wrapper.authUnwraps;
	return { wrapper, storage, inner, vault, prompts };
}

function bytes(n: number, fill: number): Uint8Array {
	return new Uint8Array(n).fill(fill);
}

describe('seatUserIdOfAlias', () => {
	it('maps every auth-required keyholder alias family to its trailing userId, and nothing else', () => {
		expect(seatUserIdOfAlias(keyholderSigningKeyAlias(U1))).toBe(U1);
		expect(seatUserIdOfAlias(keyholderDkgReceivingKeyAlias(U1))).toBe(U1);
		expect(seatUserIdOfAlias(keyholderDkgShareAlias('e.1', 0, U1))).toBe(U1);
		expect(seatUserIdOfAlias(`vt.keyholder-dkg-round.e1.0.1.2.${U1}`)).toBe(U1);
		expect(seatUserIdOfAlias(`vt.keyholder-share-attempt.e1.0.${U1}`)).toBeUndefined();
		expect(seatUserIdOfAlias(`vt.officer-enc.${U1}`)).toBeUndefined();
	});
});

describe('createKeyholderSeatVault', () => {
	it('S1 accept shape: two writes in one session cost ONE prompt (the seat key wrap) and store no plaintext', async () => {
		const { vault, storage, prompts } = makeHarness();
		const signing = bytes(32, 0xa1);
		const receiving = bytes(32, 0xb2);
		await withKeyholderSession(vault, U1, async () => {
			await vault.putSecret(keyholderSigningKeyAlias(U1), signing, AUTH);
			await vault.putSecret(keyholderDkgReceivingKeyAlias(U1), receiving, AUTH);
		});
		expect(prompts()).toBe(1);
		const values = storage.values().join('\n');
		expect(values).not.toContain(bytesToHex(signing));
		expect(values).not.toContain(bytesToHex(receiving));
		expect(await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1)).not.toBeNull();
		expect(await storage.getItem(KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX + keyholderSigningKeyAlias(U1))).not.toBeNull();
		expect(await storage.getItem(KEY_VAULT_STORAGE_PREFIX + keyholderSigningKeyAlias(U1))).toBeNull();
	});

	it('S2 drive shape: any number of reads and writes of one seat in one session cost ONE prompt, and round-trip exactly', async () => {
		const { vault, prompts } = makeHarness();
		await withKeyholderSession(vault, U1, async () => {
			await vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH);
			await vault.putSecret(keyholderDkgReceivingKeyAlias(U1), bytes(32, 2), AUTH);
		});
		const before = prompts();
		const round = `vt.keyholder-dkg-round.e1.0.1.1.${U1}`;
		await withKeyholderSession(vault, U1, async () => {
			expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
			expect(await vault.getSecret(keyholderDkgReceivingKeyAlias(U1))).toEqual(bytes(32, 2));
			await vault.putSecret(round, bytes(900, 3), AUTH);
			expect(await vault.getSecret(round)).toEqual(bytes(900, 3));
			expect(await vault.deleteSecret(round)).toBe(true);
			expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
		});
		expect(prompts() - before).toBe(1);
	});

	it('S3 outside a session every seat operation is its own prompt (the old behaviour), and the key is not kept', async () => {
		const { vault, prompts } = makeHarness();
		await withKeyholderSession(vault, U1, () => vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH));
		const before = prompts();
		await vault.getSecret(keyholderSigningKeyAlias(U1));
		await vault.getSecret(keyholderSigningKeyAlias(U1));
		expect(prompts() - before).toBe(2);
		await withKeyholderSession(vault, U1, () => vault.getSecret(keyholderSigningKeyAlias(U1)));
		await withKeyholderSession(vault, U1, () => vault.getSecret(keyholderSigningKeyAlias(U1)));
		expect(prompts() - before).toBe(4);
	});

	it('S4 a session that touches nothing, hasSecret and deleteSecret never prompt; a delete removes the ciphertext', async () => {
		const { vault, storage, prompts } = makeHarness();
		await withKeyholderSession(vault, U1, () => vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH));
		const before = prompts();
		await withKeyholderSession(vault, U1, async () => {
			expect(await vault.hasSecret(keyholderSigningKeyAlias(U1))).toBe(true);
			expect(await vault.hasSecret(keyholderDkgReceivingKeyAlias(U1))).toBe(false);
		});
		expect(await vault.deleteSecret(keyholderSigningKeyAlias(U1))).toBe(true);
		expect(await vault.deleteSecret(keyholderSigningKeyAlias(U1))).toBe(false);
		expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toBeNull();
		expect(prompts() - before).toBe(0);
		expect(await storage.getItem(KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX + keyholderSigningKeyAlias(U1))).toBeNull();
	});

	it('S5 concurrent reads in one session share one prompt; another seat is never unlocked by it', async () => {
		const { vault, prompts } = makeHarness();
		for (const u of [U1, U2]) {
			await withKeyholderSession(vault, u, async () => {
				await vault.putSecret(keyholderSigningKeyAlias(u), bytes(32, 7), AUTH);
				await vault.putSecret(keyholderDkgReceivingKeyAlias(u), bytes(32, 8), AUTH);
			});
		}
		const before = prompts();
		await withKeyholderSession(vault, U1, async () => {
			await Promise.all([
				vault.getSecret(keyholderSigningKeyAlias(U1)),
				vault.getSecret(keyholderDkgReceivingKeyAlias(U1)),
				vault.getSecret(keyholderSigningKeyAlias(U1)),
			]);
			expect(prompts() - before).toBe(1);
			await vault.getSecret(keyholderSigningKeyAlias(U2));
			expect(prompts() - before).toBe(2);
		});
	});

	it('S6 a requireUserAuth:false secret goes to the inner vault with no prompt', async () => {
		const { vault, storage, prompts } = makeHarness();
		const alias = `vt.keyholder-share-attempt.e1.0.${U1}`;
		await vault.putSecret(alias, bytes(1, 0x31), NO_AUTH);
		expect(await vault.getSecret(alias)).toEqual(bytes(1, 0x31));
		expect(prompts()).toBe(0);
		expect(await storage.getItem(KEY_VAULT_STORAGE_PREFIX + alias)).not.toBeNull();
	});

	it('S7 legacy seat: an identity already in the inner vault keeps the inner per-alias path and never gets a seat key', async () => {
		const { vault, inner, storage, prompts } = makeHarness();
		await inner.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH);
		await inner.putSecret(keyholderDkgReceivingKeyAlias(U1), bytes(32, 2), AUTH);
		const before = prompts();
		const share = keyholderDkgShareAlias('e1', 0, U1);
		await withKeyholderSession(vault, U1, async () => {
			await vault.putSecret(share, bytes(32, 9), AUTH);
			expect(await vault.getSecret(share)).toEqual(bytes(32, 9));
			expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
		});
		expect(prompts() - before).toBe(3);
		expect(await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1)).toBeNull();
		expect(await storage.getItem(KEY_VAULT_STORAGE_PREFIX + share)).not.toBeNull();
	});

	it('S8 alias-exists for a seat alias and for an alias the inner vault already holds; nothing is overwritten', async () => {
		const { vault, inner, prompts } = makeHarness();
		await withKeyholderSession(vault, U1, () => vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH));
		await expect(vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 5), AUTH)).rejects.toMatchObject({ code: 'alias-exists' });
		await inner.putSecret(keyholderDkgReceivingKeyAlias(U2), bytes(32, 2), AUTH);
		await expect(vault.putSecret(keyholderDkgReceivingKeyAlias(U2), bytes(32, 6), AUTH)).rejects.toMatchObject({ code: 'alias-exists' });
		const before = prompts();
		expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
		expect(prompts() - before).toBe(1);
	});

	it('S9 a record moved to another alias, or a flipped ciphertext byte, is refused unavailable', async () => {
		const { vault, storage } = makeHarness();
		await withKeyholderSession(vault, U1, async () => {
			await vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH);
			await vault.putSecret(keyholderDkgReceivingKeyAlias(U1), bytes(32, 2), AUTH);
		});
		const signingKey = KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX + keyholderSigningKeyAlias(U1);
		const receivingKey = KEYHOLDER_SEAT_SECRET_STORAGE_PREFIX + keyholderDkgReceivingKeyAlias(U1);
		const signingRaw = (await storage.getItem(signingKey))!;

		// Moved as is: the alias inside no longer matches its storage key.
		await storage.setItem(receivingKey, signingRaw);
		await expect(vault.getSecret(keyholderDkgReceivingKeyAlias(U1))).rejects.toMatchObject({ code: 'unavailable' });

		// Moved and relabelled: the AAD binds the alias, so GCM refuses it.
		const relabelled = { ...JSON.parse(signingRaw), alias: keyholderDkgReceivingKeyAlias(U1) };
		await storage.setItem(receivingKey, JSON.stringify(relabelled));
		await expect(vault.getSecret(keyholderDkgReceivingKeyAlias(U1))).rejects.toMatchObject({ code: 'unavailable' });

		const tampered = JSON.parse(signingRaw);
		tampered.ciphertextHex = (tampered.ciphertextHex[0] === '0' ? '1' : '0') + tampered.ciphertextHex.slice(1);
		await storage.setItem(signingKey, JSON.stringify(tampered));
		await expect(vault.getSecret(keyholderSigningKeyAlias(U1))).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('S10 a cancelled prompt surfaces auth-denied and is not cached as an unlock', async () => {
		const ok = makeHarness();
		await withKeyholderSession(ok.vault, U1, () => ok.vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH));

		// Same storage, a wrapper whose every unwrap is cancelled.
		const denied = createFakeSecretWrapper({ failUnwrapCode: 'CANCELED' });
		const deniedVault = createKeyholderSeatVault({
			inner: ok.inner,
			wrapper: denied,
			storage: ok.storage as unknown as KeyVaultStorage,
			wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
			prompt: keyholderVaultPrompt,
		});
		await withKeyholderSession(deniedVault, U1, async () => {
			await expect(deniedVault.getSecret(keyholderSigningKeyAlias(U1))).rejects.toMatchObject({ code: 'auth-denied' });
			await expect(deniedVault.getSecret(keyholderSigningKeyAlias(U1))).rejects.toMatchObject({ code: 'auth-denied' });
		});
		expect(denied.authUnwraps).toBe(2);
	});

	it('S11 withKeyholderSession on a plain per-alias vault just runs the function', async () => {
		const { inner } = makeHarness();
		await expect(withKeyholderSession(inner, U1, async () => 42)).resolves.toBe(42);
	});

	it('S12 the seat key wrap uses the keyholder wrap alias, requireAuth, and the biometric prompt copy', async () => {
		const { vault, wrapper } = makeHarness();
		await withKeyholderSession(vault, U1, () => vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH));
		expect(wrapper.calls).toHaveLength(1);
		expect(wrapper.calls[0]).toMatchObject({ op: 'wrap', keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, requireAuth: true });
		expect(wrapper.calls[0]!.prompt).toEqual(keyholderVaultPrompt());
	});
});

function makeSealedHarness(sealerOptions?: FakeSecretSealerOptions) {
	const wrapper = createFakeSecretWrapper();
	const sealer = createFakeSecretSealer(sealerOptions);
	const storage = createMapStorage();
	const inner = createAuthorityKeyVault({
		wrapper,
		storage: storage as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const build = (s = sealer) =>
		createKeyholderSeatVault({
			inner,
			wrapper,
			storage: storage as unknown as KeyVaultStorage,
			wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
			prompt: keyholderVaultPrompt,
			sealer: s,
		});
	const vault = build();
	const prompts = () => wrapper.authWraps + wrapper.authUnwraps + sealer.unsealCalls;
	return { wrapper, sealer, storage, inner, vault, build, prompts };
}

async function provisionShape(vault: ReturnType<typeof createKeyholderSeatVault>, userId: string) {
	await withKeyholderSession(vault, userId, async () => {
		await vault.putSecret(keyholderSigningKeyAlias(userId), bytes(32, 1), AUTH);
		await vault.putSecret(keyholderDkgReceivingKeyAlias(userId), bytes(32, 2), AUTH);
	});
}

describe('createKeyholderSeatVault with a public-key sealer (seat key record v2)', () => {
	it('P1 accept shape costs ZERO prompts: one seal, no wrap, no unwrap; the record is v2 under the seal alias', async () => {
		const { vault, sealer, wrapper, storage, prompts } = makeSealedHarness();
		await provisionShape(vault, U1);
		expect(prompts()).toBe(0);
		expect(sealer.sealCalls).toBe(1);
		expect(wrapper.calls).toHaveLength(0);
		const record = JSON.parse((await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1))!);
		expect(record.v).toBe(2);
		expect(record.sealed.keyAlias).toBe(VOTETORRENT_AUTHORITY_KEYHOLDER_SEAT_SEAL_KEY_V1);
		expect(record.wrapped).toBeUndefined();
	});

	it('P2 a later session costs exactly ONE prompt (the unseal) and round-trips every secret', async () => {
		const { vault, sealer, prompts } = makeSealedHarness();
		await provisionShape(vault, U1);
		await withKeyholderSession(vault, U1, async () => {
			expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
			expect(await vault.getSecret(keyholderDkgReceivingKeyAlias(U1))).toEqual(bytes(32, 2));
			await vault.putSecret(keyholderDkgShareAlias('e1', 0, U1), bytes(32, 3), AUTH);
			expect(await vault.getSecret(keyholderDkgShareAlias('e1', 0, U1))).toEqual(bytes(32, 3));
		});
		expect(prompts()).toBe(1);
		expect(sealer.unsealCalls).toBe(1);
	});

	it.each(['SEAL_UNAVAILABLE', 'NATIVE_UNAVAILABLE', 'SEAL_FAILED'])('P3 a %s seal falls back to the v1 wrap: accept costs one prompt and stays readable', async (code) => {
		const { vault, storage, wrapper, prompts } = makeSealedHarness({ failSealCode: code });
		await provisionShape(vault, U1);
		expect(prompts()).toBe(1);
		expect(wrapper.authWraps).toBe(1);
		expect(JSON.parse((await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1))!).v).toBe(1);
		expect(await vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
	});

	it('P4 a seal rejecting SEAL_KEY_POLICY_MISMATCH fails the write instead of falling back, and leaves nothing behind', async () => {
		const { vault, storage, wrapper } = makeSealedHarness({ failSealCode: 'SEAL_KEY_POLICY_MISMATCH' });
		await expect(withKeyholderSession(vault, U1, () => vault.putSecret(keyholderSigningKeyAlias(U1), bytes(32, 1), AUTH))).rejects.toMatchObject({ code: 'unavailable' });
		expect(wrapper.calls).toHaveLength(0);
		expect(await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1)).toBeNull();
		expect(await vault.hasSecret(keyholderSigningKeyAlias(U1))).toBe(false);
	});

	it('P5 a sealed seat key copied onto another seat is refused: the sealed payload is bound to its userId', async () => {
		const { vault, storage } = makeSealedHarness();
		await provisionShape(vault, U1);
		await provisionShape(vault, U2);
		const u1Record = JSON.parse((await storage.getItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U1))!);
		await storage.setItem(KEYHOLDER_SEAT_KEY_STORAGE_PREFIX + U2, JSON.stringify({ ...u1Record, userId: U2 }));
		await expect(vault.getSecret(keyholderSigningKeyAlias(U2))).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('P6 a cancelled unseal is auth-denied; a v2 record with no sealer configured is unavailable', async () => {
		const h = makeSealedHarness();
		await provisionShape(h.vault, U1);
		const cancelling = createFakeSecretSealer({ failUnsealCode: 'CANCELED' });
		await expect(h.build(cancelling).getSecret(keyholderSigningKeyAlias(U1))).rejects.toMatchObject({ code: 'auth-denied' });
		const noSealer = createKeyholderSeatVault({
			inner: h.inner,
			wrapper: h.wrapper,
			storage: h.storage as unknown as KeyVaultStorage,
			wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
			prompt: keyholderVaultPrompt,
		});
		await expect(noSealer.getSecret(keyholderSigningKeyAlias(U1))).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('P7 a v1 seat created before the sealer existed keeps unlocking through the wrap key', async () => {
		const h = makeSealedHarness();
		const v1Vault = createKeyholderSeatVault({
			inner: h.inner,
			wrapper: h.wrapper,
			storage: h.storage as unknown as KeyVaultStorage,
			wrapKeyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1,
			prompt: keyholderVaultPrompt,
		});
		await provisionShape(v1Vault, U1);
		const before = h.prompts();
		expect(await h.vault.getSecret(keyholderSigningKeyAlias(U1))).toEqual(bytes(32, 1));
		expect(h.prompts() - before).toBe(1);
		expect(h.sealer.unsealCalls).toBe(0);
		expect(h.wrapper.authUnwraps).toBe(1);
	});
});
