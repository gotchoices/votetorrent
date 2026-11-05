/**
 * Unit tests for attestation-failure.ts — the D-09 three-way failure classifier.
 *
 * `__DEV__` is a writable/configurable global under the react-native jest preset
 * (react-native/jest/setup.js) — toggled per-test and restored in `afterEach`, mirroring the
 * existing `attestation-producer.test.ts` convention.
 */

import {
	DEVICE_KEY_ABSENT_CODE,
	DEVICE_KEY_INVALIDATED_CODE,
	classifyAttestationFailure,
	isDeviceKeyAbsent,
	isDeviceKeyInvalidated,
} from '../attestation-failure';

/** The DeviceIdentityKeyUnavailableError SHAPE (name + reason) — built locally so this test never
 * loads device-user's storage/native-crypto graph, exactly like the classifier itself. */
function identityError(reason: string): Error {
	const err = new Error(`device identity key unavailable (${reason})`) as Error & {reason: string};
	err.name = 'DeviceIdentityKeyUnavailableError';
	err.reason = reason;
	return err;
}

describe('classifyAttestationFailure — D-09 three-way classifier', () => {
	const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;

	afterEach(() => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
	});

	describe('terminal-class codes', () => {
		it("classifies NO_STRONGBOX_OR_TEE as 'terminal' when __DEV__ is false", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;

			expect(classifyAttestationFailure({code: 'NO_STRONGBOX_OR_TEE'})).toBe('terminal');
		});

		it("downgrades NO_STRONGBOX_OR_TEE to 'recoverable-transient' when __DEV__ is true", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = true;

			expect(classifyAttestationFailure({code: 'NO_STRONGBOX_OR_TEE'})).toBe('recoverable-transient');
		});

		it("classifies DEVICE_INTEGRITY_FAILED as 'terminal' when __DEV__ is false", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;

			expect(classifyAttestationFailure({code: 'DEVICE_INTEGRITY_FAILED'})).toBe('terminal');
		});

		it("downgrades DEVICE_INTEGRITY_FAILED to 'recoverable-transient' when __DEV__ is true", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = true;

			expect(classifyAttestationFailure({code: 'DEVICE_INTEGRITY_FAILED'})).toBe('recoverable-transient');
		});

		it("classifies PROVISION_FAILED as 'terminal' when __DEV__ is false", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;

			expect(classifyAttestationFailure({code: 'PROVISION_FAILED'})).toBe('terminal');
		});

		it("downgrades PROVISION_FAILED to 'recoverable-transient' when __DEV__ is true", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = true;

			expect(classifyAttestationFailure({code: 'PROVISION_FAILED'})).toBe('recoverable-transient');
		});
	});

	describe('recoverable-action-class codes', () => {
		it("classifies NO_BIOMETRICS_ENROLLED as 'recoverable-action' when __DEV__ is false", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;

			expect(classifyAttestationFailure({code: 'NO_BIOMETRICS_ENROLLED'})).toBe('recoverable-action');
		});

		it("classifies NO_BIOMETRICS_ENROLLED as 'recoverable-action' when __DEV__ is true", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = true;

			expect(classifyAttestationFailure({code: 'NO_BIOMETRICS_ENROLLED'})).toBe('recoverable-action');
		});
	});

	describe('recoverable-transient-class codes', () => {
		it("classifies LOCKOUT as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({code: 'LOCKOUT'})).toBe('recoverable-transient');
		});

		it("classifies PLAY_INTEGRITY_ERROR as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({code: 'PLAY_INTEGRITY_ERROR'})).toBe('recoverable-transient');
		});

		it("classifies PLAY_INTEGRITY_NETWORK as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({code: 'PLAY_INTEGRITY_NETWORK'})).toBe('recoverable-transient');
		});
	});

	describe('vote-engine IntakeError — the authority intake, not the device', () => {
		function intakeError(code: string): Error {
			const err = new Error(`createIntakeSealer.seal: ${code}`) as Error & {code: string};
			err.name = 'IntakeError';
			err.code = code;
			return err;
		}

		it("classifies an IntakeError('no-recipients') as 'intake-unavailable'", () => {
			expect(classifyAttestationFailure(intakeError('no-recipients'))).toBe('intake-unavailable');
		});

		it("classifies every IntakeError code as 'intake-unavailable', in release and __DEV__", () => {
			for (const dev of [false, true]) {
				(globalThis as {__DEV__?: boolean}).__DEV__ = dev;
				for (const code of ['no-recipients', 'too-many-recipients', 'seal-failed', 'not-authorized', 'invalid-argument']) {
					expect(classifyAttestationFailure(intakeError(code))).toBe('intake-unavailable');
				}
			}
		});

		it("a bare {code: 'no-recipients'} without the IntakeError name stays 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({code: 'no-recipients'})).toBe('recoverable-transient');
		});
	});

	describe("'identity-lost' — a permanently unrecoverable device identity (WR-02)", () => {
		it("classifies no-wrap-key / tag-mismatch / key-mismatch as 'identity-lost', in release and __DEV__", () => {
			for (const dev of [false, true]) {
				(globalThis as {__DEV__?: boolean}).__DEV__ = dev;
				for (const reason of ['no-wrap-key', 'tag-mismatch', 'key-mismatch']) {
					expect(classifyAttestationFailure(identityError(reason))).toBe('identity-lost');
				}
			}
		});

		it("a transient identity reason stays 'recoverable-transient' (never mints a new identity)", () => {
			for (const dev of [false, true]) {
				(globalThis as {__DEV__?: boolean}).__DEV__ = dev;
				for (const reason of ['ambiguous-record', 'wrap-unavailable', 'native-error']) {
					expect(classifyAttestationFailure(identityError(reason))).toBe('recoverable-transient');
				}
			}
		});

		it('matches by name + reason, never by message text', () => {
			expect(classifyAttestationFailure(new Error('device identity key unavailable (no-wrap-key)'))).toBe(
				'recoverable-transient',
			);
			expect(classifyAttestationFailure({reason: 'no-wrap-key'})).toBe('recoverable-transient');
		});

		it('NoElectionConfiguredError and IntakeError keep their classes', () => {
			expect(classifyAttestationFailure(Object.assign(new Error('x'), {name: 'NoElectionConfiguredError'}))).toBe(
				'no-election',
			);
			expect(classifyAttestationFailure(Object.assign(new Error('x'), {name: 'IntakeError', code: 'no-recipients'}))).toBe(
				'intake-unavailable',
			);
		});

		it('the DEVICE_KEY_* lookup predicates are unchanged', () => {
			expect(DEVICE_KEY_ABSENT_CODE).toBe('DEVICE_KEY_ABSENT');
			expect(DEVICE_KEY_INVALIDATED_CODE).toBe('DEVICE_KEY_INVALIDATED');
			expect(isDeviceKeyAbsent({code: 'DEVICE_KEY_ABSENT'})).toBe(true);
			expect(isDeviceKeyInvalidated({code: 'DEVICE_KEY_INVALIDATED'})).toBe(true);
			expect(isDeviceKeyAbsent(identityError('no-wrap-key'))).toBe(false);
			expect(classifyAttestationFailure({code: 'DEVICE_KEY_ABSENT'})).toBe('recoverable-transient');
		});
	});

	describe('unknown / missing code — never silently terminal', () => {
		it("classifies an empty error object as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({})).toBe('recoverable-transient');
		});

		it("classifies an unrecognized code as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure({code: 'SOME_FUTURE_CODE'})).toBe('recoverable-transient');
		});

		it("classifies a plain Error (no code) as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure(new Error('boom'))).toBe('recoverable-transient');
		});

		it("classifies null/undefined as 'recoverable-transient'", () => {
			expect(classifyAttestationFailure(null)).toBe('recoverable-transient');
			expect(classifyAttestationFailure(undefined)).toBe('recoverable-transient');
		});

		it("never classifies an unknown code as 'terminal', even outside __DEV__", () => {
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;

			expect(classifyAttestationFailure({code: 'SOME_FUTURE_CODE'})).not.toBe('terminal');
		});
	});
});
