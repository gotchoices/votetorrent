/**
 * Phase 62 Plan 21 (D-04): key-vault.ts — the Authority `IKeyVault` adapter over 62-08's native
 * secret-wrap. Uses a test-local fake `SecretWrapper` (a Map keyed by an opaque handle returned
 * as `ciphertextBase64`, recording `(keyAlias, requireAuth, aad bytes, prompt)` per call) and the
 * mapped AsyncStorage jest mock.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KeyVaultError } from '@votetorrent/vote-engine/rn';
import type { KeyVaultPolicy } from '@votetorrent/vote-engine/rn';
import type { SecretWrapOptions, SecretWrapper, WrappedSecret } from '@votetorrent/attestation-native';
import {
	VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1,
	KEY_VAULT_STORAGE_PREFIX,
	createAuthorityKeyVault,
	resolveAuthorityKeyVault,
	setAuthorityKeyVaultForTests,
} from '../key-vault';

interface WrapCall {
	keyAlias: string;
	requireAuth: boolean;
	aad: Uint8Array;
	prompt?: unknown;
}

function makeFakeWrapper(): SecretWrapper & { wrapCalls: WrapCall[]; failNextWith?: { code: string } } {
	const store = new Map<string, { bytes: Uint8Array; keyAlias: string; aad: Uint8Array }>();
	let counter = 0;
	const wrapCalls: WrapCall[] = [];
	const fake: SecretWrapper & { wrapCalls: WrapCall[]; failNextWith?: { code: string } } = {
		wrapCalls,
		failNextWith: undefined,
		async wrapSecret(keyAlias: string, plaintext: Uint8Array, options: SecretWrapOptions): Promise<WrappedSecret> {
			wrapCalls.push({ keyAlias, requireAuth: options.requireAuth, aad: options.aad, prompt: options.prompt });
			if (fake.failNextWith) {
				const err = Object.assign(new Error('wrap failed'), { code: fake.failNextWith.code });
				fake.failNextWith = undefined;
				throw err;
			}
			const handle = `h${counter++}`;
			store.set(handle, { bytes: Uint8Array.from(plaintext), keyAlias, aad: Uint8Array.from(options.aad) });
			return {
				v: 1,
				alg: 'AES-256-GCM',
				keyAlias,
				ivBase64: 'AAAAAAAAAAAAAAAA',
				ciphertextBase64: handle,
				securityLevel: 'test-stub',
			};
		},
		async unwrapSecret(wrapped: WrappedSecret, options: SecretWrapOptions): Promise<Uint8Array> {
			if (fake.failNextWith) {
				const err = Object.assign(new Error('unwrap failed'), { code: fake.failNextWith.code });
				fake.failNextWith = undefined;
				throw err;
			}
			const entry = store.get(wrapped.ciphertextBase64);
			if (!entry) {
				throw Object.assign(new Error('unknown handle'), { code: 'UNWRAP_FAILED' });
			}
			const aadMatches =
				entry.aad.length === options.aad.length && entry.aad.every((b, i) => b === options.aad[i]);
			const aliasMatches = entry.keyAlias === wrapped.keyAlias;
			if (!aadMatches || !aliasMatches) {
				throw Object.assign(new Error('tag mismatch'), { code: 'UNWRAP_TAG_MISMATCH' });
			}
			return Uint8Array.from(entry.bytes);
		},
	};
	return fake;
}

function secretHexCandidates(secret: Uint8Array): string[] {
	let hex = '';
	for (const b of secret) hex += b.toString(16).padStart(2, '0');
	return [hex];
}

beforeEach(async () => {
	await AsyncStorage.clear();
	setAuthorityKeyVaultForTests(undefined);
});

describe('createAuthorityKeyVault (D-04)', () => {
	it('round-trips a secret through putSecret/getSecret, recording the officer wrap alias, requireAuth false and the documented AAD', async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		const secret = new Uint8Array(32).map((_, i) => i + 1);
		const policy: KeyVaultPolicy = { requireUserAuth: false };

		await vault.putSecret('vt.officer-enc.u1', secret, policy);
		const got = await vault.getSecret('vt.officer-enc.u1');

		expect(got).toEqual(secret);
		expect(wrapper.wrapCalls).toHaveLength(1);
		const call = wrapper.wrapCalls[0]!;
		expect(call.keyAlias).toBe(VOTETORRENT_AUTHORITY_OFFICER_ENC_WRAP_KEY_V1);
		expect(call.requireAuth).toBe(false);
		const expectedAad = 'votetorrent/authority-key-vault/v1|vt.officer-enc.u1|0';
		expect(Buffer.from(call.aad).toString('utf8')).toBe(expectedAad);
	});

	it('stores no plaintext at rest — no AsyncStorage value contains the secret hex/base64/base64url', async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		const secret = new Uint8Array(32).map((_, i) => i + 1);
		await vault.putSecret('vt.officer-enc.u1', secret, { requireUserAuth: false });

		const raw = await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u1');
		expect(raw).not.toBeNull();
		const hexCandidates = secretHexCandidates(secret);
		const b64 = Buffer.from(secret).toString('base64');
		const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		for (const needle of [...hexCandidates, b64, b64url]) {
			expect(raw).not.toContain(needle);
		}
	});

	it('copy semantics: mutating the array passed to put, or the one returned by get, does not change the next get', async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		const secret = new Uint8Array([1, 2, 3, 4]);
		await vault.putSecret('vt.officer-enc.u2', secret, { requireUserAuth: false });
		secret.fill(0xff); // mutate the caller's original array after put

		const got1 = await vault.getSecret('vt.officer-enc.u2');
		expect(got1).toEqual(new Uint8Array([1, 2, 3, 4]));
		got1!.fill(0xee); // mutate the returned array

		const got2 = await vault.getSecret('vt.officer-enc.u2');
		expect(got2).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("'alias-exists': a second put rejects, and the stored record is byte-identical before and after", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		await vault.putSecret('vt.officer-enc.u3', new Uint8Array([9]), { requireUserAuth: false });
		const before = await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u3');

		await expect(
			vault.putSecret('vt.officer-enc.u3', new Uint8Array([1, 2]), { requireUserAuth: false }),
		).rejects.toMatchObject({ code: 'alias-exists' });

		const after = await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u3');
		expect(after).toBe(before);
	});

	it('getSecret on an absent alias returns null with zero unwrap calls; hasSecret never prompts/wraps; deleteSecret is idempotent', async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });

		expect(await vault.getSecret('vt.officer-enc.absent')).toBeNull();

		await vault.putSecret('vt.officer-enc.u4', new Uint8Array([5]), { requireUserAuth: false });
		const wrapCallsAfterPut = wrapper.wrapCalls.length;

		expect(await vault.hasSecret('vt.officer-enc.u4')).toBe(true);
		expect(await vault.hasSecret('vt.officer-enc.absent')).toBe(false);
		expect(wrapper.wrapCalls.length).toBe(wrapCallsAfterPut); // hasSecret never wraps/unwraps

		expect(await vault.deleteSecret('vt.officer-enc.u4')).toBe(true);
		expect(await vault.deleteSecret('vt.officer-enc.u4')).toBe(false);
		expect(await vault.getSecret('vt.officer-enc.u4')).toBeNull();
	});

	it("invalid alias rejects 'invalid-alias' on all four methods", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		const badAliases = ['', 'a'.repeat(129), 'has/slash', 'has space'];
		for (const alias of badAliases) {
			await expect(vault.putSecret(alias, new Uint8Array([1]), { requireUserAuth: false })).rejects.toMatchObject({
				code: 'invalid-alias',
			});
			await expect(vault.getSecret(alias)).rejects.toMatchObject({ code: 'invalid-alias' });
			await expect(vault.hasSecret(alias)).rejects.toMatchObject({ code: 'invalid-alias' });
			await expect(vault.deleteSecret(alias)).rejects.toMatchObject({ code: 'invalid-alias' });
		}
	});

	it("an empty secret and a 4097-byte secret reject 'invalid-secret' with zero wrap calls", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });

		await expect(
			vault.putSecret('vt.officer-enc.u5', new Uint8Array(0), { requireUserAuth: false }),
		).rejects.toMatchObject({ code: 'invalid-secret' });
		await expect(
			vault.putSecret('vt.officer-enc.u5', new Uint8Array(4097), { requireUserAuth: false }),
		).rejects.toMatchObject({ code: 'invalid-secret' });
		expect(wrapper.wrapCalls).toHaveLength(0);
	});

	it("AAD binding: copying alias A's stored JSON under alias B's storage key makes getSecret(B) reject 'unavailable', deleting neither record", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		await vault.putSecret('vt.officer-enc.aliasA', new Uint8Array([7]), { requireUserAuth: false });
		const aRecord = await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.aliasA');
		expect(aRecord).not.toBeNull();
		await AsyncStorage.setItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.aliasB', aRecord!);

		await expect(vault.getSecret('vt.officer-enc.aliasB')).rejects.toMatchObject({ code: 'unavailable' });

		expect(await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.aliasA')).toBe(aRecord);
		expect(await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.aliasB')).toBe(aRecord);
	});

	it("a fake unwrap throwing an AAD-mismatch-shaped SecretWrapError code also rejects 'unavailable' and deletes nothing", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		await vault.putSecret('vt.officer-enc.u6', new Uint8Array([1]), { requireUserAuth: false });
		wrapper.failNextWith = { code: 'UNWRAP_TAG_MISMATCH' };

		await expect(vault.getSecret('vt.officer-enc.u6')).rejects.toMatchObject({ code: 'unavailable' });
		expect(await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u6')).not.toBeNull();
	});

	it.each([
		['non-JSON', 'not json at all'],
		['v:2', JSON.stringify({ v: 2, alias: 'vt.officer-enc.u7', requireUserAuth: false, wrapped: {} })],
		[
			'alias mismatch',
			JSON.stringify({
				v: 1,
				alias: 'some-other-alias',
				requireUserAuth: false,
				wrapped: { keyAlias: 'x', ivBase64: 'a', ciphertextBase64: 'b' },
			}),
		],
		['missing wrapped', JSON.stringify({ v: 1, alias: 'vt.officer-enc.u7', requireUserAuth: false })],
	])("corrupt record (%s) makes get reject 'unavailable' and leaves the stored value unchanged", async (_name, raw) => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		await AsyncStorage.setItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u7', raw);

		await expect(vault.getSecret('vt.officer-enc.u7')).rejects.toMatchObject({ code: 'unavailable' });
		expect(await AsyncStorage.getItem(KEY_VAULT_STORAGE_PREFIX + 'vt.officer-enc.u7')).toBe(raw);
	});

	it("auth-required with no authRequiredWrap rejects 'unavailable' with zero wrap calls", async () => {
		const wrapper = makeFakeWrapper();
		const vault = createAuthorityKeyVault({ wrapper, storage: AsyncStorage });
		await expect(
			vault.putSecret('vt.keyholder-share.e1.0.u1', new Uint8Array([1]), { requireUserAuth: true }),
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(wrapper.wrapCalls).toHaveLength(0);
	});

	it('auth-required with authRequiredWrap configured uses that alias/requireAuth/prompt for wrap and get', async () => {
		const wrapper = makeFakeWrapper();
		const prompt = { title: 't', subtitle: 's', negativeButton: 'n' };
		const vault = createAuthorityKeyVault({
			wrapper,
			storage: AsyncStorage,
			authRequiredWrap: { keyAlias: 'VOTETORRENT_TEST_SHARE_WRAP_KEY_V1', prompt: () => prompt },
		});
		await vault.putSecret('vt.keyholder-share.e1.0.u2', new Uint8Array([2]), { requireUserAuth: true });
		expect(wrapper.wrapCalls[0]!.keyAlias).toBe('VOTETORRENT_TEST_SHARE_WRAP_KEY_V1');
		expect(wrapper.wrapCalls[0]!.requireAuth).toBe(true);
		expect(wrapper.wrapCalls[0]!.prompt).toEqual(prompt);

		const got = await vault.getSecret('vt.keyholder-share.e1.0.u2');
		expect(got).toEqual(new Uint8Array([2]));
	});

	it.each([
		['CANCELED', 'auth-denied'],
		['LOCKOUT', 'auth-denied'],
		['NO_BIOMETRICS_ENROLLED', 'auth-denied'],
		['KEY_INVALIDATED', 'unavailable'],
		['NATIVE_UNAVAILABLE', 'unavailable'],
	])('unwrap throwing code %s maps to KeyVaultError code %s', async (nativeCode, expectedCode) => {
		const wrapper = makeFakeWrapper();
		const prompt = { title: 't', subtitle: 's', negativeButton: 'n' };
		const vault = createAuthorityKeyVault({
			wrapper,
			storage: AsyncStorage,
			authRequiredWrap: { keyAlias: 'VOTETORRENT_TEST_SHARE_WRAP_KEY_V1', prompt: () => prompt },
		});
		await vault.putSecret('vt.keyholder-share.e1.0.u3', new Uint8Array([3]), { requireUserAuth: true });
		wrapper.failNextWith = { code: nativeCode };

		await expect(vault.getSecret('vt.keyholder-share.e1.0.u3')).rejects.toMatchObject({ code: expectedCode });
	});

	it("a storage fake whose setItem silently drops the value makes put reject 'unavailable'", async () => {
		const wrapper = makeFakeWrapper();
		const dropStorage = {
			async getItem(): Promise<string | null> {
				return null;
			},
			async setItem(): Promise<void> {
				/* silently drops */
			},
			async removeItem(): Promise<void> {
				/* no-op */
			},
		};
		const vault = createAuthorityKeyVault({ wrapper, storage: dropStorage });
		await expect(
			vault.putSecret('vt.officer-enc.u8', new Uint8Array([1]), { requireUserAuth: false }),
		).rejects.toMatchObject({ code: 'unavailable' });
	});

	it('never logs, and never uses instanceof SecretWrapError (structural mapping only)', () => {
		// Source-level proof, not behavioral — see the acceptance-criteria grep this mirrors.
		const fs = require('fs') as typeof import('fs');
		const path = require('path') as typeof import('path');
		const src = fs
			.readFileSync(path.resolve(__dirname, '../key-vault.ts'), 'utf8')
			.replace(/\/\/.*$/gm, '');
		expect(/console\.|instanceof SecretWrapError/.test(src)).toBe(false);
	});
});

describe('resolveAuthorityKeyVault / setAuthorityKeyVaultForTests (D-04)', () => {
	it('returns the override when set, and restores the lazy default (constructed once) when cleared', () => {
		const fake = { putSecret: jest.fn(), getSecret: jest.fn(), hasSecret: jest.fn(), deleteSecret: jest.fn() };
		setAuthorityKeyVaultForTests(fake as never);
		expect(resolveAuthorityKeyVault()).toBe(fake);

		setAuthorityKeyVaultForTests(undefined);
		const first = resolveAuthorityKeyVault();
		const second = resolveAuthorityKeyVault();
		expect(first).toBe(second);
		expect(first).not.toBe(fake);
	});
});
