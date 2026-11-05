import type { Signature } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';

/**
 * officer-intake-key.ts — Phase 62 Plan 21 (D-04).
 *
 * `readOfficerIntakeKeyState`/`enableOfficerEncryptedIntake` — the officer's "enable encrypted
 * intake" registration step. Publishes a self-signed `UserEncryptionKey` row through 62-14's
 * `IntakeEngine.registerOfficerEncryptionKey`; the secret half is held only in the native-wrapped
 * Authority key vault (`key-vault.ts`).
 *
 * There is NO default signer and no `device-signer`/`device-user` import here: `createSigner` is a
 * REQUIRED injected dependency, supplied by the hosting screen from `useApp().resolveDeviceSigner`
 * (`AppProvider.tsx`'s lazy thunk). This keeps this file out of the `createDeviceSigner(` invoker
 * inventory (62-21 adds no new invoker; see `deviceSigningRollout.coverage.test.ts`). Its own doc
 * comments never spell out that literal call text — write "the injected signer factory" instead.
 *
 * No `@votetorrent/vote-engine` VALUE import — types only. Never logs.
 */

/** `'enabled-contested'`: enabled, and another officer also published this key (a possible copy). */
export type OfficerIntakeKeyState = 'enabled' | 'enabled-contested' | 'not-enabled' | 'unavailable';

export interface OfficerIntakeKeyDeps {
	getEngine: <T>(engineName: string) => Promise<T>;
	vault?: IKeyVault;
	/** REQUIRED — the injected signer factory (never a default, never `device-signer` imported
	 * here). `readOfficerIntakeKeyState` never calls it. */
	createSigner: () => Promise<(digest: Uint8Array) => Promise<Signature>>;
}

/** The minimal local structural type this file needs from `IntakeEngine`. */
interface OfficerIntakeEngine {
	getOfficerEncryptionKeyStatus(authorityId: string, vault: IKeyVault): Promise<{ isIntakeRecipient: boolean; isContested?: boolean }>;
	registerOfficerEncryptionKey(
		authorityId: string,
		vault: IKeyVault,
		sign: (digest: Uint8Array) => Promise<Signature>,
	): Promise<unknown>;
	/** Optional: absent on mock engines. */
	renewStrandedOfficerEncryptionKey?(
		vault: IKeyVault,
		sign: (digest: Uint8Array) => Promise<Signature>,
	): Promise<OfficerKeyRenewalResult>;
}

/** Local structural copy of the engine's renewal outcome (not exported from vote-engine). */
export type OfficerKeyRenewalResult = 'not-an-officer' | 'no-local-key' | 'not-needed' | 'renewed';

/** Outcome of `renewOfficerIntakeKeyAfterKeyReplacement`; never a rejection. */
export type OfficerKeyRenewalOutcome = OfficerKeyRenewalResult | 'failed' | 'unsupported';

/** Code carried by the error `enableOfficerEncryptedIntake` throws for a superseded key. */
export const INTAKE_KEY_SUPERSEDED_CODE = 'intake-key-superseded';

export function isIntakeKeySupersededError(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		(err as { code?: unknown }).code === INTAKE_KEY_SUPERSEDED_CODE
	);
}

function resolveVault(deps: OfficerIntakeKeyDeps): IKeyVault {
	return deps.vault ?? resolveAuthorityKeyVault();
}

/** Never throws — any failure (no engine, no network, a rejected status read) reports `'unavailable'`. */
export async function readOfficerIntakeKeyState(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	try {
		const intake = await deps.getEngine<OfficerIntakeEngine>('intake');
		const status = await intake.getOfficerEncryptionKeyStatus(authorityId, resolveVault(deps));
		if (!status.isIntakeRecipient) return 'not-enabled';
		return status.isContested === true ? 'enabled-contested' : 'enabled';
	} catch {
		return 'unavailable';
	}
}

/**
 * Registers the officer's encryption key. A `createSigner()` rejection propagates UNCHANGED (no
 * wrapping, no re-throw of a new Error) so the hosting screen's `useDeviceSigningErrorHandler` can
 * classify it directly. After a successful registration call, re-reads the state; if it is not
 * `'enabled'`/`'enabled-contested'` (e.g. a newer key from another device of the same officer — 62-14's one-current-key
 * rule), this rejects rather than silently returning a wrong state.
 */
export async function enableOfficerEncryptedIntake(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	const intake = await deps.getEngine<OfficerIntakeEngine>('intake');
	const vault = resolveVault(deps);
	const sign = await deps.createSigner();
	const registered = await intake.registerOfficerEncryptionKey(authorityId, vault, sign);
	if ((registered as { superseded?: unknown } | null | undefined)?.superseded === true) {
		throw Object.assign(new Error('encrypted intake key superseded by another device'), {
			code: INTAKE_KEY_SUPERSEDED_CODE,
		});
	}

	const state = await readOfficerIntakeKeyState(deps, authorityId);
	if (state !== 'enabled' && state !== 'enabled-contested') {
		throw new Error('encrypted intake is not active for this device');
	}
	return state;
}

/**
 * Renews a stranded intake key right after a successful signing-key replacement. The injected
 * signer factory is invoked lazily, only inside the sign callback the engine calls, so the
 * common `not-needed` case costs no biometric prompt. Never rejects: any failure (engine, vault,
 * signer cancel) resolves `'failed'`; an engine without the method resolves `'unsupported'`.
 */
export async function renewOfficerIntakeKeyAfterKeyReplacement(
	deps: OfficerIntakeKeyDeps,
): Promise<OfficerKeyRenewalOutcome> {
	try {
		const intake = await deps.getEngine<OfficerIntakeEngine>('intake');
		if (typeof intake.renewStrandedOfficerEncryptionKey !== 'function') return 'unsupported';
		const sign = async (digest: Uint8Array): Promise<Signature> => {
			const signer = await deps.createSigner();
			return signer(digest);
		};
		return await intake.renewStrandedOfficerEncryptionKey(resolveVault(deps), sign);
	} catch {
		return 'failed';
	}
}
