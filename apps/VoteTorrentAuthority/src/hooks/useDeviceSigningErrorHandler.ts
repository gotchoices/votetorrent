import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
	DEVICE_SIGNING_ERROR_COPY_KEY,
	isDeviceSigningError,
	mapDeviceSigningError,
} from '../utils/deviceSigningError';
import { peerUnavailableMessage } from '../utils/peerUnavailableMessage';

/**
 * useDeviceSigningErrorHandler — the single catch-block contract (49-11)
 * every migrated `createDeviceSigner` call site routes through.
 *
 * Caller shape (documented here, followed at every call site): invoke the
 * returned handler INSIDE your existing `catch (err) { ... }` block. If
 * `outcome.handled` is true, `return` immediately — the handler has already
 * done everything the UI needs (a navigation, or a deliberate no-op for a
 * cancellation). Otherwise, call your screen's existing `setErrorMessage`
 * with `outcome.message`. The "not mine" case returns `message` undefined, so a
 * caller keeps its own screen-specific key or uses `errorCopy` (utils/errorCopy);
 * never render the caught error's own message:
 *
 *   const handleDeviceSigningError = useDeviceSigningErrorHandler();
 *   try {
 *     ...
 *   } catch (err) {
 *     const outcome = handleDeviceSigningError(err);
 *     if (outcome.handled) return;
 *     setErrorMessage(outcome.message ?? errorCopy(err, t, 'write'));
 *   }
 *
 * Peer-unavailable writes: a joiner's first write after a cold start can reach
 * a silent restored cohort (allocateTid's TidHighWater read, or any unheld
 * table header) and fail `Block ... is unavailable (cohort-unreachable)`. The
 * engine writes nothing in that case, so retrying with the same button is
 * safe. In the "not mine" branch such a failure returns
 * `{ handled: false, message: t('peerWriteUnavailable') }`, so every screen
 * using the caller shape above shows translated copy with no change of its own.
 * Signing codes are checked FIRST; a peer failure is never relabelled as a
 * biometric failure and vice versa.
 *
 * This hook owns the ENTIRE mapping from a `signWithDeviceKey` native reject
 * code to a UI outcome — no call site re-derives any part of it. See
 * `deviceSigningError.ts` for the underlying D-13 taxonomy this hook
 * consumes (`mapDeviceSigningError`, `DEVICE_SIGNING_ERROR_COPY_KEY`) and the
 * 49-11 addition it also consumes (`isDeviceSigningError`).
 */
export type DeviceSigningErrorOutcome = { handled: boolean; message?: string };

export function useDeviceSigningErrorHandler(): (err: unknown) => DeviceSigningErrorOutcome {
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { t } = useTranslation();

	return useCallback(
		(err: unknown): DeviceSigningErrorOutcome => {
			// "Not mine": an error without a recognized device-signing `code`
			// (a plain Error, undefined, {}, or an unrecognized code) is left
			// entirely alone. The caller keeps its own raw-message fallback.
			// This is the single most important behavior in this file — it is
			// what keeps a real engine/network/validation failure from ever
			// being relabeled as a biometric failure (T-49-USER-7).
			if (!isDeviceSigningError(err)) {
				const peer = peerUnavailableMessage(err, t, 'write');
				if (peer) {
					console.warn('[signing] write peer unavailable');
					return { handled: false, message: peer };
				}
				return { handled: false, message: undefined };
			}

			const cls = mapDeviceSigningError(err);

			switch (cls) {
				case 'cancellation':
					// Per D-13: a dismissal is not a fault. No InlineError, no log.
					return { handled: true };

				case 'key-invalidated':
					navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
					return { handled: true };

				case 'no-key-provisioned':
					// 49-UI-SPEC.md's Contract, exact: there is deliberately no third
					// `reason: 'no-key-yet'` route param — this condition reuses the
					// visually-identical first-run variant.
					navigation.navigate('ProvisionSigningKey', { reason: 'first-run' });
					return { handled: true };

				case 'no-device-credential':
					// D-18 terminal state has no entry in DEVICE_SIGNING_ERROR_COPY_KEY
					// and is not one of isNavigationClass's pair — 49-01 scoped it as a
					// provisioning-screen-local terminal condition. Routing it here to
					// the SAME `reason: 'invalidated'` destination is deliberate: if it
					// ever does surface at a call site (rather than inside the
					// provisioning screen's own recovery ceremony, where it is more
					// likely to originate), the provisioning screen's terminal
					// no-recovery body is the only surface that explains it — an
					// unhandled `undefined` copy key here would otherwise render an
					// empty InlineError, which is worse than routing to a screen that
					// can at least explain the condition even though it arrives via
					// the "invalidated" reason rather than a dedicated one.
					navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
					return { handled: true };

				case 'recovery-unsupported-os':
					// Same shape as `no-device-credential` above: a terminal class that
					// deliberately has NO entry in DEVICE_SIGNING_ERROR_COPY_KEY and is not
					// one of isNavigationClass's pair. Without an explicit case it would fall
					// through to `default:` and evaluate t(undefined), rendering an empty
					// InlineError. The provisioning screen owns the only surface that explains
					// this condition (its terminal recovery-unsupported-os body), so route
					// there rather than trying to phrase it inline.
					navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
					return { handled: true };

				default:
					// The four inline classes: no-biometrics-enrolled, lockout,
					// lockout-permanent, biometric-error.
					return { handled: false, message: t(DEVICE_SIGNING_ERROR_COPY_KEY[cls]!) };
			}
		},
		[navigation, t]
	);
}
