/**
 * registration-ceremony-parity.test.ts (phase 67 plan 11).
 *
 * The shared Voter registration ceremony (`@votetorrent/workflows/voter`, `registration-ceremony.ts`)
 * declares structural copies of the app's attempt record, transports, draft and store shapes, because the
 * shared package cannot import app modules. This file is where both sides are in scope, so it pins the
 * copies to the app originals at compile time (`yarn typecheck` fails on drift; a planted
 * `registrationStaged?:` was seen to break it), and pins the shared device-key "gone" predicate to the
 * app's `attestation-failure` codes at run time. Every app import is `import type` except the two code
 * constants, so no native module is loaded.
 */

import type {
	RegistrationAttemptRecord,
	clearRegistrationAttempt,
	readRegistrationAttempt,
	writeRegistrationAttempt,
} from '../../../engines/registration-attempt-store';
import type {VoterRequestTransports} from '../../../engines/voter-request-transports';
import type {RegistrationDraft} from '../../../providers/RegistrationDraftProvider';
import type {SignCallback as AppSignCallback} from '../../../engines/device-signer';
import type {AttestationProducer as AppAttestationProducer} from '../../../engines/attestation-producer';
import {DEVICE_KEY_ABSENT_CODE, DEVICE_KEY_INVALIDATED_CODE} from '../../../engines/attestation-failure';
import {createRegistrationCeremonyMemory, resolveAttemptDeviceKey} from '@votetorrent/workflows/voter';
import type {
	RegistrationCeremonyAttemptRecord,
	RegistrationCeremonyAttemptStore,
	RegistrationCeremonyDeps,
	RegistrationCeremonyDraft,
	RegistrationCeremonyTransports,
} from '@votetorrent/workflows/voter';

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assignable<A, B> = [A] extends [B] ? true : false;

const attemptRecordParity: Equal<RegistrationCeremonyAttemptRecord, RegistrationAttemptRecord> = true;
const transportsAssignable: Assignable<VoterRequestTransports, RegistrationCeremonyTransports> = true;
const draftAssignable: Assignable<RegistrationDraft, RegistrationCeremonyDraft> = true;
const storeAssignable: Assignable<
	{read: typeof readRegistrationAttempt; write: typeof writeRegistrationAttempt; clear: typeof clearRegistrationAttempt},
	RegistrationCeremonyAttemptStore
> = true;
const deviceSignAssignable: Assignable<AppSignCallback, RegistrationCeremonyDeps['deviceSign']> = true;
const producerAssignable: Assignable<AppAttestationProducer, RegistrationCeremonyDeps['producer']> = true;

/** A producer double for the device-key read: `getCurrentDeviceKey` rejects as told, `provisionDeviceKey` mints K2. */
function producerWithCurrentKeyRejecting(err: unknown): RegistrationCeremonyDeps['producer'] & {provisionCalls: number} {
	const producer = {
		provisionCalls: 0,
		provisionDeviceKey: async () => {
			producer.provisionCalls += 1;
			return {publicKey: 'K2'};
		},
		getCurrentDeviceKey: async (): Promise<{publicKey: string}> => {
			throw err;
		},
		produce: async () => {
			throw new Error('not reached');
		},
	};
	return producer;
}

function memoryWithAssociation() {
	const memory = createRegistrationCeremonyMemory();
	memory.deviceKey = 'K1';
	memory.associationRequestId = 'assoc-1';
	memory.associationRequestInit = {id: 'assoc-1', authorityId: 'auth', registrantId: 'reg', deviceKey: 'K1', submittedAt: 'now'};
	return memory;
}

describe('registration ceremony parity (Voter)', () => {
	it('P1: the compile-time pins hold (checked by yarn typecheck)', () => {
		expect([attemptRecordParity, transportsAssignable, draftAssignable, storeAssignable, deviceSignAssignable, producerAssignable]).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it.each([DEVICE_KEY_ABSENT_CODE, DEVICE_KEY_INVALIDATED_CODE])(
		"P2: the shared device-key 'gone' predicate matches the app's %s code: re-provision and drop the association",
		async code => {
			const memory = memoryWithAssociation();
			const producer = producerWithCurrentKeyRejecting(Object.assign(new Error('gone'), {code}));
			await expect(resolveAttemptDeviceKey(memory, producer)).resolves.toBe('K2');
			expect(memory.deviceKey).toBe('K2');
			expect(memory.associationRequestId).toBeNull();
			expect(memory.associationRequestInit).toBeNull();
			expect(producer.provisionCalls).toBe(1);
		},
	);

	it('P3: any other lookup code (LOCKOUT) propagates the same error object and provisions nothing', async () => {
		const memory = memoryWithAssociation();
		const lockout = Object.assign(new Error('locked'), {code: 'LOCKOUT'});
		const producer = producerWithCurrentKeyRejecting(lockout);
		await expect(resolveAttemptDeviceKey(memory, producer)).rejects.toBe(lockout);
		expect(producer.provisionCalls).toBe(0);
		expect(memory.deviceKey).toBe('K1');
		expect(memory.associationRequestId).toBe('assoc-1');
	});
});
