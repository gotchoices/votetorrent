/**
 * O-01 app half: renewOfficerIntakeKeyAfterKeyReplacement (A1) and the coded superseded error (A2).
 * Fake engines only; the engine behaviour itself is proven in vote-engine intake-key-renewal.spec.ts.
 */
import type { Signature } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	enableOfficerEncryptedIntake,
	isIntakeKeySupersededError,
	renewOfficerIntakeKeyAfterKeyReplacement,
} from '../officer-intake-key';

const vault = {} as IKeyVault;
const sig: Signature = { signerUserId: 'u', signerKey: 'k', signature: 's' };

function makeDeps(engine: unknown) {
	const createSigner = jest.fn(async () => async () => sig);
	return {
		createSigner,
		deps: { getEngine: (async () => engine) as never, vault, createSigner },
	};
}

describe('renewOfficerIntakeKeyAfterKeyReplacement (A1)', () => {
	for (const outcome of ['not-needed', 'no-local-key', 'not-an-officer'] as const) {
		it(`passes ${outcome} through without ever creating a signer`, async () => {
			const { deps, createSigner } = makeDeps({ renewStrandedOfficerEncryptionKey: async () => outcome });
			await expect(renewOfficerIntakeKeyAfterKeyReplacement(deps)).resolves.toBe(outcome);
			expect(createSigner).not.toHaveBeenCalled();
		});
	}

	it('renewed creates the signer exactly once, lazily inside the engine sign callback', async () => {
		const { deps, createSigner } = makeDeps({
			renewStrandedOfficerEncryptionKey: async (_v: IKeyVault, sign: (d: Uint8Array) => Promise<Signature>) => {
				expect(createSigner).not.toHaveBeenCalled();
				await sign(new Uint8Array([1]));
				return 'renewed';
			},
		});
		await expect(renewOfficerIntakeKeyAfterKeyReplacement(deps)).resolves.toBe('renewed');
		expect(createSigner).toHaveBeenCalledTimes(1);
	});

	it('resolves failed (never rejects) on an engine throw and on a signer cancel', async () => {
		const a = makeDeps({
			renewStrandedOfficerEncryptionKey: async () => {
				throw new Error('boom');
			},
		});
		await expect(renewOfficerIntakeKeyAfterKeyReplacement(a.deps)).resolves.toBe('failed');
		const b = makeDeps({
			renewStrandedOfficerEncryptionKey: async (_v: IKeyVault, sign: (d: Uint8Array) => Promise<Signature>) => {
				await sign(new Uint8Array([1]));
				return 'renewed';
			},
		});
		b.createSigner.mockRejectedValueOnce(Object.assign(new Error('c'), { code: 'CANCELED' }));
		await expect(renewOfficerIntakeKeyAfterKeyReplacement(b.deps)).resolves.toBe('failed');
	});

	it('an engine without the method (mock) is unsupported', async () => {
		const { deps } = makeDeps({});
		await expect(renewOfficerIntakeKeyAfterKeyReplacement(deps)).resolves.toBe('unsupported');
	});
});

describe('enableOfficerEncryptedIntake superseded (A2)', () => {
	it('throws a coded error, not the plain English one, when the register result is superseded', async () => {
		const { deps } = makeDeps({
			getOfficerEncryptionKeyStatus: async () => ({ isIntakeRecipient: false }),
			registerOfficerEncryptionKey: async () => ({ outcome: 'already-registered', superseded: true }),
		});
		let caught: unknown;
		try {
			await enableOfficerEncryptedIntake(deps, 'a1');
		} catch (e) {
			caught = e;
		}
		expect(isIntakeKeySupersededError(caught)).toBe(true);
		expect((caught as Error).message).not.toMatch(/not active for this device/);
	});

	it('a stranded key that the engine renews ends enabled', async () => {
		let enabled = false;
		const { deps } = makeDeps({
			getOfficerEncryptionKeyStatus: async () => ({ isIntakeRecipient: enabled }),
			registerOfficerEncryptionKey: async () => {
				enabled = true;
				return { outcome: 'renewed' };
			},
		});
		await expect(enableOfficerEncryptedIntake(deps, 'a1')).resolves.toBe('enabled');
	});
});
