/**
 * Unit tests for attestation-failure.ts — the D-09 three-way failure classifier.
 *
 * `__DEV__` is a writable/configurable global under the react-native jest preset
 * (react-native/jest/setup.js) — toggled per-test and restored in `afterEach`, mirroring the
 * existing `attestation-producer.test.ts` convention.
 */

import {classifyAttestationFailure} from '../attestation-failure';

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
