/**
 * Behavioral tests for useDeviceSigningErrorHandler (49-11).
 *
 * Pins the hook's entire outcome contract:
 *   1. Each of the three navigating classes ('key-invalidated',
 *      'no-key-provisioned', 'no-device-credential') produces exactly one
 *      `navigate` call with the exact route name and `reason` value, and
 *      returns `{ handled: true }`.
 *   2. `{ code: 'CANCELED' }` returns `{ handled: true }` with no `navigate`
 *      call and no message.
 *   3. Each of the four inline classes returns `{ handled: false, message }`
 *      with the expected i18n key resolved.
 *   4. `new Error('engine write failed')`, `undefined`, `{}`, and
 *      `{ code: 'SOMETHING_NEW' }` all return `{ handled: false, message:
 *      undefined }` with no `navigate` call — the pass-through case that
 *      protects every non-device error at every call site.
 *
 * Approach mirrors useCurrentOfficerScopes.test.tsx: a minimal host component
 * exposing the handler via a testID-driven trigger, module-scope mocks for
 * @react-navigation/native and react-i18next.
 */

import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks — must be at module scope (jest hoists jest.mock calls).
// ---------------------------------------------------------------------------

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useDeviceSigningErrorHandler } = require('../useDeviceSigningErrorHandler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const deviceSigningErrorModule = require('../../utils/deviceSigningError');

// ---------------------------------------------------------------------------
// Host component: exposes the handler's outcome for an on-press error.
// ---------------------------------------------------------------------------

let lastOutcome: { handled: boolean; message?: string } | undefined;

function Harness({ err }: { err: unknown }) {
	const handle = useDeviceSigningErrorHandler();
	return (
		<TouchableOpacity
			testID="trigger"
			onPress={() => {
				lastOutcome = handle(err);
			}}
		>
			<Text>trigger</Text>
		</TouchableOpacity>
	);
}

function run(err: unknown): { handled: boolean; message?: string } {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<Harness err={err} />);
	});
	renderer.act(() => {
		tr.root.findByProps({ testID: 'trigger' }).props.onPress();
	});
	return lastOutcome!;
}

beforeEach(() => {
	jest.clearAllMocks();
	lastOutcome = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDeviceSigningErrorHandler — 49-11 outcome contract', () => {
	describe('navigating classes', () => {
		it("'key-invalidated' navigates to ProvisionSigningKey with reason: 'invalidated'", () => {
			const outcome = run({ code: 'KEY_INVALIDATED_REASSOCIATE' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});

		it("'no-key-provisioned' navigates to ProvisionSigningKey with reason: 'first-run'", () => {
			const outcome = run({ code: 'NO_KEY_PROVISIONED' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'first-run' });
			expect(outcome).toEqual({ handled: true });
		});

		it("'no-device-credential' navigates to ProvisionSigningKey with reason: 'invalidated'", () => {
			const outcome = run({ code: 'NO_DEVICE_CREDENTIAL' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});
	});

	describe('cancellation', () => {
		it("{ code: 'CANCELED' } returns handled:true with no navigate call and no message", () => {
			const outcome = run({ code: 'CANCELED' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: true });
			expect(outcome.message).toBeUndefined();
		});
	});

	describe('inline classes', () => {
		it("'no-biometrics-enrolled' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'NO_BIOMETRICS_ENROLLED' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({
				handled: false,
				message: 'deviceSigningErrorNoBiometricsEnrolled',
			});
		});

		it("'lockout' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'LOCKOUT' });

			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorLockout' });
		});

		it("'lockout-permanent' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'LOCKOUT_PERMANENT' });

			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorLockoutPermanent' });
		});

		it("'biometric-error' returns handled:false with the expected copy key (the hook's own switch branch — 'biometric-error' is mapDeviceSigningError's default for a code the taxonomy's lookup table does not recognize, which isDeviceSigningError's gate excludes by design; spying on the taxonomy functions isolates this branch from that gate rather than contradicting it)", () => {
			const isDeviceSigningErrorSpy = jest
				.spyOn(deviceSigningErrorModule, 'isDeviceSigningError')
				.mockReturnValueOnce(true);
			const mapDeviceSigningErrorSpy = jest
				.spyOn(deviceSigningErrorModule, 'mapDeviceSigningError')
				.mockReturnValueOnce('biometric-error');

			const outcome = run({ code: 'BIOMETRIC_ERROR' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorGeneric' });

			isDeviceSigningErrorSpy.mockRestore();
			mapDeviceSigningErrorSpy.mockRestore();
		});
	});

	describe('SignatureValid CHECK failures are not key-replacement routes (desync detection lives in device-signer self-verify)', () => {
		it('H1: a bare SignatureValid CHECK failure (any table, e.g. the requester signature) does not navigate and is not handled', () => {
			const outcome = run(new Error('Quereus error (code 19): CHECK constraint failed: SignatureValid'));

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it('H2: a KEY_INVALIDATED_REASSOCIATE-coded error still navigates to ProvisionSigningKey with reason: invalidated', () => {
			const outcome = run({ code: 'KEY_INVALIDATED_REASSOCIATE' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});

		it('an unrelated CHECK failure falls through to pass-through', () => {
			const outcome = run(new Error('CHECK constraint failed: RevisionDeadlineValid'));

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});
	});

	describe('pass-through — the "not mine" case', () => {
		it('a generic Error yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run(new Error('engine write failed'));

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it('undefined yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run(undefined);

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it('{} yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run({});

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it("{ code: 'SOMETHING_NEW' } (unrecognized code) yields handled:false, message:undefined, and no navigate call", () => {
			const outcome = run({ code: 'SOMETHING_NEW' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});
	});
});

describe('useDeviceSigningErrorHandler — peer-unavailable write classification (62-96)', () => {
	const MSG =
		'Block default/app/TidHighWater is unavailable (cohort-unreachable): the repo could not determine whether it exists';
	const expected = { handled: false, message: 'peerWriteUnavailable' };

	it('H-1a: the bare test-19 message maps to the translated write copy, no navigation', () => {
		expect(run(new Error(MSG))).toEqual(expected);
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it('H-1b: an Error wrapping the message as cause maps to the write copy', () => {
		expect(run(new Error('write failed', { cause: new Error(MSG) }))).toEqual(expected);
	});

	it('H-1c: the engine-wrapped "Unknown error ...: QuereusError: ..." string form maps to the write copy', () => {
		const wrapped = new Error(`Unknown error during INSERT: QuereusError: ${MSG}`);
		expect(run(wrapped)).toEqual(expected);
	});

	it('H-2: a recognised device-signing code wins over peer classification', () => {
		const outcome = run({ code: 'LOCKOUT', message: MSG });
		expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorLockout' });
		const nav = run({ code: 'KEY_INVALIDATED_REASSOCIATE', message: MSG });
		expect(nav).toEqual({ handled: true });
	});

	it('H-3: a plain constraint failure still passes through', () => {
		expect(run(new Error('constraint failed'))).toEqual({ handled: false, message: undefined });
	});

	it('H-4: a caller using the documented shape renders the translated copy and no raw text', () => {
		function Caller() {
			const handle = useDeviceSigningErrorHandler();
			const [msg, setMsg] = React.useState('');
			return (
				<TouchableOpacity
					testID="save"
					onPress={() => {
						const err = new Error(`Unknown error during INSERT: QuereusError: ${MSG}`);
						const outcome = handle(err);
						if (outcome.handled) return;
						setMsg(outcome.message ?? (err instanceof Error ? err.message : String(err)));
					}}
				>
					<Text testID="shown">{msg}</Text>
				</TouchableOpacity>
			);
		}
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(<Caller />);
		});
		renderer.act(() => {
			tr.root.findByProps({ testID: 'save' }).props.onPress();
		});
		const shown = tr.root.findByProps({ testID: 'shown' }).props.children;
		expect(shown).toBe('peerWriteUnavailable');
		expect(JSON.stringify(tr.toJSON())).not.toContain('TidHighWater');
	});
});
