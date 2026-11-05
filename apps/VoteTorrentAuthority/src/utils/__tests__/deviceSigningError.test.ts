import {
	CODE_TO_CLASS,
	DEVICE_SIGNING_ERROR_COPY_KEY,
	isDeviceSigningError,
	isNavigationClass,
	mapDeviceSigningError,
} from '../deviceSigningError';

describe('deviceSigningError (D-13 taxonomy)', () => {
	test('every code in CODE_TO_CLASS maps to its declared class', () => {
		for (const [code, expectedClass] of Object.entries(CODE_TO_CLASS)) {
			expect(mapDeviceSigningError({ code })).toBe(expectedClass);
		}
	});

	test('undefined maps to biometric-error', () => {
		expect(mapDeviceSigningError(undefined)).toBe('biometric-error');
	});

	test('null maps to biometric-error', () => {
		expect(mapDeviceSigningError(null)).toBe('biometric-error');
	});

	test('an empty object maps to biometric-error', () => {
		expect(mapDeviceSigningError({})).toBe('biometric-error');
	});

	test('a plain Error (no code) maps to biometric-error', () => {
		expect(mapDeviceSigningError(new Error('x'))).toBe('biometric-error');
	});

	test('an unrecognized code maps to biometric-error', () => {
		expect(mapDeviceSigningError({ code: 'SOMETHING_NEW' })).toBe('biometric-error');
	});

	test('the explicit BIOMETRIC_ERROR code also maps to biometric-error (via the default branch)', () => {
		expect(mapDeviceSigningError({ code: 'BIOMETRIC_ERROR' })).toBe('biometric-error');
	});

	test('CANCELED maps to cancellation', () => {
		expect(mapDeviceSigningError({ code: 'CANCELED' })).toBe('cancellation');
	});

	test('SYSTEM_CANCELED (a system cancel, review CR-01) maps to cancellation too: no new copy', () => {
		expect(mapDeviceSigningError({ code: 'SYSTEM_CANCELED' })).toBe('cancellation');
		expect(DEVICE_SIGNING_ERROR_COPY_KEY[mapDeviceSigningError({ code: 'SYSTEM_CANCELED' })]).toBeUndefined();
	});

	test('DEVICE_SIGNING_ERROR_COPY_KEY has no entry for cancellation, key-invalidated, no-key-provisioned, no-device-credential, or recovery-unsupported-os', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['cancellation']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['key-invalidated']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-key-provisioned']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-device-credential']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-unsupported-os']).toBeUndefined();
	});

	test('DEVICE_SIGNING_ERROR_COPY_KEY has an entry for each of the four inline-rendered classes', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-biometrics-enrolled']).toBe(
			'deviceSigningErrorNoBiometricsEnrolled'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['lockout']).toBe('deviceSigningErrorLockout');
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['lockout-permanent']).toBe(
			'deviceSigningErrorLockoutPermanent'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['biometric-error']).toBe('deviceSigningErrorGeneric');
	});

	test('isNavigationClass is true for exactly key-invalidated and no-key-provisioned', () => {
		expect(isNavigationClass('key-invalidated')).toBe(true);
		expect(isNavigationClass('no-key-provisioned')).toBe(true);

		expect(isNavigationClass('cancellation')).toBe(false);
		expect(isNavigationClass('no-biometrics-enrolled')).toBe(false);
		expect(isNavigationClass('lockout')).toBe(false);
		expect(isNavigationClass('lockout-permanent')).toBe(false);
		expect(isNavigationClass('biometric-error')).toBe(false);
		expect(isNavigationClass('no-device-credential')).toBe(false);
		expect(isNavigationClass('recovery-unsupported-os')).toBe(false);
	});
});

// Plan 19 (D-26a rescope, 2026-08-21): the native `signWithRecoveryKey` now rejects
// `RECOVERY_UNSUPPORTED_OS` on API < 30, before any ceremony starts — a terminal class,
// deliberately absent from the inline copy map, and not a navigation class (there is no
// ceremony on the provisioning screen that could resolve it).
describe('recovery-unsupported-os (49-19, D-26a rescope)', () => {
	test('RECOVERY_UNSUPPORTED_OS maps to recovery-unsupported-os', () => {
		expect(mapDeviceSigningError({ code: 'RECOVERY_UNSUPPORTED_OS' })).toBe('recovery-unsupported-os');
	});

	test('DEVICE_SIGNING_ERROR_COPY_KEY has no entry for recovery-unsupported-os — it renders a terminal screen, never InlineError', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-unsupported-os']).toBeUndefined();
	});

	test('isNavigationClass is false for recovery-unsupported-os — no ceremony exists to route to', () => {
		expect(isNavigationClass('recovery-unsupported-os')).toBe(false);
	});

	test('isDeviceSigningError recognizes RECOVERY_UNSUPPORTED_OS as a device-signing rejection', () => {
		expect(isDeviceSigningError({ code: 'RECOVERY_UNSUPPORTED_OS' })).toBe(true);
	});

	test('a near-miss code (RECOVERY_UNSUPPORTED, no _OS suffix) still maps to biometric-error — exact match, not prefix match', () => {
		expect(mapDeviceSigningError({ code: 'RECOVERY_UNSUPPORTED' })).toBe('biometric-error');
	});
});

// 49-14 follow-up (D-16 observability defect + DeleteValid precondition, root-caused on real
// hardware this session — see 49-14-PROOF-LOG.md's "Follow-up session — prerequisite diagnosis"
// section). Two NEW classes: `recovery-key-invalidated` (native's `provisionRecoveryKey` now
// rejects with a distinct code instead of silently regenerating an invalidated alias) and
// `recovery-key-not-registered` (JS-thrown by `handleRecovery`'s own precondition check, never a
// native code). Both render INLINE — neither is a navigation class, and both have dedicated,
// non-generic copy.
describe('recovery-key-invalidated / recovery-key-not-registered (49-14 follow-up)', () => {
	test('RECOVERY_KEY_INVALIDATED maps to recovery-key-invalidated', () => {
		expect(mapDeviceSigningError({ code: 'RECOVERY_KEY_INVALIDATED' })).toBe(
			'recovery-key-invalidated'
		);
	});

	test('RECOVERY_KEY_NOT_REGISTERED maps to recovery-key-not-registered', () => {
		expect(mapDeviceSigningError({ code: 'RECOVERY_KEY_NOT_REGISTERED' })).toBe(
			'recovery-key-not-registered'
		);
	});

	test('both classes have dedicated, non-generic inline copy keys', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-key-invalidated']).toBe(
			'deviceSigningErrorRecoveryKeyInvalidated'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-key-not-registered']).toBe(
			'deviceSigningErrorRecoveryKeyNotRegistered'
		);
		// Neither collapses into the generic "couldn't verify your biometrics" copy — that
		// collapse is exactly the T-49-USER-7 masking this follow-up exists to prevent.
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-key-invalidated']).not.toBe(
			'deviceSigningErrorGeneric'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['recovery-key-not-registered']).not.toBe(
			'deviceSigningErrorGeneric'
		);
	});

	test('neither class is a navigation class', () => {
		expect(isNavigationClass('recovery-key-invalidated')).toBe(false);
		expect(isNavigationClass('recovery-key-not-registered')).toBe(false);
	});
});

// Frozen literal copy of CODE_TO_CLASS taken before the O-10 fix.
const EXPECTED_SNAPSHOT: Record<string, string> = {
	CANCELED: 'cancellation',
	// Added by Phase 65 review CR-01 (after the O-10 snapshot): a system cancel, same class.
	SYSTEM_CANCELED: 'cancellation',
	NO_BIOMETRICS_ENROLLED: 'no-biometrics-enrolled',
	LOCKOUT: 'lockout',
	LOCKOUT_PERMANENT: 'lockout-permanent',
	KEY_INVALIDATED_REASSOCIATE: 'key-invalidated',
	NO_KEY_PROVISIONED: 'no-key-provisioned',
	NO_DEVICE_CREDENTIAL: 'no-device-credential',
	RECOVERY_KEY_INVALIDATED: 'recovery-key-invalidated',
	RECOVERY_KEY_NOT_REGISTERED: 'recovery-key-not-registered',
	RECOVERY_UNSUPPORTED_OS: 'recovery-unsupported-os',
};

describe('own-property code lookup (O-10)', () => {
	const PROTOTYPE_NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

	test.each(PROTOTYPE_NAMES)('code %s is not a device-signing code and maps to biometric-error', code => {
		expect(isDeviceSigningError({ code })).toBe(false);
		expect(mapDeviceSigningError({ code })).toBe('biometric-error');
	});

	test('every real code keeps its exact class (snapshot taken before the fix)', () => {
		expect({ ...CODE_TO_CLASS }).toEqual(EXPECTED_SNAPSHOT);
		for (const [code, cls] of Object.entries(EXPECTED_SNAPSHOT)) {
			expect(mapDeviceSigningError({ code })).toBe(cls);
			expect(isDeviceSigningError({ code })).toBe(true);
		}
	});

	test('a non-string code is not mine and maps to biometric-error', () => {
		for (const code of [5, {}, ['CANCELED'], null]) {
			expect(isDeviceSigningError({ code })).toBe(false);
			expect(mapDeviceSigningError({ code })).toBe('biometric-error');
		}
	});
});
