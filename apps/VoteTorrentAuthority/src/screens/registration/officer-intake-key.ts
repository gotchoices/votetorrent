/**
 * officer-intake-key.ts — Authority binding (67-09). The intake-key logic moved to
 * `packages/workflows/src/authority/officer-intake-key.ts`; this path stays so existing imports,
 * `jest.mock` paths and screens keep working. It is where the app supplies its native-wrapped vault
 * (`resolveAuthorityKeyVault`), resolved per call and never cached at module scope. The never-throw
 * contracts of the read and renew entry points still hold for a vault that cannot be built.
 */
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import {
	INTAKE_KEY_SUPERSEDED_CODE,
	isIntakeKeySupersededError,
	enableOfficerEncryptedIntake as enableShared,
	readOfficerIntakeKeyState as readShared,
	renewOfficerIntakeKeyAfterKeyReplacement as renewShared,
	type OfficerIntakeKeyDeps as SharedOfficerIntakeKeyDeps,
	type OfficerIntakeKeyState,
	type OfficerKeyRenewalOutcome,
	type OfficerKeyRenewalResult,
} from '@votetorrent/workflows/authority';
import { resolveAuthorityKeyVault } from '../../engines/key-vault';

export { INTAKE_KEY_SUPERSEDED_CODE, isIntakeKeySupersededError };
export type { OfficerIntakeKeyState, OfficerKeyRenewalOutcome, OfficerKeyRenewalResult };

/** The old shape: `vault` is optional here and defaults to the app vault. */
export interface OfficerIntakeKeyDeps extends Omit<SharedOfficerIntakeKeyDeps, 'vault'> {
	vault?: IKeyVault;
}

/** Evaluated per call: the app vault is resolved only when the caller passed none. */
function appDeps(deps: OfficerIntakeKeyDeps): SharedOfficerIntakeKeyDeps {
	return { ...deps, vault: deps.vault ?? resolveAuthorityKeyVault() };
}

/** Never throws — a vault that cannot be built reports `'unavailable'` like every other failure. */
export async function readOfficerIntakeKeyState(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	let shared: SharedOfficerIntakeKeyDeps;
	try {
		shared = appDeps(deps);
	} catch {
		return 'unavailable';
	}
	return readShared(shared, authorityId);
}

/** A vault-construction failure rejects, as before. */
export async function enableOfficerEncryptedIntake(
	deps: OfficerIntakeKeyDeps,
	authorityId: string,
): Promise<OfficerIntakeKeyState> {
	return enableShared(appDeps(deps), authorityId);
}

/** Never rejects — a vault that cannot be built resolves `'failed'`. */
export async function renewOfficerIntakeKeyAfterKeyReplacement(
	deps: OfficerIntakeKeyDeps,
): Promise<OfficerKeyRenewalOutcome> {
	let shared: SharedOfficerIntakeKeyDeps;
	try {
		shared = appDeps(deps);
	} catch {
		return 'failed';
	}
	return renewShared(shared);
}
